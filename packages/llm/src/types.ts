import type { ModelInfo, ProviderId } from "@orq/shared";

/**
 * Formato neutro de conversación.
 *
 * Ni el motor ni las herramientas conocen el formato de ningún proveedor: todo
 * habla en estos tipos, y cada adaptador traduce en su borde. Es lo que hace
 * que cambiar de OpenRouter a Anthropic sea configuración y no una reescritura.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** Llamada a herramienta pedida por el modelo. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Solo en `assistant`: herramientas que el modelo quiere ejecutar. */
  toolCalls?: ToolCall[];
  /** Solo en `tool`: a qué `ToolCall.id` responde. */
  toolCallId?: string;
  /** Solo en `tool`: nombre de la herramienta, para adaptadores que lo piden. */
  name?: string;
}

/** Herramienta tal como se le ofrece al modelo. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema de los argumentos. */
  inputSchema: Record<string, unknown>;
}

export interface WebSearchOptions {
  enabled: boolean;
  maxResults?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** `null` o ausente = default del proveedor. */
  temperature?: number | null;
  maxOutputTokens?: number;
  /**
   * Búsqueda web nativa del proveedor, cuando la soporta. Los adaptadores que
   * no la tienen la ignoran y el agente cae en la herramienta `web_search`.
   */
  webSearch?: WebSearchOptions;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error";

/** Eventos del stream normalizado. */
export type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "done";
      message: ChatMessage;
      usage: TokenUsage;
      finishReason: FinishReason;
      /** Slug que realmente respondió (OpenRouter puede hacer fallback). */
      modelSlug: string;
    };

export interface ChatResult {
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: FinishReason;
  modelSlug: string;
}

/**
 * Contrato que cumple todo proveedor. El motor solo conoce esta interfaz.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  /** Nombre legible para la UI. */
  readonly label: string;
  /** Catálogo de modelos con precios. Se cachea; `refresh` fuerza recarga. */
  listModels(refresh?: boolean): Promise<ModelInfo[]>;
  /** Verifica credenciales y conectividad sin gastar tokens de generación. */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  chat(req: ChatRequest): AsyncIterable<ChatEvent>;
}

/** Error tipado para distinguir fallas recuperables de las que no lo son. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly providerId: ProviderId,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Drena el stream y devuelve el resultado final, reenviando los deltas de texto
 * a `onText` para que la UI los vea llegar en vivo.
 */
export async function collect(
  stream: AsyncIterable<ChatEvent>,
  onText?: (text: string) => void,
): Promise<ChatResult> {
  for await (const event of stream) {
    if (event.type === "text_delta") onText?.(event.text);
    if (event.type === "done") {
      return {
        message: event.message,
        usage: event.usage,
        finishReason: event.finishReason,
        modelSlug: event.modelSlug,
      };
    }
  }
  throw new Error("El stream terminó sin emitir un evento 'done'");
}
