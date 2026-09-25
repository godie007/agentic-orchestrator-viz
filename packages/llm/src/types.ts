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
  /**
   * Preferencia de ruteo para los proveedores que agregan varios upstreams.
   *
   * Sin esto cada llamada cae en un upstream distinto y **el caché nunca pega**:
   * el prefijo está cacheado en otra máquina. Un orden determinista deja las
   * llamadas de un turno en el mismo lugar.
   */
  routing?: RoutingPreference;
  /**
   * Puente a las herramientas de coordinación del org, para los proveedores
   * que corren su propio loop (Claude Code CLI) en vez de devolver `tool_calls`.
   *
   * Si está presente, el adaptador abre una sesión MCP antes de delegar y arma
   * el `--mcp-config` + la allowlist de herramientas con prefijo `mcp__…`. El
   * engine es quien implementa el servidor MCP (reside en su proceso y ejecuta
   * sus propias `RegisteredTool`); este tipo es solo el contrato que consume el
   * proveedor.
   */
  orgTools?: OrgToolsBridge;
  signal?: AbortSignal;
}

/** Sesión MCP abierta por el puente hacia las herramientas del org. */
export interface OrgToolsSession {
  /** Ruta del socket Unix donde el engine escucha el servidor MCP. */
  socketPath: string;
  /** Nombre del servidor en el `--mcp-config` (define el prefijo `mcp__<n>__`). */
  serverName: string;
  /** Nombres MCP completos de las herramientas expuestas (`mcp__orq__tool`). */
  allowedTools: string[];
  /**
   * Directorio de salida de la empresa, para que el agente **vea** lo que produjo.
   *
   * Es la diferencia entre un diseñador que puede mirar la lámina que programó y
   * uno que trabaja a ciegas: con esto, las herramientas nativas del CLI leen la
   * previsualización, el PDF que subió una persona y sus propios archivos.
   *
   * Se entrega **de sólo lectura** (ver `claude-code.ts`): escribir sigue yendo
   * por `write_output_file`, que es lo único que sanea la ruta segmento por
   * segmento, anota la procedencia en el manifiesto y aplica la jerarquía de
   * borrado. Un `cwd` con permiso de escritura saltearía las tres cosas.
   */
  cwd?: string;
  /**
   * El turno trabaja sobre un repo: `cwd` es su worktree, no la salida.
   *
   * Es la excepción a la regla de sólo lectura, y por eso viene explícita: con
   * `escritura` el CLI recibe `Edit`/`Write` —el turno tiene el arriendo del
   * repo—, y **nunca** `Bash`: los comandos van por `ejecutar_comando` del org,
   * que es lo único que aplica sandbox, entorno limpio y deja rastro.
   */
  codigo?: { cwd: string; escritura: boolean };
  /**
   * ¿Hay una herramienta del org ejecutándose ahora? Mientras corre —un
   * `npm test` de cinco minutos— el CLI no emite nada, y el vigilante de
   * silencio del proveedor tomaría ese silencio por un cuelgue.
   */
  ocupada?(): boolean;
  /** Cierra la sesión: detiene el listen del socket y libera recursos. */
  close(): Promise<void>;
}

/** Fábrica de sesiones: `open()` arranca un socket nuevo por delegación. */
export interface OrgToolsBridge {
  open(): Promise<OrgToolsSession>;
}

/** Cómo elegir entre los upstreams que sirven un mismo modelo. */
export interface RoutingPreference {
  /** `price` es el default: es determinista y evita el endpoint caro al azar. */
  sort: "price" | "throughput" | "latency";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cuántos de los de entrada salieron del caché del proveedor.
   *
   * Dentro de un turno la conversación crece pero su prefijo no cambia, así que
   * casi todo se puede servir cacheado —y cuesta cerca de diez veces menos—.
   * Medido: es la diferencia entre US$0.0022 y US$0.068 por la misma llamada.
   */
  cachedInputTokens?: number;
  /**
   * Costo real informado por el proveedor, si lo informa.
   *
   * Vale más que el precio del catálogo: OpenRouter publica el del endpoint
   * **más barato** del modelo, pero rutea a cualquiera de los 18 que lo sirven,
   * con hasta 4x de diferencia. Calcular con el de catálogo subestima la
   * factura, y el presupuesto de la corrida deja de ser un límite real.
   */
  reportedCostUsd?: number | null;
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
      /** Ver `ChatResult.herramientasPropias`. */
      herramientasPropias?: HerramientaPropia[];
      /** Ver `ChatResult.avisos`. */
      avisos?: string[];
    };

/** Una herramienta que el CLI delegado usó por su cuenta (`Edit`, `Read`…). */
export interface HerramientaPropia {
  nombre: string;
  /** El archivo que tocó, si la herramienta es de archivos. */
  ruta: string | null;
}

export interface ChatResult {
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: FinishReason;
  modelSlug: string;
  /**
   * Lo que un proveedor que delega hizo con **sus propias** herramientas.
   *
   * Las del org pasan por el puente y se cuentan solas; las del CLI no. Sin
   * esto, un programador que sólo usa el `Edit` de Claude Code cuenta cero
   * herramientas por turno, el scheduler lo toma por un rol que habla sin
   * hacer nada y a los dos turnos lo deja de convocar — con el trabajo a medias.
   */
  herramientasPropias?: HerramientaPropia[];
  /**
   * Lo que el proveedor quiere que se sepa del turno y no es parte de la
   * respuesta: que el modelo pedido estaba saturado y respondió otro, que la
   * suscripción está cerca de su límite. El motor los vuelca a la traza.
   */
  avisos?: string[];
}

/**
 * Contrato que cumple todo proveedor. El motor solo conoce esta interfaz.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  /** Nombre legible para la UI. */
  readonly label: string;
  /**
   * Cuánto puede tardar una llamada de este proveedor, en milisegundos.
   *
   * El corte por defecto del motor está pensado para una API que contesta en
   * segundos. `claude-code` no es eso: delega el turno entero al CLI, que corre
   * su propio agent loop con sus herramientas, y dos minutos se le quedan cortos
   * **siempre**. Sin esto, cada turno moría por tiempo justo cuando el agente
   * estaba trabajando.
   *
   * Es una propiedad del proveedor y no de la corrida a propósito: quien
   * configura una empresa no tiene por qué saber cuánto tarda cada backend.
   */
  readonly timeoutMs?: number;
  /**
   * El corte cuando el turno trabaja sobre código. Un turno que lee, edita y
   * corre tests tarda más que uno que redacta un mensaje, y con el corte común
   * moría justo mientras corría la verificación.
   */
  readonly timeoutCodigoMs?: number;
  /**
   * El proveedor corre su **propio** agent loop y no devuelve `tool_calls`.
   *
   * Son los que delegan al CLI de una suscripción (`claude-code`, `opencode`).
   * El motor lo mira para prestarles el puente MCP con las herramientas del
   * org: sin eso, el agente delegado no puede coordinar con nadie. Es una
   * propiedad del proveedor y no una lista de ids en el motor a propósito —
   * agregar un CLI más no puede obligar a tocar `loop.ts`.
   */
  readonly delegaElTurno?: boolean;
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
        ...(event.herramientasPropias ? { herramientasPropias: event.herramientasPropias } : {}),
        ...(event.avisos?.length ? { avisos: event.avisos } : {}),
      };
    }
  }
  throw new Error("El stream terminó sin emitir un evento 'done'");
}
