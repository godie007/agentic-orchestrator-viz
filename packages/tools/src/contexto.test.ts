import { describe, expect, it } from "vitest";
import {
  crearHerramientasDeContexto,
  mapaDeContextoEnPrompt,
  type ContextoStorage,
} from "./contexto.js";

const almacen = (notas: Record<string, string> = {}): ContextoStorage => ({
  escribir: async (ruta, contenido) => {
    notas[ruta] = contenido;
    return { ok: true, ruta, caracteres: contenido.length };
  },
  leer: async (ruta) => notas[ruta] ?? null,
  buscar: async (texto) =>
    Object.entries(notas)
      .filter(([, c]) => c.toLowerCase().includes(texto.toLowerCase()))
      .map(([ruta]) => ({ ruta, linea: "línea con la coincidencia" })),
  mapa: async () =>
    Object.entries(notas).map(([ruta, c]) => ({ ruta, titulo: "t", caracteres: c.length })),
});

const buscarTool = (nombre: string, storage: ContextoStorage) =>
  crearHerramientasDeContexto(storage).find((t) => t.name === nombre)!;

const ctx = { runId: "r", tick: 1 } as never;

describe("leer_contexto", () => {
  it("abre la nota que el mapa nombró", async () => {
    const tool = buscarTool("leer_contexto", almacen({ "rodaje/nc.md": "# NC\n\nvive en /inspector/nc" }));
    const res = await tool.execute({ ruta: "rodaje/nc.md" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("/inspector/nc");
  });

  it("si no existe, manda al mapa en vez de dejarlo adivinando", async () => {
    const res = await buscarTool("leer_contexto", almacen()).execute({ ruta: "no/existe.md" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("mapa");
  });
});

describe("buscar_contexto", () => {
  it("devuelve dónde mirar, no el contenido", async () => {
    const storage = almacen({ "a.md": "# A\n\nhabla de no conformidades" });
    const res = await buscarTool("buscar_contexto", storage).execute({ texto: "conformidades" }, ctx);
    expect(res.content).toContain("a.md");
    expect(res.content).not.toContain("# A");
  });

  it("sin resultados, invita a guardarlo si lo averigua ahora", async () => {
    const res = await buscarTool("buscar_contexto", almacen()).execute({ texto: "nada" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("escribir_contexto");
  });
});

describe("escribir_contexto", () => {
  it("guarda la nota y avisa que ya aparece en el mapa de todos", async () => {
    const notas: Record<string, string> = {};
    const res = await buscarTool("escribir_contexto", almacen(notas)).execute(
      { ruta: "rodaje/pantallas.md", contenido: "# Pantallas\n\nLa lista de NC vive en /inspector/nc." },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(notas["rodaje/pantallas.md"]).toContain("/inspector/nc");
    // No hace falta mandársela a nadie: eso ahorra un mensaje y un ciclo.
    expect(res.content).toContain("mapa de contexto");
  });

  it("una línea suelta no es una nota: la manda a record_lesson", async () => {
    // Lo corto tiene que ir al prompt de todos, no a un archivo que hay que
    // abrir: traerlo cuesta una iteración entera del turno delegado.
    const res = await buscarTool("escribir_contexto", almacen()).execute(
      { ruta: "x.md", contenido: "usar sesion inspector" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("record_lesson");
  });

  it("propaga el motivo cuando el almacén rechaza la ruta", async () => {
    const storage: ContextoStorage = {
      ...almacen(),
      escribir: async () => ({ ok: false, motivo: "ruta inválida" }),
    };
    const res = await buscarTool("escribir_contexto", storage).execute(
      { ruta: "..", contenido: "# Algo\n\ncontenido suficientemente largo para pasar" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("ruta inválida");
  });
});

describe("mapaDeContextoEnPrompt", () => {
  it("lista rutas y títulos, nunca contenido", () => {
    const mapa = mapaDeContextoEnPrompt([
      { ruta: "rodaje/nc.md", titulo: "Pantallas de no conformidades", caracteres: 4200 },
    ]);
    expect(mapa).toContain("rodaje/nc.md");
    expect(mapa).toContain("Pantallas de no conformidades");
    expect(mapa).toContain("4200");
    expect(mapa).toContain("leer_contexto");
  });

  it("un árbol vacío no ocupa lugar en el prompt", () => {
    // Una empresa nueva no tiene por qué pagar una sección que no dice nada.
    expect(mapaDeContextoEnPrompt([])).toBe("");
  });
});
