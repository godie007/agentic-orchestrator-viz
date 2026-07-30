import type { Role } from "@orq/shared";
import { ids } from "@orq/shared";
import {
  LlmError,
  collect,
  computeCost,
  type ChatMessage,
  type ProviderRegistry,
  type RunLedger,
  type ToolCall,
} from "@orq/llm";
import {
  WEB_SEARCH_TOOL_NAME,
  preview,
  selectTools,
  type RegisteredTool,
  type ToolContext,
  type ToolRegistry,
} from "@orq/tools";
import type { EventBus } from "./events.js";
import type { RunState } from "./state.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.js";

/**
 * Agent loop: un turno de un rol.
 *
 * Cada paso emite un evento antes de ejecutarse, no después de terminar, para
 * que la UI muestre lo que está pasando y no un resumen a posteriori.
 */

export interface TurnDeps {
  bus: EventBus;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  ledger: RunLedger;
  objective: string;
  /** Límite de ciclos de la corrida, para calcular la presión de cierre. */
  maxTicks: number;
  /**
   * Cuánto se espera una respuesta del modelo antes de cortarla y reintentar.
   *
   * Sin esto una sola llamada lenta bloquea el ciclo entero: medimos una de
   * **649 segundos** que dejó a los otros tres agentes esperando once minutos.
   * El ciclo avanza cuando terminan todos, así que el más lento manda.
   */
  llmTimeoutMs?: number;
  /**
   * Hoy, ya formateado. Entra desde el llamador y no de un reloj acá adentro,
   * igual que en el render de documentos: así los tests son deterministas.
   *
   * Sin esto el agente no sabe en qué año vive. Un auditor "encontró" que la
   * fecha correcta de una propuesta era un typo y pidió cambiarla a un año
   * anterior: no alcanza con que no invente, tiene que poder verificar.
   */
  fechaHoy?: string;
  signal?: AbortSignal;
}

export interface TurnResult {
  iterations: number;
  costUsd: number;
  /** Último texto del agente, si escribió algo antes de cerrar el turno. */
  summary: string | null;
  /** `true` si el turno quedó bloqueado esperando una aprobación. */
  awaitingApproval: boolean;
  /**
   * Cuántas herramientas ejecutó. Cero significa que habló y no hizo nada, que
   * desde afuera es indistinguible de no haber tenido el turno.
   */
  herramientas: number;
}

export async function runAgentTurn(
  state: RunState,
  role: Role,
  deps: TurnDeps,
): Promise<TurnResult> {
  const { bus, providers, tools, ledger } = deps;
  const runId = state.runId;

  deps.ledger.assertWithinBudget();

  // ¿Quedó un turno de este rol cortado a la mitad? Se continúa, no se
  // reempieza: la conversación guardada ya tiene la bandeja leída, las fuentes
  // consultadas y los resultados de las herramientas que sí funcionaron.
  const interrumpido = state.tomarTurnoInterrumpido(role.id);

  const inbox = state.drainInbox(role.id);
  const tasks = await state.listTasks(role.id);

  // El turno responde al primer pedido pendiente de la bandeja; el resto queda
  // como contexto. Sin esto `reply` no sabría a quién contestar.
  //
  // Si no hay un pedido formal se contesta el primer mensaje que haya. Antes se
  // exigía `request` o `escalation`, y entonces **nadie podía contestarle a la
  // persona**: el encargo que se inyecta desde la UI es de tipo `human`, así que
  // `reply` devolvía "no hay ningún mensaje que responder". En una corrida real
  // se comió 14 de 25 llamadas a `reply` —el coordinador insistía en acusar
  // recibo del encargo—, y cada intento gastaba una iteración entera.
  const pending =
    inbox.find((message) => message.type === "request" || message.type === "escalation") ??
    inbox[0];

  // Vista ligada a este rol: el actor viaja por el closure, no por un campo
  // compartido que los turnos paralelos se pisarían entre sí.
  const workspace = state.forActor(role.id);

  const { provider, modelSlug, modelInfo } = await providers.resolveModel(role.model);
  const allowed = tools.forRole(role, state.tools);

  // La búsqueda web nativa del proveedor reemplaza a la herramienta: se activa
  // en el request y el modelo la usa sin gastar una vuelta del loop. Si se
  // dejara expuesta como tool, el modelo llamaría a una que devuelve error.
  const hasWebSearch = allowed.some((tool) => tool.name === WEB_SEARCH_TOOL_NAME);
  const nativeWebSearch = hasWebSearch && provider.id === "openrouter";
  const exposable = nativeWebSearch
    ? allowed.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME)
    : allowed;

  const taskContext = [
    deps.objective,
    ...inbox.map((message) => `${message.subject} ${message.body}`),
    ...tasks.map((task) => `${task.title} ${task.detail}`),
  ].join(" ");

  const selection = selectTools(exposable, taskContext);
  bus.emit({
    type: "tool.selection",
    runId,
    tick: state.tick,
    roleId: role.id,
    candidates: selection.candidates,
    exposed: selection.exposed,
    strategy: selection.strategy,
    reason: nativeWebSearch
      ? `${selection.reason} Además, la búsqueda web nativa de ${provider.label} está activa para este turno.`
      : selection.reason,
  });

  const byName = new Map(selection.tools.map((tool) => [tool.name, tool]));

  const conversation: ChatMessage[] = interrumpido
    ? [
        ...interrumpido.conversation,
        {
          role: "user",
          content:
            `Tu turno anterior se cortó antes de terminar (${interrumpido.motivo}). ` +
            `Seguís desde donde quedaste: todo lo que está más arriba ya lo hiciste, ` +
            `no lo repitas. Revisá qué te faltaba y cerrá el turno.` +
            (inbox.length > 0
              ? `\n\nMientras tanto llegó esto:\n${resumirBandeja(inbox)}`
              : ""),
        },
      ]
    : [
        { role: "system", content: buildSystemPrompt(state, role, deps.objective) },
        {
          role: "user",
          content: buildTurnPrompt(
            state,
            role,
            inbox,
            tasks,
            {
              tick: state.tick,
              maxTicks: deps.maxTicks,
              spentUsd: ledger.spentUsd,
              budgetUsd: ledger.budgetUsd,
            },
            deps.fechaHoy,
          ),
        },
      ];

  // Al retomar se conserva a quién le estaba contestando: si no, `reply` se
  // queda sin destinatario y el pedido que originó el turno nunca se cierra.
  const hilo = interrumpido
    ? {
        messageId: interrumpido.pendingMessageId,
        threadId: interrumpido.threadId,
        replyToRoleId: interrumpido.replyToRoleId,
      }
    : {
        messageId: pending?.id ?? null,
        threadId: pending?.threadId ?? null,
        replyToRoleId: pending?.fromRoleId ?? null,
      };

  /**
   * Cuántas iteraciones merece este turno.
   *
   * `maxTurns` del rol deja de ser un número fijo para ser el **piso**: un
   * agente con un mensaje corto no necesita doce vueltas, y uno que tiene que
   * leer cinco pedidos, consultar fuentes y redactar un entregable no entra en
   * doce. Un tope igual para las dos situaciones falla en las dos: sobra en la
   * primera y corta a la mitad en la segunda —vimos a un coordinador tocar el
   * techo en 11 de 12 turnos, dejando entregables escritos por la mitad—.
   */
  const presupuesto = presupuestoDeIteraciones(role, {
    mensajes: inbox.length,
    tareas: tasks.length,
    caracteres: taskContext.length,
    reanudando: interrumpido != null,
  });

  let iterations = 0;
  let costUsd = 0;
  let summary: string | null = null;
  let awaitingApproval = false;
  let herramientas = 0;

  // Cuántas veces falló exactamente la misma llamada en este turno. Un modelo
  // que choca contra un error que no puede resolver —una ruta MCP fuera del
  // directorio permitido, por ejemplo— reintenta lo mismo hasta agotar
  // `maxTurns`, y el turno se pierde entero sin haber hecho nada.
  const fallosRepetidos = new Map<string, number>();
  /** Lecturas ya resueltas en este turno, para no repetirlas. */
  const lecturasDelTurno = new Map<string, string>();
  // Dos tolerancias distintas porque son dos situaciones distintas. Repetir la
  // llamada **idéntica** es estar trabado: se corta enseguida. Cambiar los
  // argumentos y seguir chocando con el **mismo error** puede ser exploración
  // legítima —probar rutas hasta encontrar la buena—, así que se le da más aire
  // antes de asumir que la pared no se mueve.
  const TOLERANCIA_IDENTICA = 3;
  const TOLERANCIA_MOTIVO = 5;

  // `try/finally`: si el turno falla —proveedor saturado, red caída— el evento
  // de cierre igual se emite. Sin esto el nodo del organigrama se queda
  // "pensando" para siempre, porque la UI espera un `agent.turn_end` que nunca
  // llega.
  try {
  // El techo se puede estirar mientras el agente **avance**. Un turno que sigue
  // ejecutando herramientas con éxito está trabajando; uno que solo habla, no.
  let ultimoAvance = 0;
  while (iterations < presupuesto.techo) {
    if (iterations >= presupuesto.base && iterations - ultimoAvance >= 2) break;
    iterations++;
    ledger.assertWithinBudget();

    bus.emit({
      type: "agent.thinking",
      runId,
      tick: state.tick,
      roleId: role.id,
      providerId: provider.id,
      modelSlug,
      iteration: iterations,
    });

    const startedAt = Date.now();
    const timeoutMs = deps.llmTimeoutMs ?? 120_000;

    const result = await withRetry(
      () =>
        collect(
          provider.chat({
            model: modelSlug,
            messages: conversation,
            tools: selection.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            ...(role.model.temperature != null ? { temperature: role.model.temperature } : {}),
            maxOutputTokens: role.model.maxOutputTokens,
            ...(nativeWebSearch ? { webSearch: { enabled: true, maxResults: 5 } } : {}),
            // El corte por tiempo se suma al del usuario: cualquiera de los dos
            // aborta la llamada.
            signal: conTimeout(deps.signal, timeoutMs),
          }),
        ),
      (attempt, delayMs, error) =>
        bus.emit({
          type: "log",
          runId,
          tick: state.tick,
          level: "warn",
          roleId: role.id,
          message:
            `${role.name}: ${error.message}. Reintento ${attempt} en ${Math.round(delayMs / 1000)}s.`,
        }),
      deps.signal,
    );
    const latencyMs = Date.now() - startedAt;

    const cost = computeCost(modelInfo, result.usage);
    costUsd += cost.totalUsd;
    ledger.record({
      roleId: role.id,
      providerId: provider.id,
      modelSlug: result.modelSlug,
      tick: state.tick,
      usage: result.usage,
      costUsd: cost.totalUsd,
      latencyMs,
    });
    bus.emit({
      type: "cost.updated",
      runId,
      tick: state.tick,
      roleId: role.id,
      providerId: provider.id,
      modelSlug: result.modelSlug,
      deltaUsd: cost.totalUsd,
      totalUsd: ledger.spentUsd,
      budgetUsd: ledger.budgetUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens ?? 0,
    });

    if (result.message.content.trim()) summary = result.message.content.trim();
    conversation.push(result.message);

    const calls = result.message.toolCalls ?? [];
    if (calls.length === 0) break; // el agente terminó su turno

    const ctx: ToolContext = {
      runId,
      tick: state.tick,
      actor: role,
      workspace,
      currentThreadId: hilo.threadId,
      currentMessageId: hilo.messageId,
      replyToRoleId: hilo.replyToRoleId,
      ...(deps.signal ? { signal: deps.signal } : {}),
    };

    // Las de solo lectura pueden ir en paralelo; las que mutan van en serie,
    // porque el orden en que se envían mensajes y se cambian tareas importa.
    herramientas += calls.length;
    const results = await executeCalls(calls, byName, ctx, state, bus, lecturasDelTurno);
    conversation.push(...results.messages);

    // Antes de la vuelta siguiente: si la conversación se pasó del presupuesto,
    // lo ya consumido se retira. Va acá y no al final del turno porque el
    // ahorro es en las vueltas que faltan, no en la que terminó.
    const compactado = compactarConversacion(conversation, lecturasDelTurno);
    if (compactado.compactados > 0) {
      bus.emit({
        type: "log",
        runId,
        tick: state.tick,
        level: "info",
        roleId: role.id,
        message:
          `${role.name}: se retiraron del contexto ${compactado.compactados} resultado(s) ya ` +
          `leídos (~${compactado.liberados} tokens) para no reenviarlos en cada vuelta.`,
      });
    }
    // Avance = al menos una herramienta de esta vuelta hizo algo. Es lo que
    // habilita a estirar el turno más allá de la base.
    if (results.failures.length < calls.length) ultimoAvance = iterations;
    if (results.awaitingApproval) {
      awaitingApproval = true;
      break;
    }

    const atascado = results.failures.filter((huella) => {
      const veces = (fallosRepetidos.get(huella) ?? 0) + 1;
      fallosRepetidos.set(huella, veces);
      const tope = huella.includes("::") ? TOLERANCIA_MOTIVO : TOLERANCIA_IDENTICA;
      return veces >= tope;
    });

    if (atascado.length > 0) {
      // Se le dice al modelo en su propio contexto —no solo en el log— porque
      // el objetivo es que use lo que le queda de turno en otra cosa.
      conversation.push({
        role: "user",
        content:
          `Frená. Ya chocaste varias veces contra lo mismo y va a seguir fallando: ` +
          `${atascado.join("; ")}. No insistas. Resolvé lo que puedas con lo que ya ` +
          `tenés, o pedí lo que te falta con send_message o request_context, y cerrá ` +
          `el turno.`,
      });
      bus.emit({
        type: "log",
        runId,
        tick: state.tick,
        level: "warn",
        roleId: role.id,
        message:
          `${role.name} viene chocando con el mismo error (${atascado[0]}). ` +
          `Se le pidió cambiar de enfoque.`,
      });
      // Una sola advertencia por turno: si vuelve a insistir, se corta.
      if (
        atascado.some(
          (huella) =>
            (fallosRepetidos.get(huella) ?? 0) >
            (huella.includes("::") ? TOLERANCIA_MOTIVO : TOLERANCIA_IDENTICA),
        )
      ) {
        break;
      }
    }
  }

  if (iterations >= presupuesto.techo) {
    bus.emit({
      type: "log",
      runId,
      tick: state.tick,
      level: "warn",
      roleId: role.id,
      message:
        `${role.name} agotó las ${presupuesto.techo} iteraciones que le tocaban ` +
        `(${presupuesto.base} de base por su carga, estiradas mientras avanzaba). ` +
        `Sigue en el ciclo próximo desde donde quedó.`,
    });
  }

  return { iterations, costUsd, summary, awaitingApproval, herramientas };
  } catch (error) {
    // Lo que se hizo hasta acá no se tira: se guarda para continuarlo en el
    // ciclo siguiente. Reempezar de cero paga de nuevo todo el contexto y
    // vuelve a ejecutar herramientas que ya habían salido bien.
    const motivo = error instanceof Error ? error.message : String(error);
    const guardado = state.guardarTurnoInterrumpido(role.id, {
      conversation: podarSinRespuesta(conversation),
      motivo,
      pendingMessageId: hilo.messageId,
      threadId: hilo.threadId,
      replyToRoleId: hilo.replyToRoleId,
    });
    bus.emit({
      type: "log",
      runId,
      tick: state.tick,
      level: "warn",
      roleId: role.id,
      message: guardado
        ? `${role.name} se cortó por "${motivo}", pero su turno queda guardado: sigue en el ciclo próximo desde donde estaba.`
        : `${role.name} se cortó por "${motivo}" demasiadas veces seguidas. Se abandona el turno.`,
    });
    throw error;
  } finally {
    bus.emit({
      type: "agent.turn_end",
      runId,
      tick: state.tick,
      roleId: role.id,
      iterations,
      costUsd,
      summary,
    });
  }
}

/**
 * Combina el corte del usuario con uno por tiempo.
 *
 * `AbortSignal.any` deja que cualquiera de los dos aborte, y el timeout se
 * descarta solo cuando la llamada termina.
 */
function conTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const porTiempo = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, porTiempo]) : porTiempo;
}

/**
 * Reintenta los errores que el proveedor marca como recuperables.
 *
 * Con modelos gratuitos el 429 es lo normal, no la excepción: sin reintentos la
 * primera vez que un proveedor pide esperar se cae el turno entero y la corrida
 * queda coja. El backoff es exponencial con tope, y cada espera se emite como
 * evento para que se vea en la UI en vez de parecer que el agente se colgó.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  onRetry: (attempt: number, delayMs: number, error: Error) => void,
  signal?: AbortSignal,
  maxAttempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Un corte por tiempo es reintentable; uno pedido por la persona no. Se
      // distinguen por el signal del usuario: si no está abortado, el que cortó
      // fue nuestro timeout.
      const porTimeout = esAborto(error) && !signal?.aborted;
      const retryable = porTimeout || (error instanceof LlmError && error.retryable);
      if (!retryable || attempt === maxAttempts || signal?.aborted) break;

      if (porTimeout) lastError = new Error("El modelo no respondió a tiempo.");

      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 20_000);
      onRetry(attempt, delayMs, error as Error);
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}

/** ¿La llamada se cortó, sea por el usuario o por el timeout? */
function esAborto(error: unknown): boolean {
  const nombre = (error as { name?: string } | null)?.name ?? "";
  const mensaje = error instanceof Error ? error.message : String(error);
  return (
    nombre === "AbortError" ||
    nombre === "TimeoutError" ||
    /abort|timed?\s*out/i.test(mensaje)
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Corrida detenida durante la espera de reintento."));
      },
      { once: true },
    );
  });
}

/**
 * Presupuesto de contexto de un turno, en tokens estimados.
 *
 * Por encima de esto se compactan los resultados de herramienta más viejos.
 * El piso de un turno es el prompt del sistema más la bandeja: medimos 5–6k.
 * 14k deja lugar para varios documentos en juego sin que la conversación se
 * vuelva el gasto principal.
 */
const PRESUPUESTO_CONTEXTO = 14_000;

/**
 * Cuánto contexto reciente se protege, en tokens.
 *
 * Se mide en tamaño y no en cantidad de resultados. Proteger "los últimos 3"
 * parece equivalente pero no lo es: si esos tres son documentos grandes, solos
 * superan el presupuesto y la compactación ya no puede llegar al objetivo —lo
 * medimos, un turno siguió creciendo hasta 22k con el tope en 14k—. Por tamaño,
 * el trabajo en curso queda protegido tanto si son cinco resultados chicos como
 * si es uno solo enorme.
 */
const TOKENS_INTOCABLES = 6_000;

/** Aproximación barata y suficiente: no necesitamos exactitud, sino magnitud. */
function tokensAprox(texto: string): number {
  return Math.ceil(texto.length / 4);
}

/**
 * Compacta la conversación de un turno para que no crezca al cuadrado.
 *
 * El costo de una vuelta es proporcional a todo lo leído antes: cada resultado
 * de herramienta queda textual y se reenvía en cada iteración siguiente.
 * Medido en una corrida real: un turno de 14 vueltas creció de 6k a 27k tokens
 * y gastó 236k, de los cuales 149k —el 63%— fue reenviar lo mismo. Ese único
 * turno fue casi la mitad de la corrida entera.
 *
 * Lo que se compacta es el **contenido ya consumido**: un agente actúa sobre lo
 * que leyó en la vuelta inmediatamente siguiente, y a partir de ahí el texto
 * completo pesa sin aportar. Se reemplaza por un aviso que dice qué había y que
 * puede volver a pedirlo, así la información no se pierde: se vuelve
 * recuperable en vez de estar siempre presente.
 *
 * Los últimos resultados no se tocan, y los mensajes del agente y del sistema
 * tampoco: sin el razonamiento previo el turno pierde el hilo.
 */
function compactarConversacion(
  conversation: ChatMessage[],
  memo: Map<string, string>,
): { liberados: number; compactados: number } {
  const total = conversation.reduce((suma, m) => suma + tokensAprox(m.content), 0);
  if (total <= PRESUPUESTO_CONTEXTO) return { liberados: 0, compactados: 0 };

  // Resultados de herramienta todavía enteros, de más viejo a más nuevo.
  const enteros = conversation.filter(
    (mensaje) => mensaje.role === "tool" && !mensaje.content.startsWith(MARCA_RETIRADO),
  );

  // Se protege el trabajo en curso contando hacia atrás por tamaño: el más
  // reciente siempre queda, aunque solo ya se pase del cupo.
  const protegidos = new Set<ChatMessage>();
  let acumulado = 0;
  for (let i = enteros.length - 1; i >= 0; i--) {
    const mensaje = enteros[i]!;
    if (protegidos.size > 0 && acumulado >= TOKENS_INTOCABLES) break;
    protegidos.add(mensaje);
    acumulado += tokensAprox(mensaje.content);
  }

  const candidatos = enteros.filter((mensaje) => !protegidos.has(mensaje));

  let restante = total;
  let liberados = 0;
  let compactados = 0;

  for (const mensaje of candidatos) {
    if (restante <= PRESUPUESTO_CONTEXTO) break;
    const antes = tokensAprox(mensaje.content);
    // No vale la pena tocar lo chico: el aviso ocupa parecido y se pierde
    // información a cambio de nada.
    if (antes < 200) continue;

    const nombre = mensaje.name ?? "una herramienta";
    mensaje.content =
      `${MARCA_RETIRADO} El resultado de \`${nombre}\` (${mensaje.content.length} caracteres) ` +
      `se retiró del contexto para no reenviarlo en cada vuelta. Ya lo leíste más arriba en ` +
      `este turno. Si necesitás volver a consultarlo, pedilo de nuevo.`;
    restante -= antes - tokensAprox(mensaje.content);
    liberados += antes - tokensAprox(mensaje.content);
    compactados += 1;

    // Si lo sacamos del contexto, el memo no puede seguir diciendo "ya lo
    // leíste, está más arriba": ya no está. Volver a pedirlo tiene que
    // ejecutarse de verdad.
    for (const clave of [...memo.keys()]) {
      if (clave.startsWith(`${nombre}(`)) memo.delete(clave);
    }
  }

  return { liberados, compactados };
}

/** Prefijo de un resultado ya retirado, para no compactarlo dos veces. */
const MARCA_RETIRADO = "[contenido retirado]";

/**
 * Herramientas que sólo hablan: crean un mensaje o una solicitud, y no tocan
 * nada de lo que reporta una herramienta de lectura —ni entregables, ni
 * tareas, ni archivos—. No invalidan el memo de lecturas del turno.
 */
const COMUNICACION = new Set([
  "send_message",
  "reply",
  "broadcast",
  "escalate",
  "request_approval",
  "request_context",
  "request_new_role",
  "request_tool_access",
]);

async function executeCalls(
  calls: ToolCall[],
  byName: Map<string, RegisteredTool>,
  ctx: ToolContext,
  state: RunState,
  bus: EventBus,
  memo: Map<string, string>,
): Promise<{ messages: ChatMessage[]; awaitingApproval: boolean; failures: string[] }> {
  const messages: ChatMessage[] = [];
  const failures: string[] = [];
  let awaitingApproval = false;

  const readOnly = calls.filter((call) => byName.get(call.name)?.readOnly === true);
  const mutating = calls.filter((call) => byName.get(call.name)?.readOnly !== true);

  const parallel = await Promise.all(
    readOnly.map(async (call) => {
      // Una lectura ya hecha en este mismo turno **no se repite ni se vuelve a
      // pegar**: se contesta con un puntero a lo que ya está más arriba en la
      // conversación. Devolver el contenido cacheado ahorraba el ida y vuelta
      // al servidor MCP pero no los tokens, que es donde está el costo real:
      // cada iteración del turno reenvía la conversación entera, así que un
      // entregable repetido se paga muchas veces.
      const huella = huellaDeLectura(byName.get(call.name), call);
      const cacheado = memo.get(huella);
      if (cacheado != null) {
        bus.emit({
          type: "log",
          runId: ctx.runId,
          tick: ctx.tick,
          level: "info",
          roleId: ctx.actor.id,
          message:
            `${call.name}: ya lo había leído en este turno. Se le devuelve un puntero ` +
            `en vez del contenido (${cacheado.length} caracteres ahorrados).`,
        });
        return {
          message: {
            role: "tool" as const,
            toolCallId: call.id || ids.toolCall(),
            name: call.name,
            content:
              `Ya hiciste esta misma lectura en este turno: el resultado completo ` +
              `(${cacheado.length} caracteres) está más arriba en esta conversación. ` +
              `Usá lo que ya leíste en vez de volver a pedirlo. Si intentaste acotar la ` +
              `lectura con un argumento que la herramienta no declara, ese argumento no ` +
              `existe y se ignora: no hay forma de pedir "la parte siguiente".`,
          },
          awaitingApproval: false,
          failure: null,
        };
      }
      const entry = await executeOne(call, byName, ctx, state, bus);
      // Sólo se memoriza lo que salió bien: un error puede ser transitorio y
      // repetirlo cacheado le sacaría al agente la chance de reintentar.
      if (!entry.failure) memo.set(huella, entry.message.content);
      return entry;
    }),
  );
  for (const entry of parallel) {
    messages.push(entry.message);
    if (entry.failure) failures.push(...entry.failure);
  }

  for (const call of mutating) {
    const entry = await executeOne(call, byName, ctx, state, bus);
    messages.push(entry.message);
    if (entry.failure) failures.push(...entry.failure);
    if (entry.awaitingApproval) awaitingApproval = true;

    // Algo cambió: lo leído antes puede haber quedado viejo. Un `list_output`
    // después de escribir un archivo tiene que ver el archivo nuevo.
    //
    // Pero hablar no cambia el mundo. Vaciar el memo con *cualquier* mutación
    // incluía mandar un mensaje, y como un turno de coordinación intercala
    // lecturas y mensajes todo el tiempo, en la práctica el memo casi nunca
    // servía: medimos a un agente ejecutar `list_artifacts` tres veces en el
    // mismo turno porque entre medio mandó un mensaje y asignó una tarea.
    // Lo único que un mensaje sí desactualiza es la traza de actividad.
    if (COMUNICACION.has(call.name)) {
      for (const clave of [...memo.keys()]) {
        if (clave.startsWith("check_activity(")) memo.delete(clave);
      }
    } else {
      memo.clear();
    }
  }

  return { messages, awaitingApproval, failures };
}

/**
 * Identifica una llamada fallida por herramienta y argumentos.
 *
 * Sirve para detectar que el agente está repitiendo exactamente lo mismo. Los
 * argumentos se serializan con las claves ordenadas: al modelo le da igual el
 * orden y sin normalizar la misma llamada daría dos huellas distintas.
 */
function huellaDeFallo(name: string, args: Record<string, unknown>): string {
  const claves = Object.keys(args).sort();
  return `${name}(${claves.map((clave) => `${clave}=${JSON.stringify(args[clave])}`).join(",")})`;
}

/**
 * Huella para el memo de lecturas, calculada **solo sobre los argumentos que la
 * herramienta declara**.
 *
 * Los modelos inventan parámetros que no existen. Medimos a un agente pedir
 * `read_artifact` once veces con `start=4000`, `start=8000`… creyendo que
 * paginaba: la herramienta ignora lo que no está en su esquema y devuelve el
 * entregable entero cada vez, pero con la huella cruda cada llamada parecía
 * distinta, el memo no pegaba nunca y el mismo documento de 40k caracteres
 * entró once veces al contexto. Esa corrida gastó 534k tokens de entrada para
 * producir 2k de salida.
 *
 * Si el esquema no cierra la puerta (`additionalProperties` distinto de
 * `false`), el argumento extra sí puede cambiar el resultado y la huella se
 * calcula completa.
 */
function huellaDeLectura(tool: RegisteredTool | undefined, call: ToolCall): string {
  // Si la herramienta declara cuáles de sus argumentos determinan el resultado,
  // manda eso: el resto es decoración y no puede hacer parecer nueva una
  // llamada repetida.
  if (tool?.clavesDeCache) {
    const efectivos: Record<string, unknown> = {};
    for (const clave of tool.clavesDeCache) {
      if (clave in call.arguments) efectivos[clave] = call.arguments[clave];
    }
    return huellaDeFallo(call.name, efectivos);
  }

  const schema = tool?.inputSchema as
    | { properties?: Record<string, unknown>; additionalProperties?: boolean }
    | undefined;
  const declaradas = schema?.properties;
  if (!declaradas || schema?.additionalProperties !== false) {
    return huellaDeFallo(call.name, call.arguments);
  }
  const efectivos: Record<string, unknown> = {};
  for (const clave of Object.keys(call.arguments)) {
    if (clave in declaradas) efectivos[clave] = call.arguments[clave];
  }
  return huellaDeFallo(call.name, efectivos);
}

/**
 * Segunda huella, por **motivo** del fallo y no por argumentos.
 *
 * Cuando el modelo agota `maxOutputTokens` escribiendo un documento largo, los
 * argumentos llegan cortados en un lugar distinto cada vez: la huella por
 * argumentos nunca coincide y el agente reintenta hasta agotar el turno.
 * Medimos cuatro `write_artifact` seguidos fallando por lo mismo. Agrupar por
 * el motivo sí lo detecta.
 */
function huellaDeMotivo(name: string, detalle: string): string {
  const motivo = detalle
    .replace(/"[^"]*"/g, "…")
    .replace(/\d+/g, "#")
    .slice(0, 120);
  return `${name}::${motivo}`;
}

async function executeOne(
  call: ToolCall,
  byName: Map<string, RegisteredTool>,
  ctx: ToolContext,
  state: RunState,
  bus: EventBus,
): Promise<{ message: ChatMessage; awaitingApproval: boolean; failure: string[] | null }> {
  const tool = byName.get(call.name);
  const callId = call.id || ids.toolCall();

  if (!tool) {
    // El modelo inventó una herramienta. Se le devuelve la lista real para que
    // se corrija en la iteración siguiente en vez de cortar el turno.
    const available = [...byName.keys()].join(", ");
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: call.name,
        content: `ERROR: la herramienta "${call.name}" no existe. Disponibles: ${available}`,
      },
      awaitingApproval: false,
      failure: [huellaDeFallo(call.name, call.arguments)],
    };
  }

  bus.emit({
    type: "tool.start",
    runId: ctx.runId,
    tick: ctx.tick,
    roleId: ctx.actor.id,
    callId,
    toolName: tool.name,
    origin: tool.origin,
    mcpServerId: tool.mcpServerId ?? null,
    args: call.arguments,
  });

  const startedAt = Date.now();

  // Una herramienta marcada como sensible no se ejecuta: se abre una solicitud
  // de aprobación y esa rama del trabajo queda detenida hasta que se resuelva.
  if (tool.requiresApproval) {
    const approval = await ctx.workspace.requestApproval({
      approverRoleId: ctx.actor.reportsTo,
      reason: `${ctx.actor.name} quiere ejecutar ${tool.name}`,
      toolName: tool.name,
      toolArgs: call.arguments,
    });
    bus.emit({
      type: "approval.changed",
      runId: ctx.runId,
      tick: ctx.tick,
      approvalId: approval.id,
      requestedByRoleId: approval.requestedByRoleId,
      approverRoleId: approval.approverRoleId,
      status: "pending",
      reason: approval.reason,
      toolName: tool.name,
    });
    bus.emit({
      type: "tool.end",
      runId: ctx.runId,
      tick: ctx.tick,
      roleId: ctx.actor.id,
      callId,
      toolName: tool.name,
      origin: tool.origin,
      mcpServerId: tool.mcpServerId ?? null,
      durationMs: Date.now() - startedAt,
      ok: false,
      preview: "esperando aprobación",
      error: null,
    });
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: tool.name,
        content:
          `Esta herramienta requiere aprobación. Se abrió la solicitud ${approval.id} y ` +
          `quedás a la espera. Terminá el turno; vas a poder continuar cuando se resuelva.`,
      },
      awaitingApproval: true,
      failure: null,
    };
  }

  try {
    const result = await tool.execute(call.arguments, ctx);
    emitToolEnd(bus, ctx, callId, tool, startedAt, result.ok, result.preview ?? preview(result.content), null);
    // Se registra el resultado real, no el que el agente vaya a contar después:
    // es lo único que permite a un revisor contrastar una cosa con la otra.
    state.recordActivity({
      roleId: ctx.actor.id,
      tick: ctx.tick,
      tool: tool.name,
      ok: result.ok,
      detail: preview(result.content, 200),
    });
    if (tool.origin === "coordination" && result.ok) emitCoordinationEffect(bus, ctx, state, tool);
    return {
      message: { role: "tool", toolCallId: callId, name: tool.name, content: result.content },
      awaitingApproval: false,
      failure: result.ok
        ? null
        : [huellaDeFallo(tool.name, call.arguments), huellaDeMotivo(tool.name, result.content)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitToolEnd(bus, ctx, callId, tool, startedAt, false, "falló", message);
    state.recordActivity({
      roleId: ctx.actor.id,
      tick: ctx.tick,
      tool: tool.name,
      ok: false,
      detail: preview(message, 200),
    });
    return {
      message: {
        role: "tool",
        toolCallId: callId,
        name: tool.name,
        content: `ERROR: ${message}`,
      },
      awaitingApproval: false,
      failure: [huellaDeFallo(tool.name, call.arguments), huellaDeMotivo(tool.name, message)],
    };
  }
}

function emitToolEnd(
  bus: EventBus,
  ctx: ToolContext,
  callId: string,
  tool: RegisteredTool,
  startedAt: number,
  ok: boolean,
  previewText: string,
  error: string | null,
): void {
  bus.emit({
    type: "tool.end",
    runId: ctx.runId,
    tick: ctx.tick,
    roleId: ctx.actor.id,
    callId,
    toolName: tool.name,
    origin: tool.origin,
    mcpServerId: tool.mcpServerId ?? null,
    durationMs: Date.now() - startedAt,
    ok,
    preview: previewText,
    error,
  });
}

/**
 * Las herramientas de coordinación cambian el estado visible de la empresa
 * —mensajes, tareas, entregables— y esos cambios tienen que aparecer en el
 * organigrama animado, no solo en el feed de tool calls.
 */
function emitCoordinationEffect(
  bus: EventBus,
  ctx: ToolContext,
  state: RunState,
  tool: RegisteredTool,
): void {
  const base = { runId: ctx.runId, tick: ctx.tick } as const;

  if (["send_message", "reply", "broadcast", "escalate"].includes(tool.name)) {
    const message = state.messages.at(-1);
    if (!message) return;
    bus.emit({
      ...base,
      type: "agent.message",
      messageId: message.id,
      fromRoleId: message.fromRoleId,
      toRoleId: message.toRoleId,
      toDepartmentId: message.toDepartmentId,
      messageType: message.type,
      subject: message.subject,
      preview: preview(message.body, 300),
    });
    return;
  }

  if (tool.name === "assign_task" || tool.name === "update_task") {
    const task = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!task) return;
    bus.emit({
      ...base,
      type: "task.changed",
      taskId: task.id,
      title: task.title,
      assigneeRoleId: task.assigneeRoleId,
      status: task.status,
      created: tool.name === "assign_task",
    });
    return;
  }

  if (tool.name === "write_artifact") {
    const artifact = state.artifacts.at(-1);
    if (!artifact) return;
    bus.emit({
      ...base,
      type: "artifact.created",
      artifactId: artifact.id,
      key: artifact.key,
      title: artifact.title,
      version: artifact.version,
      authorRoleId: artifact.authorRoleId,
    });
    return;
  }

  if (
    tool.name === "request_new_role" ||
    tool.name === "request_context" ||
    tool.name === "request_tool_access"
  ) {
    const request = state.requests.at(-1);
    if (!request) return;
    bus.emit({
      ...base,
      type: "request.created",
      requestId: request.id,
      requestedByRoleId: request.requestedByRoleId,
      requestType: request.type,
      reason: request.reason,
      summary:
        request.roleProposal
          ? `${request.roleProposal.name} — ${request.roleProposal.title}`
          : (request.question ?? request.toolNames.join(", ")),
    });
    return;
  }

  if (tool.name === "request_approval") {
    const approval = state.approvals.at(-1);
    if (!approval) return;
    bus.emit({
      ...base,
      type: "approval.changed",
      approvalId: approval.id,
      requestedByRoleId: approval.requestedByRoleId,
      approverRoleId: approval.approverRoleId,
      status: approval.status,
      reason: approval.reason,
      toolName: approval.toolName,
    });
  }
}


/**
 * Poda las llamadas a herramienta que quedaron sin respuesta.
 *
 * Si el turno se corta justo después de que el modelo pidió una herramienta, la
 * conversación termina en un mensaje del asistente con `toolCalls` y ningún
 * resultado. Varios proveedores rechazan ese request con un 400 —el protocolo
 * exige que a cada llamada le siga su resultado—, así que al retomar fallaría
 * en la primera iteración, para siempre. Se cortan esas colas antes de guardar.
 */
export function podarSinRespuesta(conversation: ChatMessage[]): ChatMessage[] {
  const podada = [...conversation];
  while (podada.length > 0) {
    const ultimo = podada[podada.length - 1]!;
    const sinResponder =
      ultimo.role === "assistant" && (ultimo.toolCalls?.length ?? 0) > 0;
    if (!sinResponder) break;
    podada.pop();
  }
  return podada;
}

/** Las novedades que llegaron mientras el turno estaba cortado, en dos líneas. */
function resumirBandeja(inbox: { subject: string; body: string }[]): string {
  return inbox
    .map((message) => `- ${message.subject}: ${message.body.slice(0, 200)}`)
    .join("\n");
}

/**
 * Traduce la carga de trabajo del turno a una cantidad de iteraciones.
 *
 * Cada pedido de la bandeja se lee y se contesta —dos vueltas como mínimo—, y
 * un contexto largo se recorre en varias consultas antes de poder escribir. El
 * techo duplica la base pero solo se alcanza si el agente sigue avanzando, y
 * nunca pasa de 50, que es el máximo que admite el esquema del rol.
 */
export function presupuestoDeIteraciones(
  role: Role,
  trabajo: { mensajes: number; tareas: number; caracteres: number; reanudando: boolean },
): { base: number; techo: number } {
  const porBandeja = trabajo.mensajes * 2;
  const porTareas = trabajo.tareas;
  const porContexto = Math.min(6, Math.floor(trabajo.caracteres / 4000));
  // Al retomar ya se gastaron vueltas en el ciclo anterior: alcanza con lo que
  // falta para cerrar, no con el turno entero otra vez.
  const escala = trabajo.reanudando ? 0.5 : 1;

  const base = Math.max(3, Math.round((role.maxTurns + porBandeja + porTareas + porContexto) * escala));
  return { base, techo: Math.min(50, base * 2) };
}
