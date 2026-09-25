import { api } from "../../api.js";

/**
 * Lo que manda el selector de la vista previa cuando la persona toca un
 * elemento del frontend corriendo (ver `apps/server/src/proxy-vista.ts`).
 */
export interface ElementoSeleccionado {
  etiqueta: string;
  selector: string;
  texto: string;
  html: string;
  /** Componentes de React, del más cercano al más lejano. */
  componentes: string[];
  /** `archivo:línea` si React los expone (hasta React 18). */
  fuentes: string[];
  atributos: Record<string, string>;
  /** Ruta de la app donde estaba (`/login`). */
  ruta: string;
  titulo: string;
  tamano: string;
}

export function esElemento(dato: unknown): dato is ElementoSeleccionado {
  const e = dato as Partial<ElementoSeleccionado> | null;
  return (
    e != null &&
    typeof e.etiqueta === "string" &&
    typeof e.selector === "string" &&
    Array.isArray(e.componentes) &&
    typeof e.ruta === "string"
  );
}

/** "button «Ingresar» · LoginForm" */
export function rotuloDeElemento(e: ElementoSeleccionado): string {
  const texto = e.texto ? ` «${e.texto.length > 28 ? `${e.texto.slice(0, 28)}…` : e.texto}»` : "";
  return `${e.etiqueta}${texto}${e.componentes[0] ? ` · ${e.componentes[0]}` : ""}`;
}

export interface Candidato {
  ruta: string;
  linea: number;
  motivo: string;
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Dónde está ese elemento en el código. Es lo que hace útil señalar: el agente
 * recibe los archivos candidatos en vez de tener que buscarlos.
 *
 * Tres pistas, de la más fuerte a la más débil: el archivo fuente que expone
 * React (si lo hay), dónde se **define** cada componente de la cadena, y dónde
 * aparece el texto visible o un atributo distintivo (un `placeholder`, un
 * `aria-label`). Sólo dentro de la carpeta del servicio y sin tests.
 */
export async function buscarCandidatos(repoId: string, carpeta: string, e: ElementoSeleccionado): Promise<Candidato[]> {
  const prefijo = carpeta ? `${carpeta}/` : "";
  const valido = (ruta: string) => ruta.startsWith(prefijo) && !/(\.test\.|\.spec\.|__tests__|\/tests?\/)/.test(ruta);
  const vistos = new Set<string>();
  const salida: Candidato[] = [];
  const sumar = (c: Candidato) => {
    const clave = `${c.ruta}:${c.linea}`;
    if (vistos.has(clave) || salida.length >= 6) return;
    vistos.add(clave);
    salida.push(c);
  };

  for (const fuente of e.fuentes.slice(0, 2)) {
    const m = /^(.*):(\d+)$/.exec(fuente);
    if (!m) continue;
    const i = m[1]!.indexOf(prefijo || "src/");
    if (i >= 0) sumar({ ruta: m[1]!.slice(i), linea: Number(m[2]), motivo: "archivo que informa React" });
  }

  const buscar = async (q: string, regex: boolean) => {
    try {
      return (await api.buscarEnRepo(repoId, q, { regex, mayusculas: true })).resultados.filter((r) => valido(r.ruta));
    } catch {
      return [];
    }
  };

  // Los componentes propios, no los de librería: si la definición no está en
  // el repo, no es de acá.
  for (const nombre of e.componentes.slice(0, 4)) {
    const encontrados = await buscar(`(function|const|class|let) +${escapar(nombre)}([^A-Za-z0-9_$]|$)`, true);
    for (const r of encontrados.slice(0, 1)) sumar({ ruta: r.ruta, linea: r.linea, motivo: `define <${nombre}>` });
  }

  const textos = [
    e.atributos["placeholder"],
    e.atributos["aria-label"],
    e.atributos["data-testid"],
    e.texto && e.texto.length <= 60 ? e.texto : e.texto.split(/[.\n]/)[0]?.slice(0, 50),
  ].filter((t): t is string => Boolean(t && t.trim().length >= 3));
  for (const texto of textos) {
    for (const r of (await buscar(texto.trim(), false)).slice(0, 2)) sumar({ ruta: r.ruta, linea: r.linea, motivo: `contiene «${texto.trim().slice(0, 40)}»` });
  }
  return salida;
}
