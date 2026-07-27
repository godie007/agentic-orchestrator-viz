import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExportStore,
  contentTypeOf,
  esMultimedia,
  previewDe,
  type TreeFile,
  type TreeFolder,
} from "./exports.js";
import { renderDocx } from "@orq/tools";

/**
 * El directorio de salida recibe rutas que propone un agente, y un prompt puede
 * influirlas. Todo lo que entra se sanea segmento por segmento: se borra y se
 * lee dentro del directorio de la empresa y en ningún otro lado.
 */

let dir: string;
let store: ExportStore;
const empresa = "cmp_test";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orq-exp-"));
  store = new ExportStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const guardar = (filename: string, folder?: string, contenido = "x") =>
  store.forCompany(empresa).save({
    filename,
    ...(folder ? { folder } : {}),
    bytes: Buffer.from(contenido),
  });

/** Aplana el árbol a rutas, para comparar sin escribir estructuras anidadas. */
const rutas = (nodo: TreeFolder): string[] =>
  nodo.children.flatMap((hijo) =>
    hijo.kind === "folder" ? [`${hijo.path}/`, ...rutas(hijo)] : [hijo.path],
  );

describe("saneo de rutas", () => {
  it("no deja escapar del directorio de la empresa", async () => {
    await guardar("../../../robado.docx");
    const arbol = await store.tree(empresa);

    // El archivo existe, pero adentro y con el nombre neutralizado.
    expect(rutas(arbol)).toEqual(["robado.docx"]);
    expect(readFileSync(join(dir, empresa, "robado.docx"), "utf8")).toBe("x");
  });

  it("neutraliza el escape también en la carpeta", async () => {
    await guardar("informe.pdf", "../../fuera/../../mas-fuera");
    const planas = rutas(await store.tree(empresa));
    expect(planas.every((ruta) => !ruta.includes(".."))).toBe(true);
    expect(planas).toContain("fuera/mas-fuera/informe.pdf");
  });

  it("corta la profundidad en vez de esconder archivos", () => {
    // Un árbol de diez niveles no organiza: oculta.
    expect(ExportStore.safePath("a/b/c/d/e/f/g/h")).toHaveLength(6);
  });

  it("una ruta que se sanea a nada no borra ni lee nada", async () => {
    expect(await store.createFolder(empresa, "../..")).toBeNull();
    expect(await store.read(empresa, "..")).toBeNull();
    expect(await store.remove(empresa, "///")).toMatchObject({ ok: false });
  });
});

describe("carpetas", () => {
  it("las crea sola al exportar dentro de una que no existe", async () => {
    const guardado = await guardar("informe-estado-v3.pdf", "comercial/propuestas");
    expect(guardado.path).toBe("comercial/propuestas/informe-estado-v3.pdf");
    expect(readFileSync(join(dir, empresa, "comercial", "propuestas", "informe-estado-v3.pdf"), "utf8")).toBe("x");
  });

  it("se pueden crear vacías desde la UI", async () => {
    expect(await store.createFolder(empresa, "Área Comercial/2026")).toBe("Area-Comercial/2026");
    const arbol = await store.tree(empresa);
    expect(rutas(arbol)).toContain("Area-Comercial/");
  });

  it("ordena carpetas antes que archivos y alfabéticamente", async () => {
    await guardar("zeta.pdf");
    await guardar("alfa.pdf");
    await guardar("doc.pdf", "tecnico");
    await guardar("doc.pdf", "comercial");

    const arbol = await store.tree(empresa);
    expect(arbol.children.map((hijo) => hijo.name)).toEqual([
      "comercial",
      "tecnico",
      "alfa.pdf",
      "zeta.pdf",
    ]);
  });

  it("el árbol informa tamaño y distingue multimedia de entregable", async () => {
    await guardar("captura.png", "media", "imagen");
    await guardar("informe.pdf");

    const arbol = await store.tree(empresa);
    const archivos = arbol.children
      .flatMap((hijo) => (hijo.kind === "folder" ? hijo.children : [hijo]))
      .filter((hijo): hijo is TreeFile => hijo.kind === "file");

    expect(archivos.find((a) => a.name === "captura.png")).toMatchObject({
      esMultimedia: true,
      sizeBytes: 6,
    });
    expect(archivos.find((a) => a.name === "informe.pdf")?.esMultimedia).toBe(false);
  });
});

describe("borrado", () => {
  it("borra una imagen", async () => {
    await guardar("captura.png", "media");
    expect(await store.remove(empresa, "media/captura.png")).toEqual({ ok: true });
    expect(rutas(await store.tree(empresa))).not.toContain("media/captura.png");
  });

  // La restricción a multimedia se levantó por decisión explícita: se borra
  // cualquier archivo. Lo que sigue en pie es el saneo de la ruta.
  const borrables = ["informe.pdf", "informe.docx", "notas.md", "config.json"];
  for (const nombre of borrables) {
    it(`borra ${nombre} igual que un multimedia`, async () => {
      await guardar(nombre);
      expect(await store.remove(empresa, nombre)).toEqual({ ok: true });
      expect(rutas(await store.tree(empresa))).not.toContain(nombre);
    });
  }

  it("no borra una carpeta: el borrado es de archivos", async () => {
    mkdirSync(join(dir, empresa, "trampa.mp4"), { recursive: true });
    writeFileSync(join(dir, empresa, "trampa.mp4", "adentro.pdf"), "importante");

    const resultado = await store.remove(empresa, "trampa.mp4");
    expect(resultado.ok).toBe(false);
    expect(readFileSync(join(dir, empresa, "trampa.mp4", "adentro.pdf"), "utf8")).toBe("importante");
  });

  it("avisa cuando el archivo no existe en vez de decir que lo borró", async () => {
    expect(await store.remove(empresa, "media/fantasma.png")).toMatchObject({ ok: false });
  });
});

describe("qué puede borrar un agente", () => {
  /** Un archivo que trajo una persona: el store no lo registró como generado. */
  const traidoAMano = (nombre: string, contenido = "importante") => {
    mkdirSync(join(dir, empresa), { recursive: true });
    writeFileSync(join(dir, empresa, nombre), contenido);
  };

  it("borra lo que generó la empresa", async () => {
    await guardar("informe.pdf");
    expect(await store.removeComoAgente(empresa, "informe.pdf")).toEqual({ ok: true });
  });

  it("borra multimedia aunque no la haya generado la empresa", async () => {
    // Una captura suelta es apoyo: limpiarla no le cuesta nada a nadie.
    traidoAMano("captura.png");
    expect(await store.removeComoAgente(empresa, "captura.png")).toEqual({ ok: true });
  });

  it("no toca un documento que trajo una persona", async () => {
    traidoAMano("contrato-firmado.pdf");
    const resultado = await store.removeComoAgente(empresa, "contrato-firmado.pdf");

    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.motivo).toContain("no lo generó la empresa");
    // Y sigue estando: negarse no puede dejarlo a medio borrar.
    expect(readFileSync(join(dir, empresa, "contrato-firmado.pdf"), "utf8")).toBe("importante");
  });

  it("un borrado en lote tampoco se lleva lo externo", async () => {
    // "Borrá todo" no es una excusa para llevarse un archivo ajeno.
    await guardar("generado.pdf");
    traidoAMano("contrato-firmado.pdf");

    const { borrados, fallidos } = await store.removeMany(empresa, { kind: "all" });

    expect(borrados).toEqual(["generado.pdf"]);
    expect(fallidos.map((f) => f.path)).toEqual(["contrato-firmado.pdf"]);
  });

  it("desde la UI se borra igual: ahí decide una persona", async () => {
    traidoAMano("contrato-firmado.pdf");
    expect(await store.remove(empresa, "contrato-firmado.pdf")).toEqual({ ok: true });
  });

  it("el árbol dice de dónde vino cada archivo", async () => {
    await guardar("generado.pdf");
    traidoAMano("externo.pdf");

    const archivos = await store.flatList(empresa);
    expect(archivos.find((a) => a.path === "generado.pdf")?.generadoPorAgente).toBe(true);
    expect(archivos.find((a) => a.path === "externo.pdf")?.generadoPorAgente).toBe(false);
  });

  it("el manifiesto no aparece como un archivo más", async () => {
    await guardar("generado.pdf");
    const archivos = await store.flatList(empresa);
    expect(archivos.map((a) => a.path)).toEqual(["generado.pdf"]);
  });

  it("un archivo borrado y vuelto a traer a mano deja de ser propio", async () => {
    // Si el registro no se limpiara, el agente podría borrar un archivo ajeno
    // que quedó con el mismo nombre que uno que la empresa borró antes.
    await guardar("informe.pdf");
    await store.removeComoAgente(empresa, "informe.pdf");
    traidoAMano("informe.pdf");

    expect(await store.removeComoAgente(empresa, "informe.pdf")).toMatchObject({ ok: false });
  });
});

describe("reconocimiento de multimedia y tipos", () => {
  // Ya no define permisos, pero distingue apoyo de entregable en la UI.
  it("reconoce imagen, video y audio, sin importar mayúsculas", () => {
    for (const nombre of ["a.PNG", "b.mp4", "c.Mp3", "d.webp", "e.flac"]) {
      expect(esMultimedia(nombre)).toBe(true);
    }
    for (const nombre of ["a.pdf", "b.docx", "sin-extension", "c.exe"]) {
      expect(esMultimedia(nombre)).toBe(false);
    }
  });

  it("declara el tipo correcto para que el navegador sepa qué hacer", () => {
    expect(contentTypeOf("x.pdf")).toBe("application/pdf");
    expect(contentTypeOf("x.png")).toBe("image/png");
    expect(contentTypeOf("x.docx")).toContain("wordprocessingml");
    expect(contentTypeOf("x.desconocido")).toBe("application/octet-stream");
  });
});

describe("vista previa", () => {
  it("el PDF y las imágenes las dibuja el navegador", async () => {
    expect(await previewDe("informe.pdf", Buffer.from("%PDF-1.4"))).toEqual({ kind: "pdf" });
    expect(await previewDe("captura.PNG", Buffer.from("x"))).toEqual({ kind: "image" });
  });

  it("el texto se devuelve tal cual", async () => {
    const preview = await previewDe("notas.md", Buffer.from("# Hola\n\nAlgo.", "utf8"));
    expect(preview).toMatchObject({ kind: "text" });
    expect(preview.text).toContain("# Hola");
  });

  it("extrae el texto de un .docx real, con párrafos separados", async () => {
    // Word no lo abre el navegador: sin esto, el único formato que la empresa
    // produce en Word sería justo el que no se puede revisar antes de mandarlo.
    const bytes = await renderDocx("# Informe\n\nPrimer párrafo.\n\nSegundo párrafo.", {
      title: "Informe",
    });
    const preview = await previewDe("informe.docx", bytes);

    expect(preview.kind).toBe("text");
    expect(preview.text).toContain("Primer párrafo.");
    expect(preview.text).toContain("Segundo párrafo.");
    // Separados: si no, el documento entero queda en una sola línea corrida.
    expect(preview.text).toMatch(/Primer párrafo\.\s*\n/);
  });

  it("una tabla de .docx se sigue leyendo como tabla", async () => {
    const bytes = await renderDocx(
      ["| Cupo | Estado |", "|---|---|", "| max_users | Aplicado |"].join("\n"),
      { title: "Planes" },
    );
    const preview = await previewDe("planes.docx", bytes);

    expect(preview.text).toContain("Cupo | Estado");
    expect(preview.text).toContain("max_users | Aplicado");
  });

  it("dice por qué no puede previsualizar en vez de mostrar basura", async () => {
    const preview = await previewDe("archivo.zip", Buffer.from("PK"));
    expect(preview.kind).toBe("none");
    expect(preview.motivo).toContain("Descargalo");
  });
});
