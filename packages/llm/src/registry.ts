import type { ModelInfo, ModelSelection, ProviderId } from "@orq/shared";
import type { LlmProvider } from "./types.js";
import { LlmError } from "./types.js";
import { resolveTier } from "./tiers.js";
import { OpenRouterProvider } from "./adapters/openrouter.js";
import { AnthropicProvider, ClaudeSesionProvider } from "./adapters/anthropic.js";
import { ClaudeCodeProvider } from "./adapters/claude-code.js";
import { OpenAiProvider } from "./adapters/openai.js";
import { OllamaProvider } from "./adapters/ollama.js";
import { NvidiaProvider } from "./adapters/nvidia.js";

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
  NVIDIA_API_KEY?: string;
  /**
   * Habilita Claude con la sesión de `ant auth login` como proveedor aparte.
   *
   * Es un interruptor y no una credencial: la credencial vive en el perfil de
   * `~/.config/anthropic/`, no acá. Va explícito porque adivinar si hay sesión
   * —husmeando ese directorio, que además se puede mover con
   * `ANTHROPIC_CONFIG_DIR` y cambia de lugar en Windows— es frágil, y un
   * proveedor que aparece configurado y falla en la primera corrida es peor que
   * uno que no aparece.
   */
  ORQ_CLAUDE_SESION?: string;
  /** Token OAuth de `ant auth print-credentials --access-token`. De corta vida. */
  ANTHROPIC_AUTH_TOKEN?: string;
  /**
   * Habilita el proveedor "Claude Code (suscripción)": delega al CLI oficial de
   * Claude Code, que corre con el login de esta máquina (Pro/Max) y no factura
   * uso. Requiere el binario `claude` instalado y logueado.
   */
  ORQ_CLAUDE_CODE?: string;
  /** Modelo por defecto del CLI (alias: sonnet/opus/haiku). */
  CLAUDE_CODE_MODEL?: string;
  /** Carpeta de trabajo de los agentes de Claude Code. */
  CLAUDE_CODE_WORKDIR?: string;
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
  if (env.NVIDIA_API_KEY) {
    registry.register(new NvidiaProvider({ apiKey: env.NVIDIA_API_KEY }));
  }
  if (esVerdadero(env.ORQ_CLAUDE_SESION)) {
    // Una `ANTHROPIC_API_KEY` **vacía** es peor que ausente: el SDK la toma
    // igual —gana su lugar en la cadena de credenciales— y autentica con una
    // clave en blanco, así que la sesión nunca se usa y el error es un 401 sin
    // explicación. `.env.example` la trae vacía, así que copiarlo encima basta
    // para caer acá. Vacía no le sirve a nadie —el proveedor de arriba tampoco
    // se registra con ella— así que sacarla no rompe nada.
    if (env.ANTHROPIC_API_KEY === "") delete process.env["ANTHROPIC_API_KEY"];
    registry.register(
      new ClaudeSesionProvider(
        env.ANTHROPIC_AUTH_TOKEN ? { authToken: env.ANTHROPIC_AUTH_TOKEN } : {},
      ),
    );
  }
  if (esVerdadero(env.ORQ_CLAUDE_CODE)) {
    registry.register(
      new ClaudeCodeProvider({
        ...(env.CLAUDE_CODE_MODEL ? { model: env.CLAUDE_CODE_MODEL } : {}),
        ...(env.CLAUDE_CODE_WORKDIR ? { workspaceDir: env.CLAUDE_CODE_WORKDIR } : {}),
      }),
    );
  }

  return registry;
}

/** Un interruptor de entorno: `1`, `true` o `si` lo prenden. */
function esVerdadero(raw: string | undefined): boolean {
  const valor = raw?.trim().toLowerCase();
  return valor === "1" || valor === "true" || valor === "si" || valor === "sí";
}
