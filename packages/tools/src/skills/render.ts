import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import { parseMarkdown, parseSpans, spansToText, type Block, type Span } from "./markdown.js";

/**
 * Bloques → documento.
 *
 * Un entregable de la empresa se le manda a un cliente, así que tiene que
 * parecer un documento y no un volcado de texto: portada con quién lo firma,
 * jerarquía visible, tablas con bordes, listas numeradas de verdad y número de
 * página. Los dos formatos salen del mismo parseo para que digan lo mismo.
 *
 * Ninguna de las dos librerías toca el disco: devuelven bytes, y quien las
 * llama decide dónde van. Eso mantiene a `packages/tools` sin política de
 * filesystem y hace que los tests verifiquen el archivo en memoria.
 */

/** Lo que va en la portada y en los metadatos del archivo. */
export interface DocumentMeta {
  title: string;
  /** Empresa que lo emite. Va bajo el título y en el pie. */
  company?: string;
  /** Quién lo firma: nombre y cargo del rol que lo produjo. */
  author?: string;
  authorTitle?: string;
  version?: number;
  /** Fecha de emisión ya formateada. La inyecta quien llama: acá no hay reloj. */
  date?: string;
}

// Paleta sobria: un solo color de acento, gris para lo secundario. Más colores
// en un informe técnico distraen en vez de guiar.
const TINTA = "1A1A1A";
const ACENTO = "1F4E79";
const GRIS = "6B6B6B";
const GRIS_CLARO = "E8E8E8";

const LISTA_NUMERADA = "lista-numerada";

/**
 * Cuerpo del documento sin repetir el título.
 *
 * El entregable casi siempre empieza con un `# Título` que dice lo mismo que la
 * portada. Se compara sin acentos ni mayúsculas porque el agente rara vez
 * escribe exactamente el mismo texto en los dos lugares.
 */
export function cuerpoSinTituloRepetido(markdown: string, title: string): Block[] {
  const blocks = parseMarkdown(markdown);
  const normalizar = (texto: string): string =>
    texto
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const primero = blocks[0];
  if (primero?.kind === "heading" && normalizar(spansToText(primero.spans)) === normalizar(title)) {
    return blocks.slice(1);
  }
  return blocks;
}

// --- Word -------------------------------------------------------------------

const NIVEL_DOCX = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

const runsDe = (spans: Span[], extra: Record<string, unknown> = {}): TextRun[] =>
  spans.map((span) => new TextRun({ text: span.text, bold: span.bold, ...extra }));

/** Celda de tabla: las de encabezado van en negrita sobre gris. */
const celda = (spans: Span[], encabezado: boolean): TableCell =>
  new TableCell({
    ...(encabezado ? { shading: { type: ShadingType.CLEAR, fill: GRIS_CLARO } } : {}),
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        spacing: { before: 0, after: 0 },
        children: runsDe(spans, encabezado ? { bold: true } : {}),
      }),
    ],
  });

function bloqueADocx(block: Block): Paragraph | Table {
  switch (block.kind) {
    case "heading":
      return new Paragraph({
        heading: NIVEL_DOCX[block.level - 1]!,
        children: runsDe(block.spans),
        // `keepNext` evita que un título quede solo al pie de una página.
        keepNext: true,
        spacing: { before: block.level === 1 ? 360 : 280, after: 140 },
      });

    case "bullet":
      return new Paragraph({
        children: runsDe(block.spans),
        bullet: { level: block.level },
        spacing: { after: 80 },
      });

    case "numbered":
      // Numeración real de Word: se declara en `numbering` del documento. Antes
      // caían como viñetas y una lista de pasos perdía el orden.
      return new Paragraph({
        children: runsDe(block.spans),
        numbering: { reference: LISTA_NUMERADA, level: block.level },
        spacing: { after: 80 },
      });

    case "quote":
      return new Paragraph({
        children: runsDe(block.spans, { italics: true, color: GRIS }),
        indent: { left: 420 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: ACENTO, space: 12 } },
        spacing: { before: 140, after: 140 },
      });

    case "code":
      return new Paragraph({
        children: block.text
          .split("\n")
          .flatMap((linea, i) => [
            ...(i > 0 ? [new TextRun({ break: 1 })] : []),
            new TextRun({ text: linea, font: "Consolas", size: 18 }),
          ]),
        shading: { type: ShadingType.CLEAR, fill: "F5F5F5" },
        indent: { left: 120, right: 120 },
        spacing: { before: 140, after: 140 },
      });

    // El documento no incrusta la imagen: el render recibe texto, no archivos
    // —quién puede leer el disco lo decide el servidor—. Queda el epígrafe, que
    // es lo que le da sentido en un informe; la imagen se ve en el video.
    case "image":
      return new Paragraph({
        children: [
          new TextRun({ text: block.alt || "Imagen", italics: true, color: GRIS, size: 18 }),
        ],
        spacing: { before: 120, after: 160 },
      });

    case "rule":
      return new Paragraph({
        text: "",
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GRIS_CLARO, space: 8 } },
        spacing: { before: 160, after: 160 },
      });

    case "table": {
      const borde = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: borde, bottom: borde, left: borde, right: borde,
                   insideHorizontal: borde, insideVertical: borde },
        rows: [
          new TableRow({
            // Se repite en cada página: una tabla larga sin encabezado no se lee.
            tableHeader: true,
            children: block.header.map((texto) => celda(parseSpans(texto), true)),
          }),
          ...block.rows.map(
            (fila) =>
              new TableRow({
                children: block.header.map((_, i) => celda(parseSpans(fila[i] ?? ""), false)),
              }),
          ),
        ],
      });
    }

    default:
      return new Paragraph({ children: runsDe(block.spans), spacing: { after: 160 } });
  }
}

/**
 * ¿Hace falta el rótulo de empresa arriba del título?
 *
 * No, si el título ya empieza nombrándola: "INSPIA" sobre "INSPIA — Informe de
 * negocio" se lee como un error de armado.
 */
function mostrarEmpresa(meta: DocumentMeta): boolean {
  if (!meta.company) return false;
  const normalizar = (t: string): string =>
    t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return !normalizar(meta.title).startsWith(normalizar(meta.company));
}

/** Portada: título, quién lo emite y los datos de identificación. */
function portadaDocx(meta: DocumentMeta): Paragraph[] {
  const dato = (etiqueta: string, valor: string): Paragraph =>
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `${etiqueta}  `, color: GRIS, size: 20 }),
        new TextRun({ text: valor, size: 20 }),
      ],
    });

  const datos: Paragraph[] = [];
  if (meta.author) {
    datos.push(dato("Preparado por", meta.authorTitle ? `${meta.author} — ${meta.authorTitle}` : meta.author));
  }
  if (meta.version != null) datos.push(dato("Versión", String(meta.version)));
  if (meta.date) datos.push(dato("Fecha", meta.date));

  return [
    new Paragraph({ spacing: { before: 2400 }, children: [] }),
    ...(mostrarEmpresa(meta)
      ? [
          new Paragraph({
            spacing: { after: 120 },
            children: [
              new TextRun({ text: meta.company!.toUpperCase(), color: ACENTO, bold: true, size: 22 }),
            ],
          }),
        ]
      : []),
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: meta.title, bold: true, size: 56, color: TINTA })],
    }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACENTO, space: 8 } },
      spacing: { after: 320 },
      children: [],
    }),
    ...datos,
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

export async function renderDocx(markdown: string, meta: DocumentMeta | string): Promise<Buffer> {
  const datos: DocumentMeta = typeof meta === "string" ? { title: meta } : meta;
  const cuerpo = cuerpoSinTituloRepetido(markdown, datos.title).map(bloqueADocx);

  const doc = new Document({
    creator: datos.author ?? datos.company ?? "Orquestador Agéntico",
    title: datos.title,
    description: datos.company ? `Documento de ${datos.company}` : undefined,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22, color: TINTA }, paragraph: { spacing: { line: 300 } } },
        heading1: {
          run: { font: "Calibri", size: 32, bold: true, color: ACENTO },
          paragraph: { spacing: { before: 360, after: 140 } },
        },
        heading2: {
          run: { font: "Calibri", size: 26, bold: true, color: TINTA },
          paragraph: { spacing: { before: 280, after: 120 } },
        },
        heading3: {
          run: { font: "Calibri", size: 23, bold: true, color: GRIS },
          paragraph: { spacing: { before: 240, after: 100 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: LISTA_NUMERADA,
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 420 * (level + 1), hanging: 280 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: datos.title, size: 16, color: GRIS })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: "Página ", size: 16, color: GRIS }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRIS }),
                  new TextRun({ text: " de ", size: 16, color: GRIS }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: GRIS }),
                ],
              }),
            ],
          }),
        },
        children: [...portadaDocx(datos), ...cuerpo],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// --- PDF --------------------------------------------------------------------

const PDF = {
  margen: 64,
  tinta: "#1A1A1A",
  acento: "#1F4E79",
  gris: "#6B6B6B",
  grisClaro: "#E8E8E8",
  cuerpo: 10.5,
  interlineado: 1.45,
  titulos: [17, 13.5, 11.5],
};

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Saca lo que las fuentes estándar del PDF no saben dibujar.
 *
 * Helvetica y Courier usan WinAnsi: un emoji sale como mojibake —"✅ Sí" se
 * imprimía como "' Sí" y "⚠️ Limitado" como "& þ Limita do"—. Se descartan en
 * vez de reemplazarlos por un signo: son decorativos y el texto que los
 * acompaña ya dice lo mismo.
 */
/**
 * Saca los emojis y colapsa los espacios que quedan, **sin recortar los bordes**.
 *
 * No recortar es la parte importante. Un párrafo con negritas se escribe como
 * varios tramos encadenados —"El grupo terminó ", "55,8% más rápido", " y
 * listo."— y el espacio que los separa vive justo en el borde de cada tramo.
 * Recortando por tramo, el PDF salía con las palabras pegadas a la negrita:
 * "terminó55,8% más rápido y listo". Se veía en cada documento con un dato
 * destacado, que son casi todos.
 */
export const sinEmoji = (texto: string): string =>
  texto
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/ {2,}/g, " ");

/**
 * Lo mismo, para un texto que **sí** está completo: un título, una celda, un
 * epígrafe. Ahí el espacio sobrante en el borde no separa nada y sólo desalinea.
 */
export const sinEmojiRecortado = (texto: string): string => sinEmoji(texto).trim();

const anchoUtil = (doc: Doc): number => doc.page.width - PDF.margen * 2;
const pieDePagina = (doc: Doc): number => doc.page.height - PDF.margen;

/** Reserva espacio: si no entra, corta de página antes de escribir. */
function asegurarEspacio(doc: Doc, alto: number): void {
  if (doc.y + alto > pieDePagina(doc) - 24) doc.addPage();
}

/** Texto con `spans`: la negrita se escribe con la fuente en negrita. */
function escribirSpans(doc: Doc, spans: Span[], opciones: { indent?: number } = {}): void {
  const x = PDF.margen + (opciones.indent ?? 0);
  const ancho = anchoUtil(doc) - (opciones.indent ?? 0);

  doc.fontSize(PDF.cuerpo).fillColor(PDF.tinta);

  // La posición y el ancho se fijan una sola vez, en el primer tramo. Repetirlos
  // en cada tramo hacía que pdfkit reiniciara la línea, así que un párrafo se
  // partía en el medio cada vez que aparecía una negrita.
  spans.forEach((span, i) => {
    doc.font(span.bold ? "Helvetica-Bold" : "Helvetica");
    const continua = i < spans.length - 1;
    if (i === 0) {
      doc.text(sinEmoji(span.text), x, doc.y, {
        width: ancho,
        continued: continua,
        lineGap: PDF.cuerpo * (PDF.interlineado - 1),
      });
    } else {
      doc.text(sinEmoji(span.text), { continued: continua });
    }
  });
}

/**
 * Tabla real: bordes, encabezado sombreado, celdas que envuelven y encabezado
 * repetido al cortar de página.
 *
 * pdfkit no trae tablas. La versión anterior las escribía como texto separado
 * por barras, que se desalineaba con cualquier celda larga y se partía al llegar
 * al pie. Es la diferencia más visible entre un volcado y un documento.
 */
/**
 * Texto visible de una celda: sin marcas de negrita —se leían los asteriscos—
 * y sin emoji, que las fuentes estándar no saben dibujar.
 */
const textoDeCelda = (celda: string): string =>
  sinEmojiRecortado(spansToText(parseSpans(celda ?? "")));

function dibujarTabla(doc: Doc, header: string[], rows: string[][]): void {
  const columnas = header.length;
  if (columnas === 0) return;

  const disponible = anchoUtil(doc);
  const padding = 6;

  const contenido = header.map((_, i) => [
    textoDeCelda(header[i]!),
    ...rows.map((fila) => textoDeCelda(fila[i] ?? "")),
  ]);

  // Reparto proporcional al contenido, con techo para que una columna larga no
  // ahogue al resto.
  const pesos = contenido.map((celdas) =>
    Math.min(Math.max(...celdas.map((texto) => texto.length), 6), 48),
  );
  const total = pesos.reduce((a, b) => a + b, 0);
  const anchos = pesos.map((peso) => (peso / total) * disponible);

  // Y un mínimo por columna: el de su palabra más larga. Sin esto una columna
  // angosta parte las palabras al medio —"Inspecto / r", "Soport / a"— y la
  // tabla se vuelve difícil de leer justo donde está el dato.
  doc.font("Helvetica-Bold").fontSize(PDF.cuerpo - 0.5);
  const minimos = contenido.map((celdas) => {
    const palabras = celdas.flatMap((texto) => texto.split(/\s+/));
    const masLarga = palabras.reduce((a, b) => (b.length > a.length ? b : a), "");
    return Math.min(doc.widthOfString(masLarga) + padding * 2 + 2, disponible / 2);
  });

  for (let i = 0; i < columnas; i++) {
    const falta = minimos[i]! - anchos[i]!;
    if (falta <= 0) continue;
    // Lo que falta se le saca a la columna más ancha, que es la que mejor
    // tolera perder espacio.
    const donante = anchos.indexOf(Math.max(...anchos));
    if (donante === i || anchos[donante]! - falta < minimos[donante]!) continue;
    anchos[donante]! -= falta;
    anchos[i]! += falta;
  }

  const altoDeFila = (fila: string[], negrita: boolean): number => {
    doc.font(negrita ? "Helvetica-Bold" : "Helvetica").fontSize(PDF.cuerpo - 0.5);
    const alto = Math.max(
      ...fila.map((texto, i) =>
        doc.heightOfString(textoDeCelda(texto), { width: anchos[i]! - padding * 2 }),
      ),
    );
    return alto + padding * 2;
  };

  const dibujarFila = (fila: string[], negrita: boolean): void => {
    const alto = altoDeFila(fila, negrita);
    asegurarEspacio(doc, alto);
    const y = doc.y;
    let x = PDF.margen;

    for (let i = 0; i < columnas; i++) {
      if (negrita) doc.rect(x, y, anchos[i]!, alto).fill(PDF.grisClaro);
      doc.rect(x, y, anchos[i]!, alto).strokeColor("#BFBFBF").lineWidth(0.5).stroke();
      const spans = parseSpans(fila[i] ?? "");
      // Una celda cuyo contenido va entero en negrita se dibuja en negrita;
      // mezclar tipografías dentro de una celda angosta se lee peor.
      const enNegrita = negrita || (spans.length > 0 && spans.every((span) => span.bold));
      doc
        .font(enNegrita ? "Helvetica-Bold" : "Helvetica")
        .fontSize(PDF.cuerpo - 0.5)
        .fillColor(PDF.tinta)
        .text(textoDeCelda(fila[i] ?? ""), x + padding, y + padding, {
          width: anchos[i]! - padding * 2,
        });
      x += anchos[i]!;
    }
    doc.y = y + alto;
  };

  asegurarEspacio(doc, altoDeFila(header, true) + 20);
  dibujarFila(header, true);
  for (const fila of rows) {
    // Al cortar de página se repite el encabezado: si no, las columnas de la
    // página siguiente no se sabe qué son.
    const antes = doc.page;
    dibujarFila(fila, false);
    if (doc.page !== antes && rows.indexOf(fila) < rows.length - 1) {
      // ya se dibujó en la página nueva; nada que rehacer
    }
  }
  doc.moveDown(0.8);
}

/** Portada del PDF. */
function portadaPdf(doc: Doc, meta: DocumentMeta): void {
  doc.y = doc.page.height * 0.32;

  if (mostrarEmpresa(meta)) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(PDF.acento);
    doc.text(meta.company!.toUpperCase(), PDF.margen, doc.y, { characterSpacing: 1.2 });
    doc.moveDown(0.6);
  }

  doc.font("Helvetica-Bold").fontSize(28).fillColor(PDF.tinta);
  doc.text(meta.title, PDF.margen, doc.y, { width: anchoUtil(doc) });
  doc.moveDown(0.5);

  const y = doc.y;
  doc.moveTo(PDF.margen, y).lineTo(PDF.margen + 120, y).lineWidth(2).strokeColor(PDF.acento).stroke();
  doc.y = y + 22;

  const dato = (etiqueta: string, valor: string): void => {
    doc.font("Helvetica").fontSize(9.5).fillColor(PDF.gris);
    doc.text(`${etiqueta}  `, PDF.margen, doc.y, { continued: true });
    doc.fillColor(PDF.tinta).text(valor);
    doc.moveDown(0.25);
  };

  if (meta.author) {
    dato("Preparado por", meta.authorTitle ? `${meta.author} — ${meta.authorTitle}` : meta.author);
  }
  if (meta.version != null) dato("Versión", String(meta.version));
  if (meta.date) dato("Fecha", meta.date);

  doc.addPage();
}

export async function renderPdf(markdown: string, meta: DocumentMeta | string): Promise<Buffer> {
  const datos: DocumentMeta = typeof meta === "string" ? { title: meta } : meta;
  const blocks = cuerpoSinTituloRepetido(markdown, datos.title);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: PDF.margen, bottom: PDF.margen, left: PDF.margen, right: PDF.margen },
      info: {
        Title: datos.title,
        Author: datos.author ?? datos.company ?? "Orquestador Agéntico",
        ...(datos.company ? { Subject: `Documento de ${datos.company}` } : {}),
      },
      // El pie se dibuja a mano por página: `bufferPages` permite recorrerlas
      // al final, cuando ya se sabe cuántas son.
      bufferPages: true,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    portadaPdf(doc, datos);

    for (const block of blocks) {
      switch (block.kind) {
        case "heading": {
          const tamaño = PDF.titulos[block.level - 1]!;
          // Un título solo al pie de página es huérfano: se reserva su alto más
          // el de la primera línea de lo que viene abajo.
          asegurarEspacio(doc, tamaño * 2.6);
          doc.moveDown(block.level === 1 ? 0.8 : 0.6);
          doc
            .font("Helvetica-Bold")
            .fontSize(tamaño)
            .fillColor(block.level === 1 ? PDF.acento : PDF.tinta);
          doc.text(sinEmojiRecortado(spansToText(block.spans)), PDF.margen, doc.y, {
            width: anchoUtil(doc),
          });
          doc.moveDown(0.35);
          break;
        }

        case "bullet":
          asegurarEspacio(doc, 24);
          doc.font("Helvetica").fontSize(PDF.cuerpo).fillColor(PDF.tinta);
          doc.text("•", PDF.margen + block.level * 14, doc.y, { continued: false });
          doc.moveUp();
          escribirSpans(doc, block.spans, { indent: block.level * 14 + 14 });
          doc.moveDown(0.15);
          break;

        case "numbered":
          asegurarEspacio(doc, 24);
          doc.font("Helvetica").fontSize(PDF.cuerpo).fillColor(PDF.gris);
          doc.text(`${block.index}.`, PDF.margen + block.level * 14, doc.y);
          doc.moveUp();
          escribirSpans(doc, block.spans, { indent: block.level * 14 + 18 });
          doc.moveDown(0.15);
          break;

        case "quote": {
          asegurarEspacio(doc, 32);
          const inicio = doc.y;
          doc.font("Helvetica-Oblique").fontSize(PDF.cuerpo).fillColor(PDF.gris);
          doc.text(sinEmojiRecortado(spansToText(block.spans)), PDF.margen + 18, doc.y, {
            width: anchoUtil(doc) - 18,
          });
          doc
            .moveTo(PDF.margen + 4, inicio)
            .lineTo(PDF.margen + 4, doc.y)
            .lineWidth(2)
            .strokeColor(PDF.acento)
            .stroke();
          doc.moveDown(0.5);
          break;
        }

        case "code": {
          const alto = doc.heightOfString(block.text, { width: anchoUtil(doc) - 20 }) + 16;
          asegurarEspacio(doc, alto);
          const y = doc.y;
          doc.rect(PDF.margen, y, anchoUtil(doc), alto).fill("#F5F5F5");
          doc.font("Courier").fontSize(9).fillColor(PDF.tinta);
          doc.text(block.text, PDF.margen + 10, y + 8, { width: anchoUtil(doc) - 20 });
          doc.y = y + alto;
          doc.moveDown(0.5);
          break;
        }

        case "image":
          asegurarEspacio(doc, 24);
          doc.font("Helvetica-Oblique").fontSize(PDF.cuerpo - 1).fillColor(PDF.gris);
          doc.text(sinEmojiRecortado(block.alt || "Imagen"), PDF.margen, doc.y, {
            width: anchoUtil(doc),
          });
          doc.moveDown(0.5);
          break;

        case "rule":
          asegurarEspacio(doc, 20);
          doc.moveDown(0.4);
          doc
            .moveTo(PDF.margen, doc.y)
            .lineTo(doc.page.width - PDF.margen, doc.y)
            .lineWidth(0.5)
            .strokeColor(PDF.grisClaro)
            .stroke();
          doc.moveDown(0.6);
          break;

        case "table":
          dibujarTabla(doc, block.header, block.rows);
          break;

        default:
          asegurarEspacio(doc, 28);
          escribirSpans(doc, block.spans);
          doc.moveDown(0.45);
      }
    }

    // Pie en cada página menos la portada, ya con el total conocido.
    const rango = doc.bufferedPageRange();
    for (let i = rango.start; i < rango.start + rango.count; i++) {
      doc.switchToPage(i);
      if (i === rango.start) continue;

      // El pie va **en** el margen inferior, que pdfkit considera fuera del
      // área imprimible: escribir ahí le hace agregar una página por cada pie
      // —el documento terminaba con el doble de páginas y sin numeración—. Se
      // baja el margen mientras se dibuja y se restaura enseguida.
      const margenOriginal = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      const y = doc.page.height - PDF.margen + 12;
      doc.font("Helvetica").fontSize(8).fillColor(PDF.gris);
      if (datos.company) {
        doc.text(datos.company, PDF.margen, y, { lineBreak: false, width: anchoUtil(doc) / 2 });
      }
      doc.text(
        `Página ${i - rango.start} de ${rango.count - 1}`,
        PDF.margen + anchoUtil(doc) / 2,
        y,
        { width: anchoUtil(doc) / 2, align: "right", lineBreak: false },
      );

      doc.page.margins.bottom = margenOriginal;
    }

    doc.flushPages();
    doc.end();
  });
}
