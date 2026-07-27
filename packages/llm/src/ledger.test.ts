import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@orq/shared";
import { computeCost, RunLedger } from "./ledger.js";

/**
 * El presupuesto es el único freno de una corrida, así que tiene que contar lo
 * que se paga de verdad.
 *
 * OpenRouter publica en su catálogo el precio del endpoint **más barato** de un
 * modelo, pero rutea a cualquiera de los que lo sirven. Medido sobre
 * `deepseek-v4-pro`: catálogo US$0.435/MTok, endpoints reales entre 0.435 y
 * 1.740. Estimar con el de catálogo subestimaba la factura hasta 4x, y el corte
 * por presupuesto llegaba tarde.
 */

const modelo: ModelInfo = {
  providerId: "openrouter",
  slug: "deepseek/deepseek-v4-pro",
  name: "DeepSeek V4 Pro",
  contextLength: 1_048_576,
  inputPricePerMTok: 0.435,
  outputPricePerMTok: 0.87,
  supportsTools: true,
};

describe("costo de una llamada", () => {
  it("usa lo que informa el proveedor por encima del catálogo", () => {
    // Caso real: el catálogo daría US$0.017 y el endpoint cobró US$0.068.
    const real = computeCost(modelo, {
      inputTokens: 39_481,
      outputTokens: 16,
      reportedCostUsd: 0.068058,
    });
    expect(real.totalUsd).toBe(0.068058);
    expect(real.informado).toBe(true);

    const estimado = computeCost(modelo, { inputTokens: 39_481, outputTokens: 16 });
    expect(estimado.informado).toBe(false);
    expect(estimado.totalUsd).toBeCloseTo(0.01719, 4);
    // La brecha es el motivo del cambio, no un detalle.
    expect(real.totalUsd / estimado.totalUsd).toBeGreaterThan(3);
  });

  it("un costo informado de cero es cero, no 'sin dato'", () => {
    // Con caché el costo puede ser ínfimo; no hay que caer a la estimación.
    const conCache = computeCost(modelo, {
      inputTokens: 39_481,
      outputTokens: 16,
      cachedInputTokens: 39_424,
      reportedCostUsd: 0,
    });
    expect(conCache.totalUsd).toBe(0);
    expect(conCache.informado).toBe(true);
  });

  it("sin precio de catálogo ni informe, no inventa un número", () => {
    const sinPrecio = computeCost(
      { ...modelo, inputPricePerMTok: null, outputPricePerMTok: null },
      { inputTokens: 1000, outputTokens: 100 },
    );
    expect(sinPrecio.priced).toBe(false);
    expect(sinPrecio.totalUsd).toBe(0);
  });

  it("el presupuesto corta con el costo real", () => {
    const ledger = new RunLedger(0.1);
    ledger.record({
      roleId: "rol_1",
      providerId: "openrouter",
      modelSlug: modelo.slug,
      tick: 1,
      usage: { inputTokens: 39_481, outputTokens: 16, reportedCostUsd: 0.068058 },
      costUsd: 0.068058,
      latencyMs: 100,
    });
    expect(() => ledger.assertWithinBudget()).not.toThrow();

    ledger.record({
      roleId: "rol_1",
      providerId: "openrouter",
      modelSlug: modelo.slug,
      tick: 1,
      usage: { inputTokens: 39_481, outputTokens: 16, reportedCostUsd: 0.068058 },
      costUsd: 0.068058,
      latencyMs: 100,
    });
    expect(() => ledger.assertWithinBudget()).toThrow();
  });
});
