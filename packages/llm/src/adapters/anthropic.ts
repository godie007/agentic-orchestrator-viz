import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo } from "@orq/shared";
import {
  LlmError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type LlmProvider,
  type ToolCall,
} from "../types.js";

export interface AnthropicConfig {
  apiKey: string;
}

/**
 * Adaptador de Anthropic directo.
 *
 * El formato de Anthropic difiere del de OpenAI en tres puntos que se traducen
 * acá: el `system` va fuera del array de mensajes, las tool calls son bloques
 * de contenido en vez de un campo aparte, y los resultados de herramienta
 * vuelven como bloques `tool_result` dentro de un mensaje `user`.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";

  private client: Anthropic;
  private cache: ModelInfo[] | null = null;

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.cache && !refresh) return this.cache;
    try {
      const models: ModelInfo[] = [];
      for await (const model of this.client.models.list()) {
        models.push({
          providerId: this.id,
          slug: model.id,
          name: model.display_name ?? model.id,
          // Estos campos llegaron a la Models API en 2026; si el SDK instalado
          // es más viejo no vienen y el catálogo los muestra en cero.
          contextLength: (model as { max_input_tokens?: number }).max_input_tokens ?? 0,
          // La API de Anthropic no publica precios. El ledger cuenta tokens
          // pero no puede valorizarlos: para control de gasto fino, usá el
          // mismo modelo vía OpenRouter.
          inputPricePerMTok: null,
          outputPricePerMTok: null,
          supportsTools: true,
        });
      }
      this.cache = models;
      return models;
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
    const { system, messages } = splitSystem(req.messages);

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? 4096,
          ...(system ? { system } : {}),
          messages,
          ...(req.tools?.length
            ? {
                tools: req.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
          // `temperature` se omite a propósito: los modelos Claude actuales
          // (Opus 5, 4.8, 4.7, Sonnet 5) rechazan los parámetros de sampling
          // con un 400. El comportamiento se guía por prompt.
          stream: true,
        },
        { signal: req.signal },
      );
    } catch (error) {
      throw wrapError(error);
    }

    let text = "";
    let finishReason: FinishReason = "stop";
    const usage = { inputTokens: 0, outputTokens: 0 };
    // Los bloques llegan por índice: `content_block_start` trae id y nombre,
    // y los `input_json_delta` siguientes van armando el JSON de argumentos.
    const blocks = new Map<number, { id: string; name: string; json: string }>();

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            usage.inputTokens = event.message.usage?.input_tokens ?? 0;
            break;

          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              blocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: "",
              });
            }
            break;

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              text += delta.text;
              yield { type: "text_delta", text: delta.text };
            } else if (delta.type === "input_json_delta") {
              const block = blocks.get(event.index);
              if (block) block.json += delta.partial_json;
            }
            break;
          }

          case "message_delta":
            usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
            if (event.delta.stop_reason) {
              finishReason = mapStopReason(event.delta.stop_reason);
            }
            break;
        }
      }
    } catch (error) {
      throw wrapError(error);
    }

    const toolCalls: ToolCall[] = [...blocks.values()].map((block) => ({
      id: block.id,
      name: block.name,
      arguments: parseJson(block.json),
    }));
    for (const call of toolCalls) yield { type: "tool_call", call };

    const message: ChatMessage = {
      role: "assistant",
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    yield { type: "done", message, usage, finishReason, modelSlug: req.model };
  }
}

/**
 * Anthropic lleva el system prompt fuera del array de mensajes, y espera los
 * resultados de herramienta como bloques `tool_result` dentro de un `user`.
 */
function splitSystem(messages: ChatMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const converted: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      // Resultados consecutivos se agrupan en un solo turno `user`, como pide
      // la API: un `tool_result` por cada `tool_use` del turno anterior.
      const last = converted.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }

    const content: Anthropic.ContentBlockParam[] = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      });
    }
    if (content.length > 0) converted.push({ role: "assistant", content });
  }

  return { system: systemParts.join("\n\n"), messages: converted };
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function parseJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __raw: trimmed };
  } catch {
    return { __raw: trimmed };
  }
}

function wrapError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const status = (error as { status?: number })?.status;
  const retryable = status === 429 || (status != null && status >= 500);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`Anthropic: ${message}`, "anthropic", retryable, error);
}
