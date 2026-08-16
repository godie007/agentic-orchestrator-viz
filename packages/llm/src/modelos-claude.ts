import type { ModelInfo, ModelTier, ProviderId } from "@orq/shared";
import { resolveTier, type TierResolution } from "./tiers.js";

/**
 * Precios de lista y tiers curados para los proveedores Claude.
 *
 * La Models API de Anthropic no publica precios, así que sin esta tabla el
 * ledger cuenta tokens pero no puede valorizarlos: `computeCost` da 0,
 * `spentUsd` no crece y `budgetUsd` nunca corta. Con la tabla, el costo es una
 * **estimación por precio de lista** (queda `priced: true` pero sin
 * `reportedCostUsd`), que alcanza para que el tope de gasto funcione.
 *
 * Es una tabla curada a mano, fechada: precios de lista de Anthropic a
 * **agosto de 2026**. Cuando salga un modelo nuevo se agrega una fila acá y
 * nada más.
 */

interface PrecioClaude {
  /**
   * Se compara por prefijo porque `models.list()` devuelve ids con sufijo de
   * fecha (`claude-haiku-4-5-20251001`). El prefijo más largo gana, así
   * `claude-opus-4-5` no cae en la fila genérica de `claude-opus-4`.
   */
  prefijo: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  contextLength: number;
}

export const PRECIOS_CLAUDE: PrecioClaude[] = [
  { prefijo: "claude-haiku-4-5", inputUsdPerMTok: 1, outputUsdPerMTok: 5, contextLength: 200_000 },
  { prefijo: "claude-3-5-haiku", inputUsdPerMTok: 0.8, outputUsdPerMTok: 4, contextLength: 200_000 },
  { prefijo: "claude-sonnet-5", inputUsdPerMTok: 3, outputUsdPerMTok: 15, contextLength: 200_000 },
  { prefijo: "claude-sonnet-4", inputUsdPerMTok: 3, outputUsdPerMTok: 15, contextLength: 200_000 },
  { prefijo: "claude-3-7-sonnet", inputUsdPerMTok: 3, outputUsdPerMTok: 15, contextLength: 200_000 },
  { prefijo: "claude-opus-5", inputUsdPerMTok: 5, outputUsdPerMTok: 25, contextLength: 200_000 },
  // Opus 4.5 bajó el precio de la familia; 4.0 y 4.1 siguen a la tarifa vieja.
  { prefijo: "claude-opus-4-5", inputUsdPerMTok: 5, outputUsdPerMTok: 25, contextLength: 200_000 },
  { prefijo: "claude-opus-4", inputUsdPerMTok: 15, outputUsdPerMTok: 75, contextLength: 200_000 },
];

function precioDe(slug: string): PrecioClaude | null {
  let mejor: PrecioClaude | null = null;
  for (const fila of PRECIOS_CLAUDE) {
    if (!slug.startsWith(fila.prefijo)) continue;
    if (!mejor || fila.prefijo.length > mejor.prefijo.length) mejor = fila;
  }
  return mejor;
}

/**
 * Completa precios y contexto de un catálogo que vino sin ellos. Sólo pisa lo
 * que llegó vacío: si algún día la API publica precios de verdad, ganan los de
 * la API sin tocar esta función.
 */
export function enriquecerConPreciosClaude(models: ModelInfo[]): ModelInfo[] {
  return models.map((model) => {
    const precio = precioDe(model.slug);
    if (!precio) return model;
    return {
      ...model,
      inputPricePerMTok: model.inputPricePerMTok ?? precio.inputUsdPerMTok,
      outputPricePerMTok: model.outputPricePerMTok ?? precio.outputUsdPerMTok,
      contextLength: model.contextLength > 0 ? model.contextLength : precio.contextLength,
    };
  });
}

/**
 * Mapa curado tier → modelo para proveedores de una sola familia.
 *
 * No pasa por las bandas de precio de `tiers.ts` a propósito: con los precios
 * reales, el mezclado de Haiku (US$1.80) y el de Sonnet (US$5.40) caen los dos
 * en la banda `standard` — `cheap` quedaría vacío y `standard` sería ambiguo.
 * Las bandas siguen siendo correctas para un catálogo grande y heterogéneo
 * como el de OpenRouter; para un proveedor de una familia, la fuente es este
 * mapa.
 *
 * Cada tier lleva una lista de prefijos en orden de preferencia: gana el
 * primero que exista en el catálogo vivo del proveedor. Así el mapa sobrevive
 * a que una generación todavía no esté (o ya no esté) disponible.
 */
const TIERS_ESTATICOS: Partial<Record<ProviderId, Partial<Record<ModelTier, string[]>>>> = {
  anthropic: {
    cheap: ["claude-haiku-4-5", "claude-3-5-haiku"],
    standard: ["claude-sonnet-5", "claude-sonnet-4"],
    smart: ["claude-opus-5", "claude-opus-4-5", "claude-opus-4"],
  },
  "claude-sesion": {
    cheap: ["claude-haiku-4-5", "claude-3-5-haiku"],
    standard: ["claude-sonnet-5", "claude-sonnet-4"],
    smart: ["claude-opus-5", "claude-opus-4-5", "claude-opus-4"],
  },
  "claude-code": {
    // El catálogo sintético de `claude-code.ts` usa alias, no slugs fechados.
    cheap: ["claude-code/haiku"],
    standard: ["claude-code/sonnet"],
    smart: ["claude-code/opus"],
  },
};

/**
 * Resuelve un tier contra el mapa curado. Devuelve `null` si el proveedor no
 * está en el mapa (OpenRouter y compañía siguen por bandas de precio) o si
 * ningún prefijo aparece en el catálogo vivo — el llamador cae entonces en
 * `resolveTier` y, en última instancia, en el error que pide un slug explícito.
 */
export function resolverTierEstatico(
  providerId: ProviderId,
  tier: ModelTier,
  models: ModelInfo[],
): TierResolution | null {
  const prefijos = TIERS_ESTATICOS[providerId]?.[tier];
  if (!prefijos) return null;

  return resolverPorPrefijos(prefijos, models);
}

/**
 * `resolveAllTiers` con el mapa curado adelante: lo que usan la pantalla de
 * proveedores y `check:models` para mostrar la misma resolución que va a hacer
 * el motor, con su `reason` incluido.
 */
export function resolverTodosLosTiers(
  providerId: ProviderId,
  models: ModelInfo[],
): Record<ModelTier, TierResolution | null> {
  const porTier = (tier: ModelTier): TierResolution | null =>
    resolverTierEstatico(providerId, tier, models) ?? resolveTier(models, tier);
  return {
    free: porTier("free"),
    cheap: porTier("cheap"),
    standard: porTier("standard"),
    smart: porTier("smart"),
  };
}

function resolverPorPrefijos(prefijos: string[], models: ModelInfo[]): TierResolution | null {
  for (const prefijo of prefijos) {
    const candidatos = models.filter((model) => model.slug.startsWith(prefijo));
    if (candidatos.length === 0) continue;
    // Entre snapshots del mismo modelo, el slug más alto es el más reciente
    // (el sufijo es una fecha AAAAMMDD).
    candidatos.sort((a, b) => b.slug.localeCompare(a.slug));
    const model = candidatos[0]!;
    const entrada = model.inputPricePerMTok;
    const salida = model.outputPricePerMTok;
    const blended = entrada != null && salida != null ? entrada * 0.8 + salida * 0.2 : 0;
    return {
      model,
      blendedPriceUsdPerMTok: blended,
      reason:
        entrada != null && salida != null
          ? `Mapa curado para Claude: ${model.name} (US$${entrada}/US$${salida} por MTok).`
          : `Mapa curado para Claude: ${model.name} (la suscripción no factura por token).`,
    };
  }
  return null;
}
