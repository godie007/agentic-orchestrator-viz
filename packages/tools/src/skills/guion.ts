/**
 * Guion → escenas.
 *
 * Un video no es un documento con otro formato: es una secuencia temporal donde
 * lo que se escucha y lo que se ve tienen que coincidir. Este paso traduce el
 * markdown que escribió el agente a esa estructura —qué se dice, quién lo dice y
 * qué se muestra mientras— sin generar todavía un solo byte de audio ni de
 * video, que es lo caro.
 *
 * Reusa `parseMarkdown` en vez de parsear de nuevo: un guion es markdown, y así
 * un agente lo escribe con `write_artifact` como cualquier otro entregable y
 * puede exportarlo también a PDF para que alguien lo lea antes de grabar.
 */

import { separarIcono } from "./iconos.js";
import { nombreDeVisual } from "./visuales.js";
import { parseMarkdown, spansToText, type Block, type Span } from "./markdown.js";

/** Una línea hablada. El personaje decide con qué voz suena. */
export type Linea =
  | { kind: "narracion"; texto: string }
  | { kind: "dialogo"; personaje: string; texto: string };

/** Una viñeta y, si el guion lo pidió, el ícono que la acompaña. */
export interface Bala {
  texto: string;
  /** Nombre del catálogo de `iconos.ts`, o `""` para la viñeta cuadrada. */
  icono: string;
}

/**
 * Una imagen de la escena.
 *
 * `generar: true` significa que el guion no señala un archivo sino que describe
 * lo que quiere ver, y esa descripción es el prompt. Quién la produce y dónde
 * queda no se decide acá: el guion sólo dice qué imagen va.
 */
export interface ImagenGuion {
  /** Descripción. Es el epígrafe en un documento y el prompt si se genera. */
  alt: string;
  /** Ruta dentro del directorio de salida, o `"generar"`. */
  src: string;
  generar: boolean;
  /**
   * Nombre de un visual dibujado (`visual:flujo`), en vez de un archivo.
   *
   * Cuando lo que hay que mostrar es un proceso, un diagrama dice lo que
   * ninguna foto puede decir, y además no depende de ningún proveedor.
   */
  visual?: string;
}

export interface Escena {
  /** Texto grande de la placa. Vacío = la escena hereda la anterior. */
  titulo: string;
  /** Ícono de la escena, tomado del `:nombre:` del título. */
  icono: string;
  /** Lo que se escucha, en orden. */
  lineas: Linea[];
  /** Viñetas que aparecen mientras se habla, repartidas en la duración. */
  balas: Bala[];
  /** Frase destacada, en lugar de las viñetas. */
  destacado: string;
  /** Lo que se muestra. Varias imágenes se reparten la duración de la escena. */
  imagenes: ImagenGuion[];
  /** La primera escena es portada: sin viñetas y con el título a plena página. */
  esPortada: boolean;
}

export interface Guion {
  titulo: string;
  escenas: Escena[];
  /** Personajes en orden de aparición. Define a quién le toca cada voz. */
  personajes: string[];
}

/**
 * `**Ana:** hola` marca quién habla. Devuelve el nombre, o `null` si ese trozo
 * en negrita es énfasis y no un personaje: un nombre no tiene diez palabras.
 * Sin ese corte, un párrafo que arranca destacando una idea se convertía en un
 * personaje nuevo con voz propia.
 */
function comoPersonaje(span: Span | undefined): string | null {
  if (!span?.bold) return null;
  const etiqueta = span.text.trim();
  if (!etiqueta.endsWith(":")) return null;
  const personaje = etiqueta.slice(0, -1).trim();
  if (personaje === "" || personaje.split(/\s+/).length > 4) return null;
  return personaje;
}

/**
 * Las intervenciones de un párrafo, o `null` si no es diálogo.
 *
 * Un diálogo se escribe con una línea por personaje y sin renglones en blanco
 * entre ellas —así se escribe un guion—, y en markdown eso es **un solo
 * párrafo**. Si no se vuelve a partir acá, las cuatro intervenciones de una
 * conversación terminan dichas de corrido por el primero que habló, con los
 * nombres de los demás leídos en voz alta como si fueran texto.
 */
function comoDialogos(block: Block): Array<{ personaje: string; texto: string }> | null {
  if (block.kind !== "paragraph") return null;
  if (comoPersonaje(block.spans[0]) === null) return null;

  const lineas: Array<{ personaje: string; texto: string }> = [];
  let personaje = "";
  let texto = "";

  const cerrar = (): void => {
    const limpio = texto.trim();
    if (personaje && limpio) lineas.push({ personaje, texto: limpio });
  };

  for (const span of block.spans) {
    const nuevo = comoPersonaje(span);
    if (nuevo !== null) {
      cerrar();
      personaje = nuevo;
      texto = "";
      continue;
    }
    texto += span.text;
  }
  cerrar();

  return lineas.length > 0 ? lineas : null;
}

const escenaVacia = (esPortada: boolean): Escena => ({
  titulo: "",
  icono: "",
  lineas: [],
  balas: [],
  destacado: "",
  imagenes: [],
  esPortada,
});

/** Todo menos el título: si esto está vacío, la escena no muestra ni dice nada. */
const tieneCuerpo = (escena: Escena): boolean =>
  escena.lineas.length > 0 || escena.balas.length > 0 || escena.imagenes.length > 0;

const tieneContenido = (escena: Escena): boolean =>
  escena.lineas.length > 0 ||
  escena.balas.length > 0 ||
  escena.imagenes.length > 0 ||
  escena.titulo !== "";

/**
 * `![lo que se ve](fotos/taller.jpg)` muestra un archivo de la empresa;
 * `![lo que se ve](generar)` describe una imagen que todavía no existe.
 */
const comoImagen = (block: Extract<Block, { kind: "image" }>): ImagenGuion => {
  const src = block.src.trim();
  const visual = nombreDeVisual(src);
  if (visual) return { alt: block.alt, src, generar: false, visual };
  const generar = /^generar$/i.test(src) || src === "";
  return { alt: block.alt, src: generar ? "generar" : src, generar };
};

export function parseGuion(markdown: string): Guion {
  const blocks = parseMarkdown(markdown);
  const escenas: Escena[] = [];
  const personajes: string[] = [];
  let titulo = "";
  let actual = escenaVacia(true);

  const cerrar = (): void => {
    if (tieneContenido(actual)) escenas.push(actual);
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      const { icono, resto } = separarIcono(spansToText(block.spans).trim());
      const texto = resto.trim();
      // El h1 titula el video entero y encabeza la portada; los demás abren escena.
      if (block.level === 1 && titulo === "") {
        titulo = texto;
        actual.titulo = texto;
        actual.icono = icono;
        continue;
      }

      // Un segundo `#` cuando la portada todavía está vacía significa que el
      // primero era el encabezado del documento —"Guion video institucional
      // (v4)"— y no el título del video. Se pisa en vez de abrir una escena: si
      // no, la portada anuncia el número de versión del borrador y el título de
      // verdad queda como una placa más en el medio.
      if (block.level === 1 && actual.esPortada && !tieneCuerpo(actual)) {
        titulo = texto;
        actual.titulo = texto;
        if (icono) actual.icono = icono;
        continue;
      }
      cerrar();
      actual = escenaVacia(false);
      actual.titulo = texto;
      actual.icono = icono;
      continue;
    }

    if (block.kind === "image") {
      actual.imagenes.push(comoImagen(block));
      continue;
    }

    // Un separador corta escena solo si hay algo que cerrar: los agentes lo
    // ponen debajo del título por costumbre tipográfica, no para cortar.
    if (block.kind === "rule") {
      if (tieneContenido(actual)) {
        cerrar();
        actual = escenaVacia(false);
      }
      continue;
    }

    if (block.kind === "bullet" || block.kind === "numbered") {
      const { icono, resto } = separarIcono(spansToText(block.spans).trim());
      actual.balas.push({ texto: resto.trim(), icono });
      continue;
    }

    if (block.kind === "quote") {
      actual.destacado = spansToText(block.spans).trim();
      continue;
    }

    // Una tabla en pantalla no se lee: cada fila entra como viñeta, que sí.
    if (block.kind === "table") {
      for (const fila of block.rows) {
        const texto = fila.filter((celda) => celda !== "").join(" — ");
        if (texto) {
          const { icono, resto } = separarIcono(texto);
          actual.balas.push({ texto: resto.trim(), icono });
        }
      }
      continue;
    }

    if (block.kind === "paragraph") {
      const dialogos = comoDialogos(block);
      if (dialogos) {
        for (const dialogo of dialogos) {
          if (!personajes.includes(dialogo.personaje)) personajes.push(dialogo.personaje);
          actual.lineas.push({ kind: "dialogo", ...dialogo });
        }
        continue;
      }
      const texto = spansToText(block.spans).trim();
      if (!texto) continue;

      // Un párrafo que es **sólo** una marca de ícono es el ícono de la escena,
      // no algo que alguien diga. Los modelos lo escriben así todo el tiempo —en
      // su propio renglón, debajo del título— y sin esta regla la voz en off
      // pronuncia ":objetivo:" en el medio del video.
      const marca = separarIcono(texto);
      if (marca.icono && marca.resto.trim() === "") {
        if (!actual.icono) actual.icono = marca.icono;
        continue;
      }

      actual.lineas.push({ kind: "narracion", texto });
      continue;
    }

    // `code` no se dice ni se muestra bien: se descarta a propósito.
  }

  cerrar();
  return { titulo, escenas, personajes };
}

/** Todas las imágenes del guion, en orden: hay que resolverlas antes de filmar. */
export function imagenesDelGuion(guion: Guion): ImagenGuion[] {
  return guion.escenas.flatMap((escena) => escena.imagenes);
}

/** Todo lo que se va a decir, para estimar duración antes de sintetizar. */
export function caracteresHablados(guion: Guion): number {
  return guion.escenas
    .flatMap((escena) => escena.lineas)
    .reduce((total, linea) => total + linea.texto.length, 0);
}
