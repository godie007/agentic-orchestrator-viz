import { z } from "zod";
import {
  idSchema,
  mcpConnectionStatusSchema,
  messageTypeSchema,
  runStatusSchema,
  taskStatusSchema,
  timestampSchema,
  toolOriginSchema,
} from "./schema.js";

/**
 * Trazas del motor.
 *
 * El motor emite un evento por cada cosa que ocurre. El servidor los persiste
 * (para poder reproducir una corrida hacia atrás con el timeline) y los reemite
 * por SSE. Toda la visualización —organigrama animado, MCP Hub, feeds— se
 * dibuja a partir de este stream, así que un evento que no está acá es un paso
 * que el usuario no puede ver.
 */

const base = {
  id: idSchema,
  runId: idSchema,
  tick: z.number().int().nonnegative(),
  at: timestampSchema,
};

// --- Ciclo de la corrida ---------------------------------------------------

const runStatusEvent = z.object({
  ...base,
  type: z.literal("run.status"),
  status: runStatusSchema,
  reason: z.string().nullable().default(null),
});

const tickStartEvent = z.object({
  ...base,
  type: z.literal("tick.start"),
  /** Roles que van a ejecutar turno en este tick. */
  activeRoleIds: z.array(idSchema),
});

const tickEndEvent = z.object({
  ...base,
  type: z.literal("tick.end"),
  messagesEmitted: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

// --- Actividad del agente --------------------------------------------------

/** El nodo del organigrama empieza a pulsar. */
const agentThinkingEvent = z.object({
  ...base,
  type: z.literal("agent.thinking"),
  roleId: idSchema,
  providerId: z.string(),
  modelSlug: z.string(),
  /** Iteración dentro del turno (un turno puede tener varias vueltas de tools). */
  iteration: z.number().int().nonnegative(),
});

const agentTurnEndEvent = z.object({
  ...base,
  type: z.literal("agent.turn_end"),
  roleId: idSchema,
  iterations: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Texto final del turno, si el agente escribió algo antes de terminar. */
  summary: z.string().nullable().default(null),
});

/** Un paquete viaja por la arista del organigrama. */
const agentMessageEvent = z.object({
  ...base,
  type: z.literal("agent.message"),
  messageId: idSchema,
  fromRoleId: idSchema.nullable(),
  toRoleId: idSchema.nullable(),
  toDepartmentId: idSchema.nullable().default(null),
  messageType: messageTypeSchema,
  subject: z.string(),
  preview: z.string().max(500),
});

// --- Herramientas ----------------------------------------------------------

/**
 * Por qué el agente tenía esta herramienta a mano. Se emite antes de la llamada
 * al modelo, cuando el tool router ya decidió qué exponer: hace visible una
 * decisión que de otro modo sería invisible.
 */
const toolSelectionEvent = z.object({
  ...base,
  type: z.literal("tool.selection"),
  roleId: idSchema,
  /** Todas las que el rol tiene permitidas. */
  candidates: z.array(z.string()),
  /** Las que efectivamente se le pasaron al modelo en este turno. */
  exposed: z.array(z.string()),
  /** Criterio aplicado: "all" cuando entran todas, "ranked" cuando se acotó. */
  strategy: z.enum(["all", "ranked"]),
  reason: z.string(),
});

const toolStartEvent = z.object({
  ...base,
  type: z.literal("tool.start"),
  roleId: idSchema,
  callId: z.string(),
  toolName: z.string(),
  origin: toolOriginSchema,
  mcpServerId: idSchema.nullable().default(null),
  args: z.record(z.unknown()),
});

const toolEndEvent = z.object({
  ...base,
  type: z.literal("tool.end"),
  roleId: idSchema,
  callId: z.string(),
  toolName: z.string(),
  origin: toolOriginSchema,
  mcpServerId: idSchema.nullable().default(null),
  durationMs: z.number().nonnegative(),
  ok: z.boolean(),
  /** Recorte del resultado para mostrar en la UI sin volcar todo el payload. */
  preview: z.string().max(2000),
  error: z.string().nullable().default(null),
});

// --- MCP -------------------------------------------------------------------

/** Cambia el semáforo del servidor en el MCP Hub. */
const mcpStatusEvent = z.object({
  ...base,
  type: z.literal("mcp.status"),
  serverId: idSchema,
  serverName: z.string(),
  status: mcpConnectionStatusSchema,
  toolCount: z.number().int().nonnegative().default(0),
  handshakeMs: z.number().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
});

// --- Trabajo ---------------------------------------------------------------

const taskEvent = z.object({
  ...base,
  type: z.literal("task.changed"),
  taskId: idSchema,
  title: z.string(),
  assigneeRoleId: idSchema,
  status: taskStatusSchema,
  /** `true` en la creación, para animarla distinto que una actualización. */
  created: z.boolean().default(false),
});

const artifactEvent = z.object({
  ...base,
  type: z.literal("artifact.created"),
  artifactId: idSchema,
  key: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
  authorRoleId: idSchema,
});

/** Un agente le pide algo a la persona: se ve en el feed y en la bandeja. */
const agentRequestEvent = z.object({
  ...base,
  type: z.literal("request.created"),
  requestId: idSchema,
  requestedByRoleId: idSchema.nullable(),
  requestType: z.enum(["create_role", "context", "tool_access"]),
  reason: z.string(),
  summary: z.string(),
});

const approvalEvent = z.object({
  ...base,
  type: z.literal("approval.changed"),
  approvalId: idSchema,
  requestedByRoleId: idSchema,
  approverRoleId: idSchema.nullable(),
  status: z.enum(["pending", "granted", "denied", "expired"]),
  reason: z.string(),
  toolName: z.string().nullable().default(null),
});

// --- Costos ----------------------------------------------------------------

const costEvent = z.object({
  ...base,
  type: z.literal("cost.updated"),
  roleId: idSchema.nullable(),
  providerId: z.string(),
  modelSlug: z.string(),
  deltaUsd: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
  budgetUsd: z.number().positive(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
});

// --- Diagnóstico -----------------------------------------------------------

const logEvent = z.object({
  ...base,
  type: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  roleId: idSchema.nullable().default(null),
});

export const traceEventSchema = z.discriminatedUnion("type", [
  runStatusEvent,
  tickStartEvent,
  tickEndEvent,
  agentThinkingEvent,
  agentTurnEndEvent,
  agentMessageEvent,
  toolSelectionEvent,
  toolStartEvent,
  toolEndEvent,
  mcpStatusEvent,
  taskEvent,
  artifactEvent,
  approvalEvent,
  agentRequestEvent,
  costEvent,
  logEvent,
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceEventType = TraceEvent["type"];

/** Un evento sin los campos que el emisor rellena solo (`id`, `at`). */
export type TraceEventInput = {
  [K in TraceEvent as K["type"]]: Omit<K, "id" | "at">;
}[TraceEventType];

/** Estrecha el union a una variante concreta. */
export function isEvent<T extends TraceEventType>(
  event: TraceEvent,
  type: T,
): event is Extract<TraceEvent, { type: T }> {
  return event.type === type;
}
