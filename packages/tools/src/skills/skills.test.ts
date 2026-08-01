import { describe, expect, it } from "vitest";
import { parseMarkdown, parseSpans, spansToText } from "./markdown.js";
import { cuerpoSinTituloRepetido, renderDocx, renderPdf } from "./render.js";
import { createSkillTools, type SkillStorage, sinVersionEnNombre } from "./index.js";
import type { AgentWorkspace, ToolContext } from "../types.js";

/**
 * Las habilidades producen un archivo real que alguien va a abrir. Un markdown
 * mal interpretado no rompe nada visible acá adentro: se nota recién al abrir
 * el Word y encontrar los `##` como texto.
 */

describe("markdown a bloques", () => {
  it("reconoce títulos, listas, tablas, citas y código", () => {
    const blocks = parseMarkdown(
      [
        "# Plan de venta",
        "",
        "Texto con **algo en negrita** y un [link](https://ejemplo.com).",
        "",
        "## Riesgos",
        "- Listas sin paginar",
        "  - non-conformities",
        "1. Primero esto",
        "",
        "> Nota importante",
        "",
        "| Endpoint | Estado |",
        "|---|---|",
        "| photos | keyset |",
        "| projects | pendiente |",
        "",
        "```sql",
        "SELECT 1;",
        "```",
        "---",
      ].join("\n"),
    );

    const tipos = blocks.map((block) => block.kind);
    expect(tipos).toContain("heading");
    expect(tipos).toContain("bullet");
    expect(tipos).toContain("numbered");
    expect(tipos).toContain("quote");
    expect(tipos).toContain("table");
    expect(tipos).toContain("code");
    expect(tipos).toContain("rule");

    const tabla = blocks.find((block) => block.kind === "table");
    expect(tabla).toMatchObject({
      header: ["Endpoint", "Estado"],
      rows: [
        ["photos", "keyset"],
        ["projects", "pendiente"],
      ],
    });

    // El separador de la tabla no puede colarse como una fila de datos.
    expect(tabla && "rows" in tabla ? tabla.rows : []).toHaveLength(2);

    const codigo = blocks.find((block) => block.kind === "code");
    expect(codigo).toMatchObject({ text: "SELECT 1;" });

    // La sangría define el anidamiento de la lista.
    const anidado = blocks.find(
      (block) => block.kind === "bullet" && spansToText(block.spans) === "non-conformities",
    );
    expect(anidado).toMatchObject({ level: 1 });
  });

  it("separa la negrita del texto plano", () => {
    const spans = parseSpans("Estado **verificado** hoy");
    expect(spans).toEqual([
      { text: "Estado ", bold: false },
      { text: "verificado", bold: true },
      { text: " hoy", bold: false },
    ]);
  });

  it("conserva el destino de un enlace en vez de tragárselo", () => {
    // En un documento impreso el href no se puede clickear: si se descarta,
    // el lector pierde la referencia.
    expect(spansToText(parseSpans("Ver [el mapa](https://x.com/y)"))).toBe(
      "Ver el mapa (https://x.com/y)",
    );
  });

  it("junta las líneas sueltas de un párrafo en uno solo", () => {
    const blocks = parseMarkdown("Una idea\nque sigue en\ntres líneas.");
    expect(blocks).toHaveLength(1);
    expect(spansToText(blocks[0]!.kind === "paragraph" ? blocks[0]!.spans : [])).toBe(
      "Una idea que sigue en tres líneas.",
    );
  });

  it("no interpreta markdown dentro de un bloque de código", () => {
    const blocks = parseMarkdown(["```", "# esto no es un título", "- ni una lista", "```"].join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code" });
  });
});

describe("título de portada", () => {
  // El agente abre el entregable con "# Plan de paginación" y el artefacto ya
  // se llama así: el documento mostraba el nombre dos veces, una debajo de la
  // otra. Se prueba acá, sobre la decisión, y no sobre los bytes del .docx: el
  // XML va comprimido dentro del zip y no se puede buscar texto en él.
  it("descarta el primer encabezado si repite el título", () => {
    const cuerpo = cuerpoSinTituloRepetido("# Plan de Paginación\n\nTexto.", "plan de paginacion");
    expect(cuerpo).toHaveLength(1);
    expect(cuerpo[0]).toMatchObject({ kind: "paragraph" });
  });

  it("ignora acentos y mayúsculas al comparar", () => {
    // El agente rara vez escribe exactamente el mismo texto en los dos lugares.
    expect(cuerpoSinTituloRepetido("## PLAN DE PAGINACION\n", "Plan de Paginación")).toHaveLength(0);
  });

  it("conserva un primer encabezado que dice otra cosa", () => {
    const cuerpo = cuerpoSinTituloRepetido("# Resumen ejecutivo\n\nTexto.", "Plan de paginación");
    expect(cuerpo).toHaveLength(2);
    expect(cuerpo[0]).toMatchObject({ kind: "heading" });
  });

  it("no toca el cuerpo si arranca con un párrafo", () => {
    expect(cuerpoSinTituloRepetido("Plan de paginación\n", "Plan de paginación")).toHaveLength(1);
  });
});

describe("archivos generados", () => {
  const markdown = [
    "# Título",
    "",
    "Un párrafo con **negrita**.",
    "",
    "## Pasos",
    "1. Primero",
    "2. Segundo",
    "",
    "| Endpoint | Estado |",
    "|---|---|",
    "| photos | keyset |",
  ].join("\n");

  const meta = {
    title: "Plan de paginación",
    company: "INSPIA",
    author: "Lucas",
    authorTitle: "Desarrollador",
    version: 3,
    date: "26 de julio de 2026",
  };

  it("el .docx es un zip con el XML de Word adentro", async () => {
    const bytes = await renderDocx(markdown, meta);

    // Un .docx es un zip: tiene que empezar con la firma PK.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.toString("latin1")).toContain("word/document.xml");
  });

  it("el .docx trae portada, numeración, encabezado y pie", async () => {
    const xml = await docxXml(renderDocx(markdown, meta));

    // Portada: quién lo emite y quién lo firma.
    expect(xml).toContain("INSPIA");
    expect(xml).toContain("Lucas");
    expect(xml).toContain("Desarrollador");
    expect(xml).toContain("26 de julio de 2026");
    // Salto de página entre portada y cuerpo.
    expect(xml).toContain("<w:br w:type=\"page\"/>");
    // Lista numerada de verdad, no viñetas.
    expect(xml).toContain("<w:numPr>");
    // Tabla con bordes.
    expect(xml).toContain("<w:tbl>");
  });

  it("el .docx numera las páginas en el pie", async () => {
    const partes = await docxPartes(renderDocx(markdown, meta));
    const pie = partes.find((p) => p.startsWith("word/footer"));
    expect(pie).toBeDefined();
    const encabezado = partes.find((p) => p.startsWith("word/header"));
    expect(encabezado).toBeDefined();
  });

  it("el .pdf declara su versión, autor y termina bien", async () => {
    const bytes = await renderPdf(markdown, meta);
    const texto = bytes.toString("latin1");

    expect(texto.startsWith("%PDF-")).toBe(true);
    // Sin el EOF el visor lo da por corrupto.
    expect(texto.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(texto).toContain("/Title");
    expect(texto).toContain("/Author");
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("el .pdf tiene portada aparte del cuerpo", async () => {
    // Con portada, el documento más corto ya son dos páginas.
    expect(paginas(await renderPdf("Una línea.", meta))).toBe(2);
  });

  it("no agrega páginas en blanco al numerar el pie", async () => {
    // pdfkit agrega una página cada vez que se escribe debajo del margen
    // inferior. Con el pie por página el documento salía con el doble de
    // páginas, la mitad vacías, y sin numeración visible.
    const bytes = await renderPdf("Una línea corta.", meta);
    expect(paginas(bytes)).toBe(2); // portada + cuerpo, nada más
  });

  it("no se cae con un entregable vacío", async () => {
    await expect(renderDocx("", { title: "Vacío" })).resolves.toBeInstanceOf(Buffer);
    await expect(renderPdf("", { title: "Vacío" })).resolves.toBeInstanceOf(Buffer);
  });

  it("acepta solo el título, sin metadatos", async () => {
    // Compatibilidad: quien no tenga los datos de portada sigue pudiendo generar.
    await expect(renderDocx(markdown, "Sin metadatos")).resolves.toBeInstanceOf(Buffer);
    await expect(renderPdf(markdown, "Sin metadatos")).resolves.toBeInstanceOf(Buffer);
  });
});

describe("herramienta de exportación", () => {
  const guardados: Array<{ filename: string; folder?: string; bytes: Buffer }> = [];
  /** Archivos que "existen" en el almacenamiento falso. */
  const enDisco = new Map<string, boolean>([
    ["media/captura.png", true],
    ["informes/plan-v1.pdf", false],
  ]);

  const storage: SkillStorage = {
    async list() {
      return [...enDisco].map(([path, esMultimedia]) => ({
        path,
        sizeBytes: 1024,
        esMultimedia,
        generadoPorAgente: true,
      }));
    },
    async remove(path) {
      if (!enDisco.has(path)) return { ok: false, motivo: "El archivo no existe." };
      enDisco.delete(path);
      return { ok: true };
    },
    async removeMany() {
      return { borrados: [], fallidos: [] };
    },
    async writeText(path, content) {
      return { ok: true, path, sizeBytes: content.length };
    },
    async resolve() {
      return null;
    },
    async save(input) {
      guardados.push(input);
      const path = input.folder ? `${input.folder}/${input.filename}` : input.filename;
      return { url: `/api/exports/${path}`, path, sizeBytes: input.bytes.length };
    },
  };

  const workspaceCon = (artefactos: Array<{ key: string; content: string }>): AgentWorkspace =>
    new Proxy({} as AgentWorkspace, {
      get(_t, prop) {
        if (prop === "readArtifact")
          return async (key: string) => {
            const encontrado = artefactos.find((a) => a.key === key);
            return encontrado
              ? { ...encontrado, title: "Doc", version: 2, createdAt: 1_800_000_000_000 }
              : null;
          };
        if (prop === "listArtifacts")
          return async () => artefactos.map((a) => ({ ...a, title: "Doc", version: 2 }));
        if (prop === "company") return { name: "INSPIA" };
        return () => {
          throw new Error(`no esperado: ${String(prop)}`);
        };
      },
    });

  const ctx = (artefactos: Array<{ key: string; content: string }>): ToolContext =>
    ({
      workspace: workspaceCon(artefactos),
      actor: { name: "Lucas", title: "Desarrollador", authority: "executive" },
    }) as unknown as ToolContext;

  const skills = createSkillTools(storage);

  it("registra exportar, listar y borrar, todas con origen propio", () => {
    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "delete_files",
      "export_docx",
      "export_pdf",
      "export_slides",
      "export_video",
      "list_output",
      "write_output_file",
    ]);
    expect(skills.every((skill) => skill.origin === "skill")).toBe(true);
    // Las que escriben o borran no pueden correr en paralelo como las de lectura.
    expect(skills.find((s) => s.name === "export_docx")?.readOnly).toBe(false);
    expect(skills.find((s) => s.name === "delete_files")?.readOnly).toBe(false);
    expect(skills.find((s) => s.name === "list_output")?.readOnly).toBe(true);
  });

  it("exporta a un archivo por entregable, sin la versión en el nombre", async () => {
    // Con `-vN` en el nombre, cada re-exportación dejaba otro archivo: pedías
    // un PDF y terminabas con v1, v2 y v3 conviviendo. La versión va en la
    // portada, que es donde se lee.
    const docx = skills.find((skill) => skill.name === "export_docx")!;
    const result = await docx.execute({ artifact_key: "plan" }, ctx([{ key: "plan", content: "# Hola" }]));

    expect(result.ok).toBe(true);
    expect(guardados.at(-1)?.filename).toBe("plan.docx");
    expect(guardados.at(-1)?.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("se lleva los archivos con versión que dejó la forma vieja", async () => {
    const borrados: string[] = [];
    const conViejos: SkillStorage = {
      ...storage,
      async list() {
        return ["plan-v1.pdf", "plan-v2.pdf", "plan-v1.docx", "otro-v1.pdf"].map((path) => ({
          path,
          sizeBytes: 10,
          esMultimedia: false,
          generadoPorAgente: true,
        }));
      },
      async remove(path) {
        borrados.push(path);
        return { ok: true };
      },
    };

    const pdf = createSkillTools(conViejos).find((skill) => skill.name === "export_pdf")!;
    await pdf.execute({ artifact_key: "plan" }, ctx([{ key: "plan", content: "# Hola" }]));

    // Solo los del mismo entregable y formato: ni el .docx ni el de otra clave.
    expect(borrados).toEqual(["plan-v1.pdf", "plan-v2.pdf"]);
  });

  it("cuando la clave no existe, dice cuáles hay", async () => {
    const pdf = skills.find((skill) => skill.name === "export_pdf")!;
    const result = await pdf.execute(
      { artifact_key: "inventada" },
      ctx([{ key: "plan", content: "x" }]),
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("plan");
  });

  it("sin entregables, manda a escribir primero en vez de listar la nada", async () => {
    const pdf = skills.find((skill) => skill.name === "export_pdf")!;
    const result = await pdf.execute({ artifact_key: "plan" }, ctx([]));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("write_artifact");
  });

  it("rechaza la clave en blanco", async () => {
    const docx = skills.find((skill) => skill.name === "export_docx")!;
    const result = await docx.execute({ artifact_key: "   " }, ctx([{ key: "plan", content: "x" }]));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("artifact_key");
  });
});

describe("limpieza del directorio de salida por el agente", () => {
  const archivos = () =>
    new Map<string, boolean>([
      ["media/captura.png", true],
      ["media/demo.mp4", true],
      ["informes/plan-v1.pdf", false],
      ["informe-estado-v3.docx", false],
    ]);

  function conArchivos() {
    const enDisco = archivos();
    const storage: SkillStorage = {
      async save() {
        throw new Error("no esperado");
      },
      async list() {
        return [...enDisco].map(([path, esMultimedia]) => ({
          path,
          sizeBytes: 2048,
          esMultimedia,
          generadoPorAgente: !path.startsWith("externo/"),
        }));
      },
      async remove(path) {
        if (!enDisco.has(path)) return { ok: false, motivo: "El archivo no existe." };
        enDisco.delete(path);
        return { ok: true };
      },
      async removeMany({ kind, folder }) {
        const objetivo = [...enDisco].filter(([path, esMultimedia]) => {
          if (folder && !path.startsWith(`${folder}/`)) return false;
          if (kind === "all") return true;
          return kind === "multimedia" ? esMultimedia : !esMultimedia;
        });
        objetivo.forEach(([path]) => enDisco.delete(path));
        return { borrados: objetivo.map(([path]) => path), fallidos: [] };
      },
      async writeText(path, content) {
        enDisco.set(path, false);
        return { ok: true, path, sizeBytes: content.length };
      },
      async resolve() {
        return null;
      },
    };
    const tools = createSkillTools(storage);
    // Ejecutivo: acá se prueba la mecánica del borrado, no la jerarquía. Esa
    // tiene sus propios casos en permisos.test.ts.
    const ctx = { actor: { authority: "executive" } } as unknown as ToolContext;
    return {
      enDisco,
      descripcion: tools.find((t) => t.name === "delete_files")!.description,
      listar: () => tools.find((t) => t.name === "list_output")!.execute({}, ctx),
      borrar: (args: Record<string, unknown>) =>
        tools.find((t) => t.name === "delete_files")!.execute(args, ctx),
      escribir: (args: Record<string, unknown>) =>
        tools.find((t) => t.name === "write_output_file")!.execute(args, ctx),
    };
  }

  it("el listado dice si se puede borrar, no solo de dónde vino", async () => {
    // Decir solo "externo" de un multimedia hacía que el agente lo saltara,
    // aunque la regla sí permite borrarlo. La etiqueta tiene que ser el permiso.
    const { listar } = conArchivos();
    const result = await listar();

    expect(result.ok).toBe(true);
    expect(result.content).toContain("SE PUEDE BORRAR");
    expect(result.content).toContain("de la empresa");
  });

  it("borra cualquier archivo, incluidos los entregables", async () => {
    const { enDisco, borrar } = conArchivos();
    for (const path of [...enDisco.keys()]) await borrar({ path });
    expect([...enDisco.keys()]).toEqual([]);
  });

  it("avisa cuando el archivo no existe en vez de decir que lo borró", async () => {
    const { borrar } = conArchivos();
    const result = await borrar({ path: "no/existe.png" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("no existe");
  });

  it("\"borrá toda la multimedia\" es UNA llamada, no una por archivo", async () => {
    // Encadenar una llamada por archivo hace que el agente falle a la mitad y
    // deje el directorio en un estado intermedio que nadie pidió.
    const { enDisco, borrar } = conArchivos();
    const result = await borrar({ kind: "multimedia" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Borrados 2");
    expect([...enDisco.keys()].sort()).toEqual(["informe-estado-v3.docx", "informes/plan-v1.pdf"]);
  });

  it("borra todo cuando se lo piden", async () => {
    const { enDisco, borrar } = conArchivos();
    await borrar({ kind: "all" });
    expect([...enDisco.keys()]).toEqual([]);
  });

  it("acota el borrado a una carpeta", async () => {
    const { enDisco, borrar } = conArchivos();
    await borrar({ kind: "all", folder: "media" });

    expect([...enDisco.keys()].sort()).toEqual(["informe-estado-v3.docx", "informes/plan-v1.pdf"]);
  });

  it("no adivina qué borrar si no se lo dicen", async () => {
    const { enDisco, borrar } = conArchivos();
    const result = await borrar({});

    expect(result.ok).toBe(false);
    expect(result.content).toContain("list_output");
    expect([...enDisco.keys()]).toHaveLength(4);
  });

  it("con path y kind juntos, gana la ruta concreta", async () => {
    // Los modelos completan todos los campos del esquema aunque solo uno
    // aplique. Rechazar la llamada por eso dejaba la herramienta inusable.
    const { enDisco, borrar } = conArchivos();
    const result = await borrar({ path: "media/captura.png", kind: "all" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("se ignoró kind");
    expect(enDisco.has("media/captura.png")).toBe(false);
    // Y no se llevó el resto por el `kind` que mandó de más.
    expect(enDisco.size).toBe(3);
  });

  it("informa cuando no había nada que borrar", async () => {
    const { borrar } = conArchivos();
    await borrar({ kind: "all" });
    const result = await borrar({ kind: "all" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No había nada");
  });

  it("la descripción advierte que no hay papelera", async () => {
    const { descripcion } = conArchivos();
    expect(descripcion).toContain("NO HAY PAPELERA");
  });

  it("pide la ruta en vez de adivinar", async () => {
    const { borrar } = conArchivos();
    const result = await borrar({ path: "   " });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("list_output");
  });
});

describe("crear y modificar documentos", () => {
  function conStorage() {
    const escritos = new Map<string, string>();
    const storage: SkillStorage = {
      async save() {
        throw new Error("no esperado");
      },
      async list() {
        return [...escritos.keys()].map((path) => ({
          path,
          sizeBytes: 10,
          esMultimedia: false,
          generadoPorAgente: true,
        }));
      },
      async remove() {
        return { ok: true };
      },
      async removeMany() {
        return { borrados: [], fallidos: [] };
      },
      async writeText(path, content) {
        escritos.set(path, content);
        return { ok: true, path, sizeBytes: content.length };
      },
      async resolve() {
        return null;
      },
    };
    const tools = createSkillTools(storage);
    // Ejecutivo: acá se prueba la mecánica del borrado, no la jerarquía. Esa
    // tiene sus propios casos en permisos.test.ts.
    const ctx = { actor: { authority: "executive" } } as unknown as ToolContext;
    return {
      escritos,
      escribir: (args: Record<string, unknown>) =>
        tools.find((t) => t.name === "write_output_file")!.execute(args, ctx),
    };
  }

  it("crea un documento en el directorio de salida", async () => {
    const { escritos, escribir } = conStorage();
    const result = await escribir({ path: "informes/notas.md", content: "# Notas\n\nAlgo." });

    expect(result.ok).toBe(true);
    expect(escritos.get("informes/notas.md")).toContain("# Notas");
  });

  it("modificar es reemplazar: el contenido nuevo pisa al viejo", async () => {
    const { escritos, escribir } = conStorage();
    await escribir({ path: "notas.md", content: "primera versión" });
    await escribir({ path: "notas.md", content: "corregido" });

    expect(escritos.get("notas.md")).toBe("corregido");
    expect(escritos.size).toBe(1);
  });

  it("se niega a escribir un archivo vacío", async () => {
    const { escritos, escribir } = conStorage();
    const result = await escribir({ path: "vacio.md", content: "   " });

    expect(result.ok).toBe(false);
    expect(escritos.size).toBe(0);
  });

  it("pide la ruta en vez de inventarla", async () => {
    const { escribir } = conStorage();
    expect((await escribir({ content: "algo" })).ok).toBe(false);
  });
});

/**
 * Un `.docx` es un zip: para verificar el contenido hay que descomprimirlo.
 * Buscar texto en los bytes crudos solo encuentra los nombres de las entradas,
 * que van sin comprimir, y da una falsa sensación de cobertura.
 */
async function docxPartes(promesa: Promise<Buffer>): Promise<string[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await promesa);
  return Object.keys(zip.files);
}

async function docxXml(promesa: Promise<Buffer>): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await promesa);
  const partes = await Promise.all(
    Object.keys(zip.files)
      .filter((nombre) => nombre.endsWith(".xml"))
      .map((nombre) => zip.files[nombre]!.async("string")),
  );
  return partes.join("\n");
}

/** Cuenta las páginas de un PDF por sus objetos `/Type /Page`. */
function paginas(bytes: Buffer): number {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe("tablas que los agentes escriben de verdad", () => {
  // Formas observadas en entregables reales: filas agrupadas con la primera
  // celda vacía, una línea en blanco entre grupos, negritas y emoji.
  const tabla = [
    "| Rol | Capacidad | Soporta demo |",
    "|---|---|---|",
    "| **Inspector** | Login | ✅ Sí |",
    "| | Checklists | ✅ Sí |",
    "",
    "| **Director** | Login | ✅ Sí |",
    "| | Cotizaciones | ⚠️ Limitado |",
  ].join("\n");

  it("una línea en blanco entre grupos no parte la tabla", () => {
    // Antes se cortaba ahí y el resto de las filas salía como texto suelto,
    // con los pipes a la vista en medio del documento.
    const bloques = parseMarkdown(tabla);
    const tablas = bloques.filter((bloque) => bloque.kind === "table");

    expect(tablas).toHaveLength(1);
    expect(tablas[0]!.kind === "table" && tablas[0]!.rows).toHaveLength(4);
    // Y ninguna fila quedó suelta como párrafo.
    expect(bloques.some((bloque) => bloque.kind === "paragraph")).toBe(false);
  });

  it("el PDF sale sin emoji y sin asteriscos a la vista", async () => {
    // Helvetica usa WinAnsi: un emoji sale como mojibake, y los `**` sin
    // interpretar se imprimen tal cual dentro de la celda.
    const bytes = await renderPdf(tabla, { title: "Capacidad" });
    const texto = descomprimirPdf(bytes);

    expect(texto).not.toContain("*");
    expect(texto).toContain("Inspector");
    expect(texto).toContain("Limitado");
  });
});

/** Texto dibujado en un PDF, decodificando las cadenas hexadecimales. */
function descomprimirPdf(bytes: Buffer): string {
  const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
  const crudo = bytes.toString("latin1");
  const flujos = crudo.match(/stream\r?\n([\s\S]*?)\r?\nendstream/g) ?? [];

  return flujos
    .map((flujo) => {
      const cuerpo = flujo.replace(/^stream\r?\n/, "").replace(/\r?\nendstream$/, "");
      try {
        return inflateSync(Buffer.from(cuerpo, "latin1")).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("")
    .replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
      Buffer.from(hex, "hex").toString("latin1"),
    );
}

describe("la versión no va en el nombre del archivo", () => {
  it("saca el sufijo y deja carpeta y extensión", () => {
    expect(sinVersionEnNombre("comercial/paquete-comercial-v25.md")).toBe(
      "comercial/paquete-comercial.md",
    );
    expect(sinVersionEnNombre("informe_v3.csv")).toBe("informe.csv");
    expect(sinVersionEnNombre("notas-V12.md")).toBe("notas.md");
  });

  it("no toca lo que no es una versión al final", () => {
    // Un nombre puede terminar en número sin ser una versión.
    expect(sinVersionEnNombre("comercial/plan-2026.md")).toBe("comercial/plan-2026.md");
    expect(sinVersionEnNombre("ruta/v2/informe.md")).toBe("ruta/v2/informe.md");
    // Y si sacarle la versión no deja nombre, se respeta el original.
    expect(sinVersionEnNombre("v2.md")).toBe("v2.md");
  });
});
