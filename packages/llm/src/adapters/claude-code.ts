import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  type HerramientaPropia,
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
  /** Silencio tolerado antes de dar el CLI por colgado. Ver `SILENCIO_MAX_MS`. */
  silencioMaxMs?: number;
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

/**
 * Lo que se presta cuando el turno trabaja **sobre un repo** (`session.codigo`).
 *
 * Es la única excepción a la regla de sólo lectura, y viene acotada: el
 * directorio es el worktree de la sesión —nunca el repo de la persona—, sólo
 * el turno con el arriendo recibe `Edit`/`Write`, y **nadie recibe `Bash`**.
 * Los comandos van por `ejecutar_comando` del org: es lo único que aplica el
 * sandbox, limpia el entorno de credenciales, cuenta para los frenos y deja
 * rastro en la traza. Un `Bash` del CLI haría todo eso invisible.
 */
const ALLOWED_TOOLS_CODIGO_LECTURA = "Read,Glob,Grep,WebFetch";
const ALLOWED_TOOLS_CODIGO_ESCRITURA = `${ALLOWED_TOOLS_CODIGO_LECTURA},Edit,MultiEdit,Write,NotebookEdit`;

/**
 * Lo que se niega explícito en modo código, aunque la allowlist ya no lo
 * incluya: una negación sobrevive a que alguien agregue `Bash` a la lista por
 * error, y `.git` no se edita nunca —un hook escrito ahí es código que corre
 * en el próximo checkpoint, fuera del sandbox—.
 */
const NEGADAS_EN_CODIGO = ["Bash", "Edit(.git/**)", "Write(.git/**)", "MultiEdit(.git/**)", "Edit(.git)", "Write(.git)"];

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

/**
 * Cuánto silencio del CLI se tolera antes de darlo por colgado.
 *
 * Con `--include-partial-messages` el CLI emite un evento por cada trozo de
 * texto que genera, así que el silencio no es "está pensando": es que la API
 * no está contestando. Lo medimos: turnos con huecos de **quince minutos**
 * exactos sin una sola llamada, tres en la misma corrida —45 de sus 65
 * minutos—. El silencio mientras corre una herramienta del org (un `npm test`
 * largo) no cuenta: la sesión avisa que está ocupada.
 */
const SILENCIO_MAX_MS = Number(process.env["CLAUDE_CODE_SILENCIO_MS"] ?? 180_000);

/**
 * A qué modelo pasa el CLI cuando el pedido está saturado (`--fallback-model`).
 *
 * Opus bajo demanda alta devolvía error diez veces seguidas, con esperas de
 * hasta 38 s, y el turno moría a los tres minutos sin hacer nada —y el ciclo
 * siguiente repetía lo mismo—. Que lo resuelva Sonnet es mejor que perder el
 * turno, y queda dicho en la traza.
 */
const RESPALDO: Record<string, string> = { opus: "sonnet", sonnet: "opus", haiku: "sonnet" };

/**
 * El corte de un turno que programa: leer, editar y correr la verificación
 * entera no entra en diez minutos. Se ajusta con `CLAUDE_CODE_CODIGO_TIMEOUT_MS`.
 */
const CORTE_CODIGO_MS = Number(process.env["CLAUDE_CODE_CODIGO_TIMEOUT_MS"] ?? 1_500_000);

export class ClaudeCodeProvider implements LlmProvider {
  readonly id: ProviderId = "claude-code";
  readonly label = "Claude Code (suscripción)";
  readonly timeoutMs = CORTE_MS;
  readonly timeoutCodigoMs = CORTE_CODIGO_MS;
  /** Corre su propio agent loop: el motor le presta el puente MCP del org. */
  readonly delegaElTurno = true;

  private readonly command: string;
  private readonly workspace: string;
  private readonly model: string;
  private readonly allowedTools: string;
  private readonly silencioMaxMs: number;
  private catalog: ModelInfo[] | null = null;

  constructor(config: ClaudeCodeConfig = {}) {
    this.command = config.command ?? "claude";
    this.workspace = config.workspaceDir ?? join(tmpdir(), "orq-claude-code");
    this.model = config.model ?? DEFAULT_MODEL;
    this.allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.silencioMaxMs = config.silencioMaxMs ?? SILENCIO_MAX_MS;
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
    const { texto, uso, herramientasPropias, avisos, modeloReal } = await this.delegate(
      prompt,
      req.signal,
      model,
      req.orgTools,
    );

    if (texto) yield { type: "text_delta", text: texto };
    yield {
      type: "done",
      message: { role: "assistant", content: texto },
      // El consumo sale del CLI, que lo publica en su evento `result`. Antes
      // iban ceros fijos: una corrida entera informaba cero tokens mientras se
      // comía la ventana de uso, y no había forma de verlo hasta que el
      // proveedor cortaba.
      //
      // El costo en dólares **no** se reporta a propósito, aunque el CLI lo
      // calcula (`total_cost_usd`): es lo que habría salido por API, y acá no
      // se paga por token sino con la suscripción. Informarlo dispararía
      // `budgetUsd` y cortaría corridas que no cuestan dinero. Lo que sí es un
      // recurso finito son los tokens, y ésos ahora se ven.
      usage: uso,
      finishReason: "stop",
      // El modelo que respondió de verdad: con fallback puede no ser el pedido.
      modelSlug: `claude-code/${modeloReal ?? model}`,
      ...(herramientasPropias?.length ? { herramientasPropias } : {}),
      ...(avisos?.length ? { avisos } : {}),
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
  ): Promise<ResultadoDelegacion> {
    const session = orgTools ? await orgTools.open() : null;
    const configPath = session ? mcpConfigPath(session) : null;
    const trabajo = session?.cwd ?? newDir(this.workspace);
    const modo: ModoDeTrabajo = session?.codigo
      ? session.codigo.escritura
        ? "codigo-escritura"
        : "codigo-lectura"
      : session?.cwd
        ? "salida-lectura"
        : "libre";
    const propias = herramientasPara(modo, this.allowedTools);
    // El cierre se arma acá y no en `render` porque depende de con qué permisos
    // quedó el directorio, y eso recién se sabe con la sesión abierta. Sin
    // sesión —el health check— no se agrega nada.
    const completo = orgTools ? prompt + cierre(modo) : prompt;
    const respaldo = RESPALDO[model];
    const args = construirArgs({
      prompt: completo,
      model,
      propias,
      parciales: true,
      ...(respaldo ? { respaldo } : {}),
      ...(modo.startsWith("codigo") ? { negadas: NEGADAS_EN_CODIGO } : {}),
      ...(session ? { session } : {}),
      ...(configPath ? { configPath } : {}),
    });
    const inicio = Date.now();

    return new Promise<ResultadoDelegacion>(
      (resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: trabajo,
        stdio: ["ignore", "pipe", "pipe"],
        env: entornoDelCli(process.env),
      });

      let aborted = false;
      // Se declara acá arriba porque `onAbort` puede correr en el acto (una
      // señal ya abortada) antes de que el vigilante exista.
      let vigilante: ReturnType<typeof setInterval> | undefined;
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
        clearInterval(vigilante);
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

      // Los eventos parciales (`stream_event`) sólo sirven de latido: se usan
      // para el vigilante y no se guardan. Son un evento por trozo de texto, y
      // acumularlos multiplicaba por diez la memoria de un turno largo.
      let stdout = "";
      let pendiente = "";
      let stderr = "";
      let ultimaActividad = Date.now();
      let colgado = false;
      const guardarLinea = (linea: string) => {
        if (linea && !linea.startsWith('{"type":"stream_event"')) stdout += `${linea}\n`;
      };
      child.stdout?.on("data", (c) => {
        ultimaActividad = Date.now();
        pendiente += c.toString();
        const lineas = pendiente.split("\n");
        pendiente = lineas.pop() ?? "";
        for (const linea of lineas) guardarLinea(linea);
      });
      child.stderr?.on("data", (c) => (stderr += c.toString()));

      vigilante = setInterval(() => {
        // Una herramienta del org corriendo no es silencio: es trabajo.
        if (session?.ocupada?.()) {
          ultimaActividad = Date.now();
          return;
        }
        if (Date.now() - ultimaActividad > this.silencioMaxMs) {
          colgado = true;
          clearInterval(vigilante);
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
        }
      }, Math.min(5_000, Math.max(50, this.silencioMaxMs / 4)));
      vigilante.unref?.();

      child.on("error", (error) => {
        clearInterval(vigilante);
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
        clearInterval(vigilante);
        guardarLinea(pendiente);
        const transcripcion = guardarTranscripcion(this.workspace, model, stdout);
        if (aborted) return;
        session?.close().catch(() => {});
        const resultEvt = lastResult(stdout);
        const herramientasPropias = herramientasPropiasDelCli(stdout);
        const diagnostico = diagnosticoDelTurno(stdout, model);
        const avisos = diagnostico.avisos;
        if (colgado) {
          avisos.push(
            `Claude Code no dio señales durante ${Math.round(this.silencioMaxMs / 1000)} s (la API no respondía) y se cortó el turno para no perder más tiempo. Transcripción: ${transcripcion}`,
          );
        }
        if (!colgado && resultEvt && !resultEvt.is_error && resultEvt.result !== undefined) {
          resolve({
            texto: resultEvt.result,
            uso: resultEvt.uso,
            costoUsd: resultEvt.costoUsd,
            herramientasPropias,
            avisos,
            ...(diagnostico.modeloReal ? { modeloReal: diagnostico.modeloReal } : {}),
          });
          return;
        }

        // El CLI cerró con error, pero el agente pudo haber trabajado igual.
        // Medido: un verificador hizo 27 llamadas, escribió su entregable y
        // movió su tarea; falló su última llamada, el CLI cortó a las 33 vueltas
        // y el turno entero se registró como fallido y sin resumen. Peor: ese
        // fallo alimenta el medidor de dificultad, así que el turno siguiente
        // escalaba a un modelo más caro por un fracaso que no ocurrió.
        const rescatado = ultimoTextoDeAsistente(stdout);
        if (rescatado) {
          resolve({
            texto: `${rescatado}\n\n${AVISO_DE_CIERRE_FORZADO}`,
            uso: resultEvt?.uso ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
            costoUsd: resultEvt?.costoUsd ?? null,
            herramientasPropias,
            avisos,
          });
          return;
        }
        if (colgado) {
          reject(
            new LlmError(
              `Claude Code: la API no respondió durante ${Math.round((Date.now() - inicio) / 1000)} s y se cortó el turno. ` +
                `${diagnostico.reintentos > 0 ? `El CLI reintentó ${diagnostico.reintentos} veces. ` : ""}Transcripción: ${transcripcion}`,
              "claude-code",
              false,
            ),
          );
          return;
        }
        // El diagnóstico tiene que sobrevivir al fallo. Cuando el CLI muere sin
        // emitir un `result` —MCP que no levanta, modelo no disponible, límite
        // de uso— el código de salida solo no dice nada, y una corrida entera
        // se cae con "CLI salió con código 1" sin forma de saber por qué. Lo
        // último que escribió el CLI es lo que explica la causa, así que viaja
        // en el error.
        // Diez reintentos de la API con error desconocido no son un bug del
        // agente: es el modelo saturado. Se dice así, y no con el volcado del
        // stream, que era lo único que mostraba la traza.
        const detail =
          diagnostico.reintentos > 0 && !resultEvt?.result
            ? `la API de Anthropic no respondió después de ${diagnostico.reintentos} reintento(s) (${model} saturado o sin conexión). Transcripción: ${transcripcion}`
            : (resultEvt?.error ??
              (stderr.trim() || `CLI salió con código ${String(code)}${ultimoAliento(stdout)}`));
        reject(new LlmError(`Claude Code: ${detail}`, "claude-code", false));
      });
    });
  }
}

/**
 * El entorno del CLI, **sin credenciales de API**.
 *
 * Este proveedor existe para trabajar con la suscripción, que factura 0 por
 * token. Pero `claude -p` le da prioridad a `ANTHROPIC_API_KEY` si la encuentra
 * en el entorno, y el servidor la tiene cargada cuando la empresa usa además el
 * proveedor `anthropic`: el mismo turno pasaba a facturarse por API sin que
 * nada lo dijera —el costo lo reportamos en 0 a propósito—. Sacarla es lo único
 * que garantiza que lo que corre acá sea lo que el nombre promete.
 */
export function entornoDelCli(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Diez reintentos (el default) con esperas crecientes son tres minutos
    // perdidos por turno cuando el modelo está saturado; con el fallback y el
    // reintento del ciclo siguiente, cuatro alcanzan. Respetamos lo que haya
    // configurado quien corre el servidor.
    CLAUDE_CODE_MAX_RETRIES: base["CLAUDE_CODE_MAX_RETRIES"] ?? "4",
    // Las herramientas del org entran al prompt de entrada en vez de buscarse
    // de a una: medido, 58 `ToolSearch` en una corrida, cada uno una vuelta
    // entera del loop —reenviando el contexto— para cargar un esquema que
    // cabía de una vez. Son decenas, no miles: el caché de prompt las absorbe.
    ENABLE_TOOL_SEARCH: base["ENABLE_TOOL_SEARCH"] ?? "false",
  };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
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
  /** Reglas que se niegan explícito (`--disallowedTools`). */
  negadas?: string[];
  /** Modelo al que pasa el CLI si el pedido está saturado (`--fallback-model`). */
  respaldo?: string;
  /** Eventos parciales: el latido del vigilante de silencio. */
  parciales?: boolean;
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
  if (opciones.negadas?.length) {
    args.push("--disallowedTools", opciones.negadas.join(","));
  }
  if (opciones.respaldo && opciones.respaldo !== opciones.model) {
    args.push("--fallback-model", opciones.respaldo);
  }
  if (opciones.parciales) args.push("--include-partial-messages");
  if (opciones.session && opciones.configPath) {
    args.push("--strict-mcp-config", "--mcp-config", opciones.configPath);
  }
  return args;
}

/** Con qué permisos corre el CLI en este turno. */
export type ModoDeTrabajo = "libre" | "salida-lectura" | "codigo-lectura" | "codigo-escritura";

/** Las herramientas propias del CLI para cada modo. Exportada para fijarla con tests. */
export function herramientasPara(modo: ModoDeTrabajo, libres = DEFAULT_ALLOWED_TOOLS): string {
  switch (modo) {
    case "salida-lectura":
      return ALLOWED_TOOLS_LECTURA;
    case "codigo-lectura":
      return ALLOWED_TOOLS_CODIGO_LECTURA;
    case "codigo-escritura":
      return ALLOWED_TOOLS_CODIGO_ESCRITURA;
    case "libre":
      return libres;
  }
}

interface ResultadoDelegacion {
  texto: string;
  uso: ResultadoCli["uso"];
  costoUsd: number | null;
  herramientasPropias?: HerramientaPropia[];
  avisos?: string[];
  /** Alias del modelo que respondió, si no fue el pedido (fallback). */
  modeloReal?: string;
}

/**
 * Las herramientas que el CLI usó por su cuenta, leídas del `stream-json`.
 *
 * Las del org (`mcp__…`) quedan afuera: ésas pasan por el puente y ya se
 * cuentan ahí. Lo que queda es el trabajo que el org no ve pasar —un `Edit`,
 * un `Read`— y que sin esto no existía para la traza ni para el scheduler.
 */
export function herramientasPropiasDelCli(stdout: string): HerramientaPropia[] {
  const usos: HerramientaPropia[] = [];
  for (const linea of stdout.split("\n")) {
    const cruda = linea.trim();
    if (!cruda || !cruda.includes('"tool_use"')) continue;
    try {
      const evento = JSON.parse(cruda) as {
        type?: string;
        message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
      };
      if (evento.type !== "assistant") continue;
      for (const parte of evento.message?.content ?? []) {
        if (parte.type !== "tool_use" || !parte.name || parte.name.startsWith("mcp__")) continue;
        const entrada = parte.input ?? {};
        const ruta = entrada["file_path"] ?? entrada["notebook_path"] ?? entrada["path"] ?? null;
        usos.push({ nombre: parte.name, ruta: typeof ruta === "string" ? ruta : null });
      }
    } catch {
      continue;
    }
  }
  return usos;
}

/** Las herramientas de lectura que se prestan sobre el directorio de la empresa. */
export const HERRAMIENTAS_DE_LECTURA = ALLOWED_TOOLS_LECTURA;

/** Último evento `result` de la salida `stream-json`. */
/** Lo que el CLI informa al terminar: texto, consumo y cuánto salió. */
export interface ResultadoCli {
  is_error: boolean;
  result?: string;
  error?: string;
  /** Consumo real del turno. El CLI lo publica; antes se tiraba. */
  uso: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  /** Costo que el propio CLI calculó, en USD. */
  costoUsd: number | null;
}

/**
 * El último evento `result` de la salida `stream-json`.
 *
 * De acá sale también **el consumo**, y no es un detalle: el adaptador
 * devolvía `inputTokens: 0, outputTokens: 0` fijos, así que una corrida entera
 * por la suscripción informaba cero tokens y cero gasto mientras se comía la
 * ventana de uso. El CLI publica las cuatro cifras —entrada, salida, y las dos
 * de caché— y hasta su propio `total_cost_usd`; tirarlas dejaba al operador sin
 * forma de ver qué estaba consumiendo hasta que el proveedor cortaba.
 */
function lastResult(stdout: string): ResultadoCli | null {
  let last: ResultadoCli | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        is_error?: boolean;
        result?: string;
        error?: string;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
      if (parsed?.type === "result") {
        const u = parsed.usage ?? {};
        const cacheada = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        last = {
          is_error: parsed.is_error ?? false,
          ...(parsed.result !== undefined ? { result: parsed.result } : {}),
          ...(parsed.error !== undefined ? { error: parsed.error } : {}),
          uso: {
            // La entrada real incluye lo cacheado: es contexto que se envió,
            // aunque se pague distinto. Sin sumarlo, un turno de 375k tokens
            // se informa como si fueran 12.
            inputTokens: (u.input_tokens ?? 0) + cacheada,
            outputTokens: u.output_tokens ?? 0,
            cachedInputTokens: cacheada,
          },
          costoUsd: parsed.total_cost_usd ?? null,
        };
      }
    } catch {
      continue;
    }
  }
  return last;
}

/**
 * Lo que el agente alcanzó a decir, aunque el CLI haya terminado mal.
 *
 * El stream trae un evento por mensaje; los del asistente llevan su texto
 * adentro de `message.content`. Se busca el último con contenido real porque es
 * el resumen del turno: lo que el agente le iba a contar a la organización.
 */
export function ultimoTextoDeAsistente(stdout: string): string | null {
  let ultimo: string | null = null;
  for (const linea of stdout.split("\n")) {
    const cruda = linea.trim();
    if (!cruda) continue;
    try {
      const evento = JSON.parse(cruda) as {
        type?: string;
        message?: { model?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (evento.type !== "assistant") continue;
      // Los `<synthetic>` los fabrica el propio CLI al cortar: no son del agente.
      if (evento.message?.model === "<synthetic>") continue;
      const texto = (evento.message?.content ?? [])
        .filter((parte) => parte.type === "text" && parte.text?.trim())
        .map((parte) => parte.text!.trim())
        .join("\n\n");
      if (texto) ultimo = texto;
    } catch {
      continue;
    }
  }
  return ultimo;
}

/**
 * Lo que se le agrega al texto de un turno que el CLI cerró con error.
 *
 * Va pegado al texto porque es lo único que la organización lee: un resumen a
 * medias sin aviso se lee como trabajo terminado, y el que sigue en la cadena
 * arranca sobre algo incompleto.
 */
const AVISO_DE_CIERRE_FORZADO =
  "⚠️ EL CLI CERRÓ ESTE TURNO ANTES DE TIEMPO (agotó sus vueltas internas o falló su última " +
  "llamada). Lo de arriba es lo que alcancé a hacer, no necesariamente el trabajo completo: " +
  "revisá qué quedó a medias y retomo en el ciclo siguiente.";

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
function cierre(modo: ModoDeTrabajo): string {
  const donde = {
    "salida-lectura":
      "\n\nEl directorio actual es el de salida de la empresa y lo tenés en modo " +
      "lectura: abrí con tus propias herramientas lo que necesites mirar —una imagen, " +
      "un documento, un archivo que dejaste en un turno anterior—. Para **producir** o " +
      "modificar algo usá las herramientas de la organización, que son las únicas que " +
      "dejan rastro en la traza y respetan los permisos.",
    "codigo-escritura":
      "\n\nEl directorio actual es el worktree del repo y tenés el arriendo de escritura: " +
      "editá con tus herramientas Edit/Write. No tenés Bash: para correr tests, typecheck o " +
      "build usá la herramienta ejecutar_comando de la organización (corre en sandbox y deja " +
      "rastro). No declares terminado nada sin haber corrido la verificación y leído su salida.",
    "codigo-lectura":
      "\n\nEl directorio actual es el worktree del repo, en **sólo lectura** este turno: otro " +
      "rol tiene el arriendo de escritura. Leé, revisá y corré lo permitido con ejecutar_comando; " +
      "lo que encuentres, contáselo por mensaje. Editás en el ciclo siguiente.",
    libre: "\n\nTrabajás en el directorio actual. Dejá ahí los archivos que produzcas.",
  }[modo];
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

/**
 * Lo último que dijo el CLI antes de morir, para pegarlo al error.
 *
 * La salida es `stream-json`: una línea por evento. Los eventos que explican
 * una muerte —`rate_limit_event`, un `system` de error, un `result` truncado—
 * están al final, y el resto del stream es ruido enorme. Se recortan las
 * últimas líneas y cada una a lo suyo, porque esto va a un mensaje de error
 * que alguien tiene que poder leer.
 */
export function ultimoAliento(stdout: string): string {
  const lineas = stdout
    .split("\n")
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(-3)
    .map((linea) => (linea.length > 300 ? `${linea.slice(0, 300)}…` : linea));
  return lineas.length > 0 ? `. Lo último que emitió: ${lineas.join(" | ")}` : "";
}

/**
 * Lo que el stream dice del turno además de la respuesta: cuántas veces
 * reintentó la API, qué modelo respondió de verdad y cómo viene la ventana de
 * uso de la suscripción. Exportada para fijarla con tests.
 */
export function diagnosticoDelTurno(
  stdout: string,
  modeloPedido: string,
): { reintentos: number; modeloReal: string | null; avisos: string[] } {
  let reintentos = 0;
  let usados: string[] = [];
  let ventana: { cual: string; uso: number; renueva: number | null; estado: string } | null = null;
  for (const linea of stdout.split("\n")) {
    if (!linea) continue;
    let evento: Record<string, unknown>;
    try {
      evento = JSON.parse(linea) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (evento["type"] === "system" && evento["subtype"] === "api_retry") reintentos += 1;
    if (evento["type"] === "result" && evento["modelUsage"] && typeof evento["modelUsage"] === "object") {
      usados = Object.keys(evento["modelUsage"] as object);
    }
    if (evento["type"] === "rate_limit_event") {
      const info = (evento["rate_limit_info"] ?? {}) as {
        status?: string;
        unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
      };
      for (const [cual, datos] of Object.entries(info.unifiedWindows ?? {})) {
        const uso = datos.utilization ?? 0;
        if (!ventana || uso > ventana.uso) {
          ventana = { cual, uso, renueva: datos.resetsAt ?? null, estado: info.status ?? "allowed" };
        }
      }
    }
  }

  const avisos: string[] = [];
  const familia = (slug: string): string | null =>
    /opus/.test(slug) ? "opus" : /sonnet/.test(slug) ? "sonnet" : /haiku/.test(slug) ? "haiku" : null;
  const familias = [...new Set(usados.map(familia).filter((f): f is string => f !== null))];
  const pedida = familia(modeloPedido) ?? modeloPedido;
  let modeloReal: string | null = null;
  if (familias.length > 0 && !familias.includes(pedida)) {
    modeloReal = familias[0]!;
    avisos.push(`${pedida} estaba saturado: este turno lo respondió ${modeloReal} (fallback automático).`);
  } else if (familias.length > 1) {
    avisos.push(`${pedida} se saturó a mitad del turno: una parte la respondió ${familias.filter((f) => f !== pedida).join(", ")}.`);
  }
  if (reintentos >= 3) {
    avisos.push(`La API reintentó ${reintentos} veces en este turno: ${pedida} está con demanda alta.`);
  }
  if (ventana && (ventana.uso >= 0.8 || ventana.estado !== "allowed")) {
    const nombre = ventana.cual === "five_hour" ? "de 5 horas" : ventana.cual === "seven_day" ? "semanal" : ventana.cual;
    const cuando = ventana.renueva
      ? `; se renueva ${new Date(ventana.renueva * 1000).toLocaleString("es-AR", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
      : "";
    avisos.push(
      ventana.estado !== "allowed"
        ? `La suscripción llegó al límite de su ventana ${nombre}${cuando}.`
        : `La suscripción va por el ${Math.round(ventana.uso * 100)}% de su ventana ${nombre}${cuando}.`,
    );
  }
  return { reintentos, modeloReal, avisos };
}

const TRANSCRIPCIONES_GUARDADAS = 300;

/**
 * Guarda lo que emitió el CLI —sin los eventos parciales— para poder
 * diagnosticar un turno después. Hasta acá, cuando un turno se colgaba quince
 * minutos no quedaba nada que mirar: la salida vivía en memoria y moría con
 * el turno. Se conservan las últimas 300. Nunca tira: es diagnóstico.
 */
function guardarTranscripcion(workspace: string, model: string, stdout: string): string {
  const dir = join(workspace, "transcripciones");
  const archivo = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${model}.jsonl`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(archivo, stdout);
    const todas = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
    for (const vieja of todas.slice(0, Math.max(0, todas.length - TRANSCRIPCIONES_GUARDADAS))) {
      rmSync(join(dir, vieja), { force: true });
    }
  } catch {
    // sin disco para diagnóstico no se frena un turno
  }
  return archivo;
}
