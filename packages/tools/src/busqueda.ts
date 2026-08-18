import { fail, ok, type RegisteredTool } from "./types.js";

/**
 * Buscar dentro de lo que la empresa ya escribió.
 *
 * `read_artifact` trae el documento entero: medimos 6.570 caracteres de
 * promedio, 21.291 el mayor, y 71 lecturas en una sola corrida. Cada una entra
 * completa al contexto y se reenvía en cada vuelta del turno.
 *
 * Peor todavía: de 277 herramientas ejecutadas en esa corrida, 87 fueron
 * mensajes entre agentes, y buena parte pedía datos que ya estaban escritos en
 * un entregable de otra área. Preguntarle a un colega cuesta un ciclo entero de
 * reloj; buscarlo cuesta una vuelta del mismo turno.
 *
 * La búsqueda es léxica y no semántica a propósito: corre en proceso, sin
 * llamadas de red, es determinista —y por lo tanto testeable— y sobre unas
 * decenas de documentos rinde casi igual. Si la biblioteca crece a cientos, el
 * reemplazo natural son embeddings, y la interfaz de la herramienta no cambia.
 */

/** Sin tildes, sin mayúsculas: "Cotización" y "cotizacion" son la misma palabra. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Palabras que aparecen en todo y no ayudan a discriminar. */
const VACIAS = new Set([
  "para","como","este","esta","estos","estas","que","con","por","los","las","del","una","uno",
  "sus","sobre","entre","cada","donde","cuando","porque","pero","mas","muy","todo","toda","todos",
  "hay","son","fue","ser","estar","tiene","tienen","hace","hacer","puede","pueden","debe","deben",
  "the","and","for","with","from","este","segun","desde","hasta","aunque","tambien","asi","ya",
]);

function terminos(texto: string): string[] {
  return normalizar(texto)
    .split(/[^a-z0-9áéíóúñ%$.,]+/i)
    .map((t) => t.replace(/^[.,]+|[.,]+$/g, ""))
    .filter((t) => t.length > 3 && !VACIAS.has(t));
}

/**
 * Corta un documento en bloques con su encabezado.
 *
 * El encabezado viaja con el fragmento porque es la mitad de la respuesta: un
 * número suelto no dice nada, "## 4.3 Precio al cliente → $9.660.000" sí.
 */
export function bloques(contenido: string): Array<{ titulo: string; texto: string }> {
  const lineas = contenido.split("\n");
  const salida: Array<{ titulo: string; texto: string }> = [];
  let titulo = "";
  let buffer: string[] = [];

  const cerrar = (): void => {
    const texto = buffer.join("\n").trim();
    if (texto) salida.push({ titulo, texto });
    buffer = [];
  };

  for (const linea of lineas) {
    if (/^#{1,4}\s/.test(linea)) {
      cerrar();
      titulo = linea.replace(/^#+\s*/, "").trim();
      continue;
    }
    buffer.push(linea);
    // Un bloque muy largo se parte igual: devolver media propuesta no es buscar.
    if (buffer.join("\n").length > 1_200) cerrar();
  }
  cerrar();
  return salida;
}

/**
 * Corta un documento por sus encabezados **reales**, sin partir ni renombrar.
 *
 * Es la contracara de `bloques`, y la diferencia no es de estilo. `bloques`
 * existe para **buscar**: parte los tramos largos y se queda con el texto del
 * encabezado sin sus `#`, porque para puntuar un fragmento eso alcanza y
 * sobra. Usarla para mostrarle el documento a un agente miente de dos formas
 * que ya costaron caro:
 *
 * 1. Una sección de más de 1.200 caracteres sale partida en varios tramos que
 *    **repiten el mismo título**, así que el índice muestra "Resumen
 *    ejecutivo" dos veces en un documento que lo tiene una sola. Lo medimos:
 *    un informe de 18 encabezados anunciado como 23 secciones, y dos agentes
 *    gastando nueve llamadas y una reescritura entera del documento en
 *    desduplicar cinco encabezados que no estaban duplicados.
 * 2. Al volver a armar el texto hay que reponer los `#`, y reponerlos a mano
 *    inventa un encabezado en cada costura: en el medio de un párrafo aparece
 *    un `## Resumen ejecutivo` que el documento no tiene. El agente lo copia
 *    —hace bien: es lo que le mostramos— y después `edit_artifact` no lo
 *    encuentra, porque no existe.
 *
 * Acá el encabezado viaja **con sus `#`** y el texto es un recorte literal del
 * documento, así que lo que el agente lee se puede copiar tal cual a un
 * `buscar`.
 */
export interface Seccion {
  /** El encabezado completo, con sus `#`, tal cual está escrito. */
  encabezado: string;
  /** El título sin los `#`, para el índice. */
  titulo: string;
  /** Encabezado + cuerpo, recortado literal del documento. */
  texto: string;
}

export function secciones(contenido: string): Seccion[] {
  const lineas = contenido.split("\n");
  const salida: Seccion[] = [];
  let actual: { encabezado: string; titulo: string; cuerpo: string[] } | null = null;

  const cerrar = (): void => {
    if (!actual) return;
    salida.push({
      encabezado: actual.encabezado,
      titulo: actual.titulo,
      texto: [actual.encabezado, ...actual.cuerpo].join("\n").trimEnd(),
    });
    actual = null;
  };

  for (const linea of lineas) {
    if (/^#{1,4}\s/.test(linea)) {
      cerrar();
      actual = { encabezado: linea.trimEnd(), titulo: linea.replace(/^#+\s*/, "").trim(), cuerpo: [] };
      continue;
    }
    // Lo que va antes del primer encabezado no pertenece a ninguna sección: es
    // el preámbulo, y se lo lleva quien pida el documento entero.
    if (actual) actual.cuerpo.push(linea);
  }
  cerrar();
  return salida;
}

export function puntuar(bloque: string, titulo: string, consulta: string[]): number {
  const enBloque = normalizar(`${titulo}\n${bloque}`);
  let puntos = 0;
  for (const termino of consulta) {
    if (!enBloque.includes(termino)) continue;
    // Aparecer en el encabezado pesa más: es de lo que trata el bloque.
    puntos += normalizar(titulo).includes(termino) ? 3 : 1;
  }
  return puntos;
}

export const buscarEnEntregables: RegisteredTool = {
  name: "buscar_en_entregables",
  origin: "coordination",
  readOnly: true,
  requiresApproval: false,
  description:
    "Busca un dato dentro de todo lo que la empresa ya escribió y te devuelve " +
    "sólo los fragmentos que responden, con su fuente. Usala antes de leer un " +
    "entregable entero y antes de preguntarle a un colega: la mitad de lo que " +
    "los agentes se preguntan entre sí ya está escrito, y preguntar cuesta un " +
    "ciclo mientras que buscar cuesta una vuelta de este turno.",
  inputSchema: {
    type: "object",
    properties: {
      pregunta: {
        type: "string",
        description: 'Qué necesitás saber, en palabras. Ej: "margen y precio final de la propuesta"',
      },
      clave: {
        type: "string",
        description: "Opcional. Limitar la búsqueda a un entregable concreto por su clave.",
      },
    },
    required: ["pregunta"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const pregunta = String(args.pregunta ?? "").trim();
    if (!pregunta) return fail("buscar_en_entregables: falta la pregunta.");

    const consulta = terminos(pregunta);
    if (consulta.length === 0) {
      return fail(
        "La pregunta no tiene palabras con las que buscar. Escribila con los términos " +
          "concretos que esperás encontrar en el documento.",
      );
    }

    const disponibles = await ctx.workspace.listArtifacts();
    const filtrados = args.clave
      ? disponibles.filter((a) => a.key === String(args.clave))
      : disponibles;

    if (filtrados.length === 0) {
      return ok(
        args.clave
          ? `No existe el entregable "${args.clave}". Mirá cuáles hay con list_artifacts.`
          : "Todavía no hay entregables donde buscar.",
      );
    }

    type Hallazgo = { clave: string; version: number; titulo: string; texto: string; puntos: number };
    const hallazgos: Hallazgo[] = [];

    for (const meta of filtrados) {
      const artefacto = await ctx.workspace.readArtifact(meta.key);
      if (!artefacto) continue;
      for (const bloque of bloques(artefacto.content)) {
        const puntos = puntuar(bloque.texto, bloque.titulo, consulta);
        if (puntos > 0) {
          hallazgos.push({
            clave: meta.key,
            version: artefacto.version,
            titulo: bloque.titulo,
            texto: bloque.texto,
            puntos,
          });
        }
      }
    }

    if (hallazgos.length === 0) {
      return ok(
        `Nada sobre "${pregunta}" en los ${filtrados.length} entregables de la empresa. ` +
          `Si el dato no está escrito, buscalo con web_search o pedíselo a quien lo tenga.`,
      );
    }

    hallazgos.sort((a, b) => b.puntos - a.puntos || a.texto.length - b.texto.length);
    const top = hallazgos.slice(0, 5);

    const cuerpo = top
      .map(
        (h) =>
          `--- ${h.clave} v${h.version}${h.titulo ? ` › ${h.titulo}` : ""}\n${
            h.texto.length > 900 ? `${h.texto.slice(0, 900)}…` : h.texto
          }`,
      )
      .join("\n\n");

    const otros = hallazgos.length - top.length;
    return ok(
      `${top.length} fragmento(s) sobre "${pregunta}"` +
        (otros > 0 ? ` (hay ${otros} más, menos relevantes)` : "") +
        `:\n\n${cuerpo}\n\n` +
        `Si necesitás uno de estos entregables completo, leelo con read_artifact usando su clave.`,
      `🔎 ${top.length} fragmento(s) en ${new Set(top.map((h) => h.clave)).size} entregable(s)`,
    );
  },
};
