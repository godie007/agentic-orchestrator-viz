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
  type LlmProvider,
  type OrgToolsBridge,
  type OrgToolsSession,
} from "../types.js";
import { ultimoAliento } from "./claude-code.js";

/**
 * Proveedor que delega cada turno al CLI de **opencode**.
 *
 * Es el hermano de `claude-code.ts` y existe por la misma razón: una
 * suscripción no se puede usar por API. El CLI corre con la credencial de esta
 * máquina —lo que haya en `opencode auth login`: el plan de OpenCode Zen, una
 * sesión de Anthropic, Copilot, o una API key propia— y este adaptador **no
 * devuelve `tool_calls`**: delega una vez, de punta a punta, y responde con el
 * texto final. El loop del motor ve cero llamadas y cierra el turno en la
 * primera iteración, que es justo lo que queremos.
 *
 * ## Qué cambia respecto de Claude Code
 *
 * 1. **Los slugs ya vienen namespaceados**: opencode nombra sus modelos
 *    `proveedor/modelo` (`opencode/claude-sonnet-5`, `zai/glm-5`). El catálogo
 *    los usa tal cual, sin volver a prefijarlos con el id del proveedor: eso
 *    daría `opencode/opencode/claude-sonnet-5`.
 * 2. **La configuración va en un archivo, no en banderas**: los permisos, las
 *    herramientas habilitadas y el servidor MCP del org se escriben en un JSON
 *    por turno y entran por `OPENCODE_CONFIG`.
 * 3. **`--auto` no es un lujo**: sin él, una herramienta que pide permiso deja
 *    al proceso esperando una respuesta interactiva que nunca llega, y el turno
 *    se cuelga entero. Es la falla que este proyecto ya conoce —"un proveedor
 *    que no contesta cuelga la corrida"—, así que lo que no se quiere que pase
 *    se **niega** explícitamente en la config en vez de dejarse en "preguntar".
 *
 * ## Límites
 *
 * 1. La credencial es de esta máquina. `opencode auth list` dice cuál hay.
 * 2. La config global del usuario (`~/.config/opencode/`) **se fusiona** con la
 *    del turno: si ahí hay servidores MCP, sus herramientas también se le
 *    ofrecen al agente. Por eso el agente del turno declara `"*": false` y
 *    habilita sólo lo suyo.
 */
export interface OpenCodeConfig {
  /** Binario del CLI. Default `opencode`. */
  command?: string;
  /** Carpeta de trabajo del agente; se crea si no existe. Default: temp. */
  workspaceDir?: string;
  /** Modelo por defecto, en formato `proveedor/modelo`. */
  model?: string;
  /**
   * Si el costo que informa el CLI se reporta al ledger.
   *
   * Default `false`, por la misma razón que en `claude-code`: bajo un plan, el
   * turno no factura por token y reportarlo dispararía `budgetUsd` cortando
   * corridas que no cuestan dinero. Con créditos por uso (OpenCode Zen sin
   * plan, o una API key propia detrás del CLI) el gasto **sí** es real: ahí
   * conviene prenderlo con `ORQ_OPENCODE_COSTO=1` para que el tope funcione.
   */
  reportarCosto?: boolean;
}

/** Modelo por defecto si nadie eligió: el estándar del plan de Zen. */
const MODELO_DEFECTO = "opencode/claude-sonnet-5";

/**
 * Catálogo mínimo cuando `opencode models` no contesta.
 *
 * Un catálogo vacío no es neutral: el tier no resuelve, el selector de la UI
 * queda sin opciones y el proveedor parece roto aunque el CLI ande. Con esto,
 * al menos los tres modelos del plan se pueden elegir.
 */
const CATALOGO_MINIMO = [
  "opencode/claude-haiku-4-5",
  "opencode/claude-sonnet-5",
  "opencode/claude-opus-5",
];

/**
 * Herramientas propias del CLI que se habilitan **sobre el directorio de la
 * empresa**: mirar, buscar y leer. Nada que escriba.
 *
 * Es la misma regla que en `claude-code` y por los mismos tres motivos:
 * `write_output_file` es lo único que sanea la ruta segmento por segmento,
 * anota la procedencia en `.orq-generado.json` y aplica la jerarquía de
 * borrado. Un `write` del CLI saltearía las tres de una y sin dejar rastro en
 * la traza.
 */
export const HERRAMIENTAS_DE_LECTURA = ["read", "glob", "grep", "list", "webfetch"] as const;

/** Lo que se habilita cuando el agente trabaja en una carpeta propia y desechable. */
const HERRAMIENTAS_DE_TRABAJO = [
  ...HERRAMIENTAS_DE_LECTURA,
  "write",
  "edit",
  "patch",
  "bash",
] as const;

/**
 * Cuánto se le da a un turno delegado, en milisegundos.
 *
 * **Veinte** minutos y no diez. Copiar el corte de Claude Code fue un error
 * medido: los modelos gratuitos van en cola y son lentos, y un agente que hizo
 * 31 llamadas útiles —leer entregables, loguearse, navegar hasta la no
 * conformidad, sacar la captura— murió a los diez minutos sin entregar nada. El
 * corte tiene que estar por encima de lo que tarda el trabajo real, no por
 * encima de lo que tarda una API.
 */
const CORTE_MS = Number(process.env["OPENCODE_TIMEOUT_MS"] ?? 1_200_000);

/** Cuánto se le da a `opencode models` para listar el catálogo. */
const CORTE_CATALOGO_MS = 30_000;

export class OpenCodeProvider implements LlmProvider {
  /** Un turno que programa corre la verificación entera: más aire que el común. */
  readonly timeoutCodigoMs = Math.round(CORTE_MS * 1.5);
  readonly id: ProviderId = "opencode";
  readonly label = "opencode (suscripción)";
  readonly timeoutMs = CORTE_MS;
  /** Corre su propio agent loop: el motor le presta el puente MCP del org. */
  readonly delegaElTurno = true;

  private readonly command: string;
  private readonly workspace: string;
  private readonly model: string;
  private readonly reportarCosto: boolean;
  private catalog: ModelInfo[] | null = null;

  constructor(config: OpenCodeConfig = {}) {
    this.command = config.command ?? "opencode";
    this.workspace = config.workspaceDir ?? join(tmpdir(), "orq-opencode");
    this.model = config.model ?? MODELO_DEFECTO;
    this.reportarCosto = config.reportarCosto ?? false;
  }

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (this.catalog && !refresh) return this.catalog;
    const slugs = await this.listarSlugs();
    this.catalog = catalogoOpenCode(this.id, slugs.length > 0 ? slugs : CATALOGO_MINIMO);
    return this.catalog;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const slugs = await this.listarSlugs();
      if (slugs.length === 0) {
        return {
          ok: false,
          detail:
            `El binario \`${this.command}\` no listó modelos. Verificá que esté instalado ` +
            `y que \`opencode auth list\` muestre una credencial.`,
        };
      }
      // El catálogo sale de la config local: lista modelos aunque la credencial
      // esté vencida o el plan sin saldo. Sin un turno de verdad, el proveedor
      // se ve sano y la corrida muere en el primer ciclo.
      await this.delegate("Respondé únicamente con la palabra: ok", undefined, this.model, undefined);
      return { ok: true, detail: `CLI operativo con ${String(slugs.length)} modelos disponibles.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatEvent> {
    const model = normalizarSlug(req.model) || this.model;
    const prompt = render(req.messages);
    const { texto, uso, costoUsd } = await this.delegate(prompt, req.signal, model, req.orgTools);

    if (texto) yield { type: "text_delta", text: texto };
    yield {
      type: "done",
      message: { role: "assistant", content: texto },
      usage: {
        ...uso,
        ...(this.reportarCosto && costoUsd != null ? { reportedCostUsd: costoUsd } : {}),
      },
      finishReason: "stop",
      modelSlug: model,
    };
  }

  /** Los slugs que el CLI reconoce, uno por línea. */
  private async listarSlugs(): Promise<string[]> {
    try {
      const { stdout } = await correr(this.command, ["models"], {
        cwd: tmpdir(),
        corteMs: CORTE_CATALOGO_MS,
      });
      return stdout
        .split("\n")
        .map((linea) => linea.trim())
        .filter((linea) => linea.includes("/") && !linea.startsWith("-"));
    } catch {
      return [];
    }
  }

  /**
   * Invoca el CLI una vez, de punta a punta, y devuelve el texto final.
   *
   * Con directorio de empresa prestado, se trabaja **ahí mismo y de sólo
   * lectura**: el agente ve lo que la empresa produjo y sigue escribiendo por
   * las herramientas del org. Sin él, una carpeta propia por turno donde puede
   * escribir a gusto.
   */
  private async delegate(
    prompt: string,
    signal: AbortSignal | undefined,
    model: string,
    orgTools: OrgToolsBridge | undefined,
  ): Promise<{ texto: string; uso: Consumo; costoUsd: number | null }> {
    const session = orgTools ? await orgTools.open() : null;
    // Sobre un repo también va en sólo lectura, a diferencia de Claude Code: no
    // tenemos cómo negarle a opencode editar `.git` por patrón de ruta, y un
    // hook escrito ahí es código que corre fuera del sandbox en el próximo
    // checkpoint. Edita por las herramientas del org (`editar_codigo`), que
    // resuelven cada ruta y rechazan `.git`.
    const soloLectura = Boolean(session?.cwd);
    const trabajo = session?.cwd ?? nuevoDir(this.workspace);
    const configPath = escribirConfig(
      configDelTurno({ soloLectura, ...(session ? { session } : {}) }),
    );
    const completo = orgTools ? prompt + cierre(soloLectura, Boolean(session?.codigo)) : prompt;

    try {
      const { stdout, cortado } = await correr(
        this.command,
        construirArgs({ prompt: completo, model }),
        {
          cwd: trabajo,
          corteMs: CORTE_MS,
          env: { OPENCODE_CONFIG: configPath },
          ...(signal ? { signal } : {}),
          proveedor: this.id,
          rescatar: (parcial) => hayTexto(parcial),
        },
      );
      const leido = leerSalida(stdout);
      if (!cortado) return leido;
      return { ...leido, texto: `${leido.texto}\n\n${AVISO_DE_CORTE}` };
    } finally {
      await session?.close().catch(() => {});
    }
  }
}

/**
 * Los argumentos con los que se invoca el CLI.
 *
 * `--pure` deja afuera los plugins del usuario: lo que corre en una corrida no
 * puede depender de qué tenía instalado quien configuró la máquina. `--auto`
 * aprueba lo que no esté explícitamente negado, y lo que no se quiere que pase
 * está negado en la config del turno (ver `configDelTurno`): sin `--auto`, un
 * pedido de permiso deja al proceso esperando para siempre.
 */
export function construirArgs(opciones: { prompt: string; model: string }): string[] {
  return [
    "run",
    "--format", "json",
    "--pure",
    "--auto",
    "--agent", AGENTE,
    "--model", opciones.model,
    opciones.prompt,
  ];
}

/** Nombre del agente que se define por turno. */
const AGENTE = "orq";

/**
 * La configuración del turno: qué puede tocar el agente y por dónde llega el org.
 *
 * Vive aparte y se exporta porque acá hay una **regla de seguridad**, no una
 * preferencia: sobre el directorio de la empresa, entre lo habilitado no puede
 * aparecer nada que escriba. Una regla que sólo existe adentro de un `spawn` no
 * se puede verificar; ésta tiene su test.
 *
 * El `"*": false` no es redundante con la lista: la config del usuario se
 * **fusiona** con la del turno, así que sin ese barrido las herramientas de sus
 * servidores MCP globales también le llegarían al agente (y con ellas, la
 * capacidad de escribir por una vía que el org no ve).
 */
export function configDelTurno(opciones: {
  soloLectura: boolean;
  session?: OrgToolsSession;
}): Record<string, unknown> {
  const propias = opciones.soloLectura ? HERRAMIENTAS_DE_LECTURA : HERRAMIENTAS_DE_TRABAJO;
  const tools: Record<string, boolean> = { "*": false };
  for (const nombre of propias) tools[nombre] = true;
  // Las del org llegan por MCP y opencode las nombra `<servidor>_<tool>`.
  if (opciones.session) tools[`${opciones.session.serverName}*`] = true;

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    agent: {
      [AGENTE]: {
        mode: "primary",
        description: "Agente de la organización, con las herramientas que le presta el org.",
        tools,
        permission: opciones.soloLectura
          ? { edit: "deny", bash: "deny", webfetch: "allow" }
          : { edit: "allow", bash: "allow", webfetch: "allow" },
      },
    },
  };

  if (opciones.session) {
    config["mcp"] = {
      [opciones.session.serverName]: {
        type: "local",
        // El mismo relay stdio↔socket que usa Claude Code: el puente del motor
        // (`claude-mcp.ts`) es agnóstico del CLI, lo único que cambia es cómo
        // cada uno declara el servidor.
        command: [process.execPath, fileURLToPath(new URL("./claude-code-relay.mjs", import.meta.url))],
        environment: { ORQ_SOCKET: opciones.session.socketPath },
        enabled: true,
      },
    };
  }
  return config;
}

/** Consumo del turno, sumado sobre los pasos que informó el CLI. */
export interface Consumo {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * Lee la salida `stream-json` de `opencode run`: una línea por evento.
 *
 * Los eventos que importan son tres: `text` (lo que dijo el agente),
 * `step_finish` (consumo y costo de cada paso) y `error`. El texto del turno es
 * el **último** bloque no vacío —el resumen final, lo mismo que devuelve el
 * `result` de Claude Code—; si el agente terminó sin escribir un cierre, se
 * pegan todos antes que devolver vacío, porque un turno mudo se ve igual que
 * uno que falló.
 */
export function leerSalida(stdout: string): {
  texto: string;
  uso: Consumo;
  costoUsd: number | null;
} {
  const textos: string[] = [];
  const uso: Consumo = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let costo: number | null = null;
  let error: string | null = null;

  for (const linea of stdout.split("\n")) {
    const cruda = linea.trim();
    if (!cruda) continue;
    let evento: EventoOpenCode;
    try {
      evento = JSON.parse(cruda) as EventoOpenCode;
    } catch {
      continue;
    }
    if (evento.type === "text" && typeof evento.part?.text === "string") {
      const texto = evento.part.text.trim();
      if (texto) textos.push(texto);
    }
    if (evento.type === "step_finish") {
      const t = evento.part?.tokens;
      const cache = (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);
      // La entrada real incluye lo cacheado: es contexto que igual se envió,
      // aunque se pague distinto. Sin sumarlo, un turno de 375k se informa
      // como si fueran 12 —la misma lección que en `claude-code`—.
      uso.inputTokens += (t?.input ?? 0) + cache;
      uso.outputTokens += (t?.output ?? 0) + (t?.reasoning ?? 0);
      uso.cachedInputTokens += cache;
      if (typeof evento.part?.cost === "number") costo = (costo ?? 0) + evento.part.cost;
    }
    if (evento.type === "error") {
      error = evento.error?.data?.message ?? evento.error?.name ?? "error sin detalle";
    }
  }

  const texto = textos.at(-1) ?? "";
  if (!texto && error) {
    throw new LlmError(`opencode: ${error}`, "opencode", false);
  }
  return { texto: texto || textos.join("\n\n"), uso, costoUsd: costo };
}

/**
 * Lo que se le agrega al texto de un turno que se cortó por tiempo.
 *
 * Va en el texto y no en un campo aparte porque es lo único que la organización
 * lee: sin el aviso, un resumen a medias se lee como un trabajo terminado, y el
 * que sigue en la cadena arranca sobre algo que no está completo.
 */
const AVISO_DE_CORTE =
  "⚠️ ESTE TURNO SE CORTÓ POR TIEMPO antes de terminar. Lo de arriba es lo que alcancé a " +
  "hacer, no el trabajo completo: retomo en el ciclo siguiente desde este punto.";

/** ¿Hay al menos un bloque de texto en lo emitido hasta ahora? */
export function hayTexto(stdout: string): boolean {
  for (const linea of stdout.split("\n")) {
    const cruda = linea.trim();
    if (!cruda) continue;
    try {
      const evento = JSON.parse(cruda) as EventoOpenCode;
      if (evento.type === "text" && (evento.part?.text ?? "").trim()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

interface EventoOpenCode {
  type?: string;
  part?: {
    text?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  error?: { name?: string; data?: { message?: string } };
}

/** Catálogo a partir de los slugs que el CLI reconoce. */
export function catalogoOpenCode(providerId: ProviderId, slugs: string[]): ModelInfo[] {
  return [...new Set(slugs)].map((slug) => ({
    providerId,
    slug,
    name: `opencode — ${slug}`,
    contextLength: 200_000,
    // El CLI corre su propio loop: el motor nunca le manda `tools`.
    supportsTools: false,
    // Bajo un plan no hay precio por token, y con créditos el que vale es el
    // que el propio CLI informa al terminar (ver `reportarCosto`).
    inputPricePerMTok: null as null,
    outputPricePerMTok: null as null,
  }));
}

/**
 * Corre un proceso y devuelve su stdout.
 *
 * El corte por tiempo y el abort **cierran la promesa**: matar el proceso sin
 * resolver deja el turno esperando para siempre, sin proceso vivo y sin
 * `agent.turn_end`, y la corrida se cuelga en un ciclo. Ya nos pasó con Claude
 * Code; el mismo cuidado va acá.
 */
async function correr(
  command: string,
  args: string[],
  opciones: {
    cwd: string;
    corteMs: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
    proveedor?: ProviderId;
    /**
     * Qué hacer con lo ya emitido cuando el proceso se corta.
     *
     * Sin esto, un corte por tiempo tira **todo** el turno: la salida del CLI
     * llega recién al final, así que treinta llamadas de trabajo terminadas se
     * pierden enteras y la organización no se entera de nada. Con esto, lo que
     * alcanzó a producirse vuelve como resultado del turno, marcado como
     * cortado.
     */
    rescatar?: (stdout: string) => boolean;
  },
): Promise<{ stdout: string; cortado: boolean }> {
  const proveedor: ProviderId = opciones.proveedor ?? "opencode";
  return new Promise<{ stdout: string; cortado: boolean }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opciones.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opciones.env },
    });

    let cortado = false;
    const matar = (mensaje: string): void => {
      cortado = true;
      child.kill("SIGTERM");
      // SIGTERM es un pedido, no una orden: un CLI trabado no lo atiende y el
      // proceso queda huérfano gastando la suscripción.
      const remate = setTimeout(() => child.kill("SIGKILL"), 5_000);
      remate.unref?.();
      // Si algo se alcanzó a producir, el turno vuelve con eso en vez de
      // fallar: media entrega es infinitamente más que ninguna.
      if (opciones.rescatar?.(stdout)) {
        resolve({ stdout, cortado: true });
        return;
      }
      reject(new LlmError(mensaje, proveedor, false));
    };

    const reloj = setTimeout(
      () =>
        matar(
          `opencode: el turno se pasó de ${String(Math.round(opciones.corteMs / 1000))}s y se cortó. ` +
            `El CLI corre un agent loop entero por turno; si pasa seguido, subí el corte del proveedor.`,
        ),
      opciones.corteMs,
    );
    reloj.unref?.();

    const onAbort = (): void =>
      matar("opencode: el turno se cortó antes de terminar (se detuvo la corrida).");
    if (opciones.signal) {
      if (opciones.signal.aborted) onAbort();
      else opciones.signal.addEventListener("abort", onAbort, { once: true });
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));

    child.on("error", (error) => {
      clearTimeout(reloj);
      if (cortado) return;
      reject(
        new LlmError(
          `No se pudo ejecutar el CLI de opencode (${command}): ${error.message}. ` +
            `Instalalo y autenticalo con \`opencode auth login\`.`,
          proveedor,
          false,
          error,
        ),
      );
    });

    child.on("exit", (code) => {
      clearTimeout(reloj);
      if (cortado) return;
      if (code === 0 || stdout.trim()) {
        // Con salida distinta de cero pero stdout escrito, el detalle está en
        // los eventos: `leerSalida` lo convierte en un error que se entiende.
        resolve({ stdout, cortado: false });
        return;
      }
      reject(
        new LlmError(
          `opencode: ${stderr.trim() || `CLI salió con código ${String(code)}${ultimoAliento(stdout)}`}`,
          proveedor,
          false,
        ),
      );
    });
  });
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
  return parts.join("\n\n").trim();
}

/**
 * Cómo termina el prompt, según con qué permisos quedó el directorio.
 *
 * Decirle "dejá ahí los archivos" cuando el directorio es el de la empresa y
 * está en sólo lectura lo manda a pelear con un permiso negado en vez de usar
 * la herramienta del org que sí puede.
 */
function cierre(soloLectura: boolean, codigo = false): string {
  if (codigo) {
    return (
      "\n\nEl directorio actual es el worktree del repo. Tus herramientas propias son de " +
      "lectura: para **editar** usá editar_codigo / escribir_codigo / aplicar_parche de la " +
      "organización, y para correr tests o builds, ejecutar_comando. No declares terminado " +
      "nada sin haber corrido la verificación y leído su salida." +
      "\nTerminá el turno con un resumen en texto, para la organización."
    );
  }
  const donde = soloLectura
    ? "\n\nEl directorio actual es el de salida de la empresa y lo tenés en modo " +
      "lectura: abrí con tus propias herramientas lo que necesites mirar. Para **producir** " +
      "o modificar algo usá las herramientas de la organización, que son las únicas que " +
      "dejan rastro en la traza y respetan los permisos."
    : "\n\nTrabajás en el directorio actual. Dejá ahí los archivos que produzcas.";
  return `${donde}\nTerminá el turno con un resumen en texto, para la organización.`;
}

/**
 * El slug que entiende el CLI.
 *
 * Los modelos de opencode ya vienen namespaceados (`opencode/claude-sonnet-5`),
 * así que el catálogo los guarda tal cual y acá no hay nada que traducir. La
 * función existe para el caso de que alguien haya fijado un slug con el id del
 * proveedor pegado adelante, que es el error más fácil de cometer a mano.
 */
export function normalizarSlug(slug: string): string {
  const limpio = slug.trim();
  return limpio.startsWith("opencode/opencode/") ? limpio.slice("opencode/".length) : limpio;
}

function nuevoDir(base: string): string {
  const dir = join(base, `turno-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function escribirConfig(config: Record<string, unknown>): string {
  const file = join(
    tmpdir(),
    `orq-opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  writeFileSync(file, JSON.stringify(config));
  return file;
}
