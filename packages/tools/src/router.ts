import type { RegisteredTool } from "./types.js";

/**
 * Selección automática de herramientas.
 *
 * Con dos o tres MCP conectados el catálogo llega a decenas de tools. Pasarlas
 * todas en cada turno cuesta contexto y degrada la elección del modelo, así que
 * cuando se pasa del umbral se acota el set por relevancia contra la tarea.
 *
 * La decisión no queda oculta: se devuelve junto con las candidatas, las
 * expuestas y el motivo, y el motor lo emite como `tool.selection` para que la
 * UI pueda explicar por qué el agente tenía esa herramienta a mano.
 */

export interface ToolSelection {
  tools: RegisteredTool[];
  candidates: string[];
  exposed: string[];
  strategy: "all" | "ranked";
  reason: string;
}

export interface RouterOptions {
  /** Por debajo de esto se exponen todas: rankear no aporta y puede equivocarse. */
  threshold?: number;
  /**
   * Cuántas herramientas **opcionales** se exponen al rankear.
   *
   * No es el total: las que van siempre no compiten por estos lugares. Contarlas
   * dentro del límite dejaba 5 lugares para 20 herramientas, y un agente perdía
   * su propia habilidad de exportar frente a una tool de MCP cualquiera.
   */
  limit?: number;
}

/**
 * Lo que nunca se filtra.
 *
 * Las de **coordinación** porque sin ellas el agente no puede responder, delegar
 * ni escalar, y un turno sin salida es peor que uno con contexto de más.
 *
 * Las **habilidades** porque son pocas y se le asignan a un rol a propósito: son
 * lo que ese agente sabe producir. Rankearlas contra decenas de tools de MCP
 * hacía que un desarrollador al que se le pidió exportar un PDF no tuviera
 * `export_pdf` en su lista, y respondiera —con razón— que no la tenía.
 */
function isAlwaysExposed(tool: RegisteredTool): boolean {
  return tool.origin === "coordination" || tool.origin === "skill";
}

export function selectTools(
  available: RegisteredTool[],
  taskContext: string,
  options: RouterOptions = {},
): ToolSelection {
  const threshold = options.threshold ?? 25;
  const limit = options.limit ?? 12;
  const candidates = available.map((tool) => tool.name);

  if (available.length <= threshold) {
    return {
      tools: available,
      candidates,
      exposed: candidates,
      strategy: "all",
      reason: `${available.length} herramientas disponibles, por debajo del umbral de ${threshold}: se exponen todas.`,
    };
  }

  const always = available.filter(isAlwaysExposed);
  const optional = available.filter((tool) => !isAlwaysExposed(tool));
  const terms = tokenize(taskContext);

  const ranked = optional
    .map((tool) => ({ tool, score: relevance(tool, terms) }))
    .sort((a, b) => b.score - a.score);

  const picked = ranked.slice(0, limit);
  const tools = [...always, ...picked.map((entry) => entry.tool)];
  const withSignal = picked.filter((entry) => entry.score > 0).length;

  return {
    tools,
    candidates,
    exposed: tools.map((tool) => tool.name),
    strategy: "ranked",
    reason:
      `${available.length} herramientas superan el umbral de ${threshold}: se exponen ` +
      `${always.length} fijas (coordinación y habilidades) más las ${picked.length} más ` +
      `relevantes para la tarea (${withSignal} con coincidencia explícita).`,
  };
}

const STOP_WORDS = new Set([
  "para","con","que","los","las","del","por","una","uno","este","esta","como",
  "the","and","for","with","this","that","from","into","your","you","are",
]);

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    // Los tokens de 1-3 letras son ruido: coinciden con casi todo.
    if (raw.length > 3 && !STOP_WORDS.has(raw)) terms.add(raw);
  }
  return terms;
}

/**
 * Relevancia por solapamiento léxico entre la tarea y el nombre/descripción de
 * la herramienta. Es deliberadamente simple: sin embeddings no hay latencia ni
 * costo extra por turno, y el nombre de una tool suele contener la palabra que
 * la tarea usa. Cuando no alcanza, el usuario acota las tools del rol desde la
 * UI, que es una señal mucho más fuerte que cualquier ranking.
 */
function relevance(tool: RegisteredTool, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const nameTerms = tokenize(tool.name.replace(/^mcp__/, "").replace(/_/g, " "));
  const descTerms = tokenize(tool.description);

  let score = 0;
  for (const term of terms) {
    if (nameTerms.has(term)) score += 3; // el nombre es la señal más fuerte
    else if (descTerms.has(term)) score += 1;
  }
  return score;
}
