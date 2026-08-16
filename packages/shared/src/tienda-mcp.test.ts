import { describe, expect, it } from "vitest";
import { CATALOGO_MCP, articuloDeTienda, articuloDeTiendaSchema } from "./tienda-mcp.js";
import { referenciaDe } from "./mcp-config.js";

/**
 * El catálogo se valida acá y no en runtime: una entrada rota se descubre en
 * CI, no cuando alguien la instala. Y la regla de secretos se verifica con el
 * mismo detector del importador: si un valor del catálogo no pasa por
 * `referenciaDe`, es que alguien metió una credencial literal en el repo.
 */

describe("CATALOGO_MCP", () => {
  it("todas las entradas validan contra el schema", () => {
    for (const articulo of CATALOGO_MCP) {
      const resultado = articuloDeTiendaSchema.safeParse(articulo);
      expect(resultado.success, `"${articulo.id}": ${JSON.stringify(resultado)}`).toBe(true);
    }
  });

  it("los ids y los nombres de servidor no se repiten", () => {
    const ids = CATALOGO_MCP.map((articulo) => articulo.id);
    expect(new Set(ids).size).toBe(ids.length);
    const nombres = CATALOGO_MCP.map((articulo) => articulo.servidor.name);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it("ningún env del transporte lleva un valor con pinta de secreto", () => {
    for (const articulo of CATALOGO_MCP) {
      const transport = articulo.servidor.transport;
      const refs =
        transport.type === "stdio"
          ? Object.values(transport.envRefs)
          : Object.values(transport.headerRefs);
      for (const valor of refs) {
        expect(referenciaDe(valor), `"${articulo.id}" guarda "${valor}"`).not.toBeNull();
      }
    }
  });

  it("toda variable del transporte está declarada en envRequeridas", () => {
    // Sin la declaración, la credencial faltante se descubre recién en el
    // handshake: la tienda promete decirlo antes.
    for (const articulo of CATALOGO_MCP) {
      const transport = articulo.servidor.transport;
      if (transport.type !== "stdio") continue;
      const declaradas = new Set(articulo.envRequeridas.map((entrada) => entrada.ref));
      for (const ref of Object.values(transport.envRefs)) {
        expect(declaradas.has(ref), `"${articulo.id}" usa ${ref} sin declararla`).toBe(true);
      }
    }
  });

  it("hay un catálogo razonable, con más de una categoría", () => {
    expect(CATALOGO_MCP.length).toBeGreaterThanOrEqual(15);
    const categorias = new Set(CATALOGO_MCP.map((articulo) => articulo.categoria));
    expect(categorias.size).toBeGreaterThanOrEqual(5);
  });

  it("articuloDeTienda busca por id y devuelve null para lo desconocido", () => {
    expect(articuloDeTienda("memory")?.servidor.name).toBe("memoria");
    expect(articuloDeTienda("no-existe")).toBeNull();
  });
});
