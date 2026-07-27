import OpenAI from "openai";
import type { ModelInfo } from "@orq/shared";
import {
  LlmError,
  type ChatEvent,
  type ChatRequest,
  type ChatMessage,
  type FinishReason,
  type LlmProvider,
  type TokenUsage,
} from "../types.js";
import {
  ToolCallAccumulator,
  mapFinishReason,
  toOpenAiMessages,
  toOpenAiTools,
} from "./openai-shared.js";

const BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterConfig {
  apiKey: string;
  /** Aparece en el ranking público de OpenRouter. Sin efecto funcional. */
  appUrl?: string;
  appTitle?: string;
}

/**
 * Adaptador de OpenRouter: una sola key para cientos de modelos, que es lo que
 * permite darle a cada agente el modelo que su trabajo justifica.
 *
 * El catálogo se lee en vivo de `GET /models`, así que los precios que ve la UI
 * son los reales y no hay slugs hardcodeados que envejezcan.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter" as const;
  readonly label = "OpenRouter";

  private client: OpenAI;
  private cache: ModelInfo[] | null = null;

  constructor(private config: OpenRouterConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: BASE_URL,
      defaultHeaders: {
        ...(config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
        ...(config.appTitle ? { "X-Title": config.appTitle } : {}),
      },
    });
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.cache && !refresh) return this.cache;

    const response = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!response.ok) {
      throw new LlmError(
        `No se pudo leer el catálogo de OpenRouter (HTTP ${response.status})`,
        this.id,
        response.status >= 500,
      );
    }

    const payload = (await response.json()) as { data?: OpenRouterModel[] };
    this.cache = (payload.data ?? []).map((m) => this.toModelInfo(m));
    return this.cache;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.listModels(true);
      return { ok: true, detail: `${models.length} modelos disponibles` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    // El plugin `web` de OpenRouter da búsqueda nativa donde el modelo la
    // soporta, y cae a Exa donde no. Va como campo extra del body.
    const plugins = req.webSearch?.enabled
      ? [{ id: "web", max_results: req.webSearch.maxResults ?? 5 }]
      : undefined;

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      // `plugins` no está en los tipos del SDK de OpenAI (es una extensión de
      // OpenRouter), así que el body va como `never` y la respuesta se
      // reafirma: con `stream: true` el runtime devuelve un async iterable.
      stream = (await this.client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAiMessages(req.messages),
          ...(req.tools?.length ? { tools: toOpenAiTools(req.tools) } : {}),
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
          ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
          // Devuelve el costo real de la llamada y cuánto salió del caché. Sin
          // esto sólo podemos estimar con el precio de catálogo, que es el del
          // endpoint más barato y no el que nos tocó.
          usage: { include: true },
          // Orden determinista de upstreams: es lo que hace que el caché de
          // prefijo pegue entre iteraciones del mismo turno.
          // `require_parameters` descarta los endpoints que no soportan todo lo
          // que mandamos. Sin esto el ruteo por precio puede caer en uno que
          // ignora `tools`, y el agente deja de llamar herramientas **en
          // silencio**: no falla, simplemente no hace nada.
          provider: { sort: req.routing?.sort ?? "price", require_parameters: true },
          ...(plugins ? { plugins } : {}),
        } as never,
        { signal: req.signal },
      )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;
    } catch (error) {
      throw wrapError(error, this.id);
    }

    const calls = new ToolCallAccumulator();
    let text = "";
    let finishReason: FinishReason = "stop";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let modelSlug = req.model;

    try {
      for await (const chunk of stream) {
        if (chunk.model) modelSlug = chunk.model;
        if (chunk.usage) {
          // `cost` y `prompt_tokens_details` son extensiones de OpenRouter: no
          // están en los tipos del SDK de OpenAI, por eso el ensanche.
          const extra = chunk.usage as typeof chunk.usage & {
            cost?: number;
            prompt_tokens_details?: { cached_tokens?: number } | null;
          };
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cachedInputTokens: extra.prompt_tokens_details?.cached_tokens ?? 0,
            reportedCostUsd: typeof extra.cost === "number" ? extra.cost : null,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        calls.push(choice.delta?.tool_calls);

        if (choice.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
      }
    } catch (error) {
      throw wrapError(error, this.id);
    }

    const toolCalls = calls.finalize();
    for (const call of toolCalls) {
      yield { type: "tool_call", call };
    }

    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    yield { type: "done", message, usage, finishReason, modelSlug };
  }

  private toModelInfo(model: OpenRouterModel): ModelInfo {
    // `pricing` viene en USD por token, como string. Se normaliza a USD/MTok,
    // que es la unidad que se muestra en la UI.
    const perMTok = (raw: string | undefined): number | null => {
      if (raw == null) return null;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value * 1_000_000 : null;
    };

    return {
      providerId: this.id,
      slug: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? 0,
      inputPricePerMTok: perMTok(model.pricing?.prompt),
      outputPricePerMTok: perMTok(model.pricing?.completion),
      supportsTools: (model.supported_parameters ?? []).includes("tools"),
    };
  }
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

function wrapError(error: unknown, providerId: "openrouter"): LlmError {
  if (error instanceof LlmError) return error;
  const status = (error as { status?: number })?.status;
  const retryable = status === 429 || (status != null && status >= 500);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`OpenRouter: ${message}`, providerId, retryable, error);
}
