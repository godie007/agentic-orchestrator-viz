import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ContextoStore,
  notaDeAprendizajes,
  segmentoLegible,
  tituloDeTema,
} from "./contexto.js";

/**
 * El árbol de contexto es un vault de Obsidian escrito por el filesystem: sin
 * plugin, sin puerto y sin depender de que la aplicación esté abierta. Lo que
 * se fija acá es que una ruta propuesta por un modelo no pueda salirse del
 * vault, que el mapa diga qué hay sin traer el contenido, y que una empresa sin
 * árbol todavía no sea un error.
 */

let raiz: string;
let contexto: ContextoStore;
const EMPRESA = { id: "cmp_test", nombre: "INSPIA — Publicidad" };

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), "orq-contexto-"));
  contexto = new ContextoStore(raiz);
});

describe("escribir y leer", () => {
  it("guarda una nota y la devuelve tal cual", async () => {
    const guardada = await contexto.escribir(EMPRESA, "rodaje/pantallas-nc", "# Pantallas de NC\n\nLa lista vive en /inspector/nc.");
    expect(guardada).toMatchObject({ ok: true, ruta: "rodaje/pantallas-nc.md" });
    expect(await contexto.leer(EMPRESA, "rodaje/pantallas-nc.md")).toContain("/inspector/nc");
  });

  it("le pone .md aunque el agente no lo escriba", async () => {
    // El vault es de Obsidian: un .txt no se indexa, no aparece en el grafo y
    // rompe los enlaces [[…]].
    const guardada = await contexto.escribir(EMPRESA, "glosario", "# Glosario\n\nNC: no conformidad.");
    expect(guardada).toMatchObject({ ok: true, ruta: "glosario.md" });
  });

  it("una nota que no existe devuelve null, no explota", async () => {
    expect(await contexto.leer(EMPRESA, "no/existe.md")).toBeNull();
  });

  it("reemplaza la nota entera: quien la reescribe decide qué queda", async () => {
    await contexto.escribir(EMPRESA, "tema", "# Uno\n\nviejo");
    await contexto.escribir(EMPRESA, "tema", "# Dos\n\nnuevo");
    const leida = await contexto.leer(EMPRESA, "tema.md");
    expect(leida).toContain("nuevo");
    expect(leida).not.toContain("viejo");
  });
});

describe("la ruta de un modelo no puede salirse del vault", () => {
  it("descarta los saltos hacia arriba", async () => {
    const guardada = await contexto.escribir(EMPRESA, "../../fuera", "# Fuera\n\nno debería llegar acá");
    // Los `..` se descartan segmento por segmento: queda una ruta adentro.
    expect(guardada.ok).toBe(true);
    if (guardada.ok) expect(guardada.ruta).toBe("fuera.md");
    await expect(readFile(join(raiz, "..", "fuera.md"), "utf8")).rejects.toThrow();
  });

  it("una ruta vacía se rechaza en vez de escribir en cualquier lado", async () => {
    expect(await contexto.escribir(EMPRESA, "   ", "# x\n\ncontenido")).toMatchObject({ ok: false });
  });

  it("cada empresa escribe en su rama y no ve la de las otras", async () => {
    await contexto.escribir({ id: "cmp_a", nombre: "Empresa A" }, "secreto", "# A\n\nlo de A");
    expect(await contexto.leer({ id: "cmp_b", nombre: "Empresa B" }, "secreto.md")).toBeNull();
  });
});

describe("mapa", () => {
  it("lista las notas con su título, sin traer el contenido", async () => {
    await contexto.escribir(EMPRESA, "rodaje/pantallas", "# Pantallas del rodaje\n\n" + "x".repeat(5_000));
    const mapa = await contexto.mapa(EMPRESA);
    expect(mapa).toHaveLength(1);
    expect(mapa[0]).toMatchObject({ ruta: "rodaje/pantallas.md", titulo: "Pantallas del rodaje" });
    expect(mapa[0]!.caracteres).toBeGreaterThan(5_000);
    // El contenido no viaja: el mapa se reenvía en cada vuelta del turno.
    expect(JSON.stringify(mapa)).not.toContain("xxxxx");
  });

  it("una empresa sin árbol todavía devuelve un mapa vacío, no un error", async () => {
    expect(await contexto.mapa({ id: "cmp_nuevo", nombre: "Empresa nueva" })).toEqual([]);
  });

  it("ignora lo que es de Obsidian y no del conocimiento", async () => {
    await mkdir(join(raiz, "INSPIA — Publicidad", ".obsidian"), { recursive: true });
    await writeFile(join(raiz, "INSPIA — Publicidad", ".obsidian", "app.json"), "{}");
    await contexto.escribir(EMPRESA, "real", "# Real\n\ncontenido");
    expect((await contexto.mapa(EMPRESA)).map((n) => n.ruta)).toEqual(["real.md"]);
  });
});

describe("buscar", () => {
  it("devuelve dónde está, con la línea, y no el documento entero", async () => {
    await contexto.escribir(
      EMPRESA,
      "rodaje/nc",
      "# NC\n\nLa lista de no conformidades vive en /inspector/nc.\n" + "relleno\n".repeat(500),
    );
    const hallazgos = await contexto.buscar(EMPRESA, "no conformidades");
    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]!.ruta).toBe("rodaje/nc.md");
    expect(hallazgos[0]!.linea).toContain("/inspector/nc");
    expect(hallazgos[0]!.linea.length).toBeLessThanOrEqual(200);
  });

  it("sin coincidencias no inventa nada", async () => {
    await contexto.escribir(EMPRESA, "algo", "# Algo\n\ncontenido cualquiera");
    expect(await contexto.buscar(EMPRESA, "inexistente")).toEqual([]);
  });
});

describe("nombres para leer, no para descifrar", () => {
  it("la carpeta es el nombre de la empresa, con acentos y espacios", async () => {
    await contexto.escribir(EMPRESA, "nota", "# Nota\n\ncontenido suficiente");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(raiz)).toContain("INSPIA — Publicidad");
  });

  it("dos empresas con el mismo nombre no comparten conocimiento", async () => {
    // En esta base hay cinco "Codytion S.A.": sin la marca de dueño, la segunda
    // escribiría encima de la primera.
    const una = { id: "cmp_uno", nombre: "Codytion S.A." };
    const otra = { id: "cmp_dos", nombre: "Codytion S.A." };
    await contexto.escribir(una, "propia", "# Una\n\nlo de la primera empresa");
    await contexto.escribir(otra, "propia", "# Otra\n\nlo de la segunda empresa");
    expect(await contexto.leer(una, "propia.md")).toContain("primera");
    expect(await contexto.leer(otra, "propia.md")).toContain("segunda");
  });

  it("un tema en formato etiqueta se vuelve un título legible", () => {
    expect(tituloDeTema("inspia:checklist-items-no-expanden")).toBe(
      "Inspia — checklist items no expanden",
    );
    // Las siglas quedan en mayúscula: "Qa video" se lee mal.
    expect(tituloDeTema("qa-video")).toBe("QA video");
    expect(tituloDeTema("rodaje")).toBe("Rodaje");
  });

  it("el nombre de archivo conserva acentos pero no lo que rompe el disco", () => {
    expect(segmentoLegible("Pantallas de inspección")).toBe("Pantallas de inspección");
    expect(segmentoLegible("ruta/con:barras")).toBe("ruta con barras");
    // Un punto inicial esconde el archivo en el vault.
    expect(segmentoLegible("...oculto")).toBe("oculto");
  });

  it("consultar el árbol no lo crea", async () => {
    // Es la lección de ExportStore: un barrido que usa `dirFor` produce los
    // residuos que viene a medir.
    const { readdir } = await import("node:fs/promises");
    await contexto.mapa({ id: "cmp_fantasma", nombre: "Empresa fantasma" });
    expect(await readdir(raiz)).not.toContain("Empresa fantasma");
  });
});

describe("notaDeAprendizajes", () => {
  it("agrupa por tema, con las reafirmadas arriba", () => {
    const nota = notaDeAprendizajes({
      tema: "qa-video",
      empresa: "INSPIA",
      fecha: "2026-08-17",
      lecciones: [
        { lesson: "Mirá los cuadros antes de aprobar.", timesConfirmed: 1 },
        { lesson: "El video sin audio se ve perfecto y sale mudo.", timesConfirmed: 3 },
      ],
    });
    expect(nota).toContain("# QA video");
    expect(nota.indexOf("mudo")).toBeLessThan(nota.indexOf("cuadros"));
    expect(nota).toContain("reafirmada 3 veces");
  });
});

describe("la nota se lee desde Obsidian", () => {
  const nota = (temas?: string[]) =>
    notaDeAprendizajes({
      tema: "inspia:escena-8",
      empresa: "INSPIA — Publicidad",
      fecha: "2026-08-17",
      lecciones: [{ lesson: "La escena 8 sale estática si el clip no se regrabó.", timesConfirmed: 1 }],
      ...(temas ? { temas } : {}),
    });

  it("abre con frontmatter, que es lo que Obsidian muestra como propiedades", () => {
    const n = nota();
    expect(n.startsWith("---\n")).toBe(true);
    expect(n).toContain("tema: inspia:escena-8");
    expect(n).toContain("actualizada: 2026-08-17");
    expect(n).toContain("- orquestador/aprendizaje");
  });

  it("deja línea en blanco antes de cada ##, o markdown no lo toma como encabezado", () => {
    // Es el bug que hacía que las notas se vieran como un bloque de texto.
    const n = notaDeAprendizajes({
      tema: "rodaje",
      empresa: "X",
      fecha: "2026-08-17",
      lecciones: [
        { lesson: "Primera lección.", timesConfirmed: 1 },
        { lesson: "Segunda lección.", timesConfirmed: 1 },
      ],
    });
    for (const [i, linea] of n.split("\n").entries()) {
      if (linea.startsWith("## ") && i > 0) {
        expect(n.split("\n")[i - 1]).toBe("");
      }
    }
  });

  it("enlaza al índice y a las notas de su misma familia", () => {
    const n = nota(["inspia:escena-8", "inspia:escena-9", "rodaje", "qa-video"]);
    expect(n).toContain("[[00 - Índice|Índice del vault]]");
    expect(n).toContain("Inspia — escena 9");
    // Un tema de otra familia no se enlaza: el grafo tiene que decir algo.
    expect(n).not.toContain("QA video");
  });

  it("sin parientes no dibuja una sección vacía", () => {
    expect(nota(["inspia:escena-8"])).not.toContain("## Relacionadas");
  });
});
