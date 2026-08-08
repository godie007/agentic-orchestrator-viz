import type {
  AgentRequest,
  Artifact,
  ApprovalRequest,
  Learning,
  RoleProposal,
  Company,
  Department,
  Message,
  MessageType,
  Role,
  Task,
  Tool,
  TaskPriority,
  TaskStatus,
  ToolOrigin,
} from "@orq/shared";

/**
 * Puertos y contratos del registro de herramientas.
 *
 * Las herramientas no conocen la base de datos ni el motor: escriben contra
 * `AgentWorkspace`, que el motor implementa. Eso permite probarlas con un
 * workspace en memoria y mantiene la dirección de dependencias apuntando hacia
 * las interfaces.
 */

export interface ToolResult {
  ok: boolean;
  /** Lo que ve el modelo como resultado de la herramienta. */
  content: string;
  /** Recorte para la UI. Si falta, se recorta `content`. */
  preview?: string;
}

export function ok(content: string, preview?: string): ToolResult {
  return { ok: true, content, ...(preview ? { preview } : {}) };
}

/**
 * Un error de herramienta no rompe el turno: vuelve al modelo como resultado
 * para que corrija y reintente, igual que le pasaría a una persona.
 */
export function fail(content: string): ToolResult {
  return { ok: false, content: `ERROR: ${content}` };
}

export interface SendMessageInput {
  toRoleId: string | null;
  toDepartmentId: string | null;
  type: MessageType;
  subject: string;
  body: string;
  threadId: string | null;
  inReplyTo: string | null;
}

export interface CreateTaskInput {
  title: string;
  detail: string;
  assigneeRoleId: string;
  priority: TaskPriority;
  dueTick: number | null;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  result?: string;
  priority?: TaskPriority;
}

export interface WriteArtifactInput {
  key: string;
  title: string;
  contentType: "markdown" | "json" | "text";
  content: string;
}

export interface RecordLessonInput {
  topic: string;
  lesson: string;
}

export interface AgentRequestInput {
  type: "create_role" | "context" | "tool_access";
  reason: string;
  roleProposal: RoleProposal | null;
  question: string | null;
  toolNames: string[];
}

export interface RequestApprovalInput {
  approverRoleId: string | null;
  reason: string;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
}

/**
 * Lo que una herramienta puede hacerle al estado de la corrida. El motor lo
 * implementa contra la base; los tests lo implementan en memoria.
 */
/** Resultado de pasar las cifras de un entregable por `verificar_cifras`. */
export interface VerificacionCifras {
  /** Versión del entregable que se verificó: si se reescribe, hay que rehacerla. */
  version: number;
  total: number;
  malas: number;
  sinVerificar: number;
  roleId: string;
}

export interface AgentWorkspace {
  readonly company: Company;
  readonly departments: readonly Department[];
  readonly roles: readonly Role[];
  /**
   * Catálogo de herramientas del proyecto. Sirve para resolver un nombre a su
   * id al repartirlas —`convocar_especialista`—, no para usarlas: lo que este
   * rol puede ejecutar lo decide `role.toolIds`.
   */
  readonly tools: readonly Tool[];

  getRole(roleId: string): Role | undefined;
  /** Reportes directos de un rol, para validar a quién puede asignar trabajo. */
  directReports(roleId: string): Role[];

  /**
   * Incorpora un especialista a la corrida en curso y lo devuelve.
   *
   * Quién puede hacerlo y con qué límites lo decide la herramienta que la usa
   * (`convocar_especialista`); acá sólo está la capacidad. El rol nace
   * `executor` —no puede convocar a su vez— y queda guardado como rol de la
   * empresa, así que sobrevive a la corrida que lo creó.
   */
  incorporarRol(input: {
    name: string;
    title: string;
    departmentName: string;
    systemPrompt: string;
    reportsToId: string | null;
    toolIds: string[];
    maxTurns?: number;
  }): Role;

  /** Cuántos especialistas van convocados en esta corrida, para el tope. */
  especialistasConvocados(): number;

  sendMessage(input: SendMessageInput): Promise<Message>;
  /**
   * Lo que el actor ya le escribió a alguien y todavía no le contestaron.
   * Alcanza para no repetir el mismo pedido; no es el historial completo.
   */
  mensajesSinResponder(): readonly Message[];

  /**
   * Deja constancia de que las cifras de un entregable se verificaron, y con
   * qué resultado. Es lo que después mira la exportación.
   */
  registrarVerificacion(clave: string, resultado: VerificacionCifras): void;
  verificacionDe(clave: string): VerificacionCifras | undefined;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(taskId: string, patch: UpdateTaskInput): Promise<Task | null>;
  listTasks(assigneeRoleId: string): Promise<Task[]>;
  writeArtifact(input: WriteArtifactInput): Promise<Artifact>;
  readArtifact(key: string): Promise<Artifact | null>;
  /** Los de la empresa, no solo los de esta corrida. */
  listArtifacts(): Promise<
    Array<Pick<Artifact, "key" | "title" | "version"> & { deOtraCorrida: boolean }>
  >;
  requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest>;

  /** Memoria de la empresa: sobrevive a la corrida. */
  recordLesson(input: RecordLessonInput): Promise<Learning>;
  listLessons(): readonly Learning[];

  /** Pedido a la persona a cargo. Va a una bandeja aparte, no a otro agente. */
  createRequest(input: AgentRequestInput): Promise<AgentRequest>;
  listRequests(): readonly AgentRequest[];
  /** Qué ejecutó cada agente y con qué resultado, para poder auditarlo. */
  listActivity(): ReadonlyArray<{
    roleId: string;
    tick: number;
    tool: string;
    ok: boolean;
    detail: string;
  }>;
}

/** Contexto de una invocación concreta. */
export interface ToolContext {
  runId: string;
  tick: number;
  /** Rol que está ejecutando el turno. */
  actor: Role;
  workspace: AgentWorkspace;
  /** Hilo del mensaje que disparó el turno, si lo hubo. */
  currentThreadId: string | null;
  /** Mensaje concreto que se está respondiendo, si lo hay. */
  currentMessageId: string | null;
  /** Autor de ese mensaje: a quién le contesta `reply`. */
  replyToRoleId: string | null;
  signal?: AbortSignal;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: ToolOrigin;
  /** Sin efectos secundarios: el motor puede ejecutarlas en paralelo. */
  readOnly: boolean;
  /**
   * Qué argumentos determinan el resultado, para no repetir una lectura que ya
   * se hizo en el turno. Si no se declara, cuentan todos los del esquema.
   *
   * Sirve para los que llevan argumentos decorativos —un rótulo para la traza,
   * un comentario— que no cambian lo que devuelve la herramienta pero sí la
   * huella, y hacen que la misma llamada parezca nueva.
   */
  clavesDeCache?: readonly string[];
  requiresApproval: boolean;
  /** Servidor MCP de origen, si `origin === "mcp"`. */
  mcpServerId?: string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Recorta un texto para mostrarlo en la UI sin volcar el payload entero. */
export function preview(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
