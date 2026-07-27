import type { ModelInfo, ModelTier } from "@orq/shared";

/**
 * Resolución de tiers contra el catálogo vivo.
 *
 * Un rol puede fijar un slug exacto desde la UI; el tier es el atajo para
 * cuando no querés elegir modelo a mano. La resolución es por **precio real
 * del catálogo**, no por una lista de slugs hardcodeada, así que sigue
 * funcionando cuando salen modelos nuevos.
 *
 * Los nombres de familia de `QUALITY_HINTS` son la única parte curada: se usan
 * solo para desempatar dentro de una banda de precio, y podés editarlos sin
 * tocar nada más.
 */

/**
 * Bandas de precio mezclado (USD por millón de tokens), disjuntas por tier.
 *
 * Son disjuntas a propósito, y por dos razones. El piso garantiza que los tres
 * tiers resuelvan a modelos distintos: sin él, `standard` y `smart` colapsan en
 * el mismo y la distinción por complejidad deja de existir. El techo de `smart`
 * evita lo contrario: sin techo la resolución elige lo más caro del catálogo
 * —hay opciones a US$60/MTok— y un solo turno consume un presupuesto entero.
 *
 * Dentro de cada banda se elige el de mejor capacidad y, entre pares, el más
 * barato: la banda ya define cuánto se está dispuesto a pagar.
 */
const PRICE_BAND_USD_PER_MTOK: Record<ModelTier, { min: number; max: number }> = {
  // `free` es su propia categoría: precio exactamente cero, no una banda.
  free: { min: -1, max: 0 },
  cheap: { min: 0, max: 1.0 },
  standard: { min: 1.0, max: 8.0 },
  smart: { min: 8.0, max: 25.0 },
};

/** Contexto mínimo aceptable por tier, en tokens. */
const MIN_CONTEXT: Record<ModelTier, number> = {
  free: 32_000,
  cheap: 32_000,
  standard: 128_000,
  smart: 128_000,
};

/**
 * Desempate dentro de una banda. Un agente gasta muchos más tokens de entrada
 * que de salida, así que familias conocidas por buen seguimiento de
 * instrucciones y tool-calling suman puntos. Editable sin efectos colaterales.
 */
const QUALITY_HINTS: Array<{ pattern: RegExp; bonus: number }> = [
  { pattern: /claude/i, bonus: 3 },
  { pattern: /gpt-[5-9]/i, bonus: 3 },
  { pattern: /gemini/i, bonus: 2 },
  { pattern: /deepseek/i, bonus: 2 },
  { pattern: /qwen/i, bonus: 1 },
  { pattern: /llama/i, bonus: 1 },
  // Los `:free` de OpenRouter tienen límites agresivos y cortan corridas largas.
  { pattern: /:free$/i, bonus: -10 },
  { pattern: /preview|alpha|beta/i, bonus: -2 },
  // Las variantes "fast" cobran el doble por generar más rápido, no por ser
  // mejores. En una empresa que corre sola la latencia no es el cuello de
  // botella, así que pagar esa prima es tirar presupuesto.
  { pattern: /[-:]fast$/i, bonus: -6 },
];

/**
 * Precio mezclado con la proporción típica de un agente: mucho contexto de
 * entrada (historial, tools, bandeja) y salidas relativamente cortas.
 */
export function blendedPrice(model: ModelInfo): number | null {
  if (model.inputPricePerMTok == null || model.outputPricePerMTok == null) return null;
  return model.inputPricePerMTok * 0.8 + model.outputPricePerMTok * 0.2;
}

function qualityScore(model: ModelInfo, tier?: ModelTier): number {
  let score = 0;
  for (const hint of QUALITY_HINTS) {
    // Dentro del tier gratuito, penalizar `:free` no discrimina nada: son todos.
    if (tier === "free" && hint.pattern.source.includes("free")) continue;
    if (hint.pattern.test(model.slug)) score += hint.bonus;
  }
  // El contexto largo importa —los agentes acumulan historial rápido— pero es
  // un desempate, no la señal principal: se acota a 2 puntos para que un
  // modelo mediocre con ventana enorme no le gane a uno bueno.
  score += Math.min(model.contextLength / 400_000, 2);
  return score;
}

export interface TierResolution {
  model: ModelInfo;
  blendedPriceUsdPerMTok: number;
  /** Explicación legible, para mostrarla en la pantalla de proveedores. */
  reason: string;
}

/**
 * Elige el mejor modelo del catálogo para un tier. Devuelve `null` si ninguno
 * califica, para que el llamador pueda pedirle al usuario un slug explícito en
 * lugar de caer en un modelo arbitrario.
 */
export function resolveTier(models: ModelInfo[], tier: ModelTier): TierResolution | null {
  const band = PRICE_BAND_USD_PER_MTOK[tier];
  const minContext = MIN_CONTEXT[tier];

  const eligible = models
    .map((model) => ({ model, price: blendedPrice(model) }))
    .filter(
      (entry): entry is { model: ModelInfo; price: number } =>
        entry.model.supportsTools &&
        entry.model.contextLength >= minContext &&
        entry.price != null &&
        // En `free` se busca exactamente lo gratuito; en el resto se excluye,
        // porque sus límites de uso cortan corridas largas sin avisar.
        (tier === "free" ? entry.price === 0 : entry.price > 0) &&
        entry.price > band.min &&
        entry.price <= band.max,
    );

  if (eligible.length === 0) return null;

  if (tier === "free") {
    // Sin precio que comparar, manda la capacidad: el de mejor puntaje y, entre
    // pares, el de más contexto.
    eligible.sort(
      (a, b) =>
        qualityScore(b.model, tier) - qualityScore(a.model, tier) ||
        b.model.contextLength - a.model.contextLength,
    );
    const best = eligible[0]!;
    return {
      model: best.model,
      blendedPriceUsdPerMTok: 0,
      reason:
        `Gratuito con tool-calling y ${Math.round(best.model.contextLength / 1000)}k de contexto. ` +
        `Sin costo, pero con límites de uso: esperá errores 429 en corridas largas.`,
    };
  }

  if (tier === "cheap") {
    // En el tier barato el criterio es el precio: lo más barato que sirva.
    eligible.sort((a, b) => a.price - b.price || qualityScore(b.model) - qualityScore(a.model));
    const best = eligible[0]!;
    return {
      model: best.model,
      blendedPriceUsdPerMTok: best.price,
      reason: `El más barato con tool-calling y ≥${minContext / 1000}k de contexto (US$${best.price.toFixed(2)}/MTok mezclado).`,
    };
  }

  // En `standard` y `smart`, la mejor capacidad de la banda; entre pares, el
  // más barato.
  eligible.sort(
    (a, b) => qualityScore(b.model) - qualityScore(a.model) || a.price - b.price,
  );
  const best = eligible[0]!;
  return {
    model: best.model,
    blendedPriceUsdPerMTok: best.price,
    reason:
      `Mejor capacidad en la banda US$${band.min}–${band.max}/MTok ` +
      `(US$${best.price.toFixed(2)}/MTok mezclado, ${Math.round(best.model.contextLength / 1000)}k de contexto).`,
  };
}

/** Resuelve los tres tiers de una vez, para la pantalla de proveedores. */
export function resolveAllTiers(
  models: ModelInfo[],
): Record<ModelTier, TierResolution | null> {
  return {
    free: resolveTier(models, "free"),
    cheap: resolveTier(models, "cheap"),
    standard: resolveTier(models, "standard"),
    smart: resolveTier(models, "smart"),
  };
}
