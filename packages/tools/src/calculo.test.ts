import { describe, expect, it } from "vitest";
import { calcular, calcularExpresion, normalizarNumero, verificarCifras } from "./calculo.js";
import type { ToolContext } from "./types.js";

/**
 * Los casos son los errores reales que salieron a producción en este proyecto.
 * Si esta herramienta no los hubiera detectado, no valdría la pena tenerla.
 */

const ctx = {} as ToolContext;

describe("números como los escribe la gente", () => {
  const casos: Array<[string, number]> = [
    ["3.200.000", 3_200_000], // miles a la colombiana
    ["$ 3.200.000", 3_200_000],
    ["0,65", 0.65], // decimal con coma
    ["3.200.000,50", 3_200_000.5],
    ["0.65", 0.65], // decimal con punto
    ["1.500", 1_500], // tres dígitos tras un punto: son miles
    ["0.650", 0.65], // salvo que la parte entera sea 0
    ["114100", 114_100],
  ];
  for (const [texto, esperado] of casos) {
    it(`"${texto}" → ${esperado}`, () => {
      expect(normalizarNumero(texto)).toBeCloseTo(esperado, 6);
    });
  }
});

describe("evalúa sin eval", () => {
  it("respeta precedencia y paréntesis", () => {
    expect(calcularExpresion("2 + 3 * 4")).toBe(14);
    expect(calcularExpresion("(2 + 3) * 4")).toBe(20);
  });

  it("entiende el porcentaje como sufijo", () => {
    expect(calcularExpresion("35%")).toBeCloseTo(0.35);
    expect(calcularExpresion("25 * 18% * 3.200.000")).toBeCloseTo(14_400_000);
  });

  it("acepta los signos que escribe un modelo", () => {
    expect(calcularExpresion("6 × 7")).toBe(42);
    expect(calcularExpresion("84 ÷ 2")).toBe(42);
  });

  it("no ejecuta código", async () => {
    const r = await calcular.execute({ expresion: "process.exit(1)" }, ctx);
    expect(r.ok).toBe(false);
  });

  it("avisa la división por cero en vez de devolver infinito", async () => {
    const r = await calcular.execute({ expresion: "5 / 0" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("cero");
  });
});

describe("verifica cifras que ya están escritas", () => {
  it("caza el margen mal atribuido de la propuesta de MaxiHogar", async () => {
    // El documento decía "US$114.100 (margen 38,2%)"; a ese precio es 35,0%.
    const r = await calcular.execute(
      {
        expresion: "(114100 - 74165) / 114100",
        esperado: "0,382",
        concepto: "margen a US$114.100",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("NO coincide");
  });

  it("caza el ahorro inflado de Muebles El Roble", async () => {
    // Afirmaba $80.000.000/mes; son 25 leads al 18% de cierre.
    const r = await calcular.execute(
      {
        expresion: "25 * 18% * 3.200.000",
        esperado: "80.000.000",
        concepto: "ventas recuperadas por seguimiento",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("NO coincide");
    expect(r.content).toContain("14.400.000");
  });

  it("acepta lo que sí está bien, con tolerancia de redondeo", async () => {
    const r = await calcular.execute(
      { expresion: "74165 / 0,65", esperado: "114.100" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Coincide");
  });

  it("sin `esperado` simplemente calcula", async () => {
    const r = await calcular.execute({ expresion: "6.280.000 / 0,65" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("9.661.538");
  });
});

/**
 * `calcular` sola no alcanzó: en la prueba el auditor verificó tres cifras de
 * una propuesta que tenía una docena y cerró el turno. El silencio se leía
 * igual que "está todo bien". Esta versión en lote hace que verificar todo
 * cueste una llamada en vez de doce, y deja por escrito lo que no se verificó.
 */
describe("verificar todas las cifras de un documento", () => {
  it("arma la tabla y marca la que está mal", async () => {
    const r = await verificarCifras.execute(
      {
        cifras: [
          {
            concepto: "margen a $114.100",
            expresion: "(114100 - 74165) / 114100 * 100",
            esperado: "38,2",
          },
          { concepto: "precio con margen 35%", expresion: "74165 / 0,65", esperado: "114.100" },
          {
            concepto: "ventas recuperadas",
            expresion: "25 * 18% * 3.200.000",
            esperado: "80.000.000",
          },
        ],
      },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(r.content).toContain("2 de 3 cifras NO coinciden");
    // La tabla está lista para pegar y nombra el veredicto de cada fila.
    expect(r.content).toContain("| Cifra | Cuenta |");
    expect(r.content).toContain("✓ correcta");
    expect(r.content).toContain("14.400.000");
  });

  it("no oculta lo que no pudo verificar", async () => {
    const r = await verificarCifras.execute(
      { cifras: [{ concepto: "plazo", expresion: "dos semanas", esperado: "14" }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("sin verificar");
  });

  it("confirma cuando está todo bien, sin dar un visto bueno vacío", async () => {
    const r = await verificarCifras.execute(
      { cifras: [{ concepto: "precio", expresion: "6.280.000 / 0,65", esperado: "9.661.538" }] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("coinciden");
    expect(r.content).toContain("✓ correcta");
  });

  it("pide la lista si no llegó", async () => {
    const r = await verificarCifras.execute({}, ctx);
    expect(r.ok).toBe(false);
  });
});
