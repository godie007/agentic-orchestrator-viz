import OpenAI from "openai";
import type { ModelInfo } from "@orq/shared";
import {
  LlmError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type LlmProvider,
} from "../types.js";
import {
  ToolCallAccumulator,
  mapFinishReason,
  toOpenAiMessages,
  toOpenAiTools,
} from "./openai-shared.js";

export interface OpenAiConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Adaptador de OpenAI directo, para cuando querés ir sin intermediario.
 *
 * La API de modelos de OpenAI no publica precios ni longitud de contexto, así
 * que el catálogo llega sin esos datos: el Cost Dashboard registra los tokens
 * pero no puede valorizarlos. Si necesitás control de gasto fino, usá el mismo
 * modelo vía OpenRouter, que sí publica precios.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI";

  private client: OpenAI;
  private cache: ModelInfo[] | null = null;

  constructor(config: OpenAiConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.cache && !refresh) return this.cache;
    try {
      const page = await this.client.models.list();
      this.cache = page.data
        .filter((model) => /^(gpt|o\d)/i.test(model.id))
        .map((model) => ({
          providerId: this.id,
          slug: model.id,
          name: model.id,
          contextLength: 0, // la API no lo expone
          inputPricePerMTok: null,
          outputPricePerMTok: null,
          supportsTools: true,
        }));
      return this.cache;
    } catch (error) {
      throw wrapError(error);
    }
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
    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAiMessages(req.messages),
          ...(req.tools?.length ? { tools: toOpenAiTools(req.tools) } : {}),
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
          ...(req.maxOutputTokens ? { max_completion_tokens: req.maxOutputTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );
    } catch (error) {
      throw wrapError(error);
    }

    const calls = new ToolCallAccumulator();
    let text = "";
    let finishReason: FinishReason = "stop";
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
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
      throw wrapError(error);
    }

    const toolCalls = calls.finalize();
    for (const call of toolCalls) yield { type: "tool_call", call };

    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    yield { type: "done", message, usage, finishReason, modelSlug: req.model };
  }
}

function wrapError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const status = (error as { status?: number })?.status;
  const retryable = status === 429 || (status != null && status >= 500);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`OpenAI: ${message}`, "openai", retryable, error);
}
