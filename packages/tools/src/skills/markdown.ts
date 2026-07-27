/**
 * Markdown → bloques neutros.
 *
 * Los entregables se escriben en markdown, pero Word y PDF no entienden
 * markdown: necesitan párrafos, títulos y listas ya identificados. Este paso
 * intermedio existe para no escribir dos veces el mismo parseo —uno por
 * formato— y para poder testear la interpretación sin generar un archivo.
 *
 * Cubre lo que los agentes usan de verdad: títulos, listas, tablas, citas,
 * código y negritas. Lo que no reconoce cae a párrafo, que es un degradado
 * legible y no una pérdida de contenido.
 */

export type Span = { text: string; bold: boolean };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "bullet"; level: number; spans: Span[] }
  | { kind: "numbered"; level: number; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

/** Separa negritas (`**x**` y `__x__`) del texto plano. */
export function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  // Se limpian marcas que no aportan al documento: enlaces quedan como texto,
  // y el backtick simple no cambia el formato en Word ni en PDF.
  const limpio = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/`/g, "");

  let resto = limpio;
  const negrita = /(\*\*|__)(.+?)\1/;
  let match = negrita.exec(resto);
  while (match) {
    if (match.index > 0) spans.push({ text: resto.slice(0, match.index), bold: false });
    spans.push({ text: match[2]!, bold: true });
    resto = resto.slice(match.index + match[0].length);
    match = negrita.exec(resto);
  }
  if (resto) spans.push({ text: resto, bold: false });

  return spans.length > 0 ? spans : [{ text: "", bold: false }];
}

/** Texto plano de una línea de tabla, sin los pipes de los bordes. */
function celdas(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((celda) => celda.trim());
}

const esSeparadorDeTabla = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let parrafo: string[] = [];

  const cerrarParrafo = (): void => {
    if (parrafo.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseSpans(parrafo.join(" ")) });
    parrafo = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      cerrarParrafo();
      continue;
    }

    // Bloque de código: se toma literal hasta el cierre, sin interpretar nada.
    if (trimmed.startsWith("```")) {
      cerrarParrafo();
      const cuerpo: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        cuerpo.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "code", text: cuerpo.join("\n") });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      cerrarParrafo();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      cerrarParrafo();
      // Más de tres niveles no aportan jerarquía legible en un documento.
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, spans: parseSpans(heading[2]!) });
      continue;
    }

    // Tabla: la fila de encabezado se reconoce por el separador que la sigue.
    if (trimmed.includes("|") && i + 1 < lines.length && esSeparadorDeTabla(lines[i + 1]!)) {
      cerrarParrafo();
      const header = celdas(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(celdas(lines[i]!));
        i++;
      }
      i--;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      cerrarParrafo();
      blocks.push({ kind: "quote", spans: parseSpans(quote[1]!) });
      continue;
    }

    // La sangría define el nivel de anidamiento: dos espacios por nivel.
    const sangria = /^(\s*)/.exec(line)![1]!.length;
    const nivel = Math.min(Math.floor(sangria / 2), 3);

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      cerrarParrafo();
      // Las casillas de checklist se conservan como texto: marcan estado.
      blocks.push({ kind: "bullet", level: nivel, spans: parseSpans(bullet[1]!) });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      cerrarParrafo();
      blocks.push({ kind: "numbered", level: nivel, spans: parseSpans(numbered[1]!) });
      continue;
    }

    parrafo.push(trimmed);
  }

  cerrarParrafo();
  return blocks;
}

/** Texto plano de un bloque, para el PDF y para los asserts de los tests. */
export function spansToText(spans: Span[]): string {
  return spans.map((span) => span.text).join("");
}
