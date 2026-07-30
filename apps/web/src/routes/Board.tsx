import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task, TaskStatus, TraceEvent } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { useRunStream } from "../lib/stream.js";
import { derive, type DerivedTask } from "../lib/derive.js";
import { accionDeHerramienta } from "../lib/acciones.js";
import { Empty, Status, relativeTime } from "../lib/ui.js";
import { iniciales, tonosPorArea } from "./OrgGraph.js";

/**
 * Tablero: en qué etapa está cada tarea y cómo se mueve.
 *
 * Las tarjetas se derivan de la traza y no de una consulta: se mueven en el
 * instante en que el agente las mueve, y retroceder en el timeline muestra el
 * tablero como estaba en ese ciclo. El detalle que no viaja en el evento
 * —prioridad, resultado— se completa desde la corrida, que cambia poco.
 */

/** Las etapas, en el orden en que se espera que avance el trabajo. */
const ETAPAS: { status: TaskStatus; label: string; hint: string; tono: string }[] = [
  {
    status: "pending",
    label: "Pendiente",
    hint: "Asignada, todavía sin arrancar.",
    tono: "var(--color-ink-faint)",
  },
  {
    status: "in_progress",
    label: "En curso",
    hint: "Alguien la está haciendo ahora.",
    tono: "var(--color-accent)",
  },
  {
    status: "in_review",
    label: "En revisión",
    hint: "El trabajo está hecho y espera verificación de Control de Calidad.",
    tono: "var(--color-approval)",
  },
  {
    status: "blocked",
    label: "Bloqueada",
    hint: "Frenada por algo que el asignado no puede resolver solo.",
    tono: "var(--color-danger)",
  },
  {
    status: "done",
    label: "Hecha",
    hint: "Terminada y verificada.",
    tono: "var(--color-ok)",
  },
];

/** Cuánto queda destacada una tarjeta después de moverse. */
const DESTELLO_MS = 6000;

/** Estados en los que una corrida ya no va a mover nada más. */
const TERMINADAS = new Set(["completed", "stopped", "failed", "budget_exceeded"]);

export function Board({ company }: { company: CompanyBundle }) {
  const [runId, setRunId] = useState<string | null>(null);
  /** Tarjeta abierta en el detalle, por id. */
  const [abierta, setAbierta] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["runs", company.company.id],
    queryFn: () => api.runs(company.company.id),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const lista = runs.data;
    if (!lista) return;

    const actual = runId ? lista.find((item) => item.id === runId) : null;
    // La corrida que estabas mirando se borró de la lista.
    if (runId && !actual) {
      setRunId(lista[0]?.id ?? null);
      return;
    }
    if (!runId && lista[0]) {
      setRunId(lista[0].id);
      return;
    }
    // Este tablero es para mirar cómo se mueve el trabajo: si lo que tenés
    // enfrente ya terminó y arrancó algo nuevo, seguí lo nuevo. No pisa una
    // corrida en curso ni una pausada, así que no te saca de donde estás
    // mirando a propósito.
    if (actual && TERMINADAS.has(actual.status)) {
      const enCurso = lista.find((item) => item.status === "running");
      if (enCurso && enCurso.id !== runId) setRunId(enCurso.id);
    }
  }, [runs.data, runId]);

  const { events } = useRunStream(runId);
  const state = useMemo(() => derive(events), [events]);

  // Detalle que el evento `task.changed` no lleva: prioridad, resultado, quién
  // la creó. No se mueve, así que alcanza con refrescarlo de a ratos.
  const bundle = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: runId != null,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  // El destello se apaga solo: hace falta un reloj propio, porque cuando no
  // llegan eventos nuevos no hay nada que dispare un re-render.
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClock((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const tonos = useMemo(() => tonosPorArea(company.departments), [company.departments]);
  const detalle = useMemo(
    () => new Map((bundle.data?.tasks ?? []).map((task) => [task.id, task])),
    [bundle.data],
  );

  const tareas = useMemo(() => [...state.tasks.values()], [state.tasks]);
  const porEtapa = useMemo(() => {
    const mapa = new Map<TaskStatus, DerivedTask[]>();
    for (const etapa of ETAPAS) mapa.set(etapa.status, []);
    for (const tarea of tareas) {
      // Las canceladas no ocupan una columna: son ruido en un tablero que
      // sirve para ver qué está en movimiento. Se cuentan aparte.
      if (tarea.status === "cancelled") continue;
      mapa.get(tarea.status)?.push(tarea);
    }
    // Lo último que se movió, arriba: es donde está pasando algo.
    for (const lista of mapa.values()) lista.sort((a, b) => b.changedAt - a.changedAt);
    return mapa;
  }, [tareas]);

  const canceladas = tareas.filter((tarea) => tarea.status === "cancelled").length;
  const rolePorId = useMemo(
    () => new Map(company.roles.map((role) => [role.id, role])),
    [company.roles],
  );

  if (!runs.data?.length) {
    return <Empty>Todavía no hay ninguna corrida. Dale un encargo desde “Proceso en vivo”.</Empty>;
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr] gap-3 p-3">
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          value={runId ?? ""}
          onChange={(event) => setRunId(event.target.value)}
          className="min-w-0 max-w-md truncate rounded border border-line bg-canvas px-2 py-1 text-xs text-ink"
        >
          {(runs.data ?? []).map((run) => (
            <option key={run.id} value={run.id}>
              {new Date(run.startedAt).toLocaleString()} — {run.objective.slice(0, 60)}
            </option>
          ))}
        </select>

        <Status value={state.status} />
        <span className="text-xs text-ink-faint">
          ciclo {state.tick} · {tareas.length - canceladas} tareas en el tablero
          {canceladas > 0 && ` · ${canceladas} cancelada${canceladas > 1 ? "s" : ""}`}
        </span>
      </header>

      {tareas.length === 0 ? (
        <Empty>
          Esta corrida todavía no creó tareas. Aparecen acá en cuanto un agente use{" "}
          <code className="mx-1 text-accent">assign_task</code>.
        </Empty>
      ) : (
        // El tablero scrollea a lo ancho adentro suyo: con cinco columnas en
        // una pantalla angosta, sin esto empuja la página entera.
        <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
          {ETAPAS.map((etapa) => (
            <Columna
              key={etapa.status}
              etapa={etapa}
              tareas={porEtapa.get(etapa.status) ?? []}
              rolePorId={rolePorId}
              tonos={tonos}
              detalle={detalle}
              onAbrir={setAbierta}
            />
          ))}
        </div>
      )}

      {abierta && state.tasks.get(abierta) && (
        <Detalle
          tarea={state.tasks.get(abierta)!}
          task={detalle.get(abierta)}
          role={rolePorId.get(state.tasks.get(abierta)!.assigneeRoleId)}
          rolePorId={rolePorId}
          events={events}
          onClose={() => setAbierta(null)}
        />
      )}
    </div>
  );
}

function Columna({
  etapa,
  tareas,
  rolePorId,
  tonos,
  detalle,
  onAbrir,
}: {
  etapa: (typeof ETAPAS)[number];
  tareas: DerivedTask[];
  rolePorId: Map<string, CompanyBundle["roles"][number]>;
  tonos: Map<string, number>;
  detalle: Map<string, Task>;
  onAbrir: (id: string) => void;
}) {
  return (
    <section className="flex min-h-0 w-72 shrink-0 flex-col rounded-lg border border-line bg-surface">
      <header
        className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2"
        title={etapa.hint}
      >
        <span className="size-2 shrink-0 rounded-full" style={{ background: etapa.tono }} />
        <h2 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
          {etapa.label}
        </h2>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">{tareas.length}</span>
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {tareas.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] text-ink-faint">Nada acá.</p>
        ) : (
          tareas.map((tarea) => (
            <Tarjeta
              key={tarea.id}
              tarea={tarea}
              role={rolePorId.get(tarea.assigneeRoleId)}
              tonos={tonos}
              task={detalle.get(tarea.id)}
              onAbrir={onAbrir}
            />
          ))
        )}
      </div>
    </section>
  );
}

const PRIORIDAD: Record<string, string> = {
  urgent: "text-danger",
  high: "text-warn",
  normal: "text-ink-faint",
  low: "text-ink-faint",
};

function Tarjeta({
  tarea,
  role,
  tonos,
  task,
  onAbrir,
}: {
  tarea: DerivedTask;
  role: CompanyBundle["roles"][number] | undefined;
  tonos: Map<string, number>;
  task: Task | undefined;
  onAbrir: (id: string) => void;
}) {
  const tono = role ? (tonos.get(role.departmentId) ?? 250) : 250;
  const color = `oklch(0.72 0.14 ${tono})`;
  const ahora = Date.now();
  const reciente = ahora - tarea.changedAt < DESTELLO_MS;
  const { hasta, enEtapa } = tiempos(tarea, ahora);
  const terminada = tarea.status === "done" || tarea.status === "cancelled";
  const etiqueta = ETIQUETA[tarea.status] ?? tarea.status;

  return (
    <article
      onClick={() => onAbrir(tarea.id)}
      title="Ver el detalle y la historia"
      className={`cursor-pointer rounded-md border bg-surface-2 p-2 transition-colors hover:border-accent/50 ${
        reciente ? "border-accent/70" : "border-line"
      }`}
    >
      <p className="text-xs leading-snug text-ink">{tarea.title}</p>

      <div className="mt-2 flex items-center gap-1.5">
        <span
          className="grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold"
          style={{
            background: `color-mix(in oklch, ${color} 22%, transparent)`,
            color,
            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 55%, transparent)`,
          }}
          title={role?.title ?? ""}
        >
          {iniciales(role?.name ?? "?")}
        </span>
        <span className="min-w-0 truncate text-[11px] text-ink-dim">{role?.name ?? "?"}</span>

        {task && task.priority !== "normal" && (
          <span className={`ml-auto text-[10px] ${PRIORIDAD[task.priority] ?? "text-ink-faint"}`}>
            {task.priority}
          </span>
        )}
      </div>

      {/* De dónde viene: sin eso una tarjeta que apareció en "Hecha" no se
          distingue de una que estuvo ahí desde el principio. */}
      {reciente && tarea.from && (
        <div className="mt-1.5 text-[10px] text-accent">
          {ETIQUETA[tarea.from] ?? tarea.from} → {ETIQUETA[tarea.status] ?? tarea.status}
        </div>
      )}

      <div className="mt-1.5 flex items-baseline gap-2 text-[10px] text-ink-faint">
        <span className="font-mono">c{tarea.tick}</span>

        {/* Cuánto tardó en llegar hasta acá. En la primera etapa no existe
            —no vino de ningún lado— y mostrar "0s" sería ruido. */}
        {tarea.historia.length > 1 && (
          <span title={`Tardó ${lapso(hasta)} desde que se creó hasta llegar a ${etiqueta}`}>
            ⏱ {lapso(hasta)} hasta acá
          </span>
        )}

        {/* Cuánto lleva parada en esta etapa. En las terminales no corre más:
            ahí el número que importa es el total, no el tiempo desde que
            cerró. */}
        {terminada ? (
          <span
            className="ml-auto text-ok"
            title={`Se cerró ${relativeTime(tarea.changedAt)}`}
          >
            cerró en {lapso(hasta)}
          </span>
        ) : (
          <span
            className={`ml-auto ${tarea.status === "blocked" ? "text-danger" : ""}`}
            title={`Lleva ${lapso(enEtapa)} en ${etiqueta}`}
          >
            {lapso(enEtapa)} acá
          </span>
        )}
      </div>

      {task?.result && (
        <p className="mt-1.5 line-clamp-2 border-t border-line pt-1.5 text-[11px] text-ink-faint">
          {task.result}
        </p>
      )}
    </article>
  );
}

const ETIQUETA: Record<string, string> = {
  pending: "Pendiente",
  in_progress: "En curso",
  in_review: "En revisión",
  blocked: "Bloqueada",
  done: "Hecha",
  cancelled: "Cancelada",
};

/** Un lapso en palabras, compacto. */
function lapso(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Cuánto estuvo en una etapa, en palabras. */
function duracion(desde: number, hasta: number): string {
  return lapso(hasta - desde);
}

/**
 * Los dos tiempos de una tarjeta, que miden cosas distintas y conviene no
 * mezclar: cuánto tardó el trabajo en **llegar** a la etapa donde está —lo
 * acumulado desde que se creó— y cuánto lleva **parada ahí**.
 *
 * El primero dice si el proceso es lento; el segundo, si esta tarjeta está
 * trabada ahora. Una que tardó 2 minutos en llegar y lleva 40 quieta es un
 * problema distinto de una que viene lenta desde el principio.
 */
function tiempos(tarea: DerivedTask, ahora: number): { hasta: number; enEtapa: number } {
  const nacimiento = tarea.historia[0]?.at ?? tarea.changedAt;
  const llegada = tarea.historia[tarea.historia.length - 1]?.at ?? tarea.changedAt;
  return { hasta: llegada - nacimiento, enEtapa: ahora - llegada };
}

/**
 * El detalle de una tarjeta: el instructivo con el que se pidió el trabajo, por
 * dónde pasó y qué hizo realmente quien la tiene.
 *
 * Lo último es lo que no se puede leer en ningún otro lado: el tablero dice en
 * qué etapa está, pero no si la persona estuvo trabajando o el ticket quedó
 * quieto. Se arma de la traza, así que es lo que ejecutó el sistema y no lo que
 * el agente contó que hizo.
 */
function Detalle({
  tarea,
  task,
  role,
  rolePorId,
  events,
  onClose,
}: {
  tarea: DerivedTask;
  task: Task | undefined;
  role: CompanyBundle["roles"][number] | undefined;
  rolePorId: Map<string, CompanyBundle["roles"][number]>;
  events: TraceEvent[];
  onClose: () => void;
}) {
  useEffect(() => {
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", alTecla);
    return () => window.removeEventListener("keydown", alTecla);
  }, [onClose]);

  const nacimiento = tarea.historia[0]?.at ?? tarea.changedAt;
  const cierre = tarea.status === "done" || tarea.status === "cancelled" ? tarea.changedAt : null;

  // Lo que hizo el responsable mientras la tarea estuvo viva. No hay forma de
  // atar una llamada a una tarea concreta —el motor no las vincula—, así que se
  // acota por persona y por ventana de tiempo. Es una aproximación, y se dice.
  const actividad = useMemo(
    () =>
      events.filter(
        (e): e is Extract<TraceEvent, { type: "tool.end" }> =>
          e.type === "tool.end" &&
          e.roleId === tarea.assigneeRoleId &&
          e.at >= nacimiento &&
          (cierre == null || e.at <= cierre),
      ),
    [events, tarea.assigneeRoleId, nacimiento, cierre],
  );

  const mensajes = useMemo(
    () =>
      events.filter(
        (e): e is Extract<TraceEvent, { type: "agent.message" }> =>
          e.type === "agent.message" &&
          (e.fromRoleId === tarea.assigneeRoleId || e.toRoleId === tarea.assigneeRoleId) &&
          e.at >= nacimiento &&
          (cierre == null || e.at <= cierre),
      ),
    [events, tarea.assigneeRoleId, nacimiento, cierre],
  );

  const nombre = (id: string | null): string =>
    id ? (rolePorId.get(id)?.name ?? "?") : "la persona a cargo";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-canvas/80 p-6"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-2xl rounded-lg border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm leading-snug font-medium text-ink">{tarea.title}</h2>
            <p className="mt-1 text-[11px] text-ink-faint">
              {role?.name ?? "?"} · {role?.title ?? ""}
              {task?.createdByRoleId && ` · se la pidió ${nombre(task.createdByRoleId)}`}
              {task && task.priority !== "normal" && ` · prioridad ${task.priority}`}
            </p>
          </div>
          <span className="shrink-0">
            <Status value={tarea.status === "done" ? "completed" : tarea.status}
              label={ETIQUETA[tarea.status] ?? tarea.status} />
          </span>
          <button
            onClick={onClose}
            title="Cerrar (Esc)"
            className="shrink-0 rounded px-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-3">
          {task?.detail && (
            <section>
              <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
                El pedido
              </h3>
              <p className="rounded border border-line bg-canvas p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
                {task.detail}
              </p>
            </section>
          )}

          {task?.result && (
            <section>
              <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
                Lo que devolvió
              </h3>
              <p className="rounded border border-ok/40 bg-ok/5 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
                {task.result}
              </p>
            </section>
          )}

          <section>
            <h3 className="mb-1.5 flex items-baseline gap-2 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
              Por dónde pasó
              <span className="ml-auto normal-case text-ink-faint">
                {tarea.status === "done" || tarea.status === "cancelled"
                  ? `cerró en ${duracion(nacimiento, tarea.changedAt)}`
                  : `abierta hace ${duracion(nacimiento, Date.now())}`}
              </span>
            </h3>
            <ol className="space-y-1.5">
              {tarea.historia.map((paso, i) => {
                const siguiente = tarea.historia[i + 1];
                return (
                  <li key={`${paso.status}-${paso.at}`} className="flex items-baseline gap-2 text-[11px]">
                    <span className="font-mono text-[10px] text-ink-faint">c{paso.tick}</span>
                    <span className="text-ink">{ETIQUETA[paso.status] ?? paso.status}</span>
                    <span className="text-ink-faint">
                      {siguiente
                        ? `estuvo ${duracion(paso.at, siguiente.at)}`
                        : `desde hace ${duracion(paso.at, Date.now())}`}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-ink-faint">
                      {new Date(paso.at).toLocaleTimeString("es-AR", { hour12: false })}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
              Qué hizo {role?.name?.split(" ")[0] ?? "el responsable"}
            </h3>
            {actividad.length === 0 ? (
              <p className="text-[11px] text-ink-faint">
                No ejecutó ninguna herramienta mientras la tarea estuvo abierta.
              </p>
            ) : (
              <ul className="space-y-1">
                {actividad.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-[11px]" title={e.toolName}>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${e.ok ? "bg-ok" : "bg-danger"}`}
                    />
                    <span className={e.ok ? "text-ink-dim" : "text-danger"}>
                      {accionDeHerramienta(e.toolName)}
                    </span>
                    <span className="min-w-0 truncate text-[10px] text-ink-faint">
                      {e.error ?? e.preview}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                      c{e.tick}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[10px] text-ink-faint">
              Es la actividad de {role?.name?.split(" ")[0] ?? "el responsable"} en la ventana en
              que la tarea estuvo abierta: el motor no ata cada llamada a una tarea, así que puede
              incluir trabajo de otra cosa que hizo en paralelo.
            </p>
          </section>

          {mensajes.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
                Lo que se habló
              </h3>
              <ul className="space-y-1.5">
                {mensajes.map((m) => (
                  <li key={m.id} className="text-[11px]">
                    <span className="text-ink-faint">
                      {nombre(m.fromRoleId)} → {nombre(m.toRoleId)}
                    </span>
                    {m.subject && <span className="ml-1.5 text-ink">{m.subject}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
