import { describe, expect, it } from "vitest";
import type { RegisteredTool } from "@orq/tools";
import { TOPE_RESULTADO, acotarResultado, punteroDeRelectura } from "./acotar.js";

const herramienta = (properties: Record<string, unknown>): RegisteredTool =>
  ({
    name: "read_artifact",
    inputSchema: { type: "object", properties, additionalProperties: false },
  }) as unknown as RegisteredTool;

describe("acotarResultado", () => {
  it("no toca un entregable de tamaño real", () => {
    // El más grande de la empresa que produjo la medición son 11.127 caracteres.
    // Si el tope los cortara, un agente no podría leer su propio guion para
    // reescribirlo, que es la mitad del producto.
    const entregable = "x".repeat(11_127);
    const { texto, recortados } = acotarResultado(entregable, herramienta({}));
    expect(recortados).toBe(0);
    expect(texto).toBe(entregable);
  });

  it("recorta lo que sí infla y dice cuánto dejó afuera", () => {
    const listado = "a".repeat(60_000);
    const { texto, recortados } = acotarResultado(listado, herramienta({}));
    expect(recortados).toBe(60_000 - TOPE_RESULTADO);
    expect(texto.length).toBeLessThan(listado.length);
    expect(texto).toContain("RECORTADO");
    expect(texto).toContain("44.000");
  });

  it("conserva el final, donde viven los totales y las conclusiones", () => {
    const largo = `${"a".repeat(60_000)}TOTAL: 384 archivos`;
    expect(acotarResultado(largo, herramienta({})).texto).toContain("TOTAL: 384 archivos");
  });

  it("ofrece sólo argumentos que la herramienta declara de verdad", () => {
    const { texto } = acotarResultado("a".repeat(30_000), herramienta({ section: {}, key: {} }));
    expect(texto).toContain("section");
    // `key` no acota nada: ofrecerlo le hace gastar una vuelta para descubrirlo.
    expect(texto).not.toContain("acepta: key");
  });

  it("sin argumentos para acotar, lo dice en vez de inventar uno", () => {
    // La falla que ya costó 534k tokens: el modelo paginó con `start=4000`, la
    // herramienta lo ignoró por no estar en el esquema y devolvió todo de nuevo.
    const { texto } = acotarResultado("a".repeat(30_000), herramienta({ key: {} }));
    expect(texto).toContain("no inventes");
    expect(texto).toContain("start");
  });

  it("una herramienta sin esquema no rompe el recorte", () => {
    expect(acotarResultado("a".repeat(30_000), undefined).recortados).toBeGreaterThan(0);
  });

  it("el tope es configurable para poder fijarlo en un test sin textos gigantes", () => {
    expect(acotarResultado("abcdefghij", herramienta({}), 5).recortados).toBe(5);
  });
});

describe("punteroDeRelectura", () => {
  it("dice dónde está lo que ya se leyó y por qué no se repite", () => {
    const puntero = punteroDeRelectura("read_artifact", 11_127);
    expect(puntero).toContain("más arriba");
    expect(puntero).toContain("11.127");
    // Y desarma el intento de paginar con un argumento inventado.
    expect(puntero).toContain("se ignora");
  });
});
