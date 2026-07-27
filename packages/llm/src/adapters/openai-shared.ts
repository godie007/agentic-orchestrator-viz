import type OpenAI from "openai";
import type { ChatMessage, FinishReason, ToolCall, ToolDefinition } from "../types.js";

/**
 * Traducciones compartidas por los adaptadores que hablan el dialecto de
 * OpenAI (OpenAI directo, OpenRouter y Ollama). Viven acá para que agregar un
 * cuarto proveedor compatible sea un archivo de veinte líneas.
 */

export function toOpenAiMessages(
  messages: ChatMessage[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((message): OpenAI.ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "tool":
        return {
          role: "tool",
          content: message.content,
          tool_call_id: message.toolCallId ?? "",
        };
      case "assistant":
        return {
          role: "assistant",
          content: message.content || null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        };
    }
  });
}

export function toOpenAiTools(tools?: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return (tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Las tool calls llegan fragmentadas: el `id` y el nombre en un chunk, y los
 * argumentos JSON repartidos carácter a carácter en los siguientes, todos
 * identificados por `index`. Esto los reensambla.
 */
export class ToolCallAccumulator {
  private byIndex = new Map<number, PartialCall>();

  push(deltas: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined): void {
    if (!deltas) return;
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      const current = this.byIndex.get(index) ?? { id: "", name: "", args: "" };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name = delta.function.name;
      if (delta.function?.arguments) current.args += delta.function.arguments;
      this.byIndex.set(index, current);
    }
  }

  finalize(): ToolCall[] {
    const calls: ToolCall[] = [];
    for (const [index, partial] of this.byIndex) {
      if (!partial.name) continue; // fragmento sin nombre: no es invocable
      calls.push({
        id: partial.id || `call_${index}`,
        name: partial.name,
        arguments: parseArguments(partial.args),
      });
    }
    return calls;
  }
}

/**
 * Un modelo puede cortar el JSON a mitad de camino. En vez de romper el turno
 * entero, se pasa el texto crudo bajo `__raw`: el ejecutor de la herramienta
 * falla la validación y le devuelve al agente un error que puede corregir.
 */
function parseArguments(raw: string): Record<string, unknown> {
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
