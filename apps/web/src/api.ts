import type {
  AgentRequest,
  ApprovalRequest,
  ArticuloDeTienda,
  RoleProposal,
  Artifact,
  Company,
  CreateRunInput,
  Department,
  LedgerEntry,
  Learning,
  McpServer,
  McpServerHealth,
  Message,
  ModelInfo,
  ModelTier,
  PlantillaEquipo,
  Policy,
  ProviderId,
  Role,
  Repositorio,
  Run,
  SesionCodigo,
  Servicio,
  Task,
  Tool,
  TraceEvent,
} from "@orq/shared";

/** Cliente HTTP. Vite proxea /api al servidor, así que las rutas son relativas. */

/** Codifica cada segmento por separado: las barras son parte de la ruta. */
const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/** Un artículo del catálogo con su estado en esta empresa. */
export interface ArticuloDeTiendaConEstado extends ArticuloDeTienda {
  instalado: boolean;
  /** Variables obligatorias sin valor en el entorno del servidor. */
  envFaltantes: string[];
}

/** Lo que devuelve instalar: el feedback "conectado, N herramientas". */
export interface ResultadoInstalacionMcp {
  instalados: string[];
  yaExistian: string[];
  estado: string[];
  toolCount: number;
  toolNames: string[];
  herramientasOtorgadas: string[];
  avisos: string[];
}

/** Lo que devuelve generar un equipo desde una plantilla. */
export interface EquipoGenerado {
  roles: Role[];
  herramientasFaltantes: string[];
  mcpSugeridos: string[];
}

export interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  esMultimedia: boolean;
  /** Lo escribió un agente. Los que no, los trajiste vos. */
  generadoPorAgente: boolean;
}

export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: Array<TreeFolder | TreeFile>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // El `content-type: application/json` solo va cuando hay cuerpo. Fastify
  // rechaza con 400 un body vacío si el header dice que viene JSON, y eso
  // rompía todos los DELETE.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers["content-type"] = "application/json";

  const response = await fetch(`/api${path}`, { ...init, headers });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export interface ProviderStatus {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  modelCount: number;
  tiers: Record<
    ModelTier,
    { model: ModelInfo; blendedPriceUsdPerMTok: number; reason: string } | null
  >;
}

/** Un repo cargado, con su sesión abierta si la hay. */
export type EstadoDeServicio = "detenido" | "preparando" | "arrancando" | "listo" | "fallo";

export interface EstadoVivoDeServicio {
  servicioId: string;
  estado: EstadoDeServicio;
  puerto: number | null;
  url: string | null;
  desde: number | null;
  detalle: string | null;
  redirecciones: Array<{ clave: string; antes: string; despues: string }>;
  externas: Array<{ clave: string; valor: string }>;
  variables: string[];
  comando: string | null;
}

/** Un servicio con su estado. Los `.env` vienen descritos, nunca con sus valores. */
export interface ServicioConEstado extends Omit<Servicio, "archivosEntorno"> {
  archivosEntorno: Array<{ ruta: string; existe: boolean; variables: number }>;
  /** ¿Tiene sus dependencias en la sesión? `null`: todavía no hay sesión. */
  preparado: boolean | null;
  vivo: EstadoVivoDeServicio;
}

export interface RespuestaDeServicio {
  estado: number;
  cabeceras: Record<string, string>;
  cuerpo: string;
  ms: number;
}

/** El estado git de la sesión para el panel de control de versiones. Ver `apps/server/src/scm.ts`. */
export interface EstadoScm {
  rama: string | null;
  cabeza: string | null;
  adelante: number;
  preparados: Array<{ ruta: string; estado: string }>;
  cambios: Array<{ ruta: string; estado: string }>;
  conflictos: string[];
  stashes: Array<{ ref: string; mensaje: string; at: number }>;
  ramas: Array<{ nombre: string; sha: string; at: number; asunto: string; actual: boolean; ocupada: boolean }>;
  puedeModificarUltimo: boolean;
  /** La rama base en el repo de la persona: lo que la sesión lleva sin integrar y lo que avanzó allá. */
  base: { rama: string; ref: string | null; adelante: number; atras: number };
  ramasDelRepo: Array<{ nombre: string; ref: string; grupo: "repo" | "remoto"; sha: string; at: number; asunto: string; local: boolean }>;
}

export interface CommitDelHistorial {
  sha: string;
  corto: string;
  autor: string;
  at: number;
  asunto: string;
  refs: string[];
  fusion: boolean;
  sinIntegrar: boolean;
}

export interface RepoConSesion {
  repo: Repositorio;
  sesion: SesionCodigo | null;
  /** Dónde vive el clon gestionado, para mostrarlo. */
  clon: string;
}

export interface EstadoDeSesion {
  archivos: Array<{ estado: string; ruta: string }>;
  sensibles: string[];
  commits: number;
}

export interface CheckpointDeSesion {
  sha: string;
  autor: string;
  at: number;
  mensaje: string;
}

/** Lo que necesita el explorador del IDE: árbol, cambios y quién escribe. */
export interface ArbolDeRepo {
  sesion: SesionCodigo | null;
  archivos: string[];
  cambios: Array<{ estado: string; ruta: string }>;
  sensibles: string[];
  commits: number;
  /** Hay cambios sin commitear en el worktree (los de la persona). */
  pendientes: boolean;
  /** Rol que tiene el arriendo de escritura ahora, o `null`. */
  escritor: string | null;
  corridaViva: boolean;
}

export interface ArchivoDeRepo {
  ruta: string;
  contenido: string | null;
  binario: boolean;
  bytes: number;
  hash: string | null;
}

export interface ResultadoDeComando {
  codigo: number | null;
  salida: string;
  duracionMs: number;
  cortadoPorTiempo: boolean;
  aislamiento: "sandbox" | "sin-aislamiento";
  log: string | null;
  error?: string;
}

export type ComandosEditables = Partial<
  Pick<Repositorio["comandos"], "permitidos" | "preparar" | "test" | "verificar" | "sinAislamiento">
>;

export interface CompanyBundle {
  company: Company;
  departments: Department[];
  roles: Role[];
  policies: Policy[];
  mcpServers: McpServer[];
  tools: Tool[];
}

/** Lo que hace falta para elegir un proyecto sin tener que abrirlo. */
export interface ResumenProyecto {
  id: string;
  name: string;
  mission: string;
  updatedAt: number;
  roles: number;
  departamentos: number;
  corridas: number;
  entregables: number;
  misiones: number;
  ultimaCorridaAt: number | null;
  corridaViva: boolean;
  disco: { archivos: number; bytes: number };
}

/** Filas sueltas, por tabla. Sólo vienen las que tienen alguna. */
export interface Residuos {
  porEmpresa: Record<string, number>;
  porCorrida: Record<string, number>;
  filas: number;
}

/** Una carpeta de salida que ya no tiene empresa detrás. */
export interface CarpetaResidual {
  carpeta: string;
  archivos: number;
  bytes: number;
  modifiedAt: number;
}

export interface Mantenimiento {
  base: { bytes: number; residuos: Residuos };
  carpetas: CarpetaResidual[];
  corridasTerminadas: number;
}

export interface ResultadoPurga {
  corridas: number;
  residuos: Residuos | null;
  carpetas: number;
  rechazadas: Array<{ carpeta: string; motivo: string }>;
  bytesEnDisco: number;
  base: { antes: number; despues: number };
}

export interface RunBundle {
  run: Run;
  messages: Message[];
  tasks: Task[];
  artifacts: Artifact[];
  approvals: ApprovalRequest[];
  ledger: LedgerEntry[];
  live: boolean;
}

export const api = {
  providers: () => request<ProviderStatus[]>("/providers"),
  models: (refresh = false) => request<ModelInfo[]>(`/models?refresh=${refresh}`),

  companies: () => request<Company[]>("/companies"),
  /** Una línea por proyecto, con sus cuentas y su peso en disco. */
  resumenProyectos: () => request<ResumenProyecto[]>("/companies/resumen"),
  company: (id: string) => request<CompanyBundle>(`/companies/${id}`),
  /** Plantillas de equipo disponibles, más el proveedor con el que se armarían. */
  plantillas: () =>
    request<{ plantillas: PlantillaEquipo[]; proveedorPreferido: ProviderId | null }>(
      "/plantillas",
    ),
  /**
   * Crea un proyecto, ya con sus herramientas built-in registradas. Con
   * `plantillaId`, nace además con el equipo de la plantilla; la respuesta
   * trae `equipo` con las herramientas faltantes y los MCP sugeridos.
   */
  createCompany: (input: {
    name: string;
    mission: string;
    defaultModel: Company["defaultModel"];
    plantillaId?: string;
  }) =>
    request<Company & { equipo?: EquipoGenerado }>("/companies", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  blueprint: (id: string) => request<unknown>(`/companies/${id}/blueprint`),
  importCompany: (blueprint: unknown) =>
    request<{ companyId: string }>("/companies/import", {
      method: "POST",
      body: JSON.stringify(blueprint),
    }),

  createRole: (companyId: string, role: Omit<Role, "id">) =>
    request<Role>(`/companies/${companyId}/roles`, {
      method: "POST",
      body: JSON.stringify(role),
    }),
  /** `cascaded` = solicitudes del agente que se borraron junto con él. */
  deleteRole: (companyId: string, roleId: string) =>
    request<{ ok: boolean; cascaded: number }>(`/companies/${companyId}/roles/${roleId}`, {
      method: "DELETE",
    }),
  createDepartment: (companyId: string, department: Omit<Department, "id">) =>
    request<Department>(`/companies/${companyId}/departments`, {
      method: "POST",
      body: JSON.stringify(department),
    }),
  deleteDepartment: (companyId: string, departmentId: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/departments/${departmentId}`, {
      method: "DELETE",
    }),
  updateRole: (companyId: string, role: Role) =>
    request<Role>(`/companies/${companyId}/roles/${role.id}`, {
      method: "PATCH",
      body: JSON.stringify(role),
    }),
  updateCompany: (company: Company) =>
    request<Company>(`/companies/${company.id}`, {
      method: "PATCH",
      body: JSON.stringify(company),
    }),
  /** Renombra el proyecto y muda su carpeta y su vault. 409 con una corrida en curso. */
  renombrarEmpresa: (companyId: string, nombre: string) =>
    request<{ company: Company; carpeta: string | null }>(`/companies/${companyId}/renombrar`, {
      method: "POST",
      body: JSON.stringify({ nombre }),
    }),
  /**
   * Borra la empresa entera: base, conexiones MCP y directorio de salida.
   *
   * Devuelve qué se llevó del disco. Responde 409 si hay una corrida en curso.
   */
  deleteCompany: (companyId: string) =>
    request<{ ok: true; archivos: number; bytes: number }>(`/companies/${companyId}`, {
      method: "DELETE",
    }),

  tools: (companyId: string) => request<Tool[]>(`/companies/${companyId}/tools`),

  /** Árbol del directorio de salida: lo que produjeron las habilidades. */
  exportTree: (companyId: string) =>
    request<TreeFolder>(`/companies/${companyId}/exports`),
  createFolder: (companyId: string, path: string) =>
    request<{ path: string }>(`/companies/${companyId}/exports/folders`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /** Borra cualquier archivo del directorio de salida. No hay papelera. */
  deleteFile: (companyId: string, path: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/exports/${encodePath(path)}`, {
      method: "DELETE",
    }),
  /**
   * Publica un archivo: lo mueve a `publicado/`.
   *
   * Es la decisión que la misión no puede tomar sola. Un agente produce y avisa;
   * esto lo aprieta una persona después de mirarlo.
   */
  publishFile: (companyId: string, path: string, reemplazar = false) =>
    request<{ ok: true; path: string }>(
      `/companies/${companyId}/exports-publicar/${encodePath(path)}${reemplazar ? "?reemplazar=1" : ""}`,
      { method: "POST" },
    ),
  exportUrl: (companyId: string, path: string) =>
    `/api/companies/${companyId}/exports/${encodePath(path)}`,
  /** Misma URL, servida para mostrarse en pantalla en vez de descargarse. */
  exportInlineUrl: (companyId: string, path: string) =>
    `/api/companies/${companyId}/exports/${encodePath(path)}?inline`,
  exportPreview: (companyId: string, path: string) =>
    request<{
      kind: "pdf" | "image" | "video" | "audio" | "text" | "page" | "none";
      text?: string;
      motivo?: string;
      sizeBytes: number;
    }>(`/companies/${companyId}/exports-preview/${encodePath(path)}`),

  requests: (companyId: string) => request<AgentRequest[]>(`/companies/${companyId}/requests`),
  resolveRequest: (
    companyId: string,
    id: string,
    decision: "approve" | "reject",
    resolution: string,
    roleProposal: RoleProposal | null = null,
    comando: { alcance: "siempre" | "una-vez"; prefijo?: string[] } | null = null,
  ) =>
    request<{
      request: AgentRequest;
      aplicado: Record<string, unknown>;
      /** Cómo llegó la respuesta: a la bandeja del agente, o a la memoria de
       *  la empresa si su corrida ya había terminado. */
      entrega: "bandeja" | "memoria" | "descartada";
    }>(
      `/companies/${companyId}/requests/${id}`,
      { method: "POST", body: JSON.stringify({ decision, resolution, roleProposal, comando }) },
    ),

  learnings: (companyId: string) => request<Learning[]>(`/companies/${companyId}/learnings`),
  addLearning: (companyId: string, topic: string, lesson: string) =>
    request<Learning>(`/companies/${companyId}/learnings`, {
      method: "POST",
      body: JSON.stringify({ topic, lesson }),
    }),
  updateLearning: (
    companyId: string,
    id: string,
    patch: {
      topic?: string;
      lesson?: string;
      estado?: "activa" | "cuestionada" | "refutada";
      motivoDeRefutacion?: string;
    },
  ) =>
    request<Learning>(`/companies/${companyId}/learnings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteLearning: (companyId: string, id: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/learnings/${id}`, { method: "DELETE" }),
  mcpHealth: (companyId: string) =>
    request<McpServerHealth[]>(`/companies/${companyId}/mcp/health`),
  reconnectMcp: (companyId: string, serverId: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/mcp/${serverId}/reconnect`, {
      method: "POST",
    }),
  /** Alta de un servidor MCP. El id lo pone el servidor. */
  crearMcpServer: (companyId: string, server: Omit<McpServer, "id" | "companyId">) =>
    request<McpServer>(`/companies/${companyId}/mcp-servers`, {
      method: "POST",
      body: JSON.stringify(server),
    }),
  actualizarMcpServer: (companyId: string, id: string, cambios: Partial<McpServer>) =>
    request<McpServer>(`/companies/${companyId}/mcp-servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(cambios),
    }),
  borrarMcpServer: (companyId: string, id: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/mcp-servers/${id}`, { method: "DELETE" }),
  /** Catálogo de la tienda, con el flag `instalado` para esta empresa. */
  tiendaMcp: (companyId: string) =>
    request<ArticuloDeTiendaConEstado[]>(`/tienda-mcp?companyId=${companyId}`),
  /** Instala un artículo: alta + handshake + descubrimiento, en una llamada. */
  instalarDeTienda: (companyId: string, articuloId: string) =>
    request<ResultadoInstalacionMcp>(`/companies/${companyId}/tienda-mcp/${articuloId}`, {
      method: "POST",
    }),
  probeTool: (companyId: string, toolName: string, args: Record<string, unknown>) =>
    request<{ ok: boolean; content: string }>(`/companies/${companyId}/mcp/probe`, {
      method: "POST",
      body: JSON.stringify({ toolName, args }),
    }),

  /** El pulso del proyecto para el shell: corrida actual, ciclo y última señal. */
  progreso: (companyId: string) =>
    request<{
      run: Run | null;
      viva: boolean;
      progreso: { eventos: number; acciones: number; ultimaSenalAt: number | null } | null;
    }>(`/companies/${companyId}/progreso`),

  runs: (companyId?: string) =>
    request<Run[]>(`/runs${companyId ? `?companyId=${companyId}` : ""}`),
  run: (id: string) => request<RunBundle>(`/runs/${id}`),
  runEvents: (id: string) => request<TraceEvent[]>(`/runs/${id}/events`),
  /** Borra una corrida y su rastro. Los entregables se conservan. */
  deleteRun: (id: string) => request<{ ok: boolean }>(`/runs/${id}`, { method: "DELETE" }),
  limpiarCorridas: (companyId: string) =>
    request<{ borradas: number }>(`/companies/${companyId}/runs/terminadas`, { method: "DELETE" }),
  /** Lo mismo, pero de todas las empresas. */
  limpiarCorridasTodas: () =>
    request<{ borradas: number }>("/runs/terminadas", { method: "DELETE" }),

  /** Vacía la salida de una empresa conservando lo que subiste vos. */
  vaciarSalida: (companyId: string) =>
    request<{ borrados: number; conservados: number; bytes: number }>(
      `/companies/${companyId}/exports-vaciar`,
      { method: "POST" },
    ),

  /** Qué hay para limpiar, sin borrar nada. */
  mantenimiento: () => request<Mantenimiento>("/mantenimiento"),
  purgar: (opciones: {
    residuos?: boolean;
    carpetas?: string[];
    corridas?: boolean;
    compactar?: boolean;
  }) =>
    request<ResultadoPurga>("/mantenimiento/purgar", {
      method: "POST",
      body: JSON.stringify(opciones),
    }),
  createRun: (input: CreateRunInput) =>
    request<Run>("/runs", { method: "POST", body: JSON.stringify(input) }),
  tick: (id: string) =>
    request<{ advanced: boolean; reason: string }>(`/runs/${id}/tick`, { method: "POST" }),
  resume: (id: string) => request<unknown>(`/runs/${id}/resume`, { method: "POST" }),
  pause: (id: string) => request<unknown>(`/runs/${id}/pause`, { method: "POST" }),
  stop: (id: string) => request<unknown>(`/runs/${id}/stop`, { method: "POST" }),
  inject: (id: string, toRoleId: string, subject: string, body: string) =>
    request<unknown>(`/runs/${id}/inject`, {
      method: "POST",
      body: JSON.stringify({ toRoleId, subject, body }),
    }),
  resolveApproval: (
    runId: string,
    approvalId: string,
    decision: "grant" | "deny",
    resolution: string,
  ) =>
    request<unknown>(`/runs/${runId}/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify({ decision, resolution }),
    }),

  // --- Código ----------------------------------------------------------------

  repos: (companyId: string) => request<RepoConSesion[]>(`/companies/${companyId}/repos`),
  cargarRepo: (
    companyId: string,
    carga: {
      nombre?: string;
      origen: { tipo: "local"; ruta: string } | { tipo: "git"; url: string };
      ramaBase?: string;
      incluirCambiosSinCommitear?: boolean;
    },
  ) =>
    request<{ repo: Repositorio; sugeridos: ComandosEditables; avisos: string[] }>(
      `/companies/${companyId}/repos`,
      { method: "POST", body: JSON.stringify(carga) },
    ),
  actualizarComandos: (repoId: string, comandos: ComandosEditables) =>
    request<Repositorio>(`/repos/${repoId}/comandos`, { method: "PATCH", body: JSON.stringify(comandos) }),
  renombrarRepo: (repoId: string, nombre: string) =>
    request<Repositorio>(`/repos/${repoId}/renombrar`, { method: "POST", body: JSON.stringify({ nombre }) }),
  eliminarRepo: (repoId: string) =>
    request<{ ok: true; respaldo: string | null }>(`/repos/${repoId}`, { method: "DELETE" }),
  abrirSesion: (repoId: string) => request<SesionCodigo>(`/repos/${repoId}/sesion`, { method: "POST" }),
  sesion: (id: string) =>
    request<{ sesion: SesionCodigo; estado: EstadoDeSesion | null; log: CheckpointDeSesion[] }>(`/sesiones/${id}`),
  diffDeSesion: (id: string, ruta?: string) =>
    request<{ diff: string }>(`/sesiones/${id}/diff${ruta ? `?ruta=${encodeURIComponent(ruta)}` : ""}`),
  patchUrl: (id: string) => `/api/sesiones/${id}/patch`,
  integrarSesion: (id: string) =>
    request<
      | { ok: true; modo: "fast-forward" | "rama" | "copia"; detalle: string }
      | { ok: false; motivo: string; conflictos?: string[] }
    >(`/sesiones/${id}/integrar`, { method: "POST" }),
  descartarSesion: (id: string) => request<{ ok: true }>(`/sesiones/${id}/descartar`, { method: "POST" }),

  // --- IDE -------------------------------------------------------------------

  arbolDeRepo: (repoId: string) => request<ArbolDeRepo>(`/repos/${repoId}/archivos`),
  archivo: (repoId: string, ruta: string, ref: "actual" | "base" = "actual") =>
    request<ArchivoDeRepo>(`/repos/${repoId}/archivo?ruta=${encodeURIComponent(ruta)}${ref === "base" ? "&ref=base" : ""}`),
  guardarArchivo: (repoId: string, ruta: string, contenido: string, hash: string | null | undefined) =>
    request<{ ok: true; hash: string; ruta: string; sesionId: string }>(`/repos/${repoId}/archivo`, {
      method: "PUT",
      body: JSON.stringify({ ruta, contenido, ...(hash !== undefined ? { hash } : {}) }),
    }),
  borrarArchivo: (repoId: string, ruta: string) =>
    request<{ ok: true }>(`/repos/${repoId}/archivo?ruta=${encodeURIComponent(ruta)}`, { method: "DELETE" }),
  confirmarSesion: (sesionId: string, mensaje: string) =>
    request<{ sha: string | null }>(`/sesiones/${sesionId}/confirmar`, {
      method: "POST",
      body: JSON.stringify({ mensaje }),
    }),
  ejecutarEnRepo: (repoId: string, comando: string, carpeta = "") =>
    request<ResultadoDeComando>(`/repos/${repoId}/ejecutar`, {
      method: "POST",
      body: JSON.stringify({ comando, ...(carpeta ? { carpeta } : {}) }),
    }),

  // Control de versiones de la sesión: stage, commit, stash, ramas.
  scm: (repoId: string) =>
    request<{ sesion: SesionCodigo | null; estado: EstadoScm | null; escritor?: string | null }>(`/repos/${repoId}/scm`),
  scmHistorial: (sesionId: string, desde = 0, cantidad = 60) =>
    request<{ commits: CommitDelHistorial[]; hayMas: boolean }>(`/sesiones/${sesionId}/scm/historial?desde=${desde}&cantidad=${cantidad}`),
  scmCommit: (sesionId: string, sha: string) =>
    request<{ archivos: Array<{ ruta: string; estado: string }>; padre: string | null }>(`/sesiones/${sesionId}/scm/commit/${sha}`),
  scmSincronizar: (sesionId: string) =>
    request<{ ok: boolean; detalle: string }>(`/sesiones/${sesionId}/scm/sincronizar`, { method: "POST" }),
  scmOperar: <T = { ok: true }>(sesionId: string, operacion: string, cuerpo: Record<string, unknown> = {}) =>
    request<T>(`/sesiones/${sesionId}/scm/${operacion}`, { method: "POST", body: JSON.stringify(cuerpo) }),

  // Servicios: las partes de un monorepo levantadas para la vista previa.
  servicios: (repoId: string) => request<{ servicios: ServicioConEstado[] }>(`/repos/${repoId}/servicios`),
  detectarServicios: (repoId: string) =>
    request<Repositorio>(`/repos/${repoId}/servicios/detectar`, { method: "POST" }),
  guardarServicio: (repoId: string, servicio: Servicio) =>
    request<Repositorio>(`/repos/${repoId}/servicios/${encodeURIComponent(servicio.id)}`, {
      method: "PUT",
      body: JSON.stringify(servicio),
    }),
  borrarServicio: (repoId: string, servicioId: string) =>
    request<Repositorio>(`/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}`, { method: "DELETE" }),
  prepararServicio: (repoId: string, servicioId: string) =>
    request<{ ok: true }>(`/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}/preparar`, { method: "POST" }),
  arrancarServicio: (repoId: string, servicioId: string) =>
    request<EstadoVivoDeServicio>(`/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}/arrancar`, { method: "POST" }),
  detenerServicio: (repoId: string, servicioId: string) =>
    request<EstadoVivoDeServicio>(`/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}/detener`, { method: "POST" }),
  logsDeServicio: (repoId: string, servicioId: string, desde: number) =>
    request<{ lineas: string[]; siguiente: number; vivo: EstadoVivoDeServicio }>(
      `/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}/logs?desde=${desde}`,
    ),
  probarServicio: (
    repoId: string,
    servicioId: string,
    pedido: { metodo: string; ruta: string; cuerpo?: string; cabeceras?: Record<string, string> },
  ) =>
    request<RespuestaDeServicio>(`/repos/${repoId}/servicios/${encodeURIComponent(servicioId)}/probar`, {
      method: "POST",
      body: JSON.stringify(pedido),
    }),
  buscarEnRepo: (repoId: string, q: string, opciones: { mayusculas?: boolean; regex?: boolean } = {}) =>
    request<{ resultados: Array<{ ruta: string; linea: number; texto: string }>; cortado: boolean }>(
      `/repos/${repoId}/buscar?q=${encodeURIComponent(q)}${opciones.mayusculas ? "&mayusculas=1" : ""}${opciones.regex ? "&regex=1" : ""}`,
    ),

  // --- Chat de IA y vista previa ---------------------------------------------

  crearMejorador: (companyId: string) => request<Role>(`/companies/${companyId}/mejorador`, { method: "POST" }),
  pedidosDeRepo: (repoId: string, conversacion?: string) =>
    request<Run[]>(`/repos/${repoId}/pedidos${conversacion ? `?conversacion=${encodeURIComponent(conversacion)}` : ""}`),
  conversaciones: (repoId: string) =>
    request<Array<{ id: string; titulo: string; pedidos: number; desde: number; ultima: number }>>(`/repos/${repoId}/conversaciones`),
  archivosDeCommit: (sesionId: string, sha: string) =>
    request<{ archivos: Array<{ estado: string; ruta: string }> }>(`/sesiones/${sesionId}/commit/${sha}`),
  revertirCheckpoints: (sesionId: string, shas: string[]) =>
    request<{ ok: true; revertidos: number }>(`/sesiones/${sesionId}/revertir`, {
      method: "POST",
      body: JSON.stringify({ shas }),
    }),
  archivoEnRef: (repoId: string, ruta: string, ref: string) =>
    request<ArchivoDeRepo>(`/repos/${repoId}/archivo?ruta=${encodeURIComponent(ruta)}&ref=${encodeURIComponent(ref)}`),
  vistaUrl: (repoId: string, ruta: string) => `/api/repos/${repoId}/vista/${encodePath(ruta)}`,
};
