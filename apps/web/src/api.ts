import type {
  AgentRequest,
  ApprovalRequest,
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
  Policy,
  Role,
  Run,
  Task,
  Tool,
  TraceEvent,
} from "@orq/shared";

/** Cliente HTTP. Vite proxea /api al servidor, así que las rutas son relativas. */

/** Codifica cada segmento por separado: las barras son parte de la ruta. */
const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

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
  /** Crea un proyecto vacío, ya con sus herramientas built-in registradas. */
  createCompany: (input: { name: string; mission: string; defaultModel: Company["defaultModel"] }) =>
    request<Company>("/companies", { method: "POST", body: JSON.stringify(input) }),
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
  publishFile: (companyId: string, path: string) =>
    request<{ ok: true; path: string }>(
      `/companies/${companyId}/exports-publicar/${encodePath(path)}`,
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
  ) =>
    request<{
      request: AgentRequest;
      aplicado: Record<string, unknown>;
      /** Cómo llegó la respuesta: a la bandeja del agente, o a la memoria de
       *  la empresa si su corrida ya había terminado. */
      entrega: "bandeja" | "memoria" | "descartada";
    }>(
      `/companies/${companyId}/requests/${id}`,
      { method: "POST", body: JSON.stringify({ decision, resolution, roleProposal }) },
    ),

  learnings: (companyId: string) => request<Learning[]>(`/companies/${companyId}/learnings`),
  addLearning: (companyId: string, topic: string, lesson: string) =>
    request<Learning>(`/companies/${companyId}/learnings`, {
      method: "POST",
      body: JSON.stringify({ topic, lesson }),
    }),
  deleteLearning: (companyId: string, id: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/learnings/${id}`, { method: "DELETE" }),
  mcpHealth: (companyId: string) =>
    request<McpServerHealth[]>(`/companies/${companyId}/mcp/health`),
  reconnectMcp: (companyId: string, serverId: string) =>
    request<{ ok: boolean }>(`/companies/${companyId}/mcp/${serverId}/reconnect`, {
      method: "POST",
    }),
  probeTool: (companyId: string, toolName: string, args: Record<string, unknown>) =>
    request<{ ok: boolean; content: string }>(`/companies/${companyId}/mcp/probe`, {
      method: "POST",
      body: JSON.stringify({ toolName, args }),
    }),

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
};
