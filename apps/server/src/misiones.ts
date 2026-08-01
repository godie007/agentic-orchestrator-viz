import {
  describirProgramacion,
  proximaCorrida,
  type Mision,
  type Run,
} from "@orq/shared";
import type { Correo } from "@orq/tools";
import type { Store } from "./db.js";
import type { Runtime } from "./runtime.js";

/**
 * Planificador de misiones.
 *
 * Una misión es un encargo que se dispara solo. El planificador es a propósito
 * tonto: se despierta cada tanto, mira qué misión tiene el turno vencido y la
 * larga. No hay timers por misión —uno por misión significa perderlos todos al
 * reiniciar y no poder cambiar la programación sin reprogramar el timer—: el
 * próximo disparo está **guardado en la base**, así que sobrevive al reinicio y
 * se recalcula solo cuando alguien edita la misión.
 *
 * Y no larga dos corridas de la misma empresa a la vez: dos equipos completos
 * escribiendo sobre los mismos entregables se pisan, y el resultado es una
 * versión que mezcla dos trabajos.
 */
export class MisionScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly runtime: Runtime,
    private readonly correo: Correo,
    private readonly appUrl: string,
    private readonly tickMs: number,
  ) {}

  /** Deja todas las misiones con su próximo disparo calculado y arranca el reloj. */
  start(): void {
    if (this.timer) return;
    for (const mision of this.store.listAllMisiones()) {
      if (mision.enabled && mision.proximaAt == null) this.reprogramar(mision);
    }
    this.timer = setInterval(() => {
      void this.revisar();
    }, this.tickMs);
    // Un timer con `unref` no impide que el proceso termine cuando toca.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Recalcula el próximo disparo y lo guarda.
   *
   * Se llama al crear, al editar y después de cada corrida. Si la programación
   * no dispara nunca —una expresión cron inválida— la misión queda sin próximo
   * turno en vez de correr a cualquier hora.
   */
  reprogramar(mision: Mision, desde: number = Date.now()): Mision {
    const proximaAt = mision.enabled ? proximaCorrida(mision.programacion, desde) : null;
    const actualizada: Mision = { ...mision, proximaAt, updatedAt: Date.now() };
    this.store.saveMision(actualizada);
    return actualizada;
  }

  /** Las que ya vencieron, en orden. Público para poder testear sin reloj. */
  vencidas(ahora: number = Date.now()): Mision[] {
    return this.store
      .listAllMisiones()
      .filter((mision) => mision.enabled && mision.proximaAt != null && mision.proximaAt <= ahora)
      .sort((a, b) => (a.proximaAt ?? 0) - (b.proximaAt ?? 0));
  }

  private async revisar(): Promise<void> {
    for (const mision of this.vencidas()) {
      try {
        await this.disparar(mision);
      } catch (error) {
        // Una misión que falla no puede frenar a las demás ni tirar el servidor.
        const detalle = error instanceof Error ? error.message : String(error);
        console.error(`[mision ${mision.id}] no se pudo disparar: ${detalle}`);
        this.reprogramar(mision);
      }
    }
  }

  async disparar(mision: Mision): Promise<Run | null> {
    // Si la empresa ya tiene una corrida viva, esta vuelta se saltea y se
    // reprograma: es más sano perder un turno que superponer dos equipos.
    if (this.runtime.tieneCorridaViva(mision.companyId)) {
      this.reprogramar(mision);
      return null;
    }

    const run = await this.runtime.startRun({
      companyId: mision.companyId,
      objective: mision.objective,
      mode: "continuous",
      budgetUsd: mision.budgetUsd,
      ...(mision.maxTicks != null ? { maxTicks: mision.maxTicks } : {}),
    });

    this.store.saveMision({
      ...this.reprogramar(mision),
      ultimaAt: Date.now(),
      ultimaRunId: run.id,
    });

    // El aviso se manda cuando la corrida termina, no ahora: lo que le interesa
    // a quien recibe el mail es qué produjo, no que arrancó.
    void this.avisarAlTerminar(mision, run.id);
    return run;
  }

  /**
   * Espera el cierre de la corrida y manda el aviso con lo que produjo.
   *
   * Sondea en vez de escuchar el bus porque el aviso tiene que salir igual si la
   * corrida muere por presupuesto o por error: esos caminos no emiten lo mismo,
   * pero todos dejan la corrida en un estado terminal.
   */
  private async avisarAlTerminar(mision: Mision, runId: string): Promise<void> {
    if (mision.avisarA.length === 0) return;

    const terminales = new Set(["completed", "stopped", "failed", "budget_exceeded"]);
    const limite = Date.now() + 6 * 60 * 60 * 1000;
    let run = this.store.getRun(runId);

    while (run && !terminales.has(run.status) && Date.now() < limite) {
      await new Promise((listo) => setTimeout(listo, 15_000));
      run = this.store.getRun(runId);
    }
    if (!run) return;

    const artefactos = this.store.listArtifacts(runId);
    const archivos = await this.runtime.exports.flatList(mision.companyId);
    // Sólo lo que esta corrida dejó: el directorio tiene todo lo anterior.
    const nuevos = archivos.filter((archivo) => archivo.modifiedAt >= run!.startedAt);

    const enviado = await this.correo.enviar({
      to: mision.avisarA,
      subject: `[${mision.name}] ${etiquetaDeEstado(run.status)}`,
      text: cuerpoDelAviso(mision, run, artefactos.map((a) => a.title), nuevos.map((a) => a.path), this.appUrl),
      ...(nuevos.length > 0
        ? {
            attachments: nuevos.map((archivo) => ({
              filename: archivo.path.split("/").at(-1) ?? archivo.path,
              url: `${this.appUrl.replace(/\/$/, "")}/api/companies/${mision.companyId}/exports/${archivo.path}`,
            })),
          }
        : {}),
    });

    if (!enviado.ok) {
      console.error(`[mision ${mision.id}] no se pudo avisar: ${enviado.motivo}`);
    }
  }
}

const etiquetaDeEstado = (status: string): string =>
  ({
    completed: "listo para revisar",
    stopped: "se detuvo",
    failed: "falló",
    budget_exceeded: "se quedó sin presupuesto",
  })[status] ?? status;

/**
 * El cuerpo del aviso.
 *
 * Se escribe para alguien que no vio la corrida y tiene que decidir si esto se
 * publica: qué se produjo, dónde mirarlo y qué falta. Sin la decisión explícita,
 * un aviso automático es una notificación más que nadie abre.
 */
function cuerpoDelAviso(
  mision: Mision,
  run: Run,
  entregables: string[],
  archivos: string[],
  appUrl: string,
): string {
  const lineas = [
    `Misión: ${mision.name}`,
    `Programada: ${describirProgramacion(mision.programacion)}`,
    `Resultado: ${etiquetaDeEstado(run.status)} en ${run.tick} ciclos.`,
    "",
  ];

  if (archivos.length > 0) {
    lineas.push("Archivos que dejó:", ...archivos.map((ruta) => `  · ${ruta}`), "");
  }
  if (entregables.length > 0) {
    lineas.push("Entregables:", ...entregables.map((titulo) => `  · ${titulo}`), "");
  }
  if (archivos.length === 0 && entregables.length === 0) {
    lineas.push("La corrida no produjo ningún archivo ni entregable. Vale revisar la traza.", "");
  }

  lineas.push(
    "Qué tenés que decidir: si esto se publica o no.",
    `Miralo acá: ${appUrl.replace(/\/$/, "")}`,
    "",
    "Nada se publica solo: queda en el directorio de salida hasta que alguien lo apruebe.",
  );
  return lineas.join("\n");
}
