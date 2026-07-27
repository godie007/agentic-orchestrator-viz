import type { Role } from "@orq/shared";
import { ids } from "@orq/shared";
import {
  LlmError,
  collect,
  computeCost,
  type ChatMessage,
  type ProviderRegistry,
  type RunLedger,
  type ToolCall,
} from "@orq/llm";
import {
  WEB_SEARCH_TOOL_NAME,
  preview,
  selectTools,
  type RegisteredTool,
  type ToolContext,
  type ToolRegistry,
} from "@orq/tools";
import type { EventBus } from "./events.js";
import type { RunState } from "./state.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.js";

/**
 * Agent loop: un turno de un rol.
 *
 * Cada paso emite un evento antes de ejecutarse, no después de terminar, para
 * que la UI muestre lo que está pasando y no un resumen a posteriori.
 */

export interface TurnDeps {
  bus: EventBus;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  ledger: RunLedger;
  objective: string;
  /** Límite de ciclos de la corrida, para calcular la presión de cierre. */
  maxTicks: number;
  signal?: AbortSignal;
}

export interface TurnResult {
  iterations: number;
  costUsd: number;
  /** Último texto del agente, si escribió algo antes de cerrar el turno. */
  summary: string | null;
  /** `true` si el turno quedó bloqueado esperando una aprobación. */
  awaitingApproval: boolean;
}

export async function runAgentTurn(
  state: RunState,
  role: Role,
  deps: TurnDeps,
): Promise<TurnResult> {
  const { bus, providers, tools, ledger } = deps;
  const runId = state.runId;

  deps.ledger.assertWithinBudget();

  const inbox = state.drainInbox(role.id);
  const tasks = await state.listTasks(role.id);

  // El turno responde al primer pedido pendiente de la bandeja; el resto queda
  // como contexto. Sin esto `reply` no sabría a quién contestar.
  const pending = inbox.find(
    (message) => message.type === "request" || message.type === "escalation",
  );

  // Vista ligada a este rol: el actor viaja por el closure, no por un campo
  // compartido que los turnos paralelos se pisarían entre sí.
  const workspace = state.forActor(role.id);

  const { provider, modelSlug, modelInfo } = await providers.resolveModel(role.model);
  const allowed = tools.forRole(role, state.tools);

  // La búsqueda web nativa del proveedor reemplaza a la herramienta: se activa
  // en el request y el modelo la usa sin gastar una vuelta del loop. Si se
  // dejara expuesta como tool, el modelo llamaría a una que devuelve error.
  const hasWebSearch = allowed.some((tool) => tool.name === WEB_SEARCH_TOOL_NAME);
  const nativeWebSearch = hasWebSearch && provider.id === "openrouter";
  const exposable = nativeWebSearch
    ? allowed.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME)
    : allowed;

  const taskContext = [
    deps.objective,
    ...inbox.map((message) => `${message.subject} ${message.body}`),
    ...tasks.map((task) => `${task.title} ${task.detail}`),
  ].join(" ");

  const selection = selectTools(exposable, taskContext);
  bus.emit({
    type: "tool.selection",
    runId,
    tick: state.tick,
    roleId: role.id,
    candidates: selection.candidates,
    exposed: selection.exposed,
    strategy: selection.strategy,
    reason: nativeWebSearch
      ? `${selection.reason} Además, la búsqueda web nativa de ${provider.label} está activa para este turno.`
      : selection.reason,
  });

  const byName = new Map(selection.tools.map((tool) => [tool.name, tool]));
  const conversation: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(state, role, deps.objective) },
    {
      role: "user",
      content: buildTurnPrompt(state, role, inbox, tasks, {
        tick: state.tick,
        maxTicks: deps.maxTicks,
        spentUsd: ledger.spentUsd,
        budgetUsd: ledger.budgetUsd,
      }),
    },
  ];

  let iterations = 0;
  let costUsd = 0;
  let summary: string | null = null;
  let awaitingApproval = false;

  // Cuántas veces falló exactamente la misma llamada en este turno. Un modelo
  // que choca contra un error que no puede resolver —una ruta MCP fuera del
  // directorio permitido, por ejemplo— reintenta lo mismo hasta agotar
  // `maxTurns`, y el turno se pierde entero sin haber hecho nada.
  const fallosRepetidos = new Map<string, number>();
  const TOLERANCIA = 3;

  // `try/finally`: si el turno falla —proveedor saturado, red caída— el evento
  // de cierre igual se emite. Sin esto el nodo del organigrama se queda
  // "pensando" para siempre, porque la UI espera un `agent.turn_end` que nunca
  // llega.
  try {
  while (iterations < role.maxTurns) {
    iterations++;
    ledger.assertWithinBudget();

    bus.emit({
      type: "agent.thinking",
      runId,
      tick: state.tick,
      roleId: role.id,
      providerId: provider.id,
      modelSlug,
      iteration: iterations,
    });

    const startedAt = Date.now();
    const result = await withRetry(
      () =>
        collect(
          provider.chat({
            model: modelSlug,
            messages: conversation,
            tools: selection.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            ...(role.model.temperature != null ? { temperature: role.model.temperature } : {}),
            maxOutputTokens: role.model.maxOutputTokens,
            ...(nativeWebSearch ? { webSearch: { enabled: true, maxResults: 5 } } : {}),
            ...(deps.signal ? { signal: deps.signal } : {}),
          }),
        ),
      (attempt, delayMs, error) =>
        bus.emit({
          type: "log",
          runId,
          tick: state.tick,
          level: "warn",
          roleId: role.id,
          message:
            `${role.name}: ${error.message}. Reintento ${attempt} en ${Math.round(delayMs / 1000)}s.`,
        }),
      deps.signal,
    );
    const latencyMs = Date.now() - startedAt;

    const cost = computeCost(modelInfo, result.usage);
    costUsd += cost.totalUsd;
    ledger.record({
      roleId: role.id,
      providerId: provider.id,
      modelSlug: result.modelSlug,
      tick: state.tick,
      usage: result.usage,
      costUsd: cost.totalUsd,
      latencyMs,
    });
    bus.emit({
      type: "cost.updated",
      runId,
      tick: state.tick,
      roleId: role.id,
      providerId: provider.id,
      modelSlug: result.modelSlug,
      deltaUsd: cost.totalUsd,
      totalUsd: ledger.spentUsd,
      budgetUsd: ledger.budgetUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });

    if (result.message.content.trim()) summary = result.message.content.trim();
    conversation.push(result.message);

    const calls = result.message.toolCalls ?? [];
    if (calls.length === 0) break; // el agente terminó su turno

    const ctx: ToolContext = {
      runId,
      tick: state.tick,
      actor: role,
      workspace,
      currentThreadId: pending?.threadId ?? null,
      currentMessageId: pending?.id ?? null,
      replyToRoleId: pending?.fromRoleId ?? null,
      ...(deps.signal ? { signal: deps.signal } : {}),
    };

    // Las de solo lectura pueden ir en paralelo; las que mutan van en serie,
    // porque el orden en que se envían mensajes y se cambian tareas importa.
    const results = await executeCalls(calls, byName, ctx, state, bus);
    conversation.push(...results.messages);
    if (results.awaitingApproval) {
      awaitingApproval = true;
      break;
    }

    const atascado = results.failures.filter((huella) => {
      const veces = (fallosRepetidos.get(huella) ?? 0) + 1;
      fallosRepetidos.set(huella, veces);
      return veces >= TOLERANCIA;
    });

    if (atascado.length > 0) {
      // Se le dice al modelo en su propio contexto —no solo en el log— porque
      // el objetivo es que use lo que le queda de turno en otra cosa.
      conversation.push({
        role: "user",
        content:
          `Frená. Ya intentaste ${TOLERANCIA} veces exactamente lo mismo y falló ` +
          `siempre igual: ${atascado.join("; ")}. No lo repitas: el resultado va a ` +
          `ser el mismo. Resolvé lo que puedas con lo que ya tenés, o pedí lo que ` +
          `te falta con send_message o request_context, y cerrá el turno.`,
      });
      bus.emit({
        type: "log",
        runId,
        tick: state.tick,
        level: "warn",
        roleId: role.id,
        message:
          `${role.name} repitió ${TOLERANCIA} veces la misma llamada fallida ` +
          `(${atascado[0]}). Se le pidió cambiar de enfoque.`,
      });
      // Una sola advertencia por turno: si vuelve a insistir, se corta.
      if (atascado.some((huella) => (fallosRepetidos.get(huella) ?? 0) > TOLERANCIA)) break;
    }
  }

  if (iterations >= role.maxTurns) {
    bus.emit({
      type: "log",
      runId,
      tick: state.tick,
      level: "warn",
      roleId: role.id,
      message:
        `${role.name} alcanzó su límite de ${role.maxTurns} iteraciones y se cortó el turno. ` +
        `Si pasa seguido, subí maxTurns del rol o acotá su trabajo.`,
    });
  }

  return { iterations, costUsd, summary, awaitingApproval };
  } finally {
    bus.emit({
      type: "agent.turn_end",
      runId,
      tick: state.tick,
      roleId: role.id,
      iterations,
      costUsd,
      summary,
    });
  }
}

/**
 * Reintenta los errores que el proveedor marca como recuperables.
 *
 * Con modelos gratuitos el 429 es lo normal, no la excepción: sin reintentos la
 * primera vez que un proveedor pide esperar se cae el turno entero y la corrida
 * queda coja. El backoff es exponencial con tope, y cada espera se emite como
 * evento para que se vea en la UI en vez de parecer que el agente se colgó.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  onRetry: (attempt: number, delayMs: number, error: Error) => void,
  signal?: AbortSignal,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof LlmError && error.retryable;
      if (!retryable || attempt === maxAttempts || signal?.aborted) break;

      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 20_000);
      onRetry(attempt, delayMs, error as Error);
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Corrida detenida durante la espera de reintento."));
      },
      { once: true },
    );
  });
}

async function executeCalls(
  calls: ToolCall[],
  byName: Map<string, RegisteredTool>,
  ctx: ToolContext,
  state: RunState,
  bus: EventBus,
): Promise<{ messages: ChatMessage[]; awaitingApproval: boolean; failures: string[] }> {
  const messages: ChatMessage[] = [];
  const failures: string[] = [];
  let awaitingApproval = false;

  const readOnly = calls.filter((call) => byName.get(call.name)?.readOnly === true);
  const mutating = calls.filter((call) => byName.get(call.name)?.readOnly !== true);

  const parallel = await Promise.all(
    readOnly.map((call) => executeOne(call, byName, ctx, state, bus)),
  );
  for (const entry of parallel) {
    messages.push(entry.message);
    if (entry.failure) failures.push(entry.failure);
  }

  for (const call of mutating) {
    const entry = await executeOne(call, byName, ctx, state, bus);
    messages.push(entry.message);
    if (entry.failure) failures.push(entry.failure);
    if (entry.awaitingApproval) awaitingApproval = true;
  }

  return { messages, awaitingApproval, failures };
}

/**
 * Identifica una llamada fallida por herramienta y argumentos.
 *
 * Sirve para detectar que el agente está repitiendo exactamente lo mismo. Los
 * argumentos se serializan con las claves ordenadas: al modelo le da igual el
 * orden y sin normalizar la misma llamada daría dos huellas distintas.
 */
function huellaDeFallo(name: string, args: Record<string, unknown>): string {
  const claves = Object.keys(args).sort();
  return `${name}(${claves.map((clave) => `${clave}=${JSON.stringify(args[clave])}`).join(",")})`;
}

async function executeOne(
  call: ToolCall,
  byName: Map<string, RegisteredTool>,
  ctx: ToolContext,
  state: RunState,
  bus: EventBus,
): Promise<{ message: ChatMessage; awaitingApproval: boolean; failure: string | null }> {
  const tool = byName.get(call.name);
  const callId = call.id || ids.toolCall();

  if (!tool) {
    // El modelo inventó una herramienta. Se le devuelve la lista real para que
    // se corrija en la iteración siguiente en vez de cortar el turno.
    const available = [...byName.keys()].join(", ");
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: call.name,
        content: `ERROR: la herramienta "${call.name}" no existe. Disponibles: ${available}`,
      },
      awaitingApproval: false,
      failure: huellaDeFallo(call.name, call.arguments),
    };
  }

  bus.emit({
    type: "tool.start",
    runId: ctx.runId,
    tick: ctx.tick,
    roleId: ctx.actor.id,
    callId,
    toolName: tool.name,
    origin: tool.origin,
    mcpServerId: tool.mcpServerId ?? null,
    args: call.arguments,
  });

  const startedAt = Date.now();

  // Una herramienta marcada como sensible no se ejecuta: se abre una solicitud
  // de aprobación y esa rama del trabajo queda detenida hasta que se resuelva.
  if (tool.requiresApproval) {
    const approval = await ctx.workspace.requestApproval({
      approverRoleId: ctx.actor.reportsTo,
      reason: `${ctx.actor.name} quiere ejecutar ${tool.name}`,
      toolName: tool.name,
      toolArgs: call.arguments,
    });
    bus.emit({
      type: "approval.changed",
      runId: ctx.runId,
      tick: ctx.tick,
      approvalId: approval.id,
      requestedByRoleId: approval.requestedByRoleId,
      approverRoleId: approval.approverRoleId,
      status: "pending",
      reason: approval.reason,
      toolName: tool.name,
    });
    bus.emit({
      type: "tool.end",
      runId: ctx.runId,
      tick: ctx.tick,
      roleId: ctx.actor.id,
      callId,
      toolName: tool.name,
      origin: tool.origin,
      mcpServerId: tool.mcpServerId ?? null,
      durationMs: Date.now() - startedAt,
      ok: false,
      preview: "esperando aprobación",
      error: null,
    });
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: tool.name,
        content:
          `Esta herramienta requiere aprobación. Se abrió la solicitud ${approval.id} y ` +
          `quedás a la espera. Terminá el turno; vas a poder continuar cuando se resuelva.`,
      },
      awaitingApproval: true,
      failure: null,
    };
  }

  try {
    const result = await tool.execute(call.arguments, ctx);
    emitToolEnd(bus, ctx, callId, tool, startedAt, result.ok, result.preview ?? preview(result.content), null);
    if (tool.origin === "coordination" && result.ok) emitCoordinationEffect(bus, ctx, state, tool);
    return {
      message: { role: "tool", toolCallId: callId, name: tool.name, content: result.content },
      awaitingApproval: false,
      failure: result.ok ? null : huellaDeFallo(tool.name, call.arguments),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitToolEnd(bus, ctx, callId, tool, startedAt, false, "falló", message);
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: tool.name,
        content: `ERROR: ${message}`,
      },
      awaitingApproval: false,
      failure: huellaDeFallo(tool.name, call.arguments),
    };
  }
}

function emitToolEnd(
  bus: EventBus,
  ctx: ToolContext,
  callId: string,
  tool: RegisteredTool,
  startedAt: number,
  ok: boolean,
  previewText: string,
  error: string | null,
): void {
  bus.emit({
    type: "tool.end",
    runId: ctx.runId,
    tick: ctx.tick,
    roleId: ctx.actor.id,
    callId,
    toolName: tool.name,
    origin: tool.origin,
    mcpServerId: tool.mcpServerId ?? null,
    durationMs: Date.now() - startedAt,
    ok,
    preview: previewText,
    error,
  });
}

/**
 * Las herramientas de coordinación cambian el estado visible de la empresa
 * —mensajes, tareas, entregables— y esos cambios tienen que aparecer en el
 * organigrama animado, no solo en el feed de tool calls.
 */
function emitCoordinationEffect(
  bus: EventBus,
  ctx: ToolContext,
  state: RunState,
  tool: RegisteredTool,
): void {
  const base = { runId: ctx.runId, tick: ctx.tick } as const;

  if (["send_message", "reply", "broadcast", "escalate"].includes(tool.name)) {
    const message = state.messages.at(-1);
    if (!message) return;
    bus.emit({
      ...base,
      type: "agent.message",
      messageId: message.id,
      fromRoleId: message.fromRoleId,
      toRoleId: message.toRoleId,
      toDepartmentId: message.toDepartmentId,
      messageType: message.type,
      subject: message.subject,
      preview: preview(message.body, 300),
    });
    return;
  }

  if (tool.name === "assign_task" || tool.name === "update_task") {
    const task = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!task) return;
    bus.emit({
      ...base,
      type: "task.changed",
      taskId: task.id,
      title: task.title,
      assigneeRoleId: task.assigneeRoleId,
      status: task.status,
      created: tool.name === "assign_task",
    });
    return;
  }

  if (tool.name === "write_artifact") {
    const artifact = state.artifacts.at(-1);
    if (!artifact) return;
    bus.emit({
      ...base,
      type: "artifact.created",
      artifactId: artifact.id,
      key: artifact.key,
      title: artifact.title,
      version: artifact.version,
      authorRoleId: artifact.authorRoleId,
    });
    return;
  }

  if (
    tool.name === "request_new_role" ||
    tool.name === "request_context" ||
    tool.name === "request_tool_access"
  ) {
    const request = state.requests.at(-1);
    if (!request) return;
    bus.emit({
      ...base,
      type: "request.created",
      requestId: request.id,
      requestedByRoleId: request.requestedByRoleId,
      requestType: request.type,
      reason: request.reason,
      summary:
        request.roleProposal
          ? `${request.roleProposal.name} — ${request.roleProposal.title}`
          : (request.question ?? request.toolNames.join(", ")),
    });
    return;
  }

  if (tool.name === "request_approval") {
    const approval = state.approvals.at(-1);
    if (!approval) return;
    bus.emit({
      ...base,
      type: "approval.changed",
      approvalId: approval.id,
      requestedByRoleId: approval.requestedByRoleId,
      approverRoleId: approval.approverRoleId,
      status: approval.status,
      reason: approval.reason,
      toolName: approval.toolName,
    });
  }
}
