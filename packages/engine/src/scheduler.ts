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
      const activeRoleIds = this.state.rolesWithWork();

      this.deps.bus.emit({
        type: "tick.start",
        runId: this.run.id,
        tick: this.state.tick,
        activeRoleIds,
      });

      if (activeRoleIds.length === 0) {
        this.finish("completed", "No queda trabajo pendiente: todas las bandejas y tableros están vacíos.");
        return { advanced: false, reason: this.stopReason ?? "" };
      }

      const before = this.state.messages.length;
      const costBefore = this.deps.ledger.spentUsd;

      await this.runTurns(activeRoleIds);

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

  private async runTurns(roleIds: string[]): Promise<void> {
    const concurrency = Math.max(1, this.deps.concurrency ?? 4);
    const queue = [...roleIds];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (this.stopRequested) return;
        const roleId = queue.shift();
        if (!roleId) return;
        const role = this.state.getRole(roleId);
        if (!role) continue;

        try {
          await runAgentTurn(this.state, role, {
            bus: this.deps.bus,
            providers: this.deps.providers,
            tools: this.deps.tools,
            ledger: this.deps.ledger,
            objective: this.run.objective,
            maxTicks: this.run.maxTicks,
            ...(this.abort ? { signal: this.abort.signal } : {}),
          });
        } catch (error) {
          // El fallo de un agente no puede tumbar la empresa: que un proveedor
          // esté saturado o un modelo caído es el equivalente a que alguien no
          // esté disponible hoy. Se registra, ese rol pierde el turno, y el
          // resto sigue trabajando.
          //
          // El presupuesto es la excepción: es un límite de la corrida entera,
          // así que se propaga y la detiene.
          if (error instanceof BudgetExceededError) throw error;
          this.deps.bus.emit({
            type: "log",
            runId: this.run.id,
            tick: this.state.tick,
            level: "error",
            roleId: role.id,
            message: `${role.name} no pudo completar su turno: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    };

    // Los turnos corren en paralelo pero escriben en el mismo `RunState`. Es
    // seguro porque JavaScript es de un solo hilo y `RunState` no cede el
    // control (`await`) entre leer y escribir sus estructuras.
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
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

function isTerminal(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "stopped" ||
    status === "budget_exceeded" ||
    status === "failed"
  );
}
