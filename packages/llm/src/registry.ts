import type { ModelInfo, ModelSelection, ProviderId } from "@orq/shared";
import type { LlmProvider } from "./types.js";
import { LlmError } from "./types.js";
import { resolveTier } from "./tiers.js";
import { OpenRouterProvider } from "./adapters/openrouter.js";
import { AnthropicProvider } from "./adapters/anthropic.js";
import { OpenAiProvider } from "./adapters/openai.js";
import { OllamaProvider } from "./adapters/ollama.js";

/**
 * Registro de proveedores.
 *
 * Es el único lugar del sistema que sabe qué adaptadores existen. El motor
 * pide un proveedor por id y recibe la interfaz: agregar un proveedor nuevo es
 * escribir un adaptador y sumarlo acá, sin tocar el motor ni las herramientas.
 */
export class ProviderRegistry {
  private providers = new Map<ProviderId, LlmProvider>();

  register(provider: LlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: ProviderId): LlmProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      const configured = [...this.providers.keys()].join(", ") || "ninguno";
      throw new LlmError(
        `El proveedor "${id}" no está configurado. Configurados: ${configured}. ` +
          `Agregá su API key en .env y reiniciá el servidor.`,
        id,
        false,
      );
    }
    return provider;
  }

  list(): LlmProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Traduce la selección de modelo de un rol a un slug concreto. Si el rol fijó
   * un slug lo usa tal cual; si eligió un tier, lo resuelve contra el catálogo
   * vivo del proveedor.
   */
  async resolveModel(selection: ModelSelection): Promise<{
    provider: LlmProvider;
    modelSlug: string;
    modelInfo: ModelInfo | undefined;
  }> {
    const provider = this.get(selection.providerId);
    const models = await provider.listModels();

    if (selection.modelSlug) {
      return {
        provider,
        modelSlug: selection.modelSlug,
        modelInfo: models.find((m) => m.slug === selection.modelSlug),
      };
    }

    const resolved = resolveTier(models, selection.tier);
    if (!resolved) {
      throw new LlmError(
        `Ningún modelo de ${provider.label} califica para el tier "${selection.tier}". ` +
          `Elegí un modelo explícito para este rol desde la UI.`,
        selection.providerId,
        false,
      );
    }
    return { provider, modelSlug: resolved.model.slug, modelInfo: resolved.model };
  }

  /** Catálogo unificado de todos los proveedores, para el selector de la UI. */
  async allModels(refresh = false): Promise<ModelInfo[]> {
    const results = await Promise.allSettled(
      this.list().map((provider) => provider.listModels(refresh)),
    );
    return results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  }
}

export interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  APP_URL?: string;
  APP_TITLE?: string;
}

/**
 * Construye el registro a partir del entorno. Un proveedor sin credenciales
 * simplemente no se registra: la UI lo muestra como no configurado en vez de
 * fallar al arrancar.
 */
export function buildRegistry(env: ProviderEnv): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (env.OPENROUTER_API_KEY) {
    registry.register(
      new OpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        ...(env.APP_URL ? { appUrl: env.APP_URL } : {}),
        ...(env.APP_TITLE ? { appTitle: env.APP_TITLE } : {}),
      }),
    );
  }
  if (env.ANTHROPIC_API_KEY) {
    registry.register(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }));
  }
  if (env.OPENAI_API_KEY) {
    registry.register(new OpenAiProvider({ apiKey: env.OPENAI_API_KEY }));
  }
  if (env.OLLAMA_BASE_URL) {
    registry.register(new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL }));
  }

  return registry;
}
