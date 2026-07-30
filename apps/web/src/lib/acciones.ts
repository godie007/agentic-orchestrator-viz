/**
 * Cómo se cuenta en castellano lo que hace un agente.
 *
 * Vive acá y no en una vista porque lo usan las dos: la traza en vivo y el
 * detalle de una tarjeta del tablero. Duplicar el diccionario garantizaba que
 * se desincronizaran.
 */


/**
 * Qué está haciendo un agente cuando usa una herramienta, dicho como se lo
 * contarías a alguien.
 *
 * El nombre técnico —`read_artifact`, `mcp__obsidian__vault_read`— dice cómo
 * está implementado, no qué está pasando: para leer el panel había que traducir
 * cada renglón mentalmente. El nombre no se pierde, queda en el tooltip de la
 * fila para cuando lo que querés es depurar.
 *
 * En presente, que es el tiempo del panel: "lo que viene pasando".
 */
export const ACCION_HUMANA: Record<string, string> = {
  send_message: "escribe un mensaje",
  reply: "responde",
  broadcast: "avisa a toda la empresa",
  escalate: "escala a su superior",
  assign_task: "reparte una tarea",
  update_task: "mueve una tarea de etapa",
  list_my_tasks: "mira qué tiene pendiente",
  request_approval: "pide autorización",
  write_artifact: "escribe un entregable",
  edit_artifact: "corrige un entregable",
  read_artifact: "lee un entregable",
  list_artifacts: "mira qué hay hecho",
  check_activity: "revisa lo que hizo el equipo",
  record_lesson: "guarda un aprendizaje",
  request_new_role: "propone sumar a alguien al equipo",
  request_context: "pide un dato del negocio",
  request_tool_access: "pide acceso a una herramienta",
  export_docx: "arma el documento Word",
  export_pdf: "arma el PDF",
  list_output: "mira los archivos generados",
  write_output_file: "guarda un archivo",
  delete_files: "borra archivos",
  delete_file: "borra un archivo",
  delete_media: "borra material de apoyo",
  web_search: "busca en la web",
  fetch_url: "abre una página",
};

/** Qué hace un verbo de MCP, por su raíz. El orden importa: gana el primero. */
const VERBOS_MCP: Array<[RegExp, string]> = [
  [/(^|_)(read|get|open|cat)(_|$)/, "lee"],
  [/(^|_)(search|query|find|grep)(_|$)/, "busca"],
  [/(^|_)(list|tree|map)(_|$)/, "mira qué hay"],
  [/(^|_)(write|create|append|patch|edit|put)(_|$)/, "escribe"],
  [/(^|_)(delete|remove|rm)(_|$)/, "borra"],
  [/(^|_)(move|rename)(_|$)/, "mueve algo"],
];

/**
 * Traduce el nombre de una herramienta a lo que el agente está haciendo. Las
 * de MCP no se pueden enumerar —dependen del servidor que conectes— así que se
 * deducen del verbo y se nombra el servidor, que es lo que ubica la acción:
 * "lee en obsidian" dice más que `mcp__obsidian__vault_read`.
 */
export function accionDeHerramienta(toolName: string): string {
  const conocida = ACCION_HUMANA[toolName];
  if (conocida) return conocida;

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (mcp) {
    const [, servidor = "", accion = ""] = mcp;
    const verbo = VERBOS_MCP.find(([patron]) => patron.test(accion))?.[1] ?? "usa";
    return `${verbo} en ${servidor}`;
  }
  // Una herramienta que no conocemos: al menos legible, sin guiones bajos.
  return toolName.replace(/_/g, " ");
}

/**
 * Cuánto tardó, sólo cuando tardó.
 *
 * Los milisegundos de cada llamada eran ruido en todas las filas para avisar en
 * una: casi todas las de coordinación son instantáneas. Lo que importa es la
 * que se colgó, y esa se lee mejor en segundos.
 */
export function demora(ms: number): string | null {
  if (ms < 1500) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

