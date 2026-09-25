import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Directorios, MARCA_PROYECTO, migrarSalidasViejas, reescribirRutasMcp } from "./directorios.js";
import { ExportStore, disposicionPorProyecto } from "./exports.js";

/**
 * El layout de carpetas por proyecto.
 *
 * Lo que se fija acá son las dos promesas que el layout viejo rompía: que una
 * persona que abre `data/` pueda decir qué carpeta es de qué proyecto, y que
 * **mirar no escriba** — la pestaña Salida pide el árbol cada cinco segundos, y
 * con el store viejo eso alcanzaba para crear carpetas de empresas borradas.
 */

let base: string;
let nombres: Map<string, string>;
let dirs: Directorios;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "orq-dirs-"));
  nombres = new Map([
    ["cmp_aaa111", "INSPIA — Publicidad"],
    ["cmp_bbb222", "INSPIA — Publicidad"],
  ]);
  dirs = new Directorios(join(base, "proyectos"), (id) => nombres.get(id) ?? null);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("Directorios", () => {
  it("la carpeta lleva el nombre legible del proyecto y una marca con el id", () => {
    const dir = dirs.asegurar("cmp_aaa111");
    expect(dir).toBe(join(base, "proyectos", "INSPIA — Publicidad"));
    expect(readFileSync(join(dir, MARCA_PROYECTO), "utf8")).toBe("cmp_aaa111");
  });

  it("la raíz de proyectos corta la herencia del package.json del orquestador (\"type\": \"module\")", () => {
    dirs.asegurar("cmp_aaa111");
    expect(JSON.parse(readFileSync(join(base, "proyectos", "package.json"), "utf8"))).toMatchObject({ type: "commonjs" });
  });

  it("consultar no crea nada", () => {
    dirs.ruta("cmp_aaa111");
    dirs.sub("cmp_aaa111", "salida");
    expect(existsSync(join(base, "proyectos"))).toBe(false);
  });

  it("dos proyectos con el mismo nombre no comparten carpeta", () => {
    const primero = dirs.asegurar("cmp_aaa111");
    const segundo = dirs.asegurar("cmp_bbb222");
    expect(segundo).not.toBe(primero);
    expect(segundo).toBe(join(base, "proyectos", "INSPIA — Publicidad (bbb222)"));
  });

  it("renombrar el proyecto no le crea una carpeta nueva: la marca manda", () => {
    const antes = dirs.asegurar("cmp_aaa111");
    nombres.set("cmp_aaa111", "Otro nombre");
    expect(dirs.ruta("cmp_aaa111")).toBe(antes);
    expect(dirs.asegurar("cmp_aaa111")).toBe(antes);
  });

  it("no se adueña de una carpeta sin marca que alguien dejó a mano", () => {
    mkdirSync(join(base, "proyectos", "INSPIA — Publicidad"), { recursive: true });
    const dir = dirs.asegurar("cmp_aaa111");
    expect(dir).toBe(join(base, "proyectos", "INSPIA — Publicidad (aaa111)"));
  });
});

describe("ExportStore sobre el layout por proyecto", () => {
  it("pedir el árbol de un proyecto sin salida devuelve vacío y no crea la carpeta", async () => {
    const store = new ExportStore(disposicionPorProyecto(dirs));
    const arbol = await store.tree("cmp_aaa111");
    expect(arbol.children).toEqual([]);
    expect(readdirSync(join(base, "proyectos"))).toEqual([]);
  });

  it("escribir crea la salida adentro de la carpeta del proyecto", async () => {
    const store = new ExportStore(disposicionPorProyecto(dirs));
    await store.writeText("cmp_aaa111", "informes/uno.md", "# Hola");
    expect(
      readFileSync(join(base, "proyectos", "INSPIA — Publicidad", "salida", "informes", "uno.md"), "utf8"),
    ).toBe("# Hola");
  });

  it("borrar la empresa se lleva la carpeta entera del proyecto, no sólo la salida", async () => {
    const store = new ExportStore(disposicionPorProyecto(dirs));
    await store.writeText("cmp_aaa111", "a.md", "x");
    mkdirSync(join(dirs.ruta("cmp_aaa111"), "repos", "web"), { recursive: true });
    const resultado = await store.removeCompany("cmp_aaa111");
    expect(resultado.ok).toBe(true);
    expect(existsSync(join(base, "proyectos", "INSPIA — Publicidad"))).toBe(false);
  });

  it("una carpeta sin marca o de un proyecto borrado es residual; la de uno vivo no", async () => {
    const store = new ExportStore(disposicionPorProyecto(dirs));
    await store.writeText("cmp_aaa111", "a.md", "x");
    await store.writeText("cmp_bbb222", "b.md", "y");
    mkdirSync(join(base, "proyectos", "suelta"), { recursive: true });
    const residuales = (await store.carpetasResiduales(["cmp_aaa111"])).map((r) => r.carpeta).sort();
    expect(residuales).toEqual(["INSPIA — Publicidad (bbb222)", "suelta"]);
  });

  it("publicar conserva la subcarpeta y no pisa en silencio una versión publicada", async () => {
    const store = new ExportStore(disposicionPorProyecto(dirs));
    await store.writeText("cmp_aaa111", "campania/pieza.md", "uno");
    await store.writeText("cmp_aaa111", "folleto/pieza.md", "dos");
    expect(await store.publicar("cmp_aaa111", "campania/pieza.md")).toEqual({
      ok: true,
      path: "publicado/campania/pieza.md",
    });
    expect((await store.publicar("cmp_aaa111", "folleto/pieza.md")).ok).toBe(true);

    await store.writeText("cmp_aaa111", "campania/pieza.md", "uno-bis");
    const segunda = await store.publicar("cmp_aaa111", "campania/pieza.md");
    expect(segunda.ok).toBe(false);
    expect(segunda.ok === false && segunda.existe).toBe(true);

    const confirmada = await store.publicar("cmp_aaa111", "campania/pieza.md", { reemplazar: true });
    expect(confirmada.ok).toBe(true);
    const leido = await store.read("cmp_aaa111", "publicado/campania/pieza.md");
    expect(leido?.toString("utf8")).toBe("uno-bis");
  });
});

describe("migrarSalidasViejas", () => {
  function armarViejo() {
    const exportsDir = join(base, "exports");
    mkdirSync(join(exportsDir, "cmp_aaa111", "clips"), { recursive: true });
    writeFileSync(join(exportsDir, "cmp_aaa111", "clips", "01.mp4"), "video");
    mkdirSync(join(exportsDir, "cmp_muerta"), { recursive: true });
    return exportsDir;
  }

  it("muda la salida, reescribe el MCP que apuntaba a la ruta vieja y es idempotente", () => {
    const exportsDir = armarViejo();
    const servidores = [
      {
        id: "mcp1",
        transport: {
          type: "stdio" as const,
          command: "npx",
          args: ["@playwright/mcp", "--output-dir", "./exports/cmp_aaa111/reconocimiento"],
          envRefs: {},
          cwd: null,
        },
      },
    ];
    const guardados: unknown[] = [];
    const correr = () =>
      migrarSalidasViejas({
        exportsDir,
        repoRoot: base,
        directorios: dirs,
        companyIds: ["cmp_aaa111"],
        segmentoDe: (id) => id,
        servidoresMcp: () => servidores,
        guardarMcp: (s) => guardados.push(s),
      });

    const primera = correr();
    const destino = join(base, "proyectos", "INSPIA — Publicidad", "salida");
    expect(primera.movidas).toEqual([{ companyId: "cmp_aaa111", destino }]);
    expect(readFileSync(join(destino, "clips", "01.mp4"), "utf8")).toBe("video");
    expect(primera.mcpReescritos).toBe(1);
    expect(JSON.stringify(guardados[0])).toContain("proyectos/INSPIA — Publicidad/salida/reconocimiento");
    expect(primera.sinEmpresa).toEqual(["cmp_muerta"]);

    const segunda = correr();
    expect(segunda.movidas).toEqual([]);
  });

  it("si hay salida en los dos layouts no fusiona nada: lo deja para una persona", () => {
    const exportsDir = armarViejo();
    mkdirSync(dirs.sub("cmp_aaa111", "salida", true), { recursive: true });
    const resultado = migrarSalidasViejas({
      exportsDir,
      repoRoot: base,
      directorios: dirs,
      companyIds: ["cmp_aaa111"],
      segmentoDe: (id) => id,
      servidoresMcp: () => [],
      guardarMcp: () => {},
    });
    expect(resultado.enConflicto).toEqual(["cmp_aaa111"]);
    expect(existsSync(join(exportsDir, "cmp_aaa111", "clips", "01.mp4"))).toBe(true);
  });

  it("un MCP que no menciona la ruta vieja no se toca", () => {
    const servidor = {
      transport: { type: "stdio" as const, command: "npx", args: ["server-memory"], envRefs: {}, cwd: null },
    };
    expect(
      reescribirRutasMcp(servidor, { viejaAbs: "/x/old", nuevaAbs: "/x/new", viejaRel: "old", nuevaRel: "new" }),
    ).toBeNull();
  });
});
