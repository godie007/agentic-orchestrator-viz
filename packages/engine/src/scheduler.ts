import type { Run, RunStatus } from "@orq/shared";
import { BudgetExceededError, type ProviderRegistry, type RunLedger } from "@orq/llm";
import type { ToolRegistry } from "@orq/tools";
import type { EventBus } from "./events.js";
import type { RunState } from "./state.js";
import { runAgentTurn } from "./loop.js";

/**
 * Scheduler: el motor de "la empresa opera sola".
 *
 * Un *tick* es un ciclo de la empresa: se toman los roles con trabajo
 * pendiente, ejecutan su turno en paralelo acotado, y los mensajes que emiten
 * entran a las bandejas para el ciclo siguiente. Esa demora de un ciclo es
 * deliberada: modela que nadie contesta en el mismo instante en que le
 * escriben, y evita que dos agentes entren en un ida y vuelta infinito dentro
 * del mismo tick.
 */

export interface OrchestratorDeps {
  bus: EventBus;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  ledger: RunLedger;
  /** Turnos ejecutados en paralelo dentro de un tick. */
  concurrency?: number;
  /**
   * Cómo se formatea "hoy" para el prompt de los agentes. Es una función y no
   * un valor porque una corrida puede cruzar la medianoche. Los tests no la
   * pasan y así quedan deterministas. Ver `TurnDeps.fechaHoy`.
   */
  fechaHoy?: () => string;
  onRunUpdate?: (run: Run) => void;
}

export class Orchestrator {
  private status: RunStatus = "idle";
  private stopReason: string | null = null;
  private abort: AbortController | null = null;
  private cronTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly run: Run,
    private readonly state: RunState,
    private readonly deps: OrchestratorDeps,
  ) {}

  get snapshot(): Run {
    return {
      ...this.run,
      status: this.status,
      tick: this.state.tick,
      spentUsd: this.deps.ledger.spentUsd,
      stopReason: this.stopReason,
      endedAt: isTerminal(this.status) ? (this.run.endedAt ?? Date.now()) : null,
    };
  }

  /** Ejecuta un solo ciclo. Es el modo manual y la unidad de los otros modos. */
  async tick(): Promise<{ advanced: boolean; reason: string }> {
    if (this.running) return { advanced: false, reason: "ya hay un ciclo en curso" };

    const blocked = this.checkBlockers();
    if (blocked) return { advanced: false, reason: blocked };

    this.running = true;
    this.abort = new AbortController();
    this.setStatus("running");

    try {
      this.state.tick += 1;

      // Antes de decidir si queda trabajo: los pedidos que quedaron sin
      // respuesta vuelven a la bandeja de quien los debía contestar.
      const reencolados = this.state.reencolarSolicitudesSinResponder();
      if (reencolados > 0) {
        this.deps.bus.emit({
          type: "log",
          runId: this.run.id,
          tick: this.state.tick,
          level: "warn",
          roleId: null,
          message: `${reencolados} pedido(s) quedaron sin respuesta y se reenviaron.`,
        });
      }

      // Una tarea abierta hace que su responsable cuente como "con trabajo"
      // para siempre, aunque no la toque. Medimos catorce ciclos seguidos donde
      // el mismo agente tomaba turno, pensaba una vez, no llamaba ninguna
      // herramienta y terminaba: la corrida murió por límite de ciclos sin
      // producir nada, y como siempre había alguien "con trabajo", la revisión
      // de cierre nunca llegó a ofrecerse.
      //
      // Hablar sin hacer nada, repetido, es no tener trabajo. Un mensaje nuevo
      // en la bandeja sí lo es, y lo reactiva.
      const activeRoleIds = this.state.rolesWithWork().filter((roleId) => {
        const vacios = this.turnosSinHacerNada.get(roleId) ?? 0;
        if (vacios < TURNOS_VACIOS_TOLERADOS) return true;
        return this.state.inbox(roleId).length > 0;
      });

      this.deps.bus.emit({
        type: "tick.start",
        runId: this.run.id,
        tick: this.state.tick,
        activeRoleIds,
      });

      if (activeRoleIds.length === 0) {
        // Nadie tiene trabajo, pero alguien quedó esperando una respuesta de
        // una persona. Eso no es "terminó": es que el trabajo sigue del otro
        // lado. Terminar acá dejaba la pregunta huérfana —la respuesta ya no
        // llegaba a ninguna bandeja— y el pedido moría a medias.
        //
        // La espera sólo corta cuando ya no hay nada más que hacer: mientras
        // otros puedan seguir, siguen. Una pregunta pendiente no frena a toda
        // la empresa.
        const esperando = this.state.requests.filter((pedido) => pedido.status === "pending");
        if (esperando.length > 0) {
          const reason =
            `${esperando.length} solicitud(es) esperando una respuesta de la persona a cargo. ` +
            `La corrida queda en pausa y sigue sola cuando respondas.`;
          this.setStatus("awaiting_approval", reason);
          return { advanced: false, reason };
        }

        // Antes de dar por cerrada una corrida que sí produjo algo, el máximo
        // responsable tiene una última chance de mirar si el objetivo está
        // cumplido.
        //
        // Sin esto la corrida termina en silencio apenas se vacían las
        // bandejas, y eso premia quedarse a mitad de camino: lo medimos con un
        // encargo que pedía diagnóstico, diseño y precio, y cerró como
        // "completed" con sólo el diagnóstico hecho, porque quien coordinaba
        // recibió el primer entregable y no encadenó las etapas siguientes.
        // Cerrar pasa a ser una decisión explícita en vez de un silencio.
        if (!this.cierrePedido && this.mensajesEntreRoles() > 0) {
          this.cierrePedido = true;
          const responsable =
            this.state.roles.find((rol) => rol.authority === "executive") ?? this.state.roles[0];
          if (responsable) {
            void this.state.forActor(null).sendMessage({
              toRoleId: responsable.id,
              toDepartmentId: null,
              type: "human",
              subject: "Antes de cerrar: ¿está cumplido el encargo?",
              body:
                `Nadie tiene trabajo pendiente y la corrida está por cerrarse. Revisá contra el ` +
                `objetivo original si falta alguna etapa del trabajo.\n\n` +
                `Objetivo: ${this.run.objective}\n\n` +
                `Si falta algo —una etapa que no se hizo, un entregable que nadie consolidó, una ` +
                `verificación que no se pidió—, asignalo ahora con assign_task o pedilo con ` +
                `send_message. Si está todo, terminá tu turno sin llamar ninguna herramienta y la ` +
                `corrida cierra.`,
              threadId: null,
              inReplyTo: null,
            });
            return { advanced: true, reason: "se le pidió al responsable que confirme el cierre" };
          }
        }

        // "No queda trabajo pendiente" y "nadie hizo nada" se ven igual desde
        // acá: las dos dejan las bandejas vacías. Distinguirlas importa porque
        // un `completed` se lee como éxito, y una corrida donde el rol que
        // recibió el encargo leyó un artefacto y cortó el turno sin delegar ni
        // escribir es un pedido perdido. Nos pasó con el encargo de auditoría:
        // cerró en dos ciclos, sin un mensaje ni un entregable, informando que
        // no quedaba trabajo.
        if (this.state.artifacts.length === 0 && this.mensajesEntreRoles() === 0) {
          const reason =
            `La corrida terminó sin producir nada: ningún entregable escrito y ningún ` +
            `mensaje entre roles. El encargo llegó a destino pero no se ejecutó. ` +
            `Revisá la traza del primer ciclo: lo habitual es que quien lo recibió no ` +
            `haya delegado ni usado una herramienta que deje resultado.`;
          this.finish("failed", reason);
          return { advanced: false, reason };
        }
        this.finish("completed", "No queda trabajo pendiente: todas las bandejas y tableros están vacíos.");
        return { advanced: false, reason: this.stopReason ?? "" };
      }

      const before = this.state.messages.length;
      const costBefore = this.deps.ledger.spentUsd;

      const { intentados, fallidos } = await this.runTurns(activeRoleIds);

      // Si ningún turno del ciclo terminó, el problema no es de un agente: el
      // proveedor está rechazando todo (sin crédito, caído, saturado). Sin este
      // corte, una corrida así quema los ciclos restantes en un minuto —cada
      // turno falla al instante— y termina en "completed" sin haber hecho nada.
      if (intentados > 0 && fallidos === intentados) {
        this.ticksSinTurnosOk += 1;
        if (this.ticksSinTurnosOk >= TICKS_FALLIDOS_TOLERADOS) {
          const reason =
            `${TICKS_FALLIDOS_TOLERADOS} ciclos seguidos sin un solo turno completado: ` +
            `el proveedor está rechazando todas las llamadas` +
            (this.ultimoErrorDeTurno ? ` (último error: ${this.ultimoErrorDeTurno})` : "") +
            `. Se corta acá para no quemar los ciclos y el presupuesto restantes.`;
          this.finish("failed", reason);
          return { advanced: true, reason };
        }
      } else {
        this.ticksSinTurnosOk = 0;
      }

      this.deps.bus.emit({
        type: "tick.end",
        runId: this.run.id,
        tick: this.state.tick,
        messagesEmitted: this.state.messages.length - before,
        costUsd: this.deps.ledger.spentUsd - costBefore,
      });

      const after = this.checkBlockers();
      if (after) {
        return { advanced: true, reason: after };
      }
      this.setStatus("paused");
      return { advanced: true, reason: `ciclo ${this.state.tick} completado` };
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.finish("budget_exceeded", error.message);
        return { advanced: true, reason: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.bus.emit({
        type: "log",
        runId: this.run.id,
        tick: this.state.tick,
        level: "error",
        roleId: null,
        message,
      });
      this.finish("failed", message);
      return { advanced: true, reason: message };
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  /** Corre ciclos hasta que no quede trabajo, se agote el presupuesto o se corte. */
  async runContinuous(): Promise<void> {
    // Si quedó esperando a una persona y ya le contestaron, se destraba sola.
    // Sin esto, retomar era un no-op: el bucle se salta entero mientras el
    // estado sea `awaiting_approval`, así que la corrida quedaba trabada
    // informando que esperaba respuestas que ya estaban dadas.
    if (this.status === "awaiting_approval" && !this.esperaAlgo()) {
      this.setStatus("paused");
    }

    while (!isTerminal(this.status) && this.status !== "awaiting_approval") {
      if (this.stopRequested) {
        this.finish("stopped", "Detenida por la persona a cargo.");
        break;
      }
      const { advanced } = await this.tick();
      if (!advanced) break;
    }
  }

  /** Modo cron: un ciclo cada N ms, para simular el ritmo de un negocio real. */
  startCron(intervalMs: number): void {
    this.stopCron();
    this.cronTimer = setInterval(() => {
      if (isTerminal(this.status) || this.running) return;
      void this.tick();
    }, intervalMs);
    this.cronTimer.unref?.();
  }

  stopCron(): void {
    if (this.cronTimer) clearInterval(this.cronTimer);
    this.cronTimer = null;
  }

  private stopRequested = false;

  /** Corta la corrida. Un turno en vuelo se aborta por señal. */
  stop(reason = "Detenida por la persona a cargo."): void {
    this.stopRequested = true;
    this.stopCron();
    this.abort?.abort();
    if (!isTerminal(this.status)) this.finish("stopped", reason);
  }

  pause(): void {
    this.stopCron();
    if (this.status === "running") this.setStatus("paused");
  }

  /**
   * Resuelve una aprobación pendiente. Si era la última, la corrida vuelve a
   * quedar lista para el ciclo siguiente.
   */
  resolveApproval(approvalId: string, decision: "granted" | "denied", resolution: string): boolean {
    const approval = this.state.resolveApproval(approvalId, decision, resolution);
    if (!approval) return false;

    this.deps.bus.emit({
      type: "approval.changed",
      runId: this.run.id,
      tick: this.state.tick,
      approvalId: approval.id,
      requestedByRoleId: approval.requestedByRoleId,
      approverRoleId: approval.approverRoleId,
      status: approval.status,
      reason: approval.reason,
      toolName: approval.toolName,
    });

    // El solicitante se entera por su bandeja, como cualquier otra novedad.
    void this.state.forActor(null).sendMessage({
      toRoleId: approval.requestedByRoleId,
      toDepartmentId: null,
      type: decision === "granted" ? "approval_grant" : "approval_deny",
      subject: decision === "granted" ? "Aprobación concedida" : "Aprobación denegada",
      body:
        `Tu pedido "${approval.reason}" fue ${decision === "granted" ? "aprobado" : "rechazado"}.` +
        (resolution ? `\n\nComentario: ${resolution}` : ""),
      threadId: null,
      inReplyTo: null,
    });

    if (this.state.pendingApprovals().length === 0 && this.status === "awaiting_approval") {
      this.setStatus("paused");
    }
    return true;
  }

  /**
   * Mensajes que se escribieron entre sí los roles. El encargo de la persona a
   * cargo no cuenta: existe siempre y diría que hubo actividad aunque nadie
   * haya movido un dedo.
   */
  private mensajesEntreRoles(): number {
    return this.state.messages.filter((message) => message.fromRoleId !== null).length;
  }

  /** Si todavía hay algo que dependa de una persona: una aprobación o una consulta. */
  private esperaAlgo(): boolean {
    return (
      this.state.pendingApprovals().length > 0 ||
      this.state.requests.some((pedido) => pedido.status === "pending")
    );
  }

  /** Turnos seguidos en los que un rol habló sin ejecutar ninguna herramienta. */
  private readonly turnosSinHacerNada = new Map<string, number>();

  /** Ya se le ofreció al responsable revisar el cierre. Pasa una sola vez. */
  private cierrePedido = false;

  /** Ciclos consecutivos en los que ningún turno pudo completarse. */
  private ticksSinTurnosOk = 0;
  private ultimoErrorDeTurno: string | null = null;

  private async runTurns(roleIds: string[]): Promise<{ intentados: number; fallidos: number }> {
    // Nadie espera un lugar: el ciclo termina cuando termina el último, así que
    // dejar a un agente en cola no ahorra nada y alarga el ciclo entero. Con 5
    // roles y un tope de 4, uno arrancaba recién cuando otro terminaba.
    // El tope configurado se respeta como piso, no como techo.
    const concurrency = Math.max(1, this.deps.concurrency ?? 4, roleIds.length);
    const queue = [...roleIds];
    let intentados = 0;
    let fallidos = 0;

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.stopRequested) return;
        const roleId = queue.shift();
        if (!roleId) return;
        const role = this.state.getRole(roleId);
        if (!role) continue;

        intentados += 1;
        try {
          const resultado = await runAgentTurn(this.state, role, {
            bus: this.deps.bus,
            providers: this.deps.providers,
            tools: this.deps.tools,
            ledger: this.deps.ledger,
            objective: this.run.objective,
            maxTicks: this.run.maxTicks,
            ...(this.deps.fechaHoy ? { fechaHoy: this.deps.fechaHoy() } : {}),
            ...(this.abort ? { signal: this.abort.signal } : {}),
          });
          // El contador se reinicia en cuanto hace algo: lo que se persigue es
          // la racha, no un turno suelto en el que no tenía nada que hacer.
          if (resultado.herramientas > 0) {
            this.turnosSinHacerNada.delete(role.id);
          } else {
            const vacios = (this.turnosSinHacerNada.get(role.id) ?? 0) + 1;
            this.turnosSinHacerNada.set(role.id, vacios);
            if (vacios === TURNOS_VACIOS_TOLERADOS) {
              this.deps.bus.emit({
                type: "log",
                runId: this.run.id,
                tick: this.state.tick,
                level: "warn",
                roleId: role.id,
                message:
                  `${role.name} lleva ${vacios} turnos hablando sin ejecutar nada. Deja de ` +
                  `convocarse por sus tareas abiertas hasta que le llegue un mensaje nuevo.`,
              });
            }
          }
        } catch (error) {
          // El fallo de un agente no puede tumbar la empresa: que un proveedor
          // esté saturado o un modelo caído es el equivalente a que alguien no
          // esté disponible hoy. Se registra, ese rol pierde el turno, y el
          // resto sigue trabajando.
          //
          // El presupuesto es la excepción: es un límite de la corrida entera,
          // así que se propaga y la detiene.
          if (error instanceof BudgetExceededError) throw error;
          fallidos += 1;
          this.ultimoErrorDeTurno = error instanceof Error ? error.message : String(error);
          this.deps.bus.emit({
            type: "log",
            runId: this.run.id,
            tick: this.state.tick,
            level: "error",
            roleId: role.id,
            message: `${role.name} no pudo completar su turno: ${this.ultimoErrorDeTurno}`,
          });
        }
      }
    };

    // Los turnos corren en paralelo pero escriben en el mismo `RunState`. Es
    // seguro porque JavaScript es de un solo hilo y `RunState` no cede el
    // control (`await`) entre leer y escribir sus estructuras.
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { intentados, fallidos };
  }

  /** Motivo por el que no se puede avanzar, o `null` si se puede. */
  private checkBlockers(): string | null {
    if (isTerminal(this.status)) return `La corrida ya terminó (${this.status}).`;

    if (this.deps.ledger.exhausted) {
      const reason = `Presupuesto agotado: US$${this.deps.ledger.spentUsd.toFixed(4)} de US$${this.deps.ledger.budgetUsd.toFixed(2)}.`;
      this.finish("budget_exceeded", reason);
      return reason;
    }

    if (this.state.tick >= this.run.maxTicks) {
      const reason = `Se alcanzó el límite de ${this.run.maxTicks} ciclos.`;
      this.finish("completed", reason);
      return reason;
    }

    const pending = this.state.pendingApprovals();
    if (pending.length > 0) {
      const reason = `Hay ${pending.length} aprobación(es) pendiente(s). Resolvelas para continuar.`;
      this.setStatus("awaiting_approval", reason);
      return reason;
    }

    return null;
  }

  private setStatus(status: RunStatus, reason: string | null = null): void {
    if (this.status === status && this.stopReason === reason) return;
    this.status = status;
    this.stopReason = reason;
    this.deps.bus.emit({
      type: "run.status",
      runId: this.run.id,
      tick: this.state.tick,
      status,
      reason,
    });
    this.deps.onRunUpdate?.(this.snapshot);
  }

  private finish(status: RunStatus, reason: string): void {
    this.stopCron();
    this.run.endedAt = Date.now();
    this.setStatus(status, reason);
  }
}

/**
 * Cuántos ciclos enteros sin un solo turno exitoso se toleran antes de cortar.
 * Tres da margen a un pico transitorio del proveedor sin dejar que una cuenta
 * sin crédito consuma los 50 ciclos de la corrida.
 */
const TICKS_FALLIDOS_TOLERADOS = 3;

/**
 * Turnos seguidos sin ejecutar nada antes de dejar de convocar a un rol por sus
 * tareas abiertas. Dos da margen a un turno donde genuinamente no había nada que
 * hacer; a partir del tercero es una racha y quema un ciclo por vez.
 */
const TURNOS_VACIOS_TOLERADOS = 2;

function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "stopped" ||
    status === "budget_exceeded" ||
    status === "failed"
  );
}
