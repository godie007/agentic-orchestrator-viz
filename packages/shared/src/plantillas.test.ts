import { describe, expect, it } from "vitest";
import { PLANTILLAS_EQUIPO, plantillaEquipo, plantillaEquipoSchema } from "./plantillas.js";
import { CATALOGO_MCP } from "./tienda-mcp.js";

/**
 * Las plantillas se validan en CI, no al generarlas: un `reportaA` que apunta a
 * nadie o un MCP sugerido que no está en la tienda se descubren acá, no cuando
 * alguien crea un proyecto.
 */

describe("PLANTILLAS_EQUIPO", () => {
  it("todas validan contra el schema y los ids no se repiten", () => {
    for (const plantilla of PLANTILLAS_EQUIPO) {
      const resultado = plantillaEquipoSchema.safeParse(plantilla);
      expect(resultado.success, `"${plantilla.id}"`).toBe(true);
    }
    const ids = PLANTILLAS_EQUIPO.map((plantilla) => plantilla.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("las referencias internas cierran: jefe y departamento existen", () => {
    for (const plantilla of PLANTILLAS_EQUIPO) {
      const nombres = new Set(plantilla.roles.map((rol) => rol.nombre));
      const departamentos = new Set(plantilla.departamentos.map((dep) => dep.nombre));
      for (const rol of plantilla.roles) {
        if (rol.reportaA != null) {
          expect(nombres.has(rol.reportaA), `"${plantilla.id}": ${rol.nombre} → ${rol.reportaA}`).toBe(true);
        }
        expect(departamentos.has(rol.departamento), `"${plantilla.id}": ${rol.departamento}`).toBe(true);
      }
    }
  });

  it("hay exactamente un executive por plantilla y reporta a nadie", () => {
    for (const plantilla of PLANTILLAS_EQUIPO) {
      const executives = plantilla.roles.filter((rol) => rol.authority === "executive");
      expect(executives.length, `"${plantilla.id}"`).toBe(1);
      expect(executives[0]?.reportaA).toBeNull();
    }
  });

  it("ningún executor llega a smart: el rango sigue a la autoridad", () => {
    for (const plantilla of PLANTILLAS_EQUIPO) {
      for (const rol of plantilla.roles) {
        if (rol.authority === "executor") {
          expect(rol.escalado.tierMaximo, `"${plantilla.id}": ${rol.nombre}`).not.toBe("smart");
        }
      }
    }
  });

  it("los MCP sugeridos existen en la tienda", () => {
    const enTienda = new Set(CATALOGO_MCP.map((articulo) => articulo.id));
    for (const plantilla of PLANTILLAS_EQUIPO) {
      for (const sugerido of plantilla.mcpSugeridos) {
        expect(enTienda.has(sugerido), `"${plantilla.id}" sugiere ${sugerido}`).toBe(true);
      }
    }
  });

  it("toda instrucción en inglés declara que la salida es en castellano", () => {
    // Sin esa línea, un prompt en inglés arrastra la respuesta al inglés: es
    // la lección documentada del seed del estudio.
    for (const plantilla of PLANTILLAS_EQUIPO) {
      for (const rol of plantilla.roles) {
        expect(rol.systemPrompt, `"${plantilla.id}": ${rol.nombre}`).toMatch(/castellano/i);
      }
    }
  });

  it("plantillaEquipo busca por id", () => {
    expect(plantillaEquipo("consultora")?.roles.length).toBeGreaterThan(0);
    expect(plantillaEquipo("no-existe")).toBeNull();
  });
});
