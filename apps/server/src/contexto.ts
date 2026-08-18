import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ExportStore } from "./exports.js";

/**
 * El árbol de contexto de una empresa, como un vault de Obsidian.
 *
 * ## Por qué un vault y no una tabla
 *
 * Lo que el sistema aprende trabajando tiene que poder **corregirse a mano**. Un
 * campo de texto en SQLite se puede editar con un `UPDATE`; una nota markdown se
 * abre, se lee, se discute y se arregla — y el grafo de Obsidian muestra cómo se
 * relacionan los temas, que es la mitad del valor de tener el conocimiento
 * junto. La memoria corta sigue en la base porque entra en el prompt de cada
 * turno; acá vive lo largo, lo que se consulta cuando hace falta.
 *
 * ## Por qué NO pasa por el plugin de Obsidian
 *
 * Un vault es una carpeta con archivos markdown: no hace falta hablar con la
 * aplicación para escribirlo. Ir por el filesystem evita una segunda instancia
 * de Obsidian abierta, un segundo puerto y un segundo token — y sobre todo
 * evita que el contexto del sistema **dependa de que una aplicación de
 * escritorio esté corriendo**. Lo medimos: el servidor MCP de Obsidian estuvo
 * caído media tarde. Es la misma regla que ffmpeg, Kokoro y Chrome: usar lo que
 * hay, y que la ausencia degrade en vez de romper. Obsidian queda como visor y
 * editor, que es donde de verdad aporta.
 *
 * La ruta de un agente se sanea segmento por segmento, igual que en
 * `ExportStore`: es la única garantía de que lo que escribe un modelo cae
 * adentro del vault y en ningún otro lado.
 */

/**
 * Un nombre de archivo o carpeta **legible por una persona**.
 *
 * No se reusa `ExportStore.safeSegment` a propósito: ahí se sacan acentos y
 * espacios porque esos nombres viajan en URLs de descarga. Acá los nombres se
 * leen en Obsidian, y un vault que dice `inspia-checklist-items-no-expanden` en
 * vez de "Checklist: los ítems no se expanden" no se navega, se descifra. Lo que
 * sí se saca es lo que rompe un filesystem o esconde un archivo: separadores de
 * ruta, caracteres de control, y el punto inicial.
 */
export function segmentoLegible(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
}

/**
 * Convierte el tema de una lección en un título de nota.
 *
 * Los temas los escriben los agentes en formato de etiqueta
 * (`inspia:checklist-items-no-expanden`). Acá se vuelven texto: es el nombre que
 * se ve en el panel lateral de Obsidian y en los enlaces `[[…]]`.
 */
export function tituloDeTema(tema: string): string {
  const limpio = tema
    .replace(/[:_]/g, " — ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const conSiglas = limpio
    .split(" ")
    .map((palabra) => (SIGLAS.has(palabra.toLowerCase()) ? palabra.toUpperCase() : palabra))
    .join(" ");
  return conSiglas.charAt(0).toUpperCase() + conSiglas.slice(1);
}

/** Las que quedan feas en minúscula y aparecen seguido en este dominio. */
const SIGLAS = new Set(["qa", "nc", "pdf", "mcp", "ia", "url", "api", "html", "css", "retie"]);

/** Una nota del árbol, tal como la ve quien arma el mapa. */
export interface NotaDeContexto {
  /** Ruta relativa dentro de la empresa, con `/`. */
  ruta: string;
  /** Primera línea con contenido, sin `#`: sirve de resumen en el mapa. */
  titulo: string;
  caracteres: number;
  actualizadaAt: number;
}

/**
 * Cuánto puede ocupar el mapa en el prompt, en caracteres, y cuántas notas.
 *
 * Se acota por **tamaño** y no sólo por cantidad, que es la misma lección que
 * dejó la memoria de la empresa: sesenta notas de ruta corta ocupan poco, pero
 * sesenta con títulos largos son un bloque que se reenvía en cada vuelta del
 * turno. El tope de cantidad queda igual como red: un árbol de mil notas no se
 * navega desde un prompt, se busca con `buscar_contexto`.
 */
const TOPE_MAPA_CARACTERES = 4_000;
const TOPE_MAPA = 60;

/** Con qué se identifica una empresa acá: el id manda, el nombre se lee. */
export interface EmpresaDeContexto {
  id: string;
  nombre: string;
}

/**
 * Archivo oculto que dice de qué empresa es una carpeta.
 *
 * Existe porque el nombre de la carpeta es el nombre de la empresa —para que el
 * vault se navegue leyendo— y dos empresas se pueden llamar igual: en esta base
 * hay cinco "Codytion S.A.". Con la marca, la segunda toma una carpeta propia en
 * vez de mezclar su conocimiento con el de la primera, y el nombre lindo se
 * conserva para quien llegó antes.
 */
const MARCA = ".empresa";

export class ContextoStore {
  constructor(private readonly rootDir: string) {}

  /**
   * La carpeta de una empresa, por nombre legible.
   *
   * `crear: false` la busca sin tocar el disco: consultar el árbol no puede
   * escribirlo, que es la misma lección que dejó `ExportStore.dirFor` creando
   * carpetas al pasar y produciendo los residuos que venía a medir.
   */
  private async resolverDir(empresa: EmpresaDeContexto, crear: boolean): Promise<string | null> {
    const base = segmentoLegible(empresa.nombre) || empresa.id;
    const candidatos = [base, `${base} (${empresa.id.slice(-6)})`];

    for (const candidato of candidatos) {
      const dir = join(this.rootDir, candidato);
      let duenio: string | null = null;
      try {
        duenio = (await readFile(join(dir, MARCA), "utf8")).trim();
      } catch {
        duenio = null;
      }
      if (duenio === empresa.id) return dir;
      if (duenio !== null) continue; // es de otra empresa con el mismo nombre

      // Sin marca: o no existe, o es una carpeta de antes. Se reclama sólo al
      // crear, para que una consulta no invente carpetas.
      if (!crear) continue;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, MARCA), empresa.id, "utf8");
      return dir;
    }
    return null;
  }

  /** Dónde vive (o viviría) el vault de una empresa. Para mostrarlo, no para escribir. */
  pathFor(empresa: EmpresaDeContexto): string {
    return join(this.rootDir, segmentoLegible(empresa.nombre) || empresa.id);
  }

  /**
   * Resuelve una ruta propuesta por un agente, saneada, siempre con `.md`.
   *
   * La extensión se fuerza porque el vault es de Obsidian: un `.txt` en el medio
   * no se indexa, no aparece en el grafo y rompe los enlaces `[[…]]`.
   */
  private destino(dir: string, relativa: string): string | null {
    const segmentos = relativa
      .split(/[/\\]+/)
      .map((parte) => parte.trim())
      .filter((parte) => parte !== "" && parte !== "." && parte !== "..")
      .map(segmentoLegible)
      .filter((parte) => parte !== "")
      .slice(0, 4);
    if (segmentos.length === 0) return null;
    const ultimo = segmentos[segmentos.length - 1]!;
    segmentos[segmentos.length - 1] = ultimo.toLowerCase().endsWith(".md") ? ultimo : `${ultimo}.md`;

    const destino = resolve(dir, ...segmentos);
    if (!destino.startsWith(resolve(dir) + sep)) return null;
    return destino;
  }

  /** Crea o reemplaza una nota. Devuelve la ruta relativa que quedó. */
  async escribir(
    empresa: EmpresaDeContexto,
    ruta: string,
    contenido: string,
  ): Promise<{ ok: true; ruta: string; caracteres: number } | { ok: false; motivo: string }> {
    const dir = await this.resolverDir(empresa, true);
    const destino = dir ? this.destino(dir, ruta) : null;
    if (!dir || !destino) {
      return { ok: false, motivo: `"${ruta}" no es una ruta válida dentro del vault.` };
    }
    await mkdir(join(destino, ".."), { recursive: true });
    await writeFile(destino, contenido, "utf8");
    return {
      ok: true,
      ruta: destino.slice(resolve(dir).length + 1).split(sep).join("/"),
      caracteres: contenido.length,
    };
  }

  /** El contenido de una nota, o `null` si no existe. */
  async leer(empresa: EmpresaDeContexto, ruta: string): Promise<string | null> {
    const dir = await this.resolverDir(empresa, false);
    const destino = dir ? this.destino(dir, ruta) : null;
    if (!destino) return null;
    try {
      return await readFile(destino, "utf8");
    } catch {
      return null;
    }
  }

  async borrar(empresa: EmpresaDeContexto, ruta: string): Promise<boolean> {
    const dir = await this.resolverDir(empresa, false);
    const destino = dir ? this.destino(dir, ruta) : null;
    if (!destino) return false;
    try {
      await rm(destino);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * El árbol entero, con el título de cada nota.
   *
   * Es lo que viaja al prompt: **el mapa, no el contenido**. Medido en este
   * proyecto, una llamada a herramienta dentro de un turno delegado cuesta una
   * iteración —20.000 a 28.000 tokens de prefijo reenviado—, así que mandar lo
   * corto sale más barato que ir a buscarlo, y apuntar lo largo sale más barato
   * que mandarlo. El mapa es lo que hace posible esa segunda mitad: sin él, el
   * agente no sabe qué existe y busca a ciegas.
   */
  async mapa(empresa: EmpresaDeContexto): Promise<NotaDeContexto[]> {
    const dir = await this.resolverDir(empresa, false);
    const notas: NotaDeContexto[] = [];
    if (!dir) return notas;

    const recorrer = async (actual: string, prefijo: string): Promise<void> => {
      let entradas;
      try {
        entradas = await readdir(actual, { withFileTypes: true });
      } catch {
        return; // el vault todavía no existe: no es un error, es una empresa nueva
      }
      for (const entrada of entradas) {
        // Los que empiezan con punto son de Obsidian (`.obsidian/`), no del
        // conocimiento: el árbol los ignora como el de la salida.
        if (entrada.name.startsWith(".")) continue;
        const ruta = join(actual, entrada.name);
        if (entrada.isDirectory()) {
          await recorrer(ruta, `${prefijo}${entrada.name}/`);
          continue;
        }
        if (!entrada.name.toLowerCase().endsWith(".md")) continue;
        const [info, contenido] = await Promise.all([stat(ruta), readFile(ruta, "utf8")]);
        notas.push({
          ruta: `${prefijo}${entrada.name}`,
          titulo: primeraLinea(contenido),
          caracteres: contenido.length,
          actualizadaAt: info.mtimeMs,
        });
      }
    };

    await recorrer(dir, "");
    // Lo más reciente primero: si hay que recortar, se recorta lo viejo.
    notas.sort((a, b) => b.actualizadaAt - a.actualizadaAt);

    const entran: NotaDeContexto[] = [];
    let usado = 0;
    for (const nota of notas.slice(0, TOPE_MAPA)) {
      usado += nota.ruta.length + nota.titulo.length;
      if (usado > TOPE_MAPA_CARACTERES) break;
      entran.push(nota);
    }
    return entran;
  }

  /**
   * Busca texto en las notas y devuelve dónde apareció, no el contenido.
   *
   * Devolver los párrafos que coinciden sería cómodo y caro: en un turno
   * delegado ese texto se reenvía en todas las vueltas que siguen. Se devuelve
   * la ruta y una línea de contexto; el agente decide qué abrir.
   */
  async buscar(
    empresa: EmpresaDeContexto,
    texto: string,
  ): Promise<Array<{ ruta: string; linea: string }>> {
    const aguja = texto.trim().toLowerCase();
    if (!aguja) return [];
    const resultados: Array<{ ruta: string; linea: string }> = [];

    for (const nota of await this.mapa(empresa)) {
      const contenido = (await this.leer(empresa, nota.ruta)) ?? "";
      const linea = contenido
        .split("\n")
        .find((l) => l.toLowerCase().includes(aguja));
      if (linea) resultados.push({ ruta: nota.ruta, linea: linea.trim().slice(0, 200) });
    }
    return resultados;
  }
}

/**
 * La nota de un tema de la memoria, lista para escribir.
 *
 * Vive acá y no en el script de volcado porque la escriben los dos: el volcado
 * inicial y **cada `record_lesson` nuevo**. Si el formato viviera en el script,
 * la memoria que se aprende trabajando saldría distinta de la migrada, y el
 * vault terminaría con dos estilos de nota.
 */
export function notaDeAprendizajes(opciones: {
  tema: string;
  empresa: string;
  /** Hoy, ya formateado. El render no tiene reloj: la fecha entra, como en los documentos. */
  fecha: string;
  lecciones: Array<{ lesson: string; timesConfirmed: number }>;
  /** Otros temas de la empresa, para enlazar los parientes. */
  temas?: readonly string[];
}): string {
  const { tema, empresa, fecha, lecciones } = opciones;
  const ordenadas = [...lecciones].sort((a, b) => b.timesConfirmed - a.timesConfirmed);
  const titulo = tituloDeTema(tema);

  const cuerpo = ordenadas.map((l) => {
    // El encabezado va corto: es lo que se ve en el panel lateral de Obsidian,
    // y repetir ahí el párrafo entero lo vuelve ilegible.
    const primera = l.lesson.split(/[.\n]/)[0]!.trim();
    const encabezado = primera.length > 62 ? `${primera.slice(0, 62).trimEnd()}…` : primera;
    const veces = l.timesConfirmed > 1 ? `\n\n*(reafirmada ${l.timesConfirmed} veces)*` : "";
    return `## ${encabezado}\n\n${l.lesson}${veces}`;
  });

  const parientes = (opciones.temas ?? [])
    .filter((otro) => otro !== tema && familiaDeTema(otro) === familiaDeTema(tema))
    .map((otro) => `- [[${rutaDeTema(otro).replace(/\.md$/, "")}|${tituloDeTema(otro)}]]`);

  return [
    // Frontmatter: Obsidian lo muestra como propiedades y lo hace filtrable.
    // Sin esto el vault es un montón de texto plano y no una base de conocimiento.
    "---",
    `empresa: "${empresa.replace(/"/g, "'")}"`,
    `tema: ${tema}`,
    `lecciones: ${ordenadas.length}`,
    `actualizada: ${fecha}`,
    "tags:",
    "  - orquestador/aprendizaje",
    `  - orquestador/${etiquetaDeTema(tema)}`,
    "---",
    "",
    `# ${titulo}`,
    "",
    `Lo que **${empresa}** aprendió sobre ${titulo.toLowerCase()}, en ${ordenadas.length} lección(es).`,
    "Lo escribieron los agentes trabajando. Si algo está mal, corregilo acá: se lee tal cual.",
    "",
    `← [[00 - Índice|Índice del vault]]`,
    "",
    ...(parientes.length > 0 ? ["## Relacionadas", "", ...parientes, ""] : []),
    // Las notas se separan con línea en blanco **antes** de cada `##`: sin ella
    // markdown no lo toma como encabezado y en Obsidian sale como texto suelto.
    ...cuerpo.flatMap((nota) => [nota, ""]),
  ].join("\n");
}

/**
 * La familia de un tema: su primera palabra.
 *
 * Es lo que enlaza `inspia:escena-8` con `inspia:escena-9` sin que nadie
 * mantenga una lista de relaciones. Un heurístico simple que el agente puede
 * dirigir con sólo elegir bien el prefijo del tema.
 */
function familiaDeTema(tema: string): string {
  return tema.toLowerCase().split(/[:\-_\s]/)[0] ?? tema;
}

/** La etiqueta de Obsidian: sin espacios ni acentos, que ahí sí molestan. */
function etiquetaDeTema(tema: string): string {
  return (
    tema
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

/** Dónde va la nota de un tema, con nombre legible. */
export function rutaDeTema(tema: string): string {
  return `Aprendizajes/${segmentoLegible(tituloDeTema(tema))}.md`;
}

/** El título de una nota: su primer encabezado, o su primera línea con texto. */
function primeraLinea(contenido: string): string {
  for (const linea of contenido.split("\n")) {
    const limpia = linea.replace(/^#+\s*/, "").trim();
    if (limpia) return limpia.slice(0, 120);
  }
  return "(vacía)";
}
