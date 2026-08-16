import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@orq/shared";
import {
  enriquecerConPreciosClaude,
  resolverTierEstatico,
  resolverTodosLosTiers,
} from "./modelos-claude.js";
import { ProviderRegistry } from "./registry.js";
import { computeCost } from "./ledger.js";
import type { ChatEvent, LlmProvider } from "./types.js";

/**
 * La Models API de Anthropic no publica precios y sus catálogos son de una
 * sola familia: sin la tabla curada, los tiers no resuelven y el presupuesto
 * nunca corta. Estos tests fijan las dos piezas: el enriquecimiento por
 * prefijo (con slugs fechados) y la resolución de tier por mapa, que va
 * directo y no por las bandas de precio — con precios reales, Haiku y Sonnet
 * caerían los dos en la banda `standard`.
 */

function modelo(slug: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "anthropic",
    slug,
    name: slug,
    contextLength: 0,
    inputPricePerMTok: null,
    outputPricePerMTok: null,
    supportsTools: true,
    ...overrides,
  };
}

const CATALOGO = [
  modelo("claude-haiku-4-5-20251001"),
  modelo("claude-sonnet-4-6-20260115"),
  modelo("claude-opus-5-20260201"),
];

describe("enriquecerConPreciosClaude", () => {
  it("completa precios y contexto por prefijo, con slugs fechados", () => {
    const [haiku] = enriquecerConPreciosClaude([modelo("claude-haiku-4-5-20251001")]);
    expect(haiku?.inputPricePerMTok).toBe(1);
    expect(haiku?.outputPricePerMTok).toBe(5);
    expect(haiku?.contextLength).toBe(200_000);
  });

  it("no pisa precios ni contexto que ya vinieron", () => {
    const [sonnet] = enriquecerConPreciosClaude([
      modelo("claude-sonnet-4-6-20260115", {
        inputPricePerMTok: 2.5,
        outputPricePerMTok: 12,
        contextLength: 1_000_000,
      }),
    ]);
    expect(sonnet?.inputPricePerMTok).toBe(2.5);
    expect(sonnet?.outputPricePerMTok).toBe(12);
    expect(sonnet?.contextLength).toBe(1_000_000);
  });

  it("gana el prefijo más largo: opus-4-5 no cae en la tarifa vieja de opus-4", () => {
    const [nuevo, viejo] = enriquecerConPreciosClaude([
      modelo("claude-opus-4-5-20251101"),
      modelo("claude-opus-4-1-20250805"),
    ]);
    expect(nuevo?.inputPricePerMTok).toBe(5);
    expect(viejo?.inputPricePerMTok).toBe(15);
  });

  it("deja intacto lo que no es Claude", () => {
    const [otro] = enriquecerConPreciosClaude([modelo("gpt-9-mini")]);
    expect(otro?.inputPricePerMTok).toBeNull();
  });
});

describe("resolverTierEstatico", () => {
  const catalogo = enriquecerConPreciosClaude(CATALOGO);

  it("resuelve cada tier al modelo del mapa, sin pasar por bandas", () => {
    expect(resolverTierEstatico("anthropic", "cheap", catalogo)?.model.slug).toContain("haiku");
    expect(resolverTierEstatico("anthropic", "standard", catalogo)?.model.slug).toContain(
      "sonnet",
    );
    expect(resolverTierEstatico("anthropic", "smart", catalogo)?.model.slug).toContain("opus");
  });

  it("entre snapshots del mismo modelo elige el más reciente", () => {
    const dos = [modelo("claude-opus-5-20260201"), modelo("claude-opus-5-20260301")];
    expect(resolverTierEstatico("claude-sesion", "smart", dos)?.model.slug).toBe(
      "claude-opus-5-20260301",
    );
  });

  it("cae al siguiente prefijo si la generación preferida no está", () => {
    const soloViejo = [modelo("claude-opus-4-1-20250805")];
    expect(resolverTierEstatico("anthropic", "smart", soloViejo)?.model.slug).toBe(
      "claude-opus-4-1-20250805",
    );
  });

  it("devuelve null para proveedores fuera del mapa y para free", () => {
    expect(resolverTierEstatico("openrouter", "cheap", catalogo)).toBeNull();
    expect(resolverTierEstatico("anthropic", "free", catalogo)).toBeNull();
  });

  it("el reason explica de dónde salió la elección", () => {
    const eleccion = resolverTierEstatico("anthropic", "cheap", enriquecerConPreciosClaude(CATALOGO));
    expect(eleccion?.reason).toMatch(/mapa curado/i);
  });
});

describe("resolverTodosLosTiers", () => {
  it("para Anthropic resuelve cheap/standard/smart y deja free sin candidato", () => {
    const tiers = resolverTodosLosTiers("anthropic", enriquecerConPreciosClaude(CATALOGO));
    expect(tiers.cheap?.model.slug).toContain("haiku");
    expect(tiers.standard?.model.slug).toContain("sonnet");
    expect(tiers.smart?.model.slug).toContain("opus");
    expect(tiers.free).toBeNull();
  });
});

describe("resolveModel con el mapa estático", () => {
  function proveedorFake(): LlmProvider {
    return {
      id: "anthropic",
      label: "Anthropic",
      listModels: async () => enriquecerConPreciosClaude(CATALOGO),
      healthCheck: async () => ({ ok: true, detail: "" }),
      // eslint-disable-next-line require-yield
      chat: async function* (): AsyncIterable<ChatEvent> {
        throw new Error("no se usa en este test");
      },
    };
  }

  it("un tier resuelve por mapa aunque el catálogo venga sin bandas útiles", async () => {
    const registry = new ProviderRegistry();
    registry.register(proveedorFake());

    const resuelto = await registry.resolveModel({
      providerId: "anthropic",
      modelSlug: null,
      tier: "cheap",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    });

    expect(resuelto.modelSlug).toBe("claude-haiku-4-5-20251001");
    // Con el catálogo enriquecido, el costo deja de ser 0: el presupuesto
    // por fin puede cortar una corrida de Anthropic.
    const costo = computeCost(resuelto.modelInfo, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(costo.totalUsd).toBeGreaterThan(0);
  });

  it("un modelSlug fijo sigue ganando sobre el mapa", async () => {
    const registry = new ProviderRegistry();
    registry.register(proveedorFake());

    const resuelto = await registry.resolveModel({
      providerId: "anthropic",
      modelSlug: "claude-opus-5-20260201",
      tier: "cheap",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    });

    expect(resuelto.modelSlug).toBe("claude-opus-5-20260201");
  });
});
