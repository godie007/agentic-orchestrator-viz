import { describe, expect, it } from "vitest";
import { elegirTierPorDificultad, type SenialesDeDificultad } from "./dificultad.js";

/**
 * Los cortes del medidor son enteros y estables a propósito —un tier que
 * "flapea" entre turnos vecinos invalida la familiaridad del modelo con la
 * corrida—. Estos tests fijan los cortes y las dos propiedades que no pueden
 * romperse sin romper la promesa del rango: monotonicidad y clamp.
 */

const RANGO = { tierMinimo: "cheap", tierMaximo: "smart" } as const;

function seniales(overrides: Partial<SenialesDeDificultad> = {}): SenialesDeDificultad {
  return {
    mensajes: 0,
    tareas: 0,
    caracteres: 0,
    autoridad: "executor",
    reanudando: false,
    fallosRecientes: 0,
    ...overrides,
  };
}

describe("elegirTierPorDificultad", () => {
  it("un executor con turno liviano queda en el mínimo del rango", () => {
    const eleccion = elegirTierPorDificultad(seniales(), RANGO);
    expect(eleccion.tier).toBe("cheap");
    expect(eleccion.motivo).toContain("turno liviano");
  });

  it("un executive reanudando con bandeja cargada llega al máximo", () => {
    const eleccion = elegirTierPorDificultad(
      seniales({ autoridad: "executive", reanudando: true, mensajes: 5 }),
      RANGO,
    );
    expect(eleccion.tier).toBe("smart");
  });

  it("carga intermedia cae en standard", () => {
    const eleccion = elegirTierPorDificultad(
      seniales({ mensajes: 2, caracteres: 9_000 }),
      RANGO,
    );
    expect(eleccion.tier).toBe("standard");
  });

  it("más señales nunca bajan el tier (monotonicidad)", () => {
    const orden = ["free", "cheap", "standard", "smart"];
    const escalera: Array<Partial<SenialesDeDificultad>> = [
      {},
      { mensajes: 2 },
      { mensajes: 2, tareas: 3 },
      { mensajes: 5, tareas: 3 },
      { mensajes: 5, tareas: 3, caracteres: 9_000 },
      { mensajes: 5, tareas: 3, caracteres: 25_000 },
      { mensajes: 5, tareas: 3, caracteres: 25_000, reanudando: true },
      { mensajes: 5, tareas: 3, caracteres: 25_000, reanudando: true, fallosRecientes: 2 },
    ];
    let anterior = -1;
    for (const paso of escalera) {
      const eleccion = elegirTierPorDificultad(seniales(paso), RANGO);
      const nivel = orden.indexOf(eleccion.tier);
      expect(nivel).toBeGreaterThanOrEqual(anterior);
      anterior = nivel;
    }
  });

  it("el resultado siempre queda dentro del rango", () => {
    const apretado = { tierMinimo: "standard", tierMaximo: "standard" } as const;
    expect(elegirTierPorDificultad(seniales(), apretado).tier).toBe("standard");
    expect(
      elegirTierPorDificultad(
        seniales({ autoridad: "executive", reanudando: true, mensajes: 9 }),
        apretado,
      ).tier,
    ).toBe("standard");
  });

  it("un rango dado vuelta se normaliza en vez de fallar", () => {
    const eleccion = elegirTierPorDificultad(seniales(), {
      tierMinimo: "smart",
      tierMaximo: "cheap",
    });
    expect(eleccion.tier).toBe("cheap");
  });

  it("los fallos recientes suman con tope de 2", () => {
    const conDos = elegirTierPorDificultad(seniales({ fallosRecientes: 2 }), RANGO);
    const conDiez = elegirTierPorDificultad(seniales({ fallosRecientes: 10 }), RANGO);
    expect(conDos.puntaje).toBe(conDiez.puntaje);
  });

  it("el motivo nombra las señales y el rango", () => {
    const eleccion = elegirTierPorDificultad(
      seniales({ autoridad: "executive", mensajes: 5 }),
      RANGO,
    );
    expect(eleccion.motivo).toContain("executive");
    expect(eleccion.motivo).toContain("cheap..smart");
  });
});
