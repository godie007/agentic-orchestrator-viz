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
  // Mismo Anthropic, pero autenticado con la sesión de `ant auth login` en vez
  // de una API key del `.env`. Es un id aparte —y no una opción del anterior—
  // porque un rol elige proveedor por id: así conviven los dos y le podés dar
  // la sesión a un agente sin tocar a los demás.
  "claude-sesion",
  // Claude Code CLI oficial: el modelo corre del lado de Anthropic bajo la
  // suscripción de claude.ai (no factura uso/año). Es un id aparte porque el
  // agente no se autentica por variables: el CLI usa el login de la máquina.
  "claude-code",
  // CLI de opencode: mismo trato que el anterior —el turno se delega entero al
  // binario de la máquina— pero la credencial es la de `opencode auth login`,
  // que puede ser el plan de OpenCode Zen, una sesión de Anthropic o Copilot.
  // Va aparte porque un rol elige proveedor por id: así conviven las dos
  // suscripciones y le podés dar una a un agente sin tocar a los demás.
  "opencode",
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
  /**
   * Escalado automático: el motor elige el tier de cada turno según la
   * dificultad medida (bandeja, tareas, contexto, fallos), acotado al rango.
   * `null` = apagado, el rol usa siempre su `tier`. Un `modelSlug` fijo lo
   * desactiva por completo: el slug tiene prioridad absoluta.
   */
  escalado: z
    .object({
      activo: z.boolean().default(false),
      tierMinimo: modelTierSchema.default("cheap"),
      tierMaximo: modelTierSchema.default("smart"),
    })
    .nullable()
    .default(null),
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

/**
 * Cómo se ve la marca cuando la empresa produce algo.
 *
 * Vive acá por la misma razón que la voz: es un dato de la marca y no una
 * decisión de cada pieza. Un rótulo con el azul del kit sobre un video de una
 * empresa que usa naranja se ve como una plantilla, que es exactamente lo que
 * una pieza institucional no puede parecer. Los valores por defecto son los del
 * kit, así que una empresa que no la configura sigue viéndose como antes.
 */
export const marcaSchema = z.object({
  /** Color de realce: barras, subrayados, lo que hay que mirar primero. */
  acento: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "un color en formato #rrggbb")
    .default("#40a0f8"),
  /** Fondo de los paneles y rótulos sobre los que va texto claro. */
  panel: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "un color en formato #rrggbb")
    .default("#232f4d"),
  /**
   * Escribir el título de cada escena sobre el video.
   *
   * Apagado por defecto, y no es una preferencia estética menor: cuando lo que
   * se filma es una aplicación, la pantalla ya trae sus propios títulos,
   * encabezados y menús, y el rótulo compite con ellos en vez de ayudar. Sirve
   * cuando el visual no se explica solo —una toma de cámara, un diagrama— y ahí
   * se prende a propósito.
   */
  rotulos: z.boolean().default(false),
});
export type Marca = z.infer<typeof marcaSchema>;

export const companySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  mission: z.string().max(4000).default(""),
  /** Reparto de voces y pronunciación para los videos que produce. */
  voz: vozSchema.default({ unaSolaVoz: false, pronunciacion: {} }),
  /** Los colores con los que se rotula lo que produce. */
  marca: marcaSchema.default({ acento: "#40a0f8", panel: "#232f4d" }),
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
// Código: repositorios cargados y sesiones de trabajo
// ---------------------------------------------------------------------------

/**
 * Un comando como argv, nunca como texto de shell.
 *
 * La allowlist se compara token por token: guardada como string, `npm test`
 * habilitaba `npm testx` y `npm test; rm -rf ~` por prefijo.
 */
export const argvSchema = z.array(z.string().min(1).max(400)).min(1).max(40);
export type Argv = z.infer<typeof argvSchema>;

export const origenRepositorioSchema = z.discriminatedUnion("tipo", [
  /** Una carpeta de esta máquina. Se clona (o se copia, si no tiene git): nunca se toca. */
  z.object({ tipo: z.literal("local"), ruta: z.string().min(1).max(1000) }),
  /** Una URL git. Sin credenciales adentro: las pone el helper de git de la máquina. */
  z.object({ tipo: z.literal("git"), url: z.string().min(1).max(1000) }),
  /**
   * Un programa nuevo que creó la empresa (`crear_repositorio`). No tiene
   * afuera: su casa es el clon, y integrar es avanzar su `main`.
   */
  z.object({ tipo: z.literal("creado"), descripcion: z.string().max(500).default("") }),
]);
export type OrigenRepositorio = z.infer<typeof origenRepositorioSchema>;

export const comandosRepositorioSchema = z.object({
  /** Prefijos de argv que un agente puede correr sin preguntar. */
  permitidos: z.array(argvSchema).default([]),
  /** Lo que deja un worktree nuevo listo para trabajar (`npm ci`). Lo aprueba una persona. */
  preparar: argvSchema.nullable().default(null),
  /** Cómo se corren los tests. Es lo primero que un agente necesita saber. */
  test: argvSchema.nullable().default(null),
  /** Typecheck, lint, build: lo que dice si el cambio está sano. */
  verificar: argvSchema.nullable().default(null),
  /**
   * Correr sin `sandbox-exec`. Es un opt-in explícito de una persona: sin
   * aislamiento, `npm test` corre como tu usuario el código que escribió un
   * agente, con acceso a todo lo que vos tenés.
   */
  sinAislamiento: z.boolean().default(false),
  /** Permisos de un solo uso, por argv exacto. Se consumen al ejecutarse. */
  unaVez: z.array(argvSchema).default([]),
});
export type ComandosRepositorio = z.infer<typeof comandosRepositorioSchema>;

export const tipoServicioSchema = z.enum(["web", "api", "movil", "docs", "otro"]);
export type TipoServicio = z.infer<typeof tipoServicioSchema>;

/**
 * Una parte de un repo que se levanta por su cuenta: el backend, el frontend,
 * la app móvil, la documentación.
 *
 * Un monorepo como el de INSPIA es un solo repo git con cuatro programas
 * adentro, y cada uno se arranca distinto, en su carpeta, con su puerto y su
 * `.env`. Sin esto la vista previa sólo podía servir archivos estáticos, y una
 * app de Vite o de Expo no es un archivo estático: hay que levantarla.
 */
export const servicioSchema = z.object({
  /** Slug estable dentro del repo (`backend`): es lo que nombran los agentes. */
  id: z.string().min(1).max(60),
  nombre: z.string().min(1).max(80),
  /** Relativa a la raíz del repo. `""` es la raíz. */
  carpeta: z.string().max(300).default(""),
  tipo: tipoServicioSchema,
  /**
   * Cómo se levanta en desarrollo, como argv. `{puerto}` se reemplaza por el
   * asignado. `null`: no se levanta (la documentación se lee, no corre).
   */
  arrancar: argvSchema.nullable().default(null),
  /** La variable con la que el programa lee su puerto (`PORT`), si la usa. */
  variablePuerto: z.string().max(60).nullable().default(null),
  /**
   * El puerto que usa en la máquina de la persona. Sirve para redirigir: si el
   * `.env` del frontend dice `http://localhost:3001/api` y el backend usa el
   * 3001, en la vista previa esa URL pasa a ser la del backend levantado acá.
   */
  puertoOriginal: z.number().int().min(1).max(65535).nullable().default(null),
  /** Qué se consulta para saber que está listo (`/health`). Sin esto, `/`. */
  salud: z.string().max(200).nullable().default(null),
  /** Dónde abre la vista previa. */
  inicio: z.string().max(300).default("/"),
  /**
   * Archivos `.env` de la persona, con ruta absoluta. Se leen **al arrancar** y
   * no se copian al repo ni a la base: el clon excluye `.env*` a propósito, y
   * un secreto guardado acá viajaría con cada blueprint exportado.
   */
  archivosEntorno: z.array(z.string().min(1).max(1000)).max(8).default([]),
  /** Variables sin secretos que pisan a las de los archivos. `{url:backend}` es la URL de otro servicio. */
  entorno: z.record(z.string().max(2000)).default({}),
});
export type Servicio = z.infer<typeof servicioSchema>;

export const repositorioSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  nombre: z.string().min(1).max(120),
  /** Nombre de carpeta del clon gestionado: `repos/<slug>`. */
  slug: z.string().min(1).max(60),
  origen: origenRepositorioSchema,
  /** La rama sobre la que se abren las sesiones y a la que se integra. */
  ramaBase: z.string().min(1).max(200).default("main"),
  /** Commit del clon del que parten las sesiones. */
  baseSha: z.string().nullable().default(null),
  /** El origen local no tenía git: se integra copiando archivos, no con una rama. */
  origenSinGit: z.boolean().default(false),
  comandos: comandosRepositorioSchema.default({}),
  /** Lo que se levanta adentro: ver `servicioSchema`. Se detecta al cargar y se edita en la UI. */
  servicios: z.array(servicioSchema).max(20).default([]),
  /**
   * Si cada turno de agente cierra con un commit (checkpoint). Por default no:
   * los cambios quedan sin commitear y la persona decide qué prepara, escribe
   * (o genera) el mensaje, commitea y publica —el flujo de Cursor—. Cada
   * pedido igual se puede ver y deshacer: el turno toma instantáneas del árbol
   * sin tocar la rama.
   */
  commitsAutomaticos: z.boolean().default(false),
  /**
   * Llegó importado de un blueprint: la allowlist está pero nadie la confirmó
   * en esta máquina. Hasta confirmarla no se ejecuta nada.
   */
  pendienteDeConfirmar: z.boolean().default(false),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Repositorio = z.infer<typeof repositorioSchema>;

export const estadoSesionCodigoSchema = z.enum(["abierta", "integrada", "descartada"]);
export type EstadoSesionCodigo = z.infer<typeof estadoSesionCodigoSchema>;

/**
 * Una sesión de trabajo sobre un repo: un worktree con su rama `orq/…`.
 *
 * Hay una abierta por repo y **sobrevive a la corrida** que la abrió, igual que
 * las tareas heredadas: un cambio grande no entra en una corrida, y la
 * siguiente tiene que encontrar el trabajo donde quedó. La cierra una persona,
 * integrándola o descartándola.
 */
export const sesionCodigoSchema = z.object({
  id: idSchema,
  companyId: idSchema,
  repoId: idSchema,
  rama: z.string().min(1).max(200),
  /** Relativa a la carpeta del proyecto: `worktrees/<repo>/<rama>`. */
  carpeta: z.string().min(1).max(500),
  baseSha: z.string(),
  estado: estadoSesionCodigoSchema.default("abierta"),
  creadaEnRunId: idSchema.nullable().default(null),
  /** Cómo terminó integrada: fast-forward, sólo la rama, copia de archivos. */
  integracion: z
    .object({
      modo: z.enum(["fast-forward", "rama", "copia"]),
      detalle: z.string().max(4000),
      at: timestampSchema,
    })
    .nullable()
    .default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SesionCodigo = z.infer<typeof sesionCodigoSchema>;

// ---------------------------------------------------------------------------
// Herramientas y MCP
// ---------------------------------------------------------------------------

export const toolOriginSchema = z.enum([
  "coordination", // built-in: cómo los agentes se hablan entre sí
  "capability", // built-in: web_search, fetch_url
  "skill", // built-in: produce un archivo real (Word, PDF)
  "mcp", // descubierta de un servidor MCP
  "creada", // compuesta por un agente a partir de herramientas existentes
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
  /**
   * Definición de una herramienta compuesta (`origin === "creada"`): una
   * secuencia de herramientas existentes con argumentos fijos y huecos
   * `{{parametro}}` que se completan al invocarla. Es declarativa a propósito:
   * una herramienta creada por un agente no puede hacer nada que sus
   * componentes no pudieran, y por eso no necesita aprobación ni sandbox.
   */
  composicion: z
    .object({
      pasos: z
        .array(
          z.object({
            tool: z.string().min(1).max(128),
            args: z.record(z.unknown()).default({}),
          }),
        )
        .min(1)
        .max(6),
      creadaPorRoleId: idSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type Tool = z.infer<typeof toolSchema>;
export type ComposicionDeTool = NonNullable<Tool["composicion"]>;

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
  /**
   * Auto-aprobar todas las tools de este servidor al descubrirlas. Apagado,
   * sólo piden aprobación las que el servidor **no** declara de sólo lectura
   * (`annotations.readOnlyHint`): en una base de datos, listar tablas corre
   * solo y una migración espera a una persona.
   */
  autoApproveTools: z.boolean().default(true),
  /**
   * Roles a los que se otorgan las tools del servidor **cuando aparezcan**. Un
   * servidor con OAuth no las publica hasta que una persona lo autoriza en el
   * navegador; sin esto, autorizar dejaba las herramientas sin dueño y había
   * que acordarse de volver a asignarlas. Se vacía al otorgarlas.
   */
  otorgarAlConectar: z.array(idSchema).default([]),
  /**
   * Qué variables de entorno necesita el servidor, declaradas de antemano.
   * `ref` es el **nombre** de la variable (regla de secretos por referencia).
   * Sin esta lista, una credencial ausente se descubría recién en el
   * handshake, lejos de su causa.
   */
  envRequeridas: z
    .array(
      z.object({
        ref: z.string().min(1),
        descripcion: z.string().default(""),
        obligatoria: z.boolean().default(true),
      }),
    )
    .default([]),
  /** Id del artículo de la tienda del que salió, o null si se pegó a mano. */
  catalogoId: z.string().nullable().default(null),
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
  /**
   * Referencias de env/headers declaradas en el transporte que no tienen valor
   * en el entorno del servidor. Antes se omitían en silencio y el error
   * aparecía lejos de su causa.
   */
  envFaltantes: z.array(z.string()).default([]),
  /**
   * El servidor pide autorización OAuth (Supabase, Sentry…): la URL para
   * iniciar sesión en el navegador. Mientras no se autorice, no conecta.
   */
  autorizacion: z.string().nullable().default(null),
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

/**
 * Los estados de los que una corrida ya no vuelve.
 *
 * Vive acá y no en el motor porque la pregunta "¿esto se puede continuar?" se
 * hace en los tres lados —el scheduler para cortar el bucle, el servidor para
 * no borrar trabajo vivo, la UI para decidir qué botón ofrecer— y cada copia
 * de la lista se desincronizó: la UI trataba `awaiting_approval` como
 * terminada y ofrecía borrar una corrida que sólo esperaba una respuesta.
 */
export const ESTADOS_TERMINALES = [
  "completed",
  "stopped",
  "budget_exceeded",
  "failed",
] as const satisfies readonly RunStatus[];

export function esCorridaTerminal(status: RunStatus): boolean {
  return (ESTADOS_TERMINALES as readonly RunStatus[]).includes(status);
}

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
  /**
   * Corrida enfocada: un solo agente sobre un repo, disparada desde el chat del
   * IDE. Ausente o `null` en una corrida de toda la empresa —opcional y no
   * `.default()` porque las filas viejas no lo tienen y se leen sin Zod—.
   */
  foco: z
    .object({
      rolId: idSchema,
      repoId: idSchema,
      /** La conversación del chat a la que pertenece el pedido. Ausente en los pedidos de antes. */
      conversacionId: z.string().max(60).optional(),
    })
    .nullable()
    .optional(),
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
  /**
   * Corrida en la que se abrió, cuando la tarea viene de una anterior.
   *
   * El trabajo pendiente sobrevive a la corrida que lo abrió: una empresa que
   * retoma un encargo largo tiene que encontrar su tablero como lo dejó, no
   * uno vacío. `null` = nació en la corrida actual.
   */
  heredadaDeRunId: idSchema.nullable().default(null),
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
  "mcp_server", // "necesito conectar un servidor MCP que la empresa no tiene"
  "comando", // "necesito correr este comando en el repo"
  "dependencia", // "necesito esta librería instalada en el repo"
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

/**
 * Servidor MCP propuesto por un agente, ya saneado por `parsearConfigMcp`: los
 * secretos literales quedaron afuera antes de llegar acá, así que aprobar esta
 * propuesta nunca puede escribir una credencial en la base.
 */
export const servidorMcpPropuestoSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, "solo minúsculas, números, guiones y guiones bajos"),
  description: z.string().max(1000).default(""),
  transport: mcpTransportSchema,
});
export type ServidorMcpPropuesto = z.infer<typeof servidorMcpPropuestoSchema>;

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
  /** Servidores propuestos, si `type === "mcp_server"`. Ya sin secretos. */
  mcpProposal: z.array(servidorMcpPropuestoSchema).default([]),
  /** El comando pedido, si `type === "comando"`: argv exacto y en qué repo. */
  comando: z
    .object({ repoId: idSchema, argv: z.array(z.string().min(1).max(400)).min(1).max(40) })
    .nullable()
    .default(null),
  /**
   * Los paquetes pedidos, si `type === "dependencia"`. Aprobar los instala en
   * la sesión del repo (sin scripts de instalación) y commitea el resultado.
   */
  dependencia: z
    .object({
      repoId: idSchema,
      gestor: z.enum(["npm", "pnpm", "yarn"]),
      paquetes: z.array(z.string().min(1).max(260)).min(1).max(10),
      dev: z.boolean().default(false),
      /** Subcarpeta del repo donde está el `package.json` (monorepo). `""` es la raíz. */
      carpeta: z.string().max(300).default(""),
    })
    .nullable()
    .default(null),
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
  /**
   * Una lección es un **reclamo que requiere evidencia**, no un hecho a
   * guardar. Lo pagamos: un rol concluyó que `edit_artifact` estaba rota
   * —era el índice de lectura el que le mostraba secciones duplicadas
   * inexistentes— y la lección falsa entró a la memoria de la empresa, lista
   * para degradar todas las corridas siguientes. Los campos que siguen
   * existen para que eso se note y se pueda deshacer.
   */
  /** Qué respalda la lección: la herramienta y el resultado que la demuestran. */
  evidencia: z.string().max(600).nullable().default(null),
  /**
   * `refutada` no entra más al prompt pero **no se borra**: el registro de por
   * qué se refutó vale tanto como la lección. `cuestionada` entra marcada.
   */
  estado: z.enum(["activa", "cuestionada", "refutada"]).default("activa"),
  /** El tombstone: por qué se refutó y cuándo. Sólo lo pone una persona. */
  refutacion: z
    .object({ motivo: z.string().min(1).max(600), at: timestampSchema })
    .nullable()
    .default(null),
  /**
   * Quién la reafirmó de verdad. `timesConfirmed` solo contaba repetición
   * textual —posiblemente del mismo rol en el mismo turno—; una confirmación
   * vale cuando viene de otra corrida u otro autor.
   */
  confirmaciones: z
    .array(
      z.object({
        roleId: idSchema.nullable(),
        runId: idSchema.nullable(),
        at: timestampSchema,
      }),
    )
    .max(20)
    .default([]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Learning = z.infer<typeof learningSchema>;

/**
 * Normaliza para deduplicar lecciones escritas con distinta puntuación.
 *
 * Vive acá y no en el motor porque la deduplicación tiene dos puertas —el
 * `record_lesson` de un agente y el POST de una persona— y con dos copias de
 * la regla, lo que una puerta consideraba repetido la otra lo creaba de nuevo.
 */
export function normalizarLeccion(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  /**
   * Repos del proyecto, **sin rutas locales**: una ruta de esta máquina no
   * significa nada en otra. Las URL git viajan; la allowlist llega como
   * `pendienteDeConfirmar`, porque importar un JSON no puede autorizar comandos.
   */
  repositorios: z.array(repositorioSchema).default([]),
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
  foco: z
    .object({
      rolId: idSchema,
      repoId: idSchema,
      /**
       * Lo que adjuntó la persona —archivos, la selección del editor, notas—,
       * ya armado. Va en el mensaje al agente y no en `objective`, que es lo
       * que se lista en la UI y tiene su propio tope.
       */
      contexto: z.string().max(40_000).default(""),
      /**
       * La conversación del chat. Los pedidos anteriores de la misma
       * conversación viajan resumidos en el mensaje: sin eso "ahora hacelo
       * azul" no se refiere a nada, porque cada pedido es una corrida nueva.
       */
      conversacionId: z
        .string()
        .regex(/^[a-z0-9_-]{4,60}$/i)
        .optional(),
    })
    .optional(),
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
