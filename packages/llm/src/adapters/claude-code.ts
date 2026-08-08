import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ProviderId } from "@orq/shared";
import {
  LlmError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type FinishReason,
  type LlmProvider,
  type OrgToolsBridge,
  type OrgToolsSession,
} from "../types.js";

/**
 * Proveedor que delega cada llamada al CLI oficial de Claude Code.
 *
 * Es la **única** vía de usar una suscripción de claude.ai (Pro/Max) desde un
 * producto propio: la API (que este proyecto ya usa en `anthropic.ts`) factura
 * por uso contra la organización — no hay ruta que la facture a la suscripción.
 * Acá el modelo corre del lado de Anthropic con el login de esta máquina.
 *
 * ## Cómo se integra con el engine
 *
 * El engine espera que el proveedor devuelva `tool_calls` que él mismo ejecuta
 * con su `ToolRegistry`. Claude Code no habla ese protocolo: corre su propio
 * loop con sus propias herramientas (Bash, archivos, web). Así que este
 * adaptador **no devuelve `tool_calls`**: delega una vez, de punta a punta, y
 * responde con el texto final. El loop del engine ve cero llamadas y corta el
 * turno en la primera iteración — justo lo que queremos: la corrida del CLI
 * hace el trabajo entero bajo la suscripción.
 *
 * El agente trabaja en un directorio exclusivo (`workspaceDir`), donde el CLI
 * puede crear archivos. No usa las herramientas de coordinación del org; ese
 * puente MCP es un paso siguiente.
 *
 * ## Límites
 *
 * 1. La credencial es de esta máquina (la que inició sesión con su suscripción).
 * 2. La suscripción tiene rate-limits por ventana y semanales, pensados para
 *    uso interactivo: un farm 24/7 se va a throttlear.
 * 3. En modo `--print` el CLI acepta solo las herramientas permitidas; se corre
 *    con una allowlist de desarrollo, no con `--dangerously-skip-permissions`.
 */
export interface ClaudeCodeConfig {
  /** Binario del CLI. Default `claude`. */
  command?: string;
  /** Carpeta de trabajo del agente; se crea si no existe. Default: temp. */
  workspaceDir?: string;
  /** Modelo por defecto (`sonnet`, `opus`, `haiku` o un slug exacto). */
  model?: string;
  /** Herramientas permitidas, separadas por coma. El resto se niega en `--print`. */
  allowedTools?: string;
}

/** Alias cortos que entiende `--model` de Claude Code. */
const ALIASES = ["haiku", "sonnet", "opus"] as const;

const DEFAULT_MODEL = "sonnet";
const DEFAULT_ALLOWED_TOOLS =
  "Bash,Read,Write,Edit,Glob,Grep,NotebookEdit,WebSearch,WebFetch";

/**
 * Lo que se permite cuando el agente trabaja **sobre el directorio de la empresa**.
 *
 * Mirar, buscar y leer: nada que escriba. Es lo que convierte a un agente ciego
 * en uno que puede abrir la previsualización de su lámina, leer el PDF que subió
 * una persona y revisar el archivo que dejó en el turno anterior.
 *
 * Sin `Write`, `Edit` ni `Bash` a propósito. Producir sigue yendo por
 * `write_output_file`, que es lo único que sanea la ruta segmento por segmento,
 * registra la procedencia en `.orq-generado.json` y respeta la jerarquía de
 * borrado. Dejar que el CLI escriba directo en esa carpeta saltearía las tres
 * garantías de una sola vez, y encima sin dejar rastro en la traza.
 */
const ALLOWED_TOOLS_LECTURA = "Read,Glob,Grep,WebSearch,WebFetch";

/** Catálogo mínimo para que la UI pueda elegir este proveedor. */
export function claudeCodeCatalog(providerId: ProviderId, preferido: string): ModelInfo[] {
  const slugs = [...new Set([preferido, ...ALIASES])];
  return slugs.map((slug) => ({
    providerId,
    slug: `claude-code/${slug}`,
    name: `Claude Code — ${cap(slug)} (Max)`,
    contextLength: 200_000,
    supportsTools: false,
    inputPricePerMTok: null as null,
    outputPricePerMTok: null as null,
  }));
}

/**
 * Cuánto se le da a un turno delegado, en milisegundos.
 *
 * Diez minutos y no dos: acá no se espera la respuesta de una API, se espera que
 * un agente **entero** lea, escriba archivos y llame herramientas por MCP. Con
 * el corte por defecto del motor, cada turno moría por tiempo justo cuando el
 * agente estaba trabajando, y lo poco que había producido se perdía.
 */
const CORTE_MS = 600_000;

export class ClaudeCodeProvider implements LlmProvider {
  readonly id: ProviderId = "claude-code";
  readonly label = "Claude Code (suscripción)";
  readonly timeoutMs = CORTE_MS;

  private readonly command: string;
  private readonly workspace: string;
  private readonly model: string;
  private readonly allowedTools: string;
  private catalog: ModelInfo[] | null = null;

  constructor(config: ClaudeCodeConfig = {}) {
    this.command = config.command ?? "claude";
    this.workspace = config.workspaceDir ?? join(tmpdir(), "orq-claude-code");
    this.model = config.model ?? DEFAULT_MODEL;
    this.allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.catalog && !refresh) return this.catalog;
    this.catalog = claudeCodeCatalog(this.id, this.model);
    return this.catalog;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.delegate("Respondé únicamente con la palabra: ok", undefined, this.model, undefined);
      return { ok: true, detail: "CLI responde y la suscripción está activa." };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const model = aliasOfSlug(req.model);
    const prompt = render(req.messages);
    const text = await this.delegate(prompt, req.signal, model, req.orgTools);

    if (text) yield { type: "text_delta", text };
    yield {
      type: "done",
      message: { role: "assistant", content: text },
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
      modelSlug: `claude-code/${model}`,
    };
  }

  /**
   * Invoca el CLI una vez, de punta a punta, y devuelve el texto final.
   *
   * Dónde trabaja depende de qué le presta el org. Sin directorio de empresa,
   * una carpeta propia por turno donde el CLI puede escribir a gusto. Con
   * directorio de empresa, **ahí mismo y de sólo lectura**: el agente ve lo que
   * la empresa produjo —su lámina, la previsualización, el documento que subió
   * una persona— y sigue escribiendo por las herramientas del org, que son las
   * que sanean, registran procedencia y respetan la jerarquía.
   */
  private async delegate(
    prompt: string,
    signal: AbortSignal | undefined,
    model: string,
    orgTools: OrgToolsBridge | undefined,
  ): Promise<string> {
    const session = orgTools ? await orgTools.open() : null;
    const configPath = session ? mcpConfigPath(session) : null;
    const trabajo = session?.cwd ?? newDir(this.workspace);
    const propias = session?.cwd ? ALLOWED_TOOLS_LECTURA : this.allowedTools;
    // El cierre se arma acá y no en `render` porque depende de con qué permisos
    // quedó el directorio, y eso recién se sabe con la sesión abierta. Sin
    // sesión —el health check— no se agrega nada.
    const completo = orgTools ? prompt + cierre(Boolean(session?.cwd)) : prompt;
    const args = construirArgs({
      prompt: completo,
      model,
      propias,
      ...(session ? { session } : {}),
      ...(configPath ? { configPath } : {}),
    });

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: trabajo,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });

      let aborted = false;
      /**
       * Abortar **tiene que cerrar la promesa**.
       *
       * Antes esto sólo mataba al proceso y dejaba que el handler de `exit`
       * saliera por `if (aborted) return`: la promesa no se resolvía nunca, el
       * turno se quedaba esperando para siempre y la corrida entera se colgaba
       * en un ciclo, sin proceso vivo y sin `agent.turn_end`. Es exactamente la
       * falla que el proyecto ya conocía —"un proveedor que no contesta cuelga
       * la corrida"— reintroducida por la puerta de atrás: no alcanza con tener
       * un corte por tiempo si al dispararse nadie contesta.
       */
      const onAbort = (): void => {
        aborted = true;
        child.kill("SIGTERM");
        // SIGTERM es un pedido, no una orden: un CLI trabado no lo atiende y el
        // proceso queda huérfano gastando la suscripción.
        const remate = setTimeout(() => child.kill("SIGKILL"), 5_000);
        remate.unref?.();
        session?.close().catch(() => {});
        reject(
          new LlmError(
            "Claude Code: el turno se cortó antes de terminar (se agotó el tiempo o se " +
              "detuvo la corrida). El CLI corre un agent loop entero por turno, así que " +
              "si esto pasa seguido conviene subir el corte del proveedor.",
            "claude-code",
            false,
          ),
        );
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c) => (stdout += c.toString()));
      child.stderr?.on("data", (c) => (stderr += c.toString()));

      child.on("error", (error) => {
        if (aborted) return;
        session?.close().catch(() => {});
        reject(
          new LlmError(
            `No se pudo ejecutar el CLI de Claude Code (${this.command}): ${error.message}. ` +
              `Instalalo con tu suscripción de claude.ai.`,
            "claude-code",
            false,
            error,
          ),
        );
      });

      child.on("exit", (code) => {
        if (aborted) return;
        session?.close().catch(() => {});
        const resultEvt = lastResult(stdout);
        if (resultEvt && !resultEvt.is_error && resultEvt.result !== undefined) {
          resolve(resultEvt.result);
          return;
        }
        const detail = resultEvt?.error ?? (stderr.trim() || `CLI salió con código ${String(code)}`);
        reject(new LlmError(`Claude Code: ${detail}`, "claude-code", false));
      });
    });
  }
}

/**
 * Los argumentos con los que se invoca el CLI.
 *
 * Vive aparte y se exporta porque acá hay una **regla de seguridad** y no una
 * preferencia: cuando el agente trabaja sobre el directorio de la empresa, entre
 * lo permitido no puede aparecer nada que escriba. Una regla de seguridad que
 * sólo existe adentro de un `spawn` no se puede verificar; ésta tiene su test.
 */
export function construirArgs(opciones: {
  prompt: string;
  model: string;
  /** Herramientas propias del CLI, separadas por coma. */
  propias: string;
  session?: OrgToolsSession;
  configPath?: string;
}): string[] {
  const permitidas = opciones.session
    ? [...opciones.propias.split(","), ...opciones.session.allowedTools].join(",")
    : opciones.propias;

  const args = [
    "-p", opciones.prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", opciones.model,
    "--allowedTools", permitidas,
  ];
  if (opciones.session && opciones.configPath) {
    args.push("--strict-mcp-config", "--mcp-config", opciones.configPath);
  }
  return args;
}

/** Las herramientas de lectura que se prestan sobre el directorio de la empresa. */
export const HERRAMIENTAS_DE_LECTURA = ALLOWED_TOOLS_LECTURA;

/** Último evento `result` de la salida `stream-json`. */
function lastResult(
  stdout: string,
): { is_error: boolean; result?: string; error?: string } | null {
  let last: { is_error: boolean; result?: string; error?: string } | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.type === "result") {
        last = {
          is_error: parsed.is_error ?? false,
          result: parsed.result,
          error: parsed.error,
        };
      }
    } catch {
      continue;
    }
  }
  return last;
}

/** Render de la conversación a un prompt plano para el CLI. */
function render(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(message.content);
    } else if (message.role === "user") {
      parts.push(`## Instrucción de la persona\n${message.content}`);
    } else if (message.role === "assistant" && message.content) {
      parts.push(`## Tu respuesta anterior\n${message.content}`);
    }
  }
  return (
    parts.join("\n\n").trim() +
    ""
  );
}

/**
 * Cómo termina el prompt, según con qué permisos quedó el directorio.
 *
 * Decirle "dejá ahí los archivos que produzcas" cuando el directorio es el de la
 * empresa y está en sólo lectura lo manda a intentar un `Write` que no tiene
 * permitido: gasta el turno peleando con el permiso en vez de usar la
 * herramienta del org que sí puede.
 */
function cierre(soloLectura: boolean): string {
  const donde = soloLectura
    ? "\n\nEl directorio actual es el de salida de la empresa y lo tenés en modo " +
      "lectura: abrí con tus propias herramientas lo que necesites mirar —una imagen, " +
      "un documento, un archivo que dejaste en un turno anterior—. Para **producir** o " +
      "modificar algo usá las herramientas de la organización, que son las únicas que " +
      "dejan rastro en la traza y respetan los permisos."
    : "\n\nTrabajás en el directorio actual. Dejá ahí los archivos que produzcas.";
  return `${donde}\nTerminá el turno con un resumen en texto, para la organización.`;
}

function aliasOfSlug(reqModel: string): string {
  const base = reqModel.includes("/") ? (reqModel.split("/").pop() as string) : reqModel;
  return ALIASES.includes(base as (typeof ALIASES)[number]) ? base : base;
}

function newDir(base: string): string {
  const dir = join(base, `turno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Escribe el `--mcp-config` del puente org y devuelve la ruta del archivo.
 *
 * Claude Code levanta la config desde un archivo y la lee de forma estricta;
 * no acepta el JSON en línea. El servidor se conecta por un socket Unix al
 * engine, vía un relay stdio (un proceso Node mínimo que puentea stdin/stdout
 * con el socket). Ese relay es este mismo archivo hermano `claude-code-relay.mjs`.
 */
function mcpConfigPath(session: OrgToolsSession): string {
  const relay = fileURLToPath(new URL("./claude-code-relay.mjs", import.meta.url));
  const config = {
    mcpServers: {
      [session.serverName]: {
        type: "stdio",
        command: process.execPath,
        args: [relay],
        env: { ORQ_SOCKET: session.socketPath },
      },
    },
  };
  const file = join(tmpdir(), `orq-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify(config));
  return file;
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}