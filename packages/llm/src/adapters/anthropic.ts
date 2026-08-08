import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo, ProviderId } from "@orq/shared";
import {
  LlmError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type LlmProvider,
  type ToolCall,
} from "../types.js";

/** Header que exige `/v1/messages` cuando se autentica con un token OAuth. */
const BETA_OAUTH = "oauth-2025-04-20";

export interface AnthropicConfig {
  /** Clave de API estática, la de `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /**
   * Token OAuth de corta vida, el de `ant auth print-credentials --access-token`.
   *
   * Viaja como `Authorization: Bearer` en vez de `x-api-key`, y **además**
   * necesita el beta `oauth-2025-04-20`: sin ese header `/v1/messages` rechaza
   * el token aunque sea válido. Pasar de una clave a un token no es cambiar el
   * valor, es cambiar los dos headers — por eso lo maneja el adaptador y no
   * quien lo configura.
   */
  authToken?: string;
  /** Con qué id se registra. Permite que convivan dos instancias distintas. */
  id?: ProviderId;
  label?: string;
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
  readonly id: ProviderId;
  readonly label: string;

  private client: Anthropic;
  private cache: ModelInfo[] | null = null;

  constructor(config: AnthropicConfig = {}) {
    this.id = config.id ?? "anthropic";
    this.label = config.label ?? "Anthropic";

    if (config.authToken) {
      this.client = new Anthropic({
        authToken: config.authToken,
        defaultHeaders: { "anthropic-beta": BETA_OAUTH },
      });
    } else if (config.apiKey) {
      this.client = new Anthropic({ apiKey: config.apiKey });
    } else {
      // Sin nada explícito, el constructor vacío deja que el SDK recorra su
      // cadena de credenciales. Hoy eso alcanza `ANTHROPIC_API_KEY` y
      // `ANTHROPIC_AUTH_TOKEN`; cuando el SDK sume la resolución del perfil de
      // `ant auth login`, esta rama la hereda sin tocar nada.
      this.client = new Anthropic();
    }
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
      throw wrapError(error, this.id);
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
      throw wrapError(error, this.id);
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
      throw wrapError(error, this.id);
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
 * Claude autenticado con la sesión de `ant auth login`, no con una API key.
 *
 * Es el mismo adaptador: sólo cambia de dónde sale la credencial. Existe como
 * proveedor aparte —y no como una opción del anterior— porque un rol elige
 * proveedor por id: así le podés dar la sesión a **un** agente sin tocar a los
 * demás.
 *
 * ## Cómo se usa hoy
 *
 * El SDK instalado (0.68) resuelve `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN`,
 * pero **todavía no lee el perfil de `~/.config/anthropic/`**. Así que la sesión
 * entra por token:
 *
 * ```sh
 * ant auth login
 * export ANTHROPIC_AUTH_TOKEN=$(ant auth print-credentials --access-token)
 * ```
 *
 * El token es de **corta vida** y no se auto-refresca al pasarlo por variable de
 * entorno: cuando el rol empiece a fallar la autenticación, se vuelve a
 * exportar. Cuando el SDK sume la resolución del perfil en disco, esto pasa a
 * ser automático sin cambiar una línea — por eso el adaptador construye el
 * cliente vacío cuando no le dan credencial.
 *
 * ## Dos límites que conviene saber antes de asignarlo
 *
 * 1. **No es la suscripción de claude.ai.** `ant auth login` es un login a la
 *    plataforma de desarrollo: sigue facturando como API contra tu
 *    organización. Lo que ahorra es tener una clave estática en `.env`.
 * 2. **La credencial es de esta máquina**, la que inició sesión. Alcanza para el
 *    orquestador —corre local y de un solo usuario— y no para un servidor: ahí
 *    el camino soportado sigue siendo la API key.
 */
export class ClaudeSesionProvider extends AnthropicProvider {
  constructor(config: { authToken?: string } = {}) {
    super({
      id: "claude-sesion",
      label: "Claude (sesión)",
      ...(config.authToken ? { authToken: config.authToken } : {}),
    });
  }

  /**
   * El diagnóstico dice qué hacer, no sólo que falló.
   *
   * Es el único proveedor cuya credencial no está en `.env`, así que un 401 acá
   * no se arregla mirando ese archivo: hay que saber que sale de `ant`, y que
   * una `ANTHROPIC_API_KEY` definida la pisa.
   */
  override async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const estado = await super.healthCheck();
    if (estado.ok) return estado;
    return {
      ok: false,
      detail:
        `${estado.detail} — este proveedor usa la sesión de \`ant auth login\`. ` +
        `Iniciá sesión y exportá el token con ` +
        `\`export ANTHROPIC_AUTH_TOKEN=$(ant auth print-credentials --access-token)\`. ` +
        `El token vence: si esto andaba y dejó de andar, volvé a exportarlo. ` +
        `Y revisá que no haya una ANTHROPIC_API_KEY definida: gana sobre el token.`,
    };
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

function wrapError(error: unknown, id: ProviderId): LlmError {
  if (error instanceof LlmError) return error;
  const status = (error as { status?: number })?.status;
  const retryable = status === 429 || (status != null && status >= 500);
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(`Anthropic: ${message}`, id, retryable, error);
}
