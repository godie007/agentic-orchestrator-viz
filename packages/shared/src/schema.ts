import { z } from "zod";

/**
 * Modelo de dominio del orquestador.
 *
 * Este archivo es la única fuente de verdad: el servidor valida contra estos
 * esquemas, el frontend infiere sus tipos de acá, y la definición completa de
 * una empresa (`CompanyBlueprint`) es serializable a JSON para exportarla,
 * versionarla en git e importarla en otra instalación.
 */

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

export const idSchema = z.string().min(1).max(64);
export const timestampSchema = z.number().int().nonnegative();

/** Identificador de proveedor LLM. Coincide con `LlmProvider.id`. */
export const providerIdSchema = z.enum([
  "openrouter",
  "anthropic",
  "openai",
  "ollama",
  "nvidia",
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Atajo para elegir modelo sin nombrar un slug concreto. Se resuelve contra el
 * catálogo vivo del proveedor, así que no envejece cuando salen modelos nuevos.
 *
 * `free` usa modelos sin costo. Sirve para probar la empresa sin gastar, pero
 * vienen con límites de uso agresivos: esperá 429 y turnos más lentos.
 */
export const modelTierSchema = z.enum(["free", "cheap", "standard", "smart"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

/**
 * Cómo un rol elige su modelo. O bien un tier (se resuelve al arrancar la
 * corrida), o bien un slug exacto que el usuario fijó desde la UI.
 */
export const modelSelectionSchema = z.object({
  providerId: providerIdSchema,
  /** Slug exacto, ej. "anthropic/claude-sonnet-5". Tiene prioridad sobre el tier. */
  modelSlug: z.string().min(1).nullable().default(null),
  tier: modelTierSchema.default("standard"),
  /** Sobrescribe la temperatura del proveedor. `null` = default del proveedor. */
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxOutputTokens: z.number().int().positive().default(4096),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

// ---------------------------------------------------------------------------
// Empresa
// ---------------------------------------------------------------------------

/**
 * Cómo suena la empresa cuando habla.
 *
 * Vive en la empresa y no en el guion porque es un dato de la marca, no una
 * decisión de cada video: el nombre se pronuncia igual en todos. Y no se
 * arregla escribiéndolo mal en el guion —"codishon" en pantalla sería un error
 * de ortografía—: la corrección se aplica sólo al texto que va al sintetizador.
 */
export const vozSchema = z.object({
  /** Todos los personajes con la misma voz: habla la empresa, no un elenco. */
  unaSolaVoz: z.boolean().default(false),
  /** Lo escrito → cómo se dice. Se compara por palabra entera, sin acentuar. */
  pronunciacion: z.record(z.string(), z.string()).default({}),
});
export type Voz = z.infer<typeof vozSchema>;

export const companySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  mission: z.string().max(4000).default(""),
  /** Reparto de voces y pronunciación para los videos que produce. */
  voz: vozSchema.default({ unaSolaVoz: false, pronunciacion: {} }),
  /** Contexto de negocio que todos los agentes reciben en su prompt. */
  context: z.string().max(20000).default(""),
  currency: z.string().length(3).default("USD"),
  /** Tope de gasto por corrida en USD. El motor aborta al superarlo. */
  budgetUsd: z.number().positive().default(1),
  defaultModel: modelSelectionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Company = z.infer<typeof companySchema>;

export const departmentSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  name: z.string().min(1).max(200),
  purpose: z.string().max(4000).default(""),
  /** Departamento padre en el organigrama. `null` = reporta a la empresa. */
  parentId: idSchema.nullable().default(null),
  /** Posición en el canvas del organigrama. Solo presentación. */
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
});
export type Department = z.infer<typeof departmentSchema>;

/**
 * Nivel de autoridad de un rol. Determina qué puede decidir solo y qué debe
 * escalar a su superior.
 */
export const authorityLevelSchema = z.enum([
  "executor", // ejecuta lo asignado; escala cualquier decisión
  "manager", // decide dentro de su área; escala lo que cruza departamentos
  "executive", // decide para toda la empresa
]);
export type AuthorityLevel = z.infer<typeof authorityLevelSchema>;

/**
 * Un rol es un agente. Persiste entre ticks, tiene bandeja de entrada propia,
 * y no comparte contexto con los demás: solo se entera de lo que le escriben.
 */
export const roleSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  departmentId: idSchema,
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  /** Instrucciones específicas del rol. Se compone con el contexto de empresa. */
  systemPrompt: z.string().max(20000).default(""),
  model: modelSelectionSchema,
  /** IDs de herramientas asignadas. Un rol solo ve las suyas. */
  toolIds: z.array(idSchema).default([]),
  authority: authorityLevelSchema.default("executor"),
  /** A quién escala. `null` = tope de la jerarquía. */
  reportsTo: idSchema.nullable().default(null),
  /** Iteraciones máximas del agent loop dentro de un solo turno. */
  maxTurns: z.number().int().positive().max(50).default(8),
  /**
   * Monto en USD por encima del cual el rol debe pedir aprobación antes de
   * comprometer a la empresa. `null` = sin límite propio.
   */
  spendApprovalThresholdUsd: z.number().nonnegative().nullable().default(null),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
});
export type Role = z.infer<typeof roleSchema>;

/**
 * Regla de negocio. El texto va al prompt de los agentes alcanzados; el
 * `gate` opcional se evalúa en código antes de dejar pasar una acción.
 */
export const policySchema = z.object({
  id: idSchema,
  companyId: idSchema,
  name: z.string().min(1).max(200),
  /** Redacción que leen los agentes. */
  statement: z.string().min(1).max(4000),
  /** Roles alcanzados. Vacío = toda la empresa. */
  appliesToRoleIds: z.array(idSchema).default([]),
  gate: z
    .object({
      type: z.literal("spend_above"),
      amountUsd: z.number().nonnegative(),
      requiresRoleId: idSchema,
    })
    .nullable()
    .default(null),
});
export type Policy = z.infer<typeof policySchema>;

/**
 * Cuándo se dispara una misión.
 *
 * Las tres formas del nodo Schedule de n8n, porque son las que la gente
 * necesita de verdad: cada tanto, tal día a tal hora, o una expresión cron para
 * lo que no entra en las otras dos. Sin `cron` no se puede pedir "el primer
 * lunes del mes"; sin `semanal` hay que escribir cron para "todos los días a las
 * 7", que es el caso más común de todos.
 */
export const programacionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("intervalo"),
    cada: z.number().int().positive(),
    unidad: z.enum(["minutos", "horas", "dias", "semanas"]),
  }),
  z.object({
    type: z.literal("semanal"),
    /** Días de la semana, 0 = domingo. Vacío no se acepta: nunca dispararía. */
    dias: z.array(z.number().int().min(0).max(6)).min(1),
    hora: z.number().int().min(0).max(23),
    minuto: z.number().int().min(0).max(59).default(0),
  }),
  z.object({
    type: z.literal("cron"),
    /** Cinco campos: minuto hora día-del-mes mes día-de-semana. */
    expresion: z.string().min(1).max(200),
  }),
]);
export type Programacion = z.infer<typeof programacionSchema>;

/**
 * Una misión es un encargo que se dispara solo.
 *
 * No es una corrida: es la *receta* de una corrida más cuándo repetirla. Se
 * guarda a nivel empresa y sobrevive a los reinicios; lo que no sobrevive es la
 * corrida que genera, igual que cualquier otra.
 */
export const misionSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  name: z.string().min(1).max(200),
  /** El encargo, tal como se lo daría una persona. */
  objective: z.string().min(1).max(8000),
  programacion: programacionSchema,
  enabled: z.boolean().default(true),
  budgetUsd: z.number().positive().default(1),
  maxTicks: z.number().int().positive().nullable().default(null),
  /**
   * A quién se le avisa por correo cuando la misión termina.
   *
   * El aviso lleva qué produjo y el enlace para mirarlo, y es lo que convierte a
   * la misión en algo que se revisa antes de publicar en vez de algo que pasa
   * sin que nadie se entere.
   */
  avisarA: z.array(z.string().email()).default([]),
  /** Instante calculado del próximo disparo. `null` = pausada o sin calcular. */
  proximaAt: timestampSchema.nullable().default(null),
  ultimaAt: timestampSchema.nullable().default(null),
  ultimaRunId: idSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Mision = z.infer<typeof misionSchema>;

// ---------------------------------------------------------------------------
// Herramientas y MCP
// ---------------------------------------------------------------------------

export const toolOriginSchema = z.enum([
  "coordination", // built-in: cómo los agentes se hablan entre sí
  "capability", // built-in: web_search, fetch_url
  "skill", // built-in: produce un archivo real (Word, PDF)
  "mcp", // descubierta de un servidor MCP
]);
export type ToolOrigin = z.infer<typeof toolOriginSchema>;

export const toolSchema = z.object({
  id: idSchema,
  /** Nombre que ve el modelo. Las MCP usan `mcp__<servidor>__<tool>`. */
  name: z.string().min(1).max(128),
  origin: toolOriginSchema,
  description: z.string().max(2000).default(""),
  /** JSON Schema de los argumentos, tal como se le pasa al modelo. */
  inputSchema: z.record(z.unknown()).default({}),
  /** Servidor MCP de origen, si `origin === "mcp"`. */
  mcpServerId: idSchema.nullable().default(null),
  /** Si es true, la ejecución se bloquea hasta que alguien la apruebe. */
  requiresApproval: z.boolean().default(false),
  /** Sin efectos secundarios: el motor puede ejecutarlas en paralelo. */
  readOnly: z.boolean().default(false),
});
export type Tool = z.infer<typeof toolSchema>;

export const mcpTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /**
     * Variables de entorno. El valor es el *nombre* de una variable de `.env`,
     * no el secreto: `{ "GITHUB_TOKEN": "GITHUB_TOKEN" }`. Los secretos nunca
     * se guardan en la base ni viajan a la UI.
     */
    envRefs: z.record(z.string()).default({}),
    cwd: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headerRefs: z.record(z.string()).default({}),
    /**
     * Ruta a la CA que firma el certificado del servidor, para los que corren
     * en la máquina con certificado propio. No es un secreto —es una ruta— y
     * sirve para **verificar**, no para saltear la verificación.
     */
    caPath: z.string().nullable().default(null),
  }),
]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpServerSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  /** Segmento `<servidor>` en `mcp__<servidor>__<tool>`. Sin espacios. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, "solo minúsculas, números, guiones y guiones bajos"),
  description: z.string().max(1000).default(""),
  transport: mcpTransportSchema,
  enabled: z.boolean().default(true),
  /** Auto-aprobar todas las tools de este servidor al descubrirlas. */
  autoApproveTools: z.boolean().default(true),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** Estado en vivo de una conexión MCP. Es lo que pinta el MCP Hub. */
export const mcpConnectionStatusSchema = z.enum([
  "disabled",
  "connecting",
  "ready",
  "error",
  "reconnecting",
]);
export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>;

export const mcpServerHealthSchema = z.object({
  serverId: idSchema,
  serverName: z.string(),
  status: mcpConnectionStatusSchema,
  /** Latencia del handshake en ms. `null` mientras no haya conectado. */
  handshakeMs: z.number().nonnegative().nullable().default(null),
  toolCount: z.number().int().nonnegative().default(0),
  invocations: z.number().int().nonnegative().default(0),
  errors: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
  lastInvokedAt: timestampSchema.nullable().default(null),
  connectedAt: timestampSchema.nullable().default(null),
  /** Intentos de reconexión consecutivos. Se resetea al conectar. */
  reconnectAttempts: z.number().int().nonnegative().default(0),
});
export type McpServerHealth = z.infer<typeof mcpServerHealthSchema>;

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  "idle",
  "running",
  "paused",
  "awaiting_approval",
  "completed",
  "stopped",
  "budget_exceeded",
  "failed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runModeSchema = z.enum(["manual", "continuous", "cron"]);
export type RunMode = z.infer<typeof runModeSchema>;

export const runSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  /** El encargo que dispara toda la actividad. */
  objective: z.string().min(1).max(8000),
  status: runStatusSchema.default("idle"),
  mode: runModeSchema.default("manual"),
  tick: z.number().int().nonnegative().default(0),
  maxTicks: z.number().int().positive().default(50),
  budgetUsd: z.number().positive(),
  spentUsd: z.number().nonnegative().default(0),
  /** Intervalo entre ticks en modo cron, en ms. */
  cronIntervalMs: z.number().int().positive().default(60_000),
  /** Por qué se detuvo. Se muestra en la UI. */
  stopReason: z.string().nullable().default(null),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable().default(null),
});
export type Run = z.infer<typeof runSchema>;

export const messageTypeSchema = z.enum([
  "request", // pedido de trabajo, espera respuesta
  "response", // cierra un request
  "report", // informe sin respuesta esperada
  "escalation", // sube en la jerarquía
  "approval_request",
  "approval_grant",
  "approval_deny",
  "broadcast", // a todo un departamento
  "human", // inyectado por la persona desde la UI
]);
export type MessageType = z.infer<typeof messageTypeSchema>;

export const messageStatusSchema = z.enum(["pending", "delivered", "read", "answered"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageSchema = z.object({
  id: idSchema,
  runId: idSchema,
  /** Rol emisor. `null` = la persona, desde la UI. */
  fromRoleId: idSchema.nullable(),
  /** Rol destinatario. `null` con `broadcast` (usa `toDepartmentId`). */
  toRoleId: idSchema.nullable(),
  toDepartmentId: idSchema.nullable().default(null),
  type: messageTypeSchema,
  subject: z.string().max(300).default(""),
  body: z.string().max(50000),
  /** Agrupa la conversación. Un request abre hilo; su respuesta lo comparte. */
  threadId: idSchema,
  inReplyTo: idSchema.nullable().default(null),
  status: messageStatusSchema.default("pending"),
  tick: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});
export type Message = z.infer<typeof messageSchema>;

/**
 * Etapas por las que pasa una tarea. El orden es el del tablero, y es la
 * secuencia que se espera que siga el trabajo.
 *
 * `in_review` existe para que el paso por Control de Calidad sea una etapa
 * visible y no un mensaje suelto: sin ella, un entregable saltaba de "en curso"
 * a "hecha" y nadie podía ver si alguien lo había verificado.
 */
export const taskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskSchema = z.object({
  id: idSchema,
  runId: idSchema,
  title: z.string().min(1).max(300),
  detail: z.string().max(10000).default(""),
  assigneeRoleId: idSchema,
  createdByRoleId: idSchema.nullable(),
  status: taskStatusSchema.default("pending"),
  priority: taskPrioritySchema.default("normal"),
  /** Tick en el que el asignado debería haberla terminado. */
  dueTick: z.number().int().nonnegative().nullable().default(null),
  result: z.string().max(20000).nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const artifactSchema = z.object({
  id: idSchema,
  runId: idSchema,
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  contentType: z.enum(["markdown", "json", "text"]).default("markdown"),
  content: z.string().max(500000),
  version: z.number().int().positive().default(1),
  authorRoleId: idSchema,
  tick: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

export const approvalStatusSchema = z.enum(["pending", "granted", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalRequestSchema = z.object({
  id: idSchema,
  runId: idSchema,
  requestedByRoleId: idSchema,
  /** Rol con autoridad para resolverla. `null` = decide la persona. */
  approverRoleId: idSchema.nullable(),
  reason: z.string().max(4000),
  /** Tool cuya ejecución quedó bloqueada, si aplica. */
  toolName: z.string().nullable().default(null),
  toolArgs: z.record(z.unknown()).nullable().default(null),
  status: approvalStatusSchema.default("pending"),
  resolution: z.string().max(4000).nullable().default(null),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.nullable().default(null),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

// ---------------------------------------------------------------------------
// Solicitudes de los agentes hacia la persona
// ---------------------------------------------------------------------------

/**
 * Lo que un agente puede pedirle a la persona a cargo.
 *
 * Son cosas que el agente no puede resolver solo porque cambian la empresa o
 * requieren información que nadie adentro tiene: contratar a alguien, conocer
 * un dato del negocio, obtener acceso a una herramienta. Van a una bandeja
 * aparte de la mensajería entre agentes, porque tienen destinatario humano y
 * requieren una decisión, no una respuesta.
 */
export const agentRequestTypeSchema = z.enum([
  "create_role", // "necesito a alguien que se ocupe de X"
  "context", // "necesito saber Y del negocio"
  "tool_access", // "necesito la herramienta Z"
]);
export type AgentRequestType = z.infer<typeof agentRequestTypeSchema>;

export const agentRequestStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type AgentRequestStatus = z.infer<typeof agentRequestStatusSchema>;

/** Propuesta de rol nuevo. La persona puede editarla antes de aceptarla. */
export const roleProposalSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  /** Nombre del departamento. Si no existe, se crea al aceptar. */
  departmentName: z.string().min(1).max(200),
  systemPrompt: z.string().max(20000).default(""),
  authority: authorityLevelSchema.default("executor"),
  /** Nombre del rol al que reportaría. `null` = a quien lo propuso. */
  reportsToName: z.string().max(200).nullable().default(null),
});
export type RoleProposal = z.infer<typeof roleProposalSchema>;

export const agentRequestSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  runId: idSchema.nullable().default(null),
  requestedByRoleId: idSchema.nullable(),
  type: agentRequestTypeSchema,
  /** Por qué lo necesita. Es lo que la persona lee para decidir. */
  reason: z.string().min(1).max(4000),
  /** Propuesta concreta, según el tipo. */
  roleProposal: roleProposalSchema.nullable().default(null),
  question: z.string().max(4000).nullable().default(null),
  toolNames: z.array(z.string()).default([]),
  status: agentRequestStatusSchema.default("pending"),
  /** Lo que respondió la persona: texto libre, o el motivo del rechazo. */
  resolution: z.string().max(8000).nullable().default(null),
  createdAt: timestampSchema,
  resolvedAt: timestampSchema.nullable().default(null),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

// ---------------------------------------------------------------------------
// Memoria de la empresa
// ---------------------------------------------------------------------------

/**
 * Lección aprendida. A diferencia de todo lo demás de una corrida, vive a nivel
 * **empresa** y sobrevive a la corrida que la produjo.
 *
 * Es lo que evita volver a pagar por lo mismo: si en una corrida anterior ya se
 * estableció la tarifa por hora, el criterio de estimación o que cierto tipo de
 * cliente pide algo puntual, eso entra en el prompt de la corrida siguiente en
 * lugar de re-derivarse a fuerza de mensajes entre agentes.
 */
export const learningSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  /** Agrupador corto: "precios", "estimación", "cliente:retail". */
  topic: z.string().min(1).max(120),
  /** La lección en sí, autocontenida y accionable. */
  lesson: z.string().min(1).max(4000),
  /** Rol que la registró. `null` si la cargó una persona. */
  authorRoleId: idSchema.nullable().default(null),
  /** Corrida en la que se aprendió, para poder rastrear su origen. */
  runId: idSchema.nullable().default(null),
  /** Veces que se reafirmó. Las repetidas suben y se muestran primero. */
  timesConfirmed: z.number().int().positive().default(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Learning = z.infer<typeof learningSchema>;

// ---------------------------------------------------------------------------
// Costos
// ---------------------------------------------------------------------------

export const ledgerEntrySchema = z.object({
  id: idSchema,
  runId: idSchema,
  roleId: idSchema.nullable(),
  providerId: providerIdSchema,
  modelSlug: z.string(),
  tick: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** De los de entrada, cuántos sirvió el proveedor desde su caché. */
  cachedInputTokens: z.number().int().nonnegative().default(0),
  /**
   * Costo de la llamada en USD. Es el que informa el proveedor cuando lo
   * informa; si no, se estima con el precio del catálogo.
   */
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().nonnegative(),
  createdAt: timestampSchema,
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

// ---------------------------------------------------------------------------
// Blueprint: la empresa entera como un JSON
// ---------------------------------------------------------------------------

export const companyBlueprintSchema = z.object({
  version: z.literal(1),
  company: companySchema,
  departments: z.array(departmentSchema),
  roles: z.array(roleSchema),
  policies: z.array(policySchema),
  mcpServers: z.array(mcpServerSchema),
  /** Solo tools built-in; las MCP se redescubren al conectar. */
  tools: z.array(toolSchema),
});
export type CompanyBlueprint = z.infer<typeof companyBlueprintSchema>;

// ---------------------------------------------------------------------------
// Payloads de la API
// ---------------------------------------------------------------------------

export const createRunSchema = z.object({
  companyId: idSchema,
  objective: z.string().min(1).max(8000),
  mode: runModeSchema.default("manual"),
  maxTicks: z.number().int().positive().max(500).optional(),
  budgetUsd: z.number().positive().max(1000).optional(),
  cronIntervalMs: z.number().int().min(1000).optional(),
});
export type CreateRunInput = z.infer<typeof createRunSchema>;

export const injectMessageSchema = z.object({
  toRoleId: idSchema,
  subject: z.string().max(300).default(""),
  body: z.string().min(1).max(50000),
});
export type InjectMessageInput = z.infer<typeof injectMessageSchema>;

export const resolveApprovalSchema = z.object({
  decision: z.enum(["grant", "deny"]),
  resolution: z.string().max(4000).default(""),
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalSchema>;

/** Info de un modelo tal como la devuelve el catálogo vivo de un proveedor. */
export const modelInfoSchema = z.object({
  providerId: providerIdSchema,
  slug: z.string(),
  name: z.string(),
  contextLength: z.number().int().nonnegative(),
  /** USD por millón de tokens. `null` si el proveedor no lo publica. */
  inputPricePerMTok: z.number().nonnegative().nullable(),
  outputPricePerMTok: z.number().nonnegative().nullable(),
  supportsTools: z.boolean(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;
