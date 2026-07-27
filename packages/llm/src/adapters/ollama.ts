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

export interface OllamaConfig {
  /** Raíz del servidor Ollama, sin `/v1`. Por defecto `http://localhost:11434`. */
  baseUrl: string;
}

/**
 * Adaptador de Ollama (modelos locales, costo cero).
 *
 * Útil para los roles rutinarios de la empresa —triage de bandeja, formateo,
 * resúmenes— sin gastar un centavo, dejando el presupuesto para las decisiones
 * que lo justifican. Ollama expone un endpoint compatible con OpenAI en `/v1`.
 *
 * Ojo: no todos los modelos locales soportan tool-calling. Los que no, no
 * pueden usarse como agentes; el catálogo no lo indica, así que probá el rol
 * con un turno corto antes de darle trabajo.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama (local)";

  private client: OpenAI;
  private cache: ModelInfo[] | null = null;

  constructor(private config: OllamaConfig) {
    this.client = new OpenAI({
      apiKey: "ollama", // Ollama ignora la key pero el SDK exige una
      baseURL: `${config.baseUrl.replace(/\/$/, "")}/v1`,
    });
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.cache && !refresh) return this.cache;

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/tags`);
    if (!response.ok) {
      throw new LlmError(
        `Ollama no responde en ${this.config.baseUrl} (HTTP ${response.status})`,
        this.id,
        true,
      );
    }
    const payload = (await response.json()) as {
      models?: Array<{ name: string; details?: { parameter_size?: string } }>;
    };

    this.cache = (payload.models ?? []).map((model) => ({
      providerId: this.id,
      slug: model.name,
      name: model.details?.parameter_size
        ? `${model.name} (${model.details.parameter_size})`
        : model.name,
      contextLength: 0, // Ollama no lo expone en /api/tags
      inputPricePerMTok: 0, // local: gratis
      outputPricePerMTok: 0,
      supportsTools: true, // optimista: depende del modelo, no del servidor
    }));
    return this.cache;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const models = await this.listModels(true);
      if (models.length === 0) {
        return { ok: false, detail: "Ollama responde pero no tiene modelos descargados" };
      }
      return { ok: true, detail: `${models.length} modelos locales` };
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
          ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
          stream: true,
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
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`Ollama: ${message}`, "ollama", true, error);
}
