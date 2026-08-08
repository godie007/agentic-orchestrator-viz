import { ids } from "@orq/shared";
import type {
  AgentRequest,
  ApprovalRequest,
  Artifact,
  Company,
  Department,
  McpServer,
  Message,
  Policy,
  Role,
  Learning,
  Task,
  Tool,
} from "@orq/shared";
import type { ChatMessage } from "@orq/llm";
import type {
  AgentWorkspace,
  CreateTaskInput,
  RequestApprovalInput,
  SendMessageInput,
  UpdateTaskInput,
  VerificacionCifras,
  WriteArtifactInput,
} from "@orq/tools";

/**
 * Configuración de la empresa, cargada una vez al arrancar la corrida.
 * Es inmutable durante la ejecución: cambiar la empresa requiere una corrida
 * nueva, igual que reorganizar una empresa de verdad no altera el trabajo ya
 * en curso.
 */
export interface CompanyConfig {
  company: Company;
  departments: Department[];
  roles: Role[];
  policies: Policy[];
  tools: Tool[];
  mcpServers: McpServer[];
  /** Memoria acumulada de corridas anteriores. */
  learnings: Learning[];
  /** Solicitudes ya resueltas o pendientes, para no repetirlas. */
  requests: AgentRequest[];
  /**
   * Entregables que la empresa ya produjo, de corridas anteriores.
   *
   * La empresa es una sola aunque las corridas sean muchas: un área tiene que
   * poder leer lo que otra escribió la semana pasada, y versionarlo en vez de
   * empezar un documento nuevo con otra clave.
   */
  artifacts: Artifact[];
}

/**
 * Puerto de persistencia. El motor escribe acá y sigue; el servidor lo
 * implementa contra SQLite y los tests con un stub. Es lo que mantiene al
 * motor sin dependencias de base de datos.
 */
export interface Persistence {
  saveMessage(message: Message): void;
  saveTask(task: Task): void;
  saveArtifact(artifact: Artifact): void;
  saveApproval(approval: ApprovalRequest): void;
  /** Ámbito empresa, no corrida: por eso sobrevive a la corrida que la creó. */
  saveLearning(learning: Learning): void;
  saveRequest(request: AgentRequest): void;
  /**
   * Un rol incorporado durante la corrida. El departamento va aparte porque
   * puede ser nuevo: un especialista suele traer un área que no existía.
   *
   * Ámbito empresa, como los aprendizajes: el especialista que se convocó para
   * resolver algo queda disponible para la próxima corrida en vez de
   * desaparecer con la que lo creó.
   */
  saveRole(role: Role, department?: Department): void;
}

/** Persistencia nula, para tests y para correr sin guardar nada. */
export const noPersistence: Persistence = {
  saveMessage: () => {},
  saveTask: () => {},
  saveArtifact: () => {},
  saveApproval: () => {},
  saveLearning: () => {},
  saveRequest: () => {},
  saveRole: () => {},
};

/**
 * Estado vivo de una corrida.
 *
 * Vive en memoria mientras la empresa opera —es un proceso local de un solo
 * usuario, y leer la bandeja de cada rol contra SQLite en cada tick no aporta
 * nada— y se persiste en paralelo para el replay del timeline y para sobrevivir
 * a un reinicio.
 */
/** Una llamada a herramienta, como quedó registrada para poder auditarla. */
export interface ActivityEntry {
  roleId: string;
  tick: number;
  tool: string;
  ok: boolean;
  /** Resultado o error, recortado. */
  detail: string;
}

export class RunState {
  readonly messages: Message[] = [];
  /** Especialistas convocados en esta corrida. Ver `incorporarRol`. */
  private convocados = 0;
  /**
   * Qué ejecutó cada agente y con qué resultado.
   *
   * Existe para que un rol revisor pueda contrastar lo que un agente **informa**
   * con lo que efectivamente **hizo**. Es una clase de error que vimos repetida:
   * un agente ejecuta una herramienta con éxito y después reporta que no la
   * tenía disponible, o dice que produjo algo que nunca escribió.
   */
  readonly activity: ActivityEntry[] = [];
  readonly tasks: Task[] = [];
  readonly artifacts: Artifact[] = [];
  readonly approvals: ApprovalRequest[] = [];
  private readonly learningList: Learning[] = [];
  private readonly requestList: AgentRequest[] = [];

  /** Bandeja de cada rol: ids de mensajes sin procesar. */
  private inboxes = new Map<string, string[]>();
  private byId = new Map<string, Message>();

  /** Tick actual. El scheduler lo avanza; las herramientas lo estampan. */
  tick = 0;

  constructor(
    readonly runId: string,
    private readonly config: CompanyConfig,

    private readonly persistence: Persistence = noPersistence,
  ) {
    for (const role of config.roles) this.inboxes.set(role.id, []);
    this.learningList.push(...config.learnings);
    this.requestList.push(...config.requests);
    // Los de corridas anteriores entran al estado pero no se vuelven a
    // persistir: ya están guardados, y duplicarlos rompería el versionado.
    this.artifacts.push(...config.artifacts);
  }

  // --- AgentWorkspace: lectura de la configuración -------------------------

  get company(): Company {
    return this.config.company;
  }
  get departments(): readonly Department[] {
    return this.config.departments;
  }
  get roles(): readonly Role[] {
    return this.config.roles;
  }
  get policies(): readonly Policy[] {
    return this.config.policies;
  }
  get tools(): readonly Tool[] {
    return this.config.tools;
  }

  getRole(roleId: string): Role | undefined {
    return this.config.roles.find((role) => role.id === roleId);
  }

  directReports(roleId: string): Role[] {
    return this.config.roles.filter((role) => role.reportsTo === roleId);
  }

  /**
   * Vista del estado ligada a un actor.
   *
   * El actor **no** puede vivir en un campo mutable de `RunState`: dentro de un
   * tick corren varios turnos en paralelo, cada uno con muchos `await` entre
   * que empieza y que ejecuta sus herramientas. Un campo compartido se pisa
   * entre turnos y los mensajes quedan atribuidos al rol equivocado — llegamos
   * a ver mensajes de un rol a sí mismo, que la herramienta rechaza.
   *
   * Cada turno pide su propia vista y el actor viaja por el closure, así que no
   * hay estado compartido que pisar.
   */
  forActor(actorId: string | null): AgentWorkspace {
    const state = this;
    return {
      get company() {
        return state.company;
      },
      get departments() {
        return state.departments;
      },
      get roles() {
        return state.roles;
      },
      tools: state.tools,
      getRole: (roleId) => state.getRole(roleId),
      directReports: (roleId) => state.directReports(roleId),
      sendMessage: (input) => state.sendMessage(input, actorId),
      registrarVerificacion: (clave, resultado) => state.registrarVerificacion(clave, resultado),
      verificacionDe: (clave) => state.verificacionDe(clave),
      mensajesSinResponder: () =>
        state.messages.filter(
          (mensaje) => mensaje.fromRoleId === actorId && mensaje.status !== "answered",
        ),
      createTask: (input) => state.createTask(input, actorId),
      updateTask: (taskId, patch) => state.updateTask(taskId, patch),
      listTasks: (roleId) => state.listTasks(roleId),
      writeArtifact: (input) => state.writeArtifact(input, actorId),
      readArtifact: (key) => state.readArtifact(key),
      listArtifacts: () => state.listArtifacts(),
      requestApproval: (input) => state.requestApproval(input, actorId),
      recordLesson: (input) => state.recordLesson(input, actorId),
      listLessons: () => state.learnings,
      createRequest: (input) => state.createRequest(input, actorId),
      incorporarRol: (input) => state.incorporarRol(input),
      especialistasConvocados: () => state.especialistasConvocados,
      listRequests: () => state.requests,
      listActivity: () => state.activity,
    };
  }

  // --- Escritura -----------------------------------------------------------

  async sendMessage(input: SendMessageInput, actorId: string | null = null): Promise<Message> {
    const message: Message = {
      id: ids.message(),
      runId: this.runId,
      fromRoleId: actorId,
      toRoleId: input.toRoleId,
      toDepartmentId: input.toDepartmentId,
      type: input.type,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId ?? ids.thread(),
      inReplyTo: input.inReplyTo,
      status: "pending",
      tick: this.tick,
      createdAt: Date.now(),
    };

    this.messages.push(message);
    this.byId.set(message.id, message);
    this.persistence.saveMessage(message);

    // Un broadcast se expande a la bandeja de cada integrante: el mensaje es
    // uno solo, pero cada rol lo recibe por separado, como un mail a una lista.
    const recipients = input.toDepartmentId
      ? this.config.roles.filter((role) => role.departmentId === input.toDepartmentId)
      : this.config.roles.filter((role) => role.id === input.toRoleId);

    for (const recipient of recipients) {
      if (recipient.id === message.fromRoleId) continue; // nadie se escribe a sí mismo
      this.inboxes.get(recipient.id)?.push(message.id);
    }

    // Responder cierra el pedido original, para que quien lo abrió sepa que ya
    // está resuelto y no lo reabra en el ciclo siguiente.
    if (input.inReplyTo) {
      const original = this.byId.get(input.inReplyTo);
      if (original) {
        original.status = "answered";
        this.persistence.saveMessage(original);
      }
    }

    return message;
  }

  async createTask(input: CreateTaskInput, actorId: string | null = null): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: ids.task(),
      runId: this.runId,
      title: input.title,
      detail: input.detail,
      assigneeRoleId: input.assigneeRoleId,
      createdByRoleId: actorId,
      status: "pending",
      priority: input.priority,
      dueTick: input.dueTick,
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.persistence.saveTask(task);
    return task;
  }

  async updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task | null> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return null;
    if (patch.status) task.status = patch.status;
    if (patch.priority) task.priority = patch.priority;
    if (patch.result != null) task.result = patch.result;
    task.updatedAt = Date.now();
    this.persistence.saveTask(task);
    return task;
  }

  async listTasks(assigneeRoleId: string): Promise<Task[]> {
    return this.tasks.filter(
      (task) =>
        task.assigneeRoleId === assigneeRoleId &&
        task.status !== "done" &&
        task.status !== "cancelled",
    );
  }

  async writeArtifact(input: WriteArtifactInput, actorId: string | null = null): Promise<Artifact> {
    const previous = this.artifacts
      .filter((artifact) => artifact.key === input.key)
      .sort((a, b) => b.version - a.version)[0];

    const artifact: Artifact = {
      id: ids.artifact(),
      runId: this.runId,
      key: input.key,
      title: input.title,
      contentType: input.contentType,
      content: input.content,
      version: (previous?.version ?? 0) + 1,
      authorRoleId: actorId ?? "",
      tick: this.tick,
      createdAt: Date.now(),
    };
    this.artifacts.push(artifact);
    this.persistence.saveArtifact(artifact);
    return artifact;
  }

  async readArtifact(key: string): Promise<Artifact | null> {
    const versions = this.artifacts
      .filter((artifact) => artifact.key === key)
      .sort((a, b) => b.version - a.version);
    return versions[0] ?? null;
  }

  async listArtifacts(): Promise<
    Array<Pick<Artifact, "key" | "title" | "version"> & { deOtraCorrida: boolean }>
  > {
    const latest = new Map<string, Artifact>();
    for (const artifact of this.artifacts) {
      const current = latest.get(artifact.key);
      if (!current || artifact.version > current.version) latest.set(artifact.key, artifact);
    }
    return [...latest.values()].map(({ key, title, version, runId }) => ({
      key,
      title,
      version,
      // Distinguirlos importa: si no, el agente cree que lo escribió él en este
      // ciclo y no vuelve a leerlo antes de darlo por bueno.
      deOtraCorrida: runId !== this.runId,
    }));
  }

  async requestApproval(input: RequestApprovalInput, actorId: string | null = null): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      id: ids.approval(),
      runId: this.runId,
      requestedByRoleId: actorId ?? "",
      approverRoleId: input.approverRoleId,
      reason: input.reason,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      status: "pending",
      resolution: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.approvals.push(approval);
    this.persistence.saveApproval(approval);
    return approval;
  }

  /**
   * Registra una lección, o refuerza una existente.
   *
   * Se deduplica por tema + texto normalizado: los agentes tienden a registrar
   * la misma conclusión varias veces, y una memoria llena de duplicados infla
   * el prompt de cada turno — que es exactamente el consumo que esto busca
   * evitar. Repetir una lección sube su contador y la muestra antes.
   */
  async recordLesson(
    input: { topic: string; lesson: string },
    actorId: string | null = null,
  ): Promise<Learning> {
    const key = normalize(input.lesson);
    const existing = this.learningList.find(
      (candidate) =>
        normalize(candidate.topic) === normalize(input.topic) &&
        normalize(candidate.lesson) === key,
    );

    if (existing) {
      existing.timesConfirmed += 1;
      existing.updatedAt = Date.now();
      this.persistence.saveLearning(existing);
      return existing;
    }

    const now = Date.now();
    const learning: Learning = {
      id: ids.learning(),
      companyId: this.config.company.id,
      topic: input.topic,
      lesson: input.lesson,
      authorRoleId: actorId,
      runId: this.runId,
      timesConfirmed: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.learningList.push(learning);
    this.persistence.saveLearning(learning);
    return learning;
  }

  /**
   * Abre una solicitud hacia la persona a cargo.
   *
   * Se deduplica contra las pendientes: un agente que no recibe respuesta
   * tiende a volver a pedir lo mismo en el ciclo siguiente, y eso llenaría la
   * bandeja de duplicados y gastaría tokens sin aportar nada.
   */
  async createRequest(
    input: {
      type: "create_role" | "context" | "tool_access";
      reason: string;
      roleProposal: AgentRequest["roleProposal"];
      question: string | null;
      toolNames: string[];
    },
    actorId: string | null = null,
  ): Promise<AgentRequest> {
    const huella = (candidate: {
      type: string;
      roleProposal: AgentRequest["roleProposal"];
      question: string | null;
      toolNames: string[];
    }): string =>
      normalize(
        [
          candidate.type,
          candidate.roleProposal?.name ?? "",
          candidate.question ?? "",
          [...candidate.toolNames].sort().join(","),
        ].join("|"),
      );

    const existente = this.requestList.find(
      (candidate) => candidate.status === "pending" && huella(candidate) === huella(input),
    );
    if (existente) return existente;

    const request: AgentRequest = {
      id: ids.request(),
      companyId: this.config.company.id,
      runId: this.runId,
      requestedByRoleId: actorId,
      type: input.type,
      reason: input.reason,
      roleProposal: input.roleProposal,
      question: input.question,
      toolNames: input.toolNames,
      status: "pending",
      resolution: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.requestList.push(request);
    this.persistence.saveRequest(request);
    return request;
  }

  /**
   * Verificaciones de cifras por entregable.
   *
   * Vive en la corrida y no en la base a propósito: verificar es parte de
   * producir el documento, no un atributo permanente del documento. Si se
   * reescribe, la verificación de la versión anterior no vale.
   */
  private readonly verificaciones = new Map<string, VerificacionCifras>();

  registrarVerificacion(clave: string, resultado: VerificacionCifras): void {
    this.verificaciones.set(clave, resultado);
  }

  verificacionDe(clave: string): VerificacionCifras | undefined {
    return this.verificaciones.get(clave);
  }

  /** Registra una llamada a herramienta. Lo llama el agent loop. */
  recordActivity(entry: ActivityEntry): void {
    this.activity.push(entry);
    // Una corrida larga acumularía miles: se conserva una ventana, que es lo
    // que un revisor puede leer sin ahogarse.
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
  }

  get requests(): readonly AgentRequest[] {
    return this.requestList;
  }

  /**
   * Refleja acá una solicitud que se resolvió desde afuera.
   *
   * La corrida tiene su propia copia en memoria, y resolver por la API sólo
   * tocaba la base: la copia seguía diciendo "pending" para siempre. Con eso, la
   * corrida que esperaba una respuesta no volvía a arrancar nunca —el chequeo
   * de reanudación leía la lista vieja— y quedaba trabada informando que
   * esperaba solicitudes que ya estaban contestadas.
   */
  resolverSolicitud(resuelta: AgentRequest): void {
    const indice = this.requestList.findIndex((candidate) => candidate.id === resuelta.id);
    if (indice >= 0) this.requestList[indice] = resuelta;
  }

  /** Memoria de la empresa, la reafirmada primero. */
  get learnings(): readonly Learning[] {
    return [...this.learningList].sort(
      (a, b) => b.timesConfirmed - a.timesConfirmed || b.updatedAt - a.updatedAt,
    );
  }

  /**
   * Incorpora un rol a una corrida en curso.
   *
   * La configuración se carga al arrancar, pero un rol aprobado a partir de la
   * propuesta de un agente tiene que empezar a trabajar ya: si esperara a la
   * corrida siguiente, el agente que lo pidió seguiría bloqueado y volvería a
   * proponerlo, sin verlo en su lista de colegas.
   */
  /**
   * Convoca un especialista **en el acto**, sin esperar a que alguien apruebe.
   *
   * Es lo que separa a una empresa que puede abordar un problema que no previó
   * de una que sólo ejecuta el organigrama con el que arrancó. La diferencia con
   * `request_new_role` no es de permisos sino de tiempo: proponer y esperar a
   * una persona sirve para incorporar a alguien de forma permanente; esto sirve
   * para cuando el trabajo ya empezó y falta una capacidad concreta.
   *
   * Tres frenos, y ninguno es decorativo:
   *
   * 1. **El convocado nace `executor`.** No puede convocar a su vez. Sin esto un
   *    equipo puede multiplicarse solo: cada especialista descubre que le falta
   *    otro, y una corrida termina con treinta agentes hablando entre ellos.
   * 2. **Hay un tope por corrida.** Si hacen falta más que eso, el problema no
   *    es la falta de gente: es que nadie entendió el encargo.
   * 3. **Sólo hereda herramientas que la empresa ya tiene.** Convocar no crea
   *    capacidades nuevas, reparte las existentes.
   */
  incorporarRol(input: {
    name: string;
    title: string;
    departmentName: string;
    systemPrompt: string;
    reportsToId: string | null;
    toolIds: string[];
    maxTurns?: number;
  }): Role {
    let department = this.config.departments.find(
      (dep) => dep.name.toLowerCase() === input.departmentName.toLowerCase(),
    );
    const departamentoNuevo = !department;
    if (!department) {
      department = {
        id: ids.department(),
        companyId: this.config.company.id,
        name: input.departmentName,
        purpose: "",
        position: { x: 120 + this.config.departments.length * 260, y: 440 },
        parentId: null,
      };
    }

    const role: Role = {
      id: ids.role(),
      companyId: this.config.company.id,
      departmentId: department.id,
      name: input.name,
      title: input.title,
      systemPrompt: input.systemPrompt,
      model: this.config.company.defaultModel,
      toolIds: input.toolIds,
      authority: "executor",
      reportsTo: input.reportsToId,
      maxTurns: input.maxTurns ?? 10,
      spendApprovalThresholdUsd: null,
      position: { x: department.position.x, y: department.position.y + 90 },
    };

    this.addRole(role, department);
    this.convocados += 1;
    this.persistence.saveRole(role, departamentoNuevo ? department : undefined);
    return role;
  }

  /** Cuántos especialistas se convocaron en esta corrida. Ver `incorporarRol`. */
  get especialistasConvocados(): number {
    return this.convocados;
  }

  addRole(role: Role, department?: Department): void {
    if (this.config.roles.some((existing) => existing.id === role.id)) return;
    if (department && !this.config.departments.some((d) => d.id === department.id)) {
      this.config.departments.push(department);
    }
    this.config.roles.push(role);
    this.inboxes.set(role.id, []);
  }

  /**
   * Saca un rol de una corrida en curso, con sus solicitudes pendientes.
   *
   * Es la contraparte de `addRole`: la configuración se lee al arrancar, así
   * que sin esto un agente borrado desde la UI sigue tomando turnos, gastando
   * presupuesto y abriendo solicitudes nuevas que nadie puede responder.
   *
   * Los mensajes que ya envió se quedan: son historia de lo que pasó, y
   * borrarlos dejaría hilos con respuestas sin pregunta. Su bandeja de entrada
   * sí se descarta —nadie va a leerla— y quien le haya escrito recibe el aviso
   * desde el runtime.
   */
  removeRole(roleId: string): void {
    const index = this.config.roles.findIndex((role) => role.id === roleId);
    if (index === -1) return;
    // El superior se lee antes de sacarlo: después ya no está para consultarlo.
    const superior = this.config.roles[index]!.reportsTo;
    this.config.roles.splice(index, 1);
    this.inboxes.delete(roleId);

    // Quien le reportaba pasa a reportarle a su superior, igual que hace la UI.
    for (const role of this.config.roles) {
      if (role.reportsTo === roleId) role.reportsTo = superior;
    }

    for (let i = this.requestList.length - 1; i >= 0; i--) {
      if (this.requestList[i]!.requestedByRoleId === roleId) this.requestList.splice(i, 1);
    }
  }

  /** Refresca las herramientas de un rol tras otorgarle acceso. */
  updateRoleTools(roleId: string, toolIds: string[]): void {
    const role = this.config.roles.find((candidate) => candidate.id === roleId);
    if (role) role.toolIds = toolIds;
  }

  // --- Bandejas ------------------------------------------------------------

  /** Mensajes sin procesar de un rol, en orden de llegada. */
  inbox(roleId: string): Message[] {
    return (this.inboxes.get(roleId) ?? [])
      .map((id) => this.byId.get(id))
      .filter((message): message is Message => message != null);
  }

  /** Vacía la bandeja y marca los mensajes como leídos. */
  drainInbox(roleId: string): Message[] {
    const messages = this.inbox(roleId);
    this.inboxes.set(roleId, []);
    for (const message of messages) {
      if (message.status === "pending") {
        message.status = "read";
        this.persistence.saveMessage(message);
      }
    }
    return messages;
  }

  /**
   * Vuelve a poner en la bandeja los pedidos que nadie contestó.
   *
   * Leer un mensaje lo saca de la bandeja, así que un agente que se queda sin
   * turnos antes de responder hace desaparecer el pedido: la bandeja queda
   * vacía y el motor da la corrida por terminada. Pasó tal cual —Andrés delegó
   * tres pedidos, los tres se quedaron sin turno, y la corrida se cerró en el
   * ciclo 3 sin entregable—. Un pedido abierto es trabajo pendiente hasta que
   * alguien lo responde.
   *
   * Se reencola con tope: si después de `REENVIOS_MAX` insistencias el
   * destinatario sigue sin contestar, se abandona. Sin ese tope un agente mudo
   * mantendría la corrida viva para siempre.
   */
  reencolarSolicitudesSinResponder(): number {
    let reencolados = 0;
    for (const message of this.messages) {
      if (message.type !== "request" || message.status === "answered") continue;
      if (!message.toRoleId || !this.inboxes.has(message.toRoleId)) continue;
      const cola = this.inboxes.get(message.toRoleId)!;
      if (cola.includes(message.id)) continue; // todavía sin leer: ya cuenta

      const enviados = this.reenvios.get(message.id) ?? 0;
      if (enviados >= RunState.REENVIOS_MAX) continue;
      this.reenvios.set(message.id, enviados + 1);
      cola.push(message.id);
      reencolados++;
    }
    return reencolados;
  }

  private reenvios = new Map<string, number>();
  private static readonly REENVIOS_MAX = 2;

  // --- Turnos interrumpidos -------------------------------------------------

  /**
   * Turnos que se cortaron a la mitad y pueden seguir en el ciclo siguiente.
   *
   * Un turno es trabajo acumulado: el agente leyó su bandeja, consultó fuentes
   * y ejecutó herramientas. Si el proveedor se cae en la iteración 9, tirar esa
   * conversación y arrancar de cero en el ciclo siguiente cuesta el doble y
   * llega al mismo lugar —si es que llega—. Guardamos la conversación y el
   * turno **continúa** desde donde quedó.
   */
  private turnosInterrumpidos = new Map<string, TurnoInterrumpido>();
  private static readonly REANUDACIONES_MAX = 3;

  /**
   * Guarda lo que quedó de un turno para continuarlo. Devuelve `false` si ya se
   * reanudó demasiadas veces: a esa altura no es una caída pasajera sino algo
   * que no se va a arreglar solo, y seguir intentando gasta la corrida.
   */
  guardarTurnoInterrumpido(roleId: string, datos: Omit<TurnoInterrumpido, "reanudaciones">): boolean {
    const previas = this.turnosInterrumpidos.get(roleId)?.reanudaciones ?? 0;
    if (previas >= RunState.REANUDACIONES_MAX) {
      this.turnosInterrumpidos.delete(roleId);
      return false;
    }
    this.turnosInterrumpidos.set(roleId, { ...datos, reanudaciones: previas + 1 });
    return true;
  }

  /** Devuelve el turno cortado de un rol y lo saca: se consume una sola vez. */
  tomarTurnoInterrumpido(roleId: string): TurnoInterrumpido | null {
    const turno = this.turnosInterrumpidos.get(roleId) ?? null;
    this.turnosInterrumpidos.delete(roleId);
    return turno;
  }

  descartarTurnoInterrumpido(roleId: string): void {
    this.turnosInterrumpidos.delete(roleId);
  }

  /** Roles con trabajo pendiente: bandeja con algo, o tareas sin terminar. */
  rolesWithWork(): string[] {
    const active = new Set<string>();
    for (const [roleId, queue] of this.inboxes) {
      if (queue.length > 0) active.add(roleId);
    }
    for (const task of this.tasks) {
      if (task.status === "pending" || task.status === "in_progress") {
        active.add(task.assigneeRoleId);
      }
    }
    // Un turno cortado a la mitad es trabajo pendiente. Si no se cuenta acá, el
    // agente no vuelve a ser convocado y la conversación guardada no la
    // continúa nadie: guardarla no serviría de nada.
    for (const roleId of this.turnosInterrumpidos.keys()) active.add(roleId);
    return [...active];
  }

  pendingApprovals(): ApprovalRequest[] {
    return this.approvals.filter((approval) => approval.status === "pending");
  }

  resolveApproval(
    approvalId: string,
    decision: "granted" | "denied",
    resolution: string,
  ): ApprovalRequest | null {
    const approval = this.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval || approval.status !== "pending") return null;
    approval.status = decision;
    approval.resolution = resolution;
    approval.resolvedAt = Date.now();
    this.persistence.saveApproval(approval);
    return approval;
  }
}


/** Normaliza para deduplicar lecciones escritas con distinta puntuación. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lo que sobrevive de un turno que se cortó, para poder continuarlo. */
export interface TurnoInterrumpido {
  /** La conversación tal como quedó, ya podada de llamadas sin respuesta. */
  conversation: ChatMessage[];
  /** Qué lo cortó, para poder decírselo al modelo al retomar. */
  motivo: string;
  /** El pedido que estaba atendiendo, para que `reply` siga sabiendo a quién. */
  pendingMessageId: string | null;
  threadId: string | null;
  replyToRoleId: string | null;
  reanudaciones: number;
}
