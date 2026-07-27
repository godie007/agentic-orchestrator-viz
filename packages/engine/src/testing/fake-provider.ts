import type { ModelInfo, ProviderId } from "@orq/shared";
import type { ChatEvent, ChatRequest, LlmProvider, ToolCall } from "@orq/llm";

/**
 * Proveedor falso para los tests del motor.
 *
 * Devuelve respuestas guionadas en función del rol que está hablando, lo que
 * permite verificar la coordinación entre agentes —quién le escribe a quién y
 * en qué ciclo— de forma determinista y sin gastar tokens.
 *
 * También es la prueba de desacoplamiento: el motor no sabe que este proveedor
 * no habla con ningún modelo.
 */

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** Decide qué responder a partir del prompt recibido. */
export type Script = (req: ChatRequest, callIndex: number) => ScriptedTurn;

export class FakeProvider implements LlmProvider {
  readonly label = "Proveedor de prueba";
  /** Todas las peticiones recibidas, para inspeccionarlas en los asserts. */
  readonly calls: ChatRequest[] = [];

  private callIndex = 0;

  constructor(
    private readonly script: Script,
    readonly id: ProviderId = "openai",
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        providerId: this.id,
        slug: "fake-model",
        name: "Modelo de prueba",
        contextLength: 200_000,
        inputPricePerMTok: 1,
        outputPricePerMTok: 2,
        supportsTools: true,
      },
    ];
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "proveedor de prueba" };
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    this.calls.push(req);
    const turn = this.script(req, this.callIndex++);

    if (turn.text) yield { type: "text_delta", text: turn.text };

    const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, index) => ({
      id: `call_${this.callIndex}_${index}`,
      name: call.name,
      arguments: call.arguments,
    }));
    for (const call of toolCalls) yield { type: "tool_call", call };

    yield {
      type: "done",
      message: {
        role: "assistant",
        content: turn.text ?? "",
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      modelSlug: req.model,
    };
  }
}

/** Extrae el nombre del rol del prompt de sistema, para guionar por rol. */
export function actorOf(req: ChatRequest): string {
  const system = req.messages.find((message) => message.role === "system")?.content ?? "";
  return /^Sos ([^,]+),/m.exec(system)?.[1]?.trim() ?? "";
}

/**
 * `true` si el turno ya ejecutó al menos una herramienta.
 *
 * Un modelo real actúa y cierra el turno; un guion que devuelve siempre la
 * misma tool call reitera hasta agotar `maxTurns` del rol. Usá esto para que
 * el falso se comporte como el real y el test mida coordinación, no el cap.
 */
export function alreadyActed(req: ChatRequest): boolean {
  return req.messages.some((message) => message.role === "tool");
}
