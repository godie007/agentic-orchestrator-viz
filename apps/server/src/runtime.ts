import { ids } from "@orq/shared";
import type {
  AgentRequest,
  CreateRunInput,
  McpServerHealth,
  Role,
  RoleProposal,
  Run,
  Tool,
  TraceEvent,
} from "@orq/shared";
import { RunLedger, type ProviderRegistry } from "@orq/llm";
import { McpBridge, ToolRegistry, createSkillTools } from "@orq/tools";
import { EventBus, Orchestrator, RunState, type CompanyConfig } from "@orq/engine";
import type { Store } from "./db.js";
import type { Env } from "./env.js";
import { resolveSecret } from "./env.js";
import { ExportStore } from "./exports.js";

/**
 * Runtime del servidor: mantiene lo que está vivo.
 *
 * Hay dos niveles. El **runtime de empresa** vive mientras el servidor esté
 * arriba y sostiene las conexiones MCP y el registro de herramientas — por eso
 * el MCP Hub puede mostrar servidores conectados aunque no haya ninguna corrida
 * en curso. La **corrida** es efímera y se apoya en él.
 */

export type EventSink = (event: TraceEvent) => void;

interface CompanyRuntime {
  companyId: string;
  tools: ToolRegistry;
  mcp: McpBridge;
  health: Map<string, McpServerHealth>;
}

interface ActiveRun {
  run: Run;
  state: RunState;
  bus: EventBus;
  ledger: RunLedger;
  orchestrator: Orchestrator;
  companyId: string;
}

export class Runtime {
  private companies = new Map<string, CompanyRuntime>();
  private runs = new Map<string, ActiveRun>();
  /** Suscriptores SSE por corrida, más los del canal global de MCP. */
  private runSubscribers = new Map<string, Set<EventSink>>();
  private mcpSubscribers = new Set<(health: McpServerHealth) => void>();

  /** Documentos que producen las habilidades, uno por empresa. */
  readonly exports: ExportStore;

  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly env: Env,
  ) {
    this.exports = new ExportStore(env.exportsDir);
  }

  // --- Runtime de empresa (MCP + herramientas) -----------------------------

  /** Levanta (o devuelve) el runtime de una empresa y sincroniza sus MCP. */
  async companyRuntime(companyId: string): Promise<CompanyRuntime> {
    let runtime = this.companies.get(companyId);
    if (!runtime) {
      const tools = new ToolRegistry();
      // Las habilidades se registran por empresa porque escriben en su propio
      // directorio: cada una exporta a lo suyo y no ve los documentos de otra.
      for (const skill of createSkillTools(this.exports.forCompany(companyId))) {
        tools.register(skill);
      }
      const health = new Map<string, McpServerHealth>();
      const mcp = new McpBridge(tools, resolveSecret, (update) => {
        health.set(update.serverId, update);
        this.broadcastMcp(update);
        this.persistMcpTools(companyId, tools);
      });
      runtime = { companyId, tools, mcp, health };
      this.companies.set(companyId, runtime);
    }
    await runtime.mcp.sync(this.store.listMcpServers(companyId));
    return runtime;
  }

  /**
   * ¿Está avanzando ahora mismo? Es lo único que impide borrarla.
   *
   * El estado se lee del orquestador y no de `active.run`, que queda viejo: al
   * detener una corrida se persiste el snapshot pero esa referencia no se
   * actualiza, y una corrida ya detenida seguía respondiendo "está en curso".
   */
  estaViva(runId: string): boolean {
    const activa = this.runs.get(runId);
    return activa != null && activa.orchestrator.snapshot.status === "running";
  }

  /**
   * Suelta una corrida de la memoria del servidor.
   *
   * Al borrarla de la base hay que sacarla también de acá: si no, queda un
   * orquestador vivo que se puede seguir avanzando y que escribe eventos de una
   * corrida que ya no existe.
   */
  olvidarCorrida(runId: string): void {
    const activa = this.runs.get(runId);
    if (!activa) return;
    activa.orchestrator.stop();
    this.runs.delete(runId);
    this.runSubscribers.delete(runId);
  }

  mcpHealth(companyId: string): McpServerHealth[] {
    const runtime = this.companies.get(companyId);
    return runtime ? [...runtime.health.values()] : [];
  }

  async reconnectMcp(companyId: string, serverId: string): Promise<boolean> {
    const runtime = await this.companyRuntime(companyId);
    const server = this.store.listMcpServers(companyId).find((s) => s.id === serverId);
    if (!server) return false;
    await runtime.mcp.connect(server);
    return true;
  }

  /** Ejecuta una tool a mano desde el Hub, para probar un servidor MCP. */
  async probeTool(
    companyId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const runtime = await this.companyRuntime(companyId);
    const tool = runtime.tools.get(toolName);
    if (!tool) return { ok: false, content: `La herramienta "${toolName}" no está registrada.` };

    // Se arma un contexto mínimo: la prueba manual no pertenece a ninguna
    // corrida, así que las herramientas de coordinación no son invocables acá.
    if (tool.origin === "coordination" || tool.origin === "skill") {
      return {
        ok: false,
        content:
          tool.origin === "coordination"
            ? "Las herramientas de coordinación necesitan una corrida en curso: " +
              "actúan sobre bandejas y tareas que todavía no existen."
            : "Las habilidades exportan un entregable, y los entregables pertenecen " +
              "a una corrida. Arrancá una y pedile al agente que la use.",
      };
    }

    const roles = this.store.listRoles(companyId);
    const actor = roles[0];
    if (!actor) return { ok: false, content: "La empresa no tiene roles definidos." };

    const result = await tool.execute(args, {
      runId: "probe",
      tick: 0,
      actor,
      workspace: null as never, // no se usa: las de coordinación se rechazan arriba
      currentThreadId: null,
      currentMessageId: null,
      replyToRoleId: null,
    });
    return { ok: result.ok, content: result.content };
  }

  listTools(companyId: string): ReturnType<ToolRegistry["describe"]> {
    const runtime = this.companies.get(companyId);
    return runtime ? runtime.tools.describe() : new ToolRegistry().describe();
  }

  /**
   * Refleja en la base las herramientas descubiertas, para que el diseñador de
   * la empresa pueda asignarlas a un rol y la asignación sobreviva a un
   * reinicio aunque el servidor MCP esté caído en ese momento.
   */
  private persistMcpTools(companyId: string, tools: ToolRegistry): void {
    const existing = new Map(this.store.listTools(companyId).map((tool) => [tool.name, tool]));
    for (const described of tools.describe()) {
      const previous = existing.get(described.name);
      this.store.saveTool(companyId, { ...described, id: previous?.id ?? ids.tool() });
    }
  }

  // --- Corridas ------------------------------------------------------------

  async startRun(input: CreateRunInput): Promise<Run> {
    const company = this.store.getCompany(input.companyId);
    if (!company) throw new Error(`No existe la empresa "${input.companyId}".`);

    const runtime = await this.companyRuntime(company.id);
    const config: CompanyConfig = {
      company,
      departments: this.store.listDepartments(company.id),
      roles: this.store.listRoles(company.id),
      policies: this.store.listPolicies(company.id),
      tools: this.store.listTools(company.id),
      mcpServers: this.store.listMcpServers(company.id),
      learnings: this.store.listLearnings(company.id),
      requests: this.store.listRequests(company.id),
      // Lo que la empresa ya produjo, para que cualquier área lo lea y lo
      // versione en lugar de reescribirlo con otra clave.
      artifacts: this.store.listArtifactsByCompany(company.id),
    };
    if (config.roles.length === 0) {
      throw new Error("La empresa no tiene roles: definí al menos uno antes de arrancar.");
    }

    const run: Run = {
      id: ids.run(),
      companyId: company.id,
      objective: input.objective,
      status: "idle",
      mode: input.mode,
      tick: 0,
      maxTicks: input.maxTicks ?? this.env.defaultMaxTicks,
      budgetUsd: input.budgetUsd ?? company.budgetUsd ?? this.env.defaultBudgetUsd,
      spentUsd: 0,
      cronIntervalMs: input.cronIntervalMs ?? 60_000,
      stopReason: null,
      startedAt: Date.now(),
      endedAt: null,
    };

    const bus = new EventBus();
    bus.subscribe((event) => {
      this.store.saveEvent(event);
      this.broadcastRun(run.id, event);
    });

    const state = new RunState(run.id, config, {
      saveMessage: (message) => this.store.saveMessage(message),
      saveTask: (task) => this.store.saveTask(task),
      saveArtifact: (artifact) => this.store.saveArtifact(artifact, company.id),
      saveApproval: (approval) => this.store.saveApproval(approval),
      saveLearning: (learning) => this.store.saveLearning(learning),
      saveRequest: (request) => this.store.saveRequest(request),
    });

    const ledger = new RunLedger(run.budgetUsd, (record) => {
      this.store.saveLedgerEntry({
        id: ids.ledger(),
        runId: run.id,
        roleId: record.roleId,
        providerId: record.providerId,
        modelSlug: record.modelSlug,
        tick: record.tick,
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        cachedInputTokens: record.usage.cachedInputTokens ?? 0,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        createdAt: record.at,
      });
    });

    const orchestrator = new Orchestrator(run, state, {
      bus,
      providers: this.providers,
      tools: runtime.tools,
      ledger,
      concurrency: this.env.agentConcurrency,
      onRunUpdate: (updated) => this.store.saveRun(updated),
    });

    this.runs.set(run.id, { run, state, bus, ledger, orchestrator, companyId: company.id });
    this.store.saveRun(run);

    // El encargo entra como un mensaje de la persona a cargo al rol de mayor
    // autoridad: la empresa arranca porque alguien pidió algo, no por magia.
    const entryPoint =
      config.roles.find((role) => role.authority === "executive" && !role.reportsTo) ??
      config.roles.find((role) => !role.reportsTo) ??
      config.roles[0]!;
    await state.forActor(null).sendMessage({
      toRoleId: entryPoint.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: input.objective,
      threadId: null,
      inReplyTo: null,
    });

    if (input.mode === "continuous") {
      void orchestrator.runContinuous();
    } else if (input.mode === "cron") {
      orchestrator.startCron(run.cronIntervalMs);
    }

    return orchestrator.snapshot;
  }

  active(runId: string): ActiveRun | undefined {
    return this.runs.get(runId);
  }

  snapshot(runId: string): Run | null {
    const active = this.runs.get(runId);
    return active ? active.orchestrator.snapshot : this.store.getRun(runId);
  }

  async tick(runId: string): Promise<{ advanced: boolean; reason: string }> {
    const active = this.require(runId);
    const result = await active.orchestrator.tick();
    this.store.saveRun(active.orchestrator.snapshot);
    return result;
  }

  async resume(runId: string): Promise<void> {
    const active = this.require(runId);
    await active.orchestrator.runContinuous();
    this.store.saveRun(active.orchestrator.snapshot);
  }

  pause(runId: string): void {
    this.require(runId).orchestrator.pause();
  }

  stop(runId: string): void {
    const active = this.require(runId);
    active.orchestrator.stop();
    this.store.saveRun(active.orchestrator.snapshot);
  }

  /** Mensaje inyectado por la persona a cualquier agente, en cualquier momento. */
  async inject(runId: string, toRoleId: string, subject: string, body: string): Promise<void> {
    const active = this.require(runId);
    // Sin esto el mensaje entra a una bandeja que nadie va a leer y el endpoint
    // responde OK: el usuario cree que escribió y no pasa nada.
    const estado = active.orchestrator.snapshot.status;
    if (["completed", "stopped", "failed", "budget_exceeded"].includes(estado)) {
      throw new Error(
        `La corrida ya terminó (${estado}), así que nadie va a leer el mensaje. ` +
          `Arrancá una corrida nueva para seguir trabajando.`,
      );
    }
    if (!active.state.getRole(toRoleId)) throw new Error(`No existe el rol "${toRoleId}".`);
    const message = await active.state.forActor(null).sendMessage({
      toRoleId,
      toDepartmentId: null,
      type: "human",
      subject: subject || "Mensaje de la persona a cargo",
      body,
      threadId: null,
      inReplyTo: null,
    });
    active.bus.emit({
      type: "agent.message",
      runId,
      tick: active.state.tick,
      messageId: message.id,
      fromRoleId: null,
      toRoleId,
      toDepartmentId: null,
      messageType: "human",
      subject: message.subject,
      preview: body.slice(0, 300),
    });
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "grant" | "deny",
    resolution: string,
  ): boolean {
    const active = this.require(runId);
    return active.orchestrator.resolveApproval(
      approvalId,
      decision === "grant" ? "granted" : "denied",
      resolution,
    );
  }

  private require(runId: string): ActiveRun {
    const active = this.runs.get(runId);
    if (!active) {
      throw new Error(
        `La corrida "${runId}" no está activa en memoria. Las corridas no sobreviven a un ` +
          `reinicio del servidor: podés leer su traza, pero no continuarla.`,
      );
    }
    return active;
  }

  // --- Solicitudes de los agentes ------------------------------------------

  /**
   * Aplica una solicitud aprobada sobre la configuración de la empresa.
   *
   * Los cambios son a nivel empresa y persisten, pero **una corrida en curso no
   * los ve**: su configuración se congela al arrancar. Es deliberado —
   * reorganizar una empresa a mitad de un trabajo confundiría a los agentes que
   * ya están coordinando— y por eso el mensaje de vuelta lo aclara.
   */
  async applyRequest(
    companyId: string,
    request: AgentRequest,
    override: RoleProposal | null,
  ): Promise<Record<string, unknown>> {
    if (request.type === "create_role") {
      const propuesta = override ?? request.roleProposal;
      if (!propuesta) throw new Error("La solicitud no trae una propuesta de rol.");

      const roles = this.store.listRoles(companyId);
      if (roles.some((role) => role.name.toLowerCase() === propuesta.name.toLowerCase())) {
        throw new Error(`Ya existe un rol llamado "${propuesta.name}".`);
      }

      // El departamento se crea si no existe: el agente propone por nombre, no
      // conoce los IDs.
      const departments = this.store.listDepartments(companyId);
      let department = departments.find(
        (dep) => dep.name.toLowerCase() === propuesta.departmentName.toLowerCase(),
      );
      if (!department) {
        department = {
          id: ids.department(),
          companyId,
          name: propuesta.departmentName,
          purpose: "",
          parentId: null,
          position: { x: 120 + departments.length * 260, y: 420 },
        };
        this.store.saveDepartment(department);
      }

      const jefe =
        roles.find(
          (role) => role.name.toLowerCase() === (propuesta.reportsToName ?? "").toLowerCase(),
        ) ??
        (request.requestedByRoleId
          ? roles.find((role) => role.id === request.requestedByRoleId)
          : undefined);

      const company = this.store.getCompany(companyId);
      const nuevo: Role = {
        id: ids.role(),
        companyId,
        departmentId: department.id,
        name: propuesta.name,
        title: propuesta.title,
        systemPrompt: propuesta.systemPrompt,
        // Hereda el modelo por defecto de la empresa: quien lo aprueba puede
        // cambiarlo después desde el diseñador.
        model: company?.defaultModel ?? {
          providerId: "openrouter",
          modelSlug: null,
          tier: "cheap",
          temperature: null,
          maxOutputTokens: 2048,
        },
        toolIds: [],
        authority: propuesta.authority,
        reportsTo: jefe?.id ?? null,
        maxTurns: 6,
        spendApprovalThresholdUsd: null,
        position: { x: department.position.x, y: department.position.y + 90 },
      };
      this.store.saveRole(nuevo);

      // Se suma a la corrida viva, si la hay: así empieza a trabajar en el
      // ciclo siguiente y el resto lo ve en su lista de colegas.
      const activa = request.runId ? this.runs.get(request.runId) : undefined;
      activa?.state.addRole(nuevo, department);

      return { roleId: nuevo.id, roleName: nuevo.name, departmentId: department.id };
    }

    if (request.type === "tool_access") {
      if (!request.requestedByRoleId) throw new Error("La solicitud no indica quién la pidió.");
      const rol = this.store.listRoles(companyId).find((r) => r.id === request.requestedByRoleId);
      if (!rol) throw new Error("El rol que pidió el acceso ya no existe.");

      const catalogo = this.store.listTools(companyId);
      const encontradas = request.toolNames
        .map((name) => catalogo.find((tool) => tool.name === name))
        .filter((tool): tool is Tool => tool != null);
      const faltantes = request.toolNames.filter(
        (name) => !catalogo.some((tool) => tool.name === name),
      );

      const toolIds = [...new Set([...rol.toolIds, ...encontradas.map((tool) => tool.id)])];
      this.store.saveRole({ ...rol, toolIds });
      const enCurso = request.runId ? this.runs.get(request.runId) : undefined;
      enCurso?.state.updateRoleTools(rol.id, toolIds);
      return { otorgadas: encontradas.map((tool) => tool.name), inexistentes: faltantes };
    }

    return {}; // `context`: la respuesta viaja en el mensaje, no cambia config
  }

  /**
   * Retira un rol borrado de las corridas de esa empresa que sigan vivas.
   *
   * Sin esto el borrado solo afecta a la configuración: la corrida en curso
   * cargó los roles al arrancar, así que el agente eliminado seguiría tomando
   * turnos, gastando presupuesto y abriendo solicitudes nuevas —justo las que
   * el borrado acaba de limpiar—.
   */
  removeRoleFromLiveRuns(companyId: string, roleId: string, roleName: string): number {
    let alcanzadas = 0;
    for (const active of this.runs.values()) {
      if (active.companyId !== companyId) continue;
      if (!active.state.roles.some((role) => role.id === roleId)) continue;
      active.state.removeRole(roleId);
      alcanzadas++;
      active.bus.emit({
        type: "log",
        level: "warn",
        runId: active.run.id,
        tick: active.run.tick,
        roleId: null,
        message: `${roleName} fue eliminado desde la configuración y sale de la corrida.`,
      });
    }
    return alcanzadas;
  }

  /**
   * Le hace llegar la respuesta al agente que preguntó.
   *
   * Si su corrida sigue viva le entra por la bandeja. Si ya terminó —que es el
   * caso normal: uno contesta la bandeja después de mirar la corrida— la
   * respuesta se guarda como memoria de la empresa, que sí se inyecta en el
   * prompt de todas las corridas siguientes. Sin esto lo que contestás se
   * pierde en silencio y el agente vuelve a preguntar lo mismo en la próxima,
   * gastando tokens en algo ya resuelto.
   *
   * Devuelve cómo se entregó, para poder decírselo a quien contestó.
   */
  notifyRequester(
    request: AgentRequest,
    aplicado: Record<string, unknown>,
  ): "bandeja" | "memoria" | "descartada" {
    if (!request.requestedByRoleId) return "descartada";
    const active = request.runId ? this.runs.get(request.runId) : undefined;

    if (!active) {
      if (request.type !== "context" || !request.resolution?.trim()) return "descartada";
      const now = Date.now();
      const autor = this.store
        .listRoles(request.companyId)
        .find((role) => role.id === request.requestedByRoleId);
      this.store.saveLearning({
        id: ids.learning(),
        companyId: request.companyId,
        topic: (request.question ?? request.reason).slice(0, 120),
        lesson:
          `Pregunta de ${autor?.name ?? "un agente"}: ${request.question ?? request.reason}\n\n` +
          `Respuesta: ${request.resolution.trim()}`.slice(0, 4000),
        authorRoleId: null,
        runId: request.runId,
        timesConfirmed: 1,
        createdAt: now,
        updatedAt: now,
      });
      return "memoria";
    }

    const aprobada = request.status === "approved";
    const detalle =
      request.type === "context"
        ? (request.resolution ?? "")
        : aprobada
          ? `Aplicado: ${JSON.stringify(aplicado)}`
          : (request.resolution ?? "");

    void active.state.forActor(null).sendMessage({
      toRoleId: request.requestedByRoleId,
      toDepartmentId: null,
      type: aprobada ? "approval_grant" : "approval_deny",
      subject: aprobada ? "Tu solicitud fue aprobada" : "Tu solicitud fue rechazada",
      body:
        `Pedido: ${request.reason}\n\n${detalle}` +
        (request.type === "create_role" && aprobada
          ? `\n\nYa está incorporado y disponible desde el próximo ciclo: escribile con ` +
            `send_message para ponerlo a trabajar.`
          : ""),
      threadId: null,
      inReplyTo: null,
    });
    return "bandeja";
  }

  // --- Suscripciones SSE ---------------------------------------------------

  subscribeRun(runId: string, sink: EventSink): () => void {
    let set = this.runSubscribers.get(runId);
    if (!set) {
      set = new Set();
      this.runSubscribers.set(runId, set);
    }
    set.add(sink);
    return () => set.delete(sink);
  }

  subscribeMcp(sink: (health: McpServerHealth) => void): () => void {
    this.mcpSubscribers.add(sink);
    return () => this.mcpSubscribers.delete(sink);
  }

  private broadcastRun(runId: string, event: TraceEvent): void {
    for (const sink of this.runSubscribers.get(runId) ?? []) {
      try {
        sink(event);
      } catch {
        // Una conexión SSE caída no puede tumbar la corrida.
      }
    }
  }

  private broadcastMcp(health: McpServerHealth): void {
    for (const sink of this.mcpSubscribers) {
      try {
        sink(health);
      } catch {
        // idem
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const active of this.runs.values()) active.orchestrator.stop("Servidor detenido.");
    await Promise.all([...this.companies.values()].map((runtime) => runtime.mcp.disconnectAll()));
  }
}
