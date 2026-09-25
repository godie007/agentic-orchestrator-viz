import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

/**
 * El mapa de un repo: qué archivos importan y qué define cada uno.
 *
 * Es la idea del *repo map* de Aider sin sus dependencias: en vez de un árbol
 * sintáctico por lenguaje, expresiones regulares por lenguaje para las
 * definiciones de primer nivel, y en vez de PageRank sobre el grafo de
 * referencias, **cuántos otros archivos nombran cada símbolo**. Para decidir
 * por dónde empezar a leer alcanza: lo que usa medio repo aparece arriba y el
 * test de un helper aparece abajo.
 *
 * El mapa entra en un turno y **se reenvía en cada vuelta**, así que se acota
 * por tamaño, no por cantidad de archivos: el presupuesto es de caracteres y lo
 * que no entra se nombra como "y N más en carpeta/", para que el agente sepa
 * que existe y lo busque con `buscar_archivos`.
 *
 * No se persiste nada: el índice se arma al pedirlo, con caché por archivo
 * (ruta + mtime + tamaño). Así lo que editó el CLI con su propio `Edit` —que
 * el org no ve pasar— invalida su entrada solo, sin que nadie tenga que avisar.
 */

export type TipoSimbolo = "clase" | "función" | "método" | "tipo" | "constante";

export interface Simbolo {
  nombre: string;
  tipo: TipoSimbolo;
  linea: number;
}

interface Regla {
  tipo: TipoSimbolo;
  re: RegExp;
}

const JS: Regla[] = [
  { tipo: "clase", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { tipo: "función", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { tipo: "tipo", re: /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  {
    tipo: "función",
    re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  },
  { tipo: "constante", re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  {
    tipo: "método",
    re: /^ {2}(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|constructor\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{;]+)?\{\s*$/,
  },
];

const REGLAS: Record<string, Regla[]> = {
  ".ts": JS,
  ".tsx": JS,
  ".mts": JS,
  ".cts": JS,
  ".js": JS,
  ".jsx": JS,
  ".mjs": JS,
  ".cjs": JS,
  ".vue": JS,
  ".svelte": JS,
  ".py": [
    { tipo: "clase", re: /^class\s+([A-Za-z_]\w*)/ },
    { tipo: "función", re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { tipo: "método", re: /^ {4}(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    { tipo: "constante", re: /^([A-Z][A-Z0-9_]{2,})\s*[:=]/ },
  ],
  ".go": [
    { tipo: "función", re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { tipo: "tipo", re: /^type\s+([A-Za-z_]\w*)/ },
  ],
  ".rs": [
    { tipo: "función", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/ },
    { tipo: "tipo", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/ },
  ],
  ".java": [
    { tipo: "clase", re: /^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/ },
    { tipo: "método", re: /^\s+(?:public|protected|private)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  ".kt": [
    { tipo: "clase", re: /^\s*(?:[a-z]+\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/ },
    { tipo: "función", re: /^\s*(?:[a-z]+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/ },
  ],
  ".cs": [
    { tipo: "clase", re: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/ },
    { tipo: "método", re: /^\s+(?:public|internal|protected|private)\s+(?:static\s+|virtual\s+|override\s+|async\s+|abstract\s+)*[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/ },
  ],
  ".php": [
    { tipo: "clase", re: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/ },
    { tipo: "función", re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/ },
  ],
  ".rb": [
    { tipo: "clase", re: /^\s*(?:class|module)\s+([A-Z]\w*)/ },
    { tipo: "método", re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/ },
  ],
};
REGLAS[".scala"] = REGLAS[".kt"]!;
REGLAS[".swift"] = [
  { tipo: "clase", re: /^\s*(?:public\s+|private\s+|internal\s+|final\s+|open\s+)*(?:class|struct|protocol|enum|extension)\s+([A-Za-z_]\w*)/ },
  { tipo: "función", re: /^\s*(?:public\s+|private\s+|internal\s+|static\s+|override\s+|@\w+\s+)*func\s+([A-Za-z_]\w*)/ },
];

/** ¿Tiene reglas este archivo? Lo demás se lista, pero no se indexa. */
export function esCodigoIndexable(ruta: string): boolean {
  return extname(ruta).toLowerCase() in REGLAS;
}

/** Definiciones de primer nivel —y métodos de clase— de un archivo. */
export function extraerSimbolos(ruta: string, contenido: string): Simbolo[] {
  const reglas = REGLAS[extname(ruta).toLowerCase()];
  if (!reglas) return [];
  const simbolos: Simbolo[] = [];
  const vistos = new Set<string>();
  const lineas = contenido.split("\n");
  for (let i = 0; i < lineas.length && simbolos.length < 200; i++) {
    const linea = lineas[i]!;
    if (linea.length > 400) continue;
    for (const regla of reglas) {
      const m = regla.re.exec(linea);
      if (!m?.[1]) continue;
      const clave = `${regla.tipo}:${m[1]}`;
      if (!vistos.has(clave)) {
        vistos.add(clave);
        simbolos.push({ nombre: m[1], tipo: regla.tipo, linea: i + 1 });
      }
      break;
    }
  }
  return simbolos;
}

/** Los identificadores que un archivo nombra: de acá salen las referencias. */
function identificadores(contenido: string): Set<string> {
  const ids = new Set<string>();
  for (const m of contenido.matchAll(/[A-Za-z_$][\w$]{2,}/g)) ids.add(m[0]);
  return ids;
}

interface EntradaIndice {
  mtimeMs: number;
  size: number;
  simbolos: Simbolo[];
  ids: Set<string>;
  lineas: number;
}

const TOPE_ARCHIVO = 256 * 1024;
const TOPE_ARCHIVOS_ANALIZADOS = 4_000;

/** Caché por worktree: ruta → entrada. Vive mientras vive el proceso. */
const cache = new Map<string, Map<string, EntradaIndice>>();

async function indexar(raiz: string, archivos: string[]): Promise<Map<string, EntradaIndice>> {
  const previo = cache.get(raiz) ?? new Map<string, EntradaIndice>();
  const nuevo = new Map<string, EntradaIndice>();
  const candidatos = archivos.filter(esCodigoIndexable).slice(0, TOPE_ARCHIVOS_ANALIZADOS);
  await Promise.all(
    candidatos.map(async (ruta) => {
      const absoluta = join(raiz, ruta);
      let info;
      try {
        info = await stat(absoluta);
      } catch {
        return;
      }
      if (!info.isFile() || info.size > TOPE_ARCHIVO) return;
      const anterior = previo.get(ruta);
      if (anterior && anterior.mtimeMs === info.mtimeMs && anterior.size === info.size) {
        nuevo.set(ruta, anterior);
        return;
      }
      let contenido: string;
      try {
        contenido = await readFile(absoluta, "utf8");
      } catch {
        return;
      }
      if (contenido.includes("\u0000")) return;
      nuevo.set(ruta, {
        mtimeMs: info.mtimeMs,
        size: info.size,
        simbolos: extraerSimbolos(ruta, contenido),
        ids: identificadores(contenido),
        lineas: contenido.split("\n").length,
      });
    }),
  );
  cache.set(raiz, nuevo);
  return nuevo;
}

export interface OpcionesMapa {
  /** Limita el mapa a una carpeta del repo. */
  carpeta?: string;
  /** Presupuesto en caracteres. El default entra holgado en un resultado acotado. */
  presupuesto?: number;
}

/**
 * Arma el mapa. Determinista: el mismo árbol da el mismo texto, así el memo de
 * lecturas lo reconoce y dos agentes ven lo mismo.
 */
export async function mapaDelCodigo(raiz: string, archivos: string[], opciones: OpcionesMapa = {}): Promise<string> {
  const presupuesto = opciones.presupuesto ?? 9_000;
  const prefijo = opciones.carpeta ? opciones.carpeta.replace(/^\.?\/*/, "").replace(/\/*$/, "/") : "";
  const enAlcance = prefijo ? archivos.filter((a) => a.startsWith(prefijo)) : archivos;
  if (enAlcance.length === 0) {
    return prefijo ? `No hay archivos bajo "${prefijo}".` : "El repo no tiene archivos todavía.";
  }

  const indice = await indexar(raiz, enAlcance);

  // Cuántos archivos nombran cada símbolo definido. Un nombre de tres letras
  // que define medio repo (`get`, `run`) no dice nada: se descuenta con el
  // largo, para que un `crearHerramientasDeCodigo` pese más que un `map`.
  const referencias = new Map<string, number>();
  const definidos = new Set<string>();
  for (const entrada of indice.values()) for (const s of entrada.simbolos) definidos.add(s.nombre);
  for (const entrada of indice.values()) {
    for (const id of entrada.ids) {
      if (definidos.has(id)) referencias.set(id, (referencias.get(id) ?? 0) + 1);
    }
  }
  const peso = (s: Simbolo) => Math.max(0, (referencias.get(s.nombre) ?? 1) - 1) * Math.min(1, s.nombre.length / 8);

  const puntaje = (ruta: string): number => {
    const entrada = indice.get(ruta);
    if (!entrada) return 0;
    const refs = entrada.simbolos.reduce((total, s) => total + peso(s), 0);
    const entrada_ = /(^|\/)(index|main|app|server|cli|__init__|mod|lib)\.\w+$/.test(ruta) ? 3 : 0;
    const test = /(\.|_|\/)(test|spec)s?[./]|__tests__\//.test(ruta) ? -2 : 0;
    return refs + entrada_ + test + Math.min(2, entrada.simbolos.length / 10);
  };

  // Resumen por carpeta: entra siempre, es lo que da la forma del repo.
  const porCarpeta = new Map<string, number>();
  for (const ruta of enAlcance) {
    const carpeta = ruta.includes("/") ? ruta.slice(0, ruta.lastIndexOf("/") + 1) : "./";
    porCarpeta.set(carpeta, (porCarpeta.get(carpeta) ?? 0) + 1);
  }
  const carpetas = [...porCarpeta].sort((a, b) => a[0].localeCompare(b[0]));
  const cabecera = [
    `${enAlcance.length} archivos${prefijo ? ` bajo ${prefijo}` : ""}, ${indice.size} indexados.`,
    "",
    "Carpetas:",
    ...carpetas.slice(0, 60).map(([c, n]) => `  ${c} (${n})`),
    ...(carpetas.length > 60 ? [`  … y ${carpetas.length - 60} carpetas más`] : []),
    "",
    "Archivos por importancia (símbolo:línea; los más referenciados primero):",
  ].join("\n");

  const ordenados = [...indice.keys()].sort((a, b) => puntaje(b) - puntaje(a) || a.localeCompare(b));
  const bloques: string[] = [];
  let usado = cabecera.length;
  const incluidos = new Set<string>();
  for (const ruta of ordenados) {
    const entrada = indice.get(ruta)!;
    const simbolos = [...entrada.simbolos]
      .sort((a, b) => peso(b) - peso(a) || a.linea - b.linea)
      .slice(0, 12)
      .sort((a, b) => a.linea - b.linea)
      .map((s) => `${marca(s.tipo)} ${s.nombre}:${s.linea}`);
    const resto = entrada.simbolos.length - simbolos.length;
    const bloque = `${ruta} (${entrada.lineas} líneas)\n  ${simbolos.join("  ") || "(sin definiciones de primer nivel)"}${
      resto > 0 ? `  … +${resto}` : ""
    }`;
    if (usado + bloque.length + 1 > presupuesto) break;
    bloques.push(bloque);
    incluidos.add(ruta);
    usado += bloque.length + 1;
  }

  const afuera = enAlcance.filter((ruta) => !incluidos.has(ruta));
  const pie =
    afuera.length > 0
      ? `\n\n… y ${afuera.length} archivos más que no entran en el mapa (no indexables o de menos peso). ` +
        `Buscalos con buscar_archivos o buscar_codigo, o pedí el mapa de una carpeta con "carpeta".`
      : "";
  return `${cabecera}\n${bloques.join("\n")}${pie}`;
}

function marca(tipo: TipoSimbolo): string {
  return { clase: "C", función: "ƒ", método: "m", tipo: "T", constante: "k" }[tipo];
}

/** Para los tests: el índice arranca vacío. */
export function olvidarIndice(raiz?: string): void {
  if (raiz) cache.delete(raiz);
  else cache.clear();
}
