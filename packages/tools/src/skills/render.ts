import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import { parseMarkdown, parseSpans, spansToText, type Block, type Span } from "./markdown.js";

/**
 * Bloques → archivo real.
 *
 * Dos salidas del mismo parseo. Ninguna de las dos librerías toca el disco:
 * devuelven bytes, y quien las llama decide dónde van. Eso mantiene a
 * `packages/tools` sin política de filesystem y hace que los tests puedan
 * verificar el archivo en memoria.
 */

// --- Word -------------------------------------------------------------------

const NIVEL_DOCX = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

const runsDe = (spans: Span[], extra: { size?: number; color?: string } = {}): TextRun[] =>
  spans.map((span) => new TextRun({ text: span.text, bold: span.bold, ...extra }));

function bloqueADocx(block: Block): Paragraph | Table {
  switch (block.kind) {
    case "heading":
      return new Paragraph({
        heading: NIVEL_DOCX[block.level - 1]!,
        children: runsDe(block.spans),
        spacing: { before: 240, after: 120 },
      });

    case "bullet":
      return new Paragraph({
        children: runsDe(block.spans),
        bullet: { level: block.level },
        spacing: { after: 60 },
      });

    case "numbered":
      // Sin numeración automática de Word: exige declarar un `numbering` a
      // nivel documento y se desordena al concatenar listas sueltas. El número
      // explícito es estable y se ve igual.
      return new Paragraph({
        children: runsDe(block.spans),
        bullet: { level: block.level },
        spacing: { after: 60 },
      });

    case "quote":
      return new Paragraph({
        children: runsDe(block.spans, { color: "555555" }),
        indent: { left: 480 },
        spacing: { after: 120 },
      });

    case "code":
      return new Paragraph({
        children: [new TextRun({ text: block.text, font: "Courier New", size: 18 })],
        shading: { fill: "F2F2F2" },
        spacing: { before: 120, after: 120 },
      });

    case "rule":
      return new Paragraph({
        text: "",
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } },
        spacing: { before: 120, after: 120 },
      });

    case "table":
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            tableHeader: true,
            children: block.header.map(
              (celda) =>
                new TableCell({
                  shading: { fill: "EFEFEF" },
                  children: [new Paragraph({ children: [new TextRun({ text: celda, bold: true })] })],
                }),
            ),
          }),
          ...block.rows.map(
            (fila) =>
              new TableRow({
                children: block.header.map(
                  (_, i) =>
                    new TableCell({
                      children: [new Paragraph({ children: runsDe(parseSpans(fila[i] ?? "")) })],
                    }),
                ),
              }),
          ),
        ],
      });

    default:
      return new Paragraph({ children: runsDe(block.spans), spacing: { after: 120 } });
  }
}

/**
 * Bloques del documento, sin repetir el título.
 *
 * El entregable casi siempre empieza con un `# Título` que dice lo mismo que el
 * título del artefacto, y como el documento ya lleva una portada, el nombre
 * aparecía dos veces seguidas. Se compara sin acentos ni mayúsculas porque el
 * agente rara vez escribe exactamente el mismo texto en los dos lugares.
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

export async function renderDocx(markdown: string, title: string): Promise<Buffer> {
  const cuerpo = cuerpoSinTituloRepetido(markdown, title).map(bloqueADocx);

  const doc = new Document({
    creator: "Orquestador Agéntico",
    title,
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: title, bold: true })],
            spacing: { after: 240 },
          }),
          ...cuerpo,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// --- PDF --------------------------------------------------------------------

const TAMAÑO_TITULO = [18, 15, 13];

export async function renderPdf(markdown: string, title: string): Promise<Buffer> {
  const blocks = cuerpoSinTituloRepetido(markdown, title);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: title } });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(22).text(title);
    doc.moveDown(1);

    for (const block of blocks) {
      switch (block.kind) {
        case "heading":
          doc.moveDown(0.6);
          doc.font("Helvetica-Bold").fontSize(TAMAÑO_TITULO[block.level - 1]!);
          doc.text(spansToText(block.spans));
          doc.moveDown(0.3);
          break;

        case "bullet":
        case "numbered":
          doc.font("Helvetica").fontSize(11);
          doc.text(`${"    ".repeat(block.level)}•  ${spansToText(block.spans)}`, {
            paragraphGap: 2,
          });
          break;

        case "quote":
          doc.font("Helvetica-Oblique").fontSize(11).fillColor("#555555");
          doc.text(spansToText(block.spans), { indent: 20 });
          doc.fillColor("#000000");
          break;

        case "code":
          doc.font("Courier").fontSize(9.5);
          doc.text(block.text, { paragraphGap: 6 });
          break;

        case "rule":
          doc.moveDown(0.4);
          doc
            .strokeColor("#CCCCCC")
            .moveTo(doc.page.margins.left, doc.y)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y)
            .stroke();
          doc.moveDown(0.4);
          break;

        case "table":
          // Tabla simple en texto tabulado: pdfkit no trae tablas y armar una
          // con posicionamiento manual se rompe al cortar de página.
          doc.font("Helvetica-Bold").fontSize(10).text(block.header.join("  |  "));
          doc.font("Helvetica").fontSize(10);
          for (const fila of block.rows) doc.text(fila.join("  |  "), { paragraphGap: 1 });
          doc.moveDown(0.5);
          break;

        default:
          doc.font("Helvetica").fontSize(11);
          doc.text(spansToText(block.spans), { align: AlignmentType.LEFT, paragraphGap: 6 });
      }
    }

    doc.end();
  });
}
