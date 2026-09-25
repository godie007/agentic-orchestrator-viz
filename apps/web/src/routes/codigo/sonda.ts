/**
 * Lo que la sonda de la vista previa (`proxy-vista.ts`) manda desde adentro de
 * la app: la consola y la red de la página, como las pestañas de DevTools.
 * Todo llega por `postMessage` desde otro origen, así que se valida la forma
 * antes de creerle.
 */

export interface RegistroDeConsola {
  clase: "consola";
  id: number;
  nivel: "log" | "info" | "warn" | "error" | "debug";
  texto: string;
  at: number;
  ruta: string;
  excepcion: boolean;
}

export interface RegistroDeRed {
  clase: "red";
  id: number;
  metodo: string;
  url: string;
  /** Descripción de lo enviado (un multipart dice qué archivos llevaba), nunca el contenido. */
  cuerpo: string | null;
  at: number;
  ruta: string;
  enCurso: boolean;
  estado: number | null;
  ms: number | null;
  tipoContenido: string | null;
  /** Cuerpo de la respuesta, sólo de las que fallaron: ahí está el mensaje del backend. */
  respuesta: string | null;
  error: string | null;
}

export type Registro = RegistroDeConsola | RegistroDeRed;

/** Una falla de la app corriendo que la persona manda al chat. */
export interface FallaDeVista {
  titulo: string;
  detalle: string;
  pagina: string;
}

const NIVELES = new Set(["log", "info", "warn", "error", "debug"]);
const texto = (v: unknown, tope: number): string | null => (typeof v === "string" ? v.slice(0, tope) : null);
const numero = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function consolaDesdeMensaje(d: Record<string, unknown>, id: number): RegistroDeConsola | null {
  if (typeof d.nivel !== "string" || !NIVELES.has(d.nivel)) return null;
  return {
    clase: "consola",
    id,
    nivel: d.nivel as RegistroDeConsola["nivel"],
    texto: texto(d.texto, 6_000) ?? "",
    at: numero(d.at) ?? Date.now(),
    ruta: texto(d.ruta, 500) ?? "",
    excepcion: d.excepcion === true,
  };
}

/** El inicio de un pedido crea el registro; el fin lo completa. */
export function aplicarRed(previos: Registro[], d: Record<string, unknown>): Registro[] {
  const idRed = numero(d.id);
  if (idRed === null) return previos;
  if (d.fase === "inicio") {
    const r: RegistroDeRed = {
      clase: "red",
      id: idRed,
      metodo: texto(d.metodo, 20) ?? "GET",
      url: texto(d.url, 2_000) ?? "",
      cuerpo: texto(d.cuerpo, 1_000),
      at: numero(d.at) ?? Date.now(),
      ruta: texto(d.ruta, 500) ?? "",
      enCurso: true,
      estado: null,
      ms: null,
      tipoContenido: null,
      respuesta: null,
      error: null,
    };
    return [...previos, r];
  }
  if (d.fase === "fin") {
    return previos.map((r) =>
      r.clase === "red" && r.id === idRed
        ? {
            ...r,
            enCurso: false,
            estado: numero(d.estado),
            ms: numero(d.ms),
            tipoContenido: texto(d.tipoContenido, 200),
            respuesta: texto(d.respuesta, 4_000),
            error: texto(d.error, 2_000),
          }
        : r,
    );
  }
  return previos;
}

export const falloLaRed = (r: RegistroDeRed) => !r.enCurso && (r.estado === 0 || r.estado === null || r.estado >= 400);
export const esError = (r: Registro) => (r.clase === "consola" ? r.nivel === "error" : falloLaRed(r));

/** La falla contada para el agente: lo que vio la persona, sin adornos. */
export function fallaDe(r: Registro): FallaDeVista {
  if (r.clase === "consola") {
    const primera = r.texto.split("\n")[0]!.slice(0, 160);
    return {
      titulo: `${r.excepcion ? "Excepción" : r.nivel === "error" ? "Error" : r.nivel === "warn" ? "Advertencia" : "Consola"}: ${primera}`,
      detalle: r.texto,
      pagina: r.ruta,
    };
  }
  const lineas = [
    `${r.metodo} ${r.url}`,
    `Estado: ${r.estado === 0 || r.estado === null ? "sin respuesta" : r.estado}${r.ms !== null ? ` · ${r.ms} ms` : ""}`,
    ...(r.cuerpo ? [`Enviado: ${r.cuerpo}`] : []),
    ...(r.error ? [`Error: ${r.error}`] : []),
    ...(r.respuesta ? [`Respuesta${r.tipoContenido ? ` (${r.tipoContenido})` : ""}:`, r.respuesta] : []),
  ];
  return {
    titulo: `${r.metodo} ${rutaDeUrl(r.url)} → ${r.estado === 0 || r.estado === null ? "sin respuesta" : r.estado}`,
    detalle: lineas.join("\n"),
    pagina: r.ruta,
  };
}

export function rutaDeUrl(url: string): string {
  try {
    const u = new URL(url, "http://x");
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * Los archivos propios que aparecen en un stack, relativos a la carpeta del
 * servicio. Vite los sirve tal cual (`http://127.0.0.1:4301/src/pages/X.tsx?t=…:42:7`),
 * así que el stack ya dice qué archivo y qué línea; los de `node_modules` y
 * los chunks de dependencias no se tocan y se descartan.
 */
export function archivosDelStack(detalle: string): Array<{ ruta: string; linea: number }> {
  const vistos = new Map<string, { ruta: string; linea: number }>();
  const patron = /(?:https?:\/\/[^/\s)]+)?\/((?:src|app|components|pages|lib|screens|hooks|utils)\/[^\s?:)]+)(?:\?[^\s:)]*)?:(\d+)(?::\d+)?/g;
  for (const m of detalle.matchAll(patron)) {
    const ruta = m[1]!;
    if (ruta.includes("node_modules") || ruta.includes(".vite/deps")) continue;
    if (!vistos.has(ruta)) vistos.set(ruta, { ruta, linea: Number(m[2]) });
    if (vistos.size >= 5) break;
  }
  return [...vistos.values()];
}
