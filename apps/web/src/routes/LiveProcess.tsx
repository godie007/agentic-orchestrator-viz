import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TraceEvent } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { useRunStream } from "../lib/stream.js";
import { derive, MESSAGE_COLOR, MESSAGE_LABEL, porcentajeCache, recentFlows } from "../lib/derive.js";
import { Button, Empty, Field, Panel, Status, inputClass, money, relativeTime, tokens } from "../lib/ui.js";
import { OrgGraph } from "./OrgGraph.js";

/**
 * Live Process View: cómo trabaja la empresa.
 *
 * El organigrama se anima con la traza, y el timeline permite retroceder y
 * reproducir la corrida desde el principio. Ver en vivo y reproducir son la
 * misma operación: derivar el estado de los eventos hasta un punto.
 */
export function LiveProcess({ company }: { company: CompanyBundle }) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  /** Abre el formulario de encargo aunque ya haya corridas anteriores. */
  const [nuevoEncargo, setNuevoEncargo] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  /** `null` = seguir el vivo. Un número congela la vista en ese evento. */
  const [scrub, setScrub] = useState<number | null>(null);

  const runs = useQuery({
    queryKey: ["runs", company.company.id],
    queryFn: () => api.runs(company.company.id),
    refetchInterval: 5000,
    // Una corrida en modo continuo puede durar minutos y el usuario va a
    // cambiar de pestaña. Sin esto React Query pausa el polling al perder foco
    // y la vista queda congelada al volver.
    refetchIntervalInBackground: true,
  });

  // Al entrar se engancha a la corrida más reciente, para que la pantalla no
  // arranque vacía si ya hay algo pasando. Y si la que estaba seleccionada dejó
  // de existir —se limpió la lista— se suelta: sin esto quedaba en pantalla una
  // corrida fantasma, con su estado y sus mensajes, que ya no estaba en la base.
  useEffect(() => {
    const lista = runs.data;
    if (!lista) return;

    if (runId && !lista.some((item) => item.id === runId)) {
      setRunId(lista[0]?.id ?? null);
      setScrub(null);
      return;
    }
    if (!runId && lista[0]) setRunId(lista[0].id);
  }, [runs.data, runId]);

  const { events: liveEvents, connected } = useRunStream(runId);

  // Al retroceder en el timeline se lee la traza completa de la base: el stream
  // solo retiene una ventana, y el replay tiene que poder ir al principio.
  const history = useQuery({
    queryKey: ["run-events", runId],
    queryFn: () => api.runEvents(runId!),
    enabled: runId != null && scrub != null,
  });

  const events: TraceEvent[] = scrub != null && history.data ? history.data : liveEvents;
  const cut = scrub ?? events.length;
  const state = useMemo(() => derive(events, cut), [events, cut]);

  const bundle = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: runId != null,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  });

  // Las aristas activas se recalculan con el reloj, no solo con eventos nuevos:
  // el destello tiene que apagarse solo aunque no llegue nada más.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClock((value) => value + 1), 700);
    return () => clearInterval(timer);
  }, []);

  const activeEdges = useMemo(() => {
    const map = new Map<string, string>();
    if (scrub != null) {
      // Congelado: se resaltan los mensajes del corte actual, no los "recientes".
      const lastTick = state.flows.at(-1)?.tick;
      for (const flow of state.flows) {
        if (flow.tick === lastTick && flow.from && flow.to) {
          map.set(`${flow.from}->${flow.to}`, flow.type);
        }
      }
      return map;
    }
    const active = recentFlows(state.flows);
    for (const flow of state.flows) {
      const key = flow.from && flow.to ? `${flow.from}->${flow.to}` : null;
      if (key && active.has(key)) map.set(key, flow.type);
    }
    return map;
  }, [state.flows, scrub, clock]);

  const inboxCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const message of bundle.data?.messages ?? []) {
      if (message.status === "pending" && message.toRoleId) {
        counts.set(message.toRoleId, (counts.get(message.toRoleId) ?? 0) + 1);
      }
    }
    return counts;
  }, [bundle.data?.messages]);

  const run = bundle.data?.run;
  const pendingApprovals = (bundle.data?.approvals ?? []).filter((a) => a.status === "pending");

  const control = useMutation({
    mutationFn: async (action: "tick" | "resume" | "pause" | "stop") => {
      if (!runId) return;
      if (action === "tick") return api.tick(runId);
      if (action === "resume") return api.resume(runId);
      if (action === "pause") return api.pause(runId);
      return api.stop(runId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["runs", company.company.id] });
    },
  });

  /** Corridas que ya no van a avanzar: son las que se pueden limpiar. */
  const terminadas = (runs.data ?? []).filter(
    (item) => !["running", "idle", "paused"].includes(item.status),
  ).length;

  const trasBorrar = (): void => {
    setRunId(null);
    setScrub(null);
    // Se descarta lo cacheado de la corrida borrada, no solo la lista: si no,
    // sus mensajes y su estado siguen dibujados hasta el próximo refetch.
    queryClient.removeQueries({ queryKey: ["run"] });
    queryClient.removeQueries({ queryKey: ["run-events"] });
    void queryClient.invalidateQueries({ queryKey: ["runs", company.company.id] });
  };

  const borrarCorrida = useMutation({
    mutationFn: () => api.deleteRun(runId!),
    onSuccess: trasBorrar,
  });

  const limpiarTerminadas = useMutation({
    mutationFn: () => api.limpiarCorridas(company.company.id),
    onSuccess: trasBorrar,
  });

  // `nuevoEncargo` fuerza el formulario aunque ya existan corridas. Sin esto
  // sólo se podía arrancar la empresa la primera vez: después el selector
  // listaba las corridas viejas y no había forma de darle un encargo nuevo.
  if (!runId || nuevoEncargo) {
    return (
      <StartRun
        company={company}
        onStarted={(id) => {
          setNuevoEncargo(false);
          setRunId(id);
        }}
        onCancel={runId ? () => setNuevoEncargo(false) : undefined}
      />
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_360px] gap-2 p-2">
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr_auto] gap-2">
        {/* Controles y motivo de detención van juntos en una sola fila: si el
            banner fuera un hijo aparte, aparecer haría correr al organigrama a
            una fila `auto` y lo colapsaría a cero de alto. */}
        <div className="space-y-2">
        {/* Controles y estado de la corrida */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <select
            value={runId}
            onChange={(event) => {
              setRunId(event.target.value);
              setScrub(null);
            }}
            className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink"
          >
            {(runs.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.startedAt).toLocaleString()} — {item.objective.slice(0, 40)}
              </option>
            ))}
          </select>

          <Button variant="ghost" onClick={() => setNuevoEncargo(true)}>
            + encargo
          </Button>

          {run && <Status value={run.status} />}
          <span className="text-xs text-ink-dim">ciclo {state.tick}</span>
          <span
            className={`text-xs ${state.totalCostUsd / (state.budgetUsd || 1) > 0.8 ? "text-warn" : "text-ink-dim"}`}
          >
            {money(state.totalCostUsd)} / {money(run?.budgetUsd ?? 0)}
          </span>
          <span
            className="text-xs text-ink-dim"
            title={
              `${state.inputTokens.toLocaleString("es-AR")} tokens de entrada · ` +
              `${state.outputTokens.toLocaleString("es-AR")} de salida · ` +
              `${state.cachedInputTokens.toLocaleString("es-AR")} servidos desde caché`
            }
          >
            ↓{tokens(state.inputTokens)} ↑{tokens(state.outputTokens)}
            {state.inputTokens > 0 && (
              // El caché es lo que decide la factura: sin él cada iteración
              // vuelve a pagar todo el contexto.
              <span className={porcentajeCache(state) >= 50 ? " text-ok" : " text-warn"}>
                {" "}
                ⚡{porcentajeCache(state)}%
              </span>
            )}
          </span>
          <span className={`text-xs ${connected ? "text-ok" : "text-ink-faint"}`}>
            {connected ? "● en vivo" : "○ desconectado"}
          </span>

          <Controles
            estado={run?.status}
            pendiente={control.isPending}
            onAccion={(accion) => control.mutate(accion)}
            onBorrar={() => borrarCorrida.mutate()}
            onLimpiar={() => limpiarTerminadas.mutate()}
            limpiando={limpiarTerminadas.isPending || borrarCorrida.isPending}
            terminadas={terminadas}
          />
        </div>

        {run?.stopReason && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            {run.stopReason}
          </div>
        )}
        </div>

        {/* React Flow necesita un contenedor con alto definido: el body del
            Panel lo obtiene de flex, pero el hijo hay que estirarlo o el grafo
            mide 0 en el primer render. */}
        <Panel className="min-h-0">
          <div className="h-full w-full">
          <OrgGraph
            roles={company.roles}
            departments={company.departments}
            state={state}
            activeEdges={activeEdges}
            inboxCounts={inboxCounts}
            selectedRoleId={selectedRoleId}
            onSelect={setSelectedRoleId}
          />
          </div>
        </Panel>

        <Timeline
          events={events}
          cut={cut}
          scrubbing={scrub != null}
          onScrub={setScrub}
          onLive={() => setScrub(null)}
        />
      </div>

      <div className="grid min-h-0 min-w-0 grid-rows-[1fr_1fr] gap-2">
        {selectedRoleId ? (
          <RoleDetail
            roleId={selectedRoleId}
            company={company}
            state={state}
            events={events.slice(0, cut)}
            onClose={() => setSelectedRoleId(null)}
          />
        ) : (
          <Activity events={events.slice(0, cut)} company={company} />
        )}

        <Sidebar
          company={company}
          bundle={bundle.data}
          runId={runId}
          pendingApprovals={pendingApprovals}
          onResolved={() => void queryClient.invalidateQueries({ queryKey: ["run", runId] })}
        />
      </div>
    </div>
  );
}

// --- Arranque de una corrida ------------------------------------------------

function StartRun({
  company,
  onStarted,
  onCancel,
}: {
  company: CompanyBundle;
  onStarted: (runId: string) => void;
  /** Sólo cuando ya hay corridas: permite volver sin arrancar otra. */
  onCancel?: () => void;
}) {
  const [objective, setObjective] = useState(
    "Prepará la propuesta comercial para un cliente del sector retail que quiere modernizar su sistema de inventario.",
  );
  const [budget, setBudget] = useState(company.company.budgetUsd);
  const [mode, setMode] = useState<"manual" | "continuous">("manual");

  const start = useMutation({
    mutationFn: () =>
      api.createRun({ companyId: company.company.id, objective, mode, budgetUsd: budget }),
    onSuccess: (run) => onStarted(run.id),
  });

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Panel title="Dar un encargo a la empresa" className="w-full max-w-2xl">
        <div className="space-y-4 p-4">
          <Field
            label="Objetivo"
            hint="Entra como un mensaje al rol de mayor autoridad, que lo descompone y delega."
          >
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={4}
              className={inputClass}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Tope de gasto (USD)" hint="La corrida se detiene sola al alcanzarlo.">
              <input
                type="number"
                step="0.25"
                min="0.05"
                value={budget}
                onChange={(event) => setBudget(Number(event.target.value))}
                className={inputClass}
              />
            </Field>
            <Field label="Modo" hint="Manual deja ver ciclo por ciclo.">
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as "manual" | "continuous")}
                className={inputClass}
              >
                <option value="manual">Manual — un ciclo por click</option>
                <option value="continuous">Continuo — hasta terminar</option>
              </select>
            </Field>
          </div>

          {start.error && (
            <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {start.error.message}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Arrancando…" : "Arrancar la empresa"}
            </Button>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                volver a la corrida
              </Button>
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}

// --- Timeline ----------------------------------------------------------------

function Timeline({
  events,
  cut,
  scrubbing,
  onScrub,
  onLive,
}: {
  events: TraceEvent[];
  cut: number;
  scrubbing: boolean;
  onScrub: (index: number) => void;
  onLive: () => void;
}) {
  const current = events[Math.max(0, cut - 1)];
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
      <Button variant={scrubbing ? "default" : "primary"} onClick={onLive}>
        {scrubbing ? "volver al vivo" : "● en vivo"}
      </Button>
      <input
        type="range"
        min={0}
        max={Math.max(1, events.length)}
        value={cut}
        onChange={(event) => onScrub(Number(event.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded bg-line accent-accent"
      />
      <span className="w-40 shrink-0 truncate text-right font-mono text-[11px] text-ink-faint">
        {cut}/{events.length} · {current ? `ciclo ${current.tick} · ${current.type}` : "—"}
      </span>
    </div>
  );
}

// --- Feed de actividad -------------------------------------------------------

function Activity({ events, company }: { events: TraceEvent[]; company: CompanyBundle }) {
  const nameOf = (id: string | null): string =>
    company.roles.find((role) => role.id === id)?.name ?? (id ? "?" : "persona");

  const rows = events.slice(-200).reverse();

  return (
    <Panel title="Actividad">
      {rows.length === 0 ? (
        <Empty>Todavía no pasó nada. Ejecutá un ciclo para ver a la empresa trabajar.</Empty>
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((event) => (
            <li key={event.id} className="px-3 py-1.5 text-xs">
              {renderEvent(event, nameOf)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function renderEvent(event: TraceEvent, nameOf: (id: string | null) => string) {
  const tick = <span className="mr-2 font-mono text-[10px] text-ink-faint">c{event.tick}</span>;

  switch (event.type) {
    case "agent.thinking":
      return (
        <div>
          {tick}
          <span className="text-accent">{nameOf(event.roleId)}</span>
          <span className="text-ink-dim"> piensa · </span>
          <span className="font-mono text-[10px] text-ink-faint">
            {event.modelSlug.split("/").pop()}
          </span>
        </div>
      );
    case "agent.message":
      return (
        <div>
          {tick}
          <span style={{ color: MESSAGE_COLOR[event.messageType] }}>
            {MESSAGE_LABEL[event.messageType] ?? event.messageType}
          </span>
          <span className="text-ink-dim">
            {" "}
            {nameOf(event.fromRoleId)} → {nameOf(event.toRoleId)}
          </span>
          <div className="mt-0.5 truncate pl-6 text-ink-faint">{event.subject}</div>
        </div>
      );
    case "tool.start":
      return (
        <div>
          {tick}
          <span className="text-ink-dim">{nameOf(event.roleId)} ejecuta </span>
          <span className="font-mono text-[11px] text-warn">{event.toolName}</span>
        </div>
      );
    case "tool.end":
      return (
        <div>
          {tick}
          <span className={event.ok ? "text-ok" : "text-danger"}>{event.ok ? "✓" : "✗"}</span>
          <span className="ml-1 font-mono text-[11px] text-ink-dim">{event.toolName}</span>
          <span className="ml-1 text-[10px] text-ink-faint">{event.durationMs}ms</span>
          <div className="mt-0.5 truncate pl-6 text-ink-faint">{event.error ?? event.preview}</div>
        </div>
      );
    case "tool.selection":
      return (
        <div title={event.reason}>
          {tick}
          <span className="text-ink-dim">
            {nameOf(event.roleId)} · {event.exposed.length} de {event.candidates.length} herramientas
          </span>
          <div className="mt-0.5 truncate pl-6 text-[10px] text-ink-faint">{event.reason}</div>
        </div>
      );
    case "artifact.created":
      return (
        <div>
          {tick}
          <span className="text-ok">📄 entregable </span>
          <span className="text-ink">{event.title}</span>
          <span className="text-ink-faint"> v{event.version}</span>
        </div>
      );
    case "task.changed":
      return (
        <div>
          {tick}
          <span className="text-ink-dim">{event.created ? "nueva tarea" : "tarea"} · </span>
          <span className="text-ink">{event.title}</span>
          <span className="text-ink-faint"> → {event.status}</span>
        </div>
      );
    case "approval.changed":
      return (
        <div>
          {tick}
          <span className="text-approval">aprobación {event.status}</span>
          <div className="mt-0.5 truncate pl-6 text-ink-faint">{event.reason}</div>
        </div>
      );
    case "run.status":
      return (
        <div>
          {tick}
          <span className="text-ink">corrida → {event.status}</span>
          {event.reason && <div className="pl-6 text-ink-faint">{event.reason}</div>}
        </div>
      );
    case "tick.start":
      return (
        <div className="text-ink-faint">
          {tick}
          <span>── ciclo {event.tick} · {event.activeRoleIds.length} agentes activos ──</span>
        </div>
      );
    case "log":
      return (
        <div className={event.level === "error" ? "text-danger" : "text-warn"}>
          {tick}
          {event.message}
        </div>
      );
    default:
      return (
        <div className="text-ink-faint">
          {tick}
          {event.type}
        </div>
      );
  }
}

// --- Detalle de un agente ----------------------------------------------------

function RoleDetail({
  roleId,
  company,
  state,
  events,
  onClose,
}: {
  roleId: string;
  company: CompanyBundle;
  state: ReturnType<typeof derive>;
  events: TraceEvent[];
  onClose: () => void;
}) {
  const role = company.roles.find((candidate) => candidate.id === roleId);
  const activity = state.roles.get(roleId);
  const selection = state.toolSelections.get(roleId);
  const own = events.filter((event) => "roleId" in event && event.roleId === roleId).slice(-60);

  if (!role) return <Panel title="Agente">{<Empty>Rol no encontrado.</Empty>}</Panel>;

  return (
    <Panel
      title={role.name}
      actions={
        <Button variant="ghost" onClick={onClose}>
          cerrar
        </Button>
      }
    >
      <div className="space-y-3 p-3 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-dim">
          <span>{role.title}</span>
          <span>autoridad: {role.authority}</span>
          <span>turnos: {activity?.turns ?? 0}</span>
          <span>gasto: {money(activity?.costUsd ?? 0)}</span>
          <span
            title={`${(activity?.inputTokens ?? 0).toLocaleString("es-AR")} tokens de entrada · ${(activity?.outputTokens ?? 0).toLocaleString("es-AR")} de salida`}
          >
            tokens: ↓{tokens(activity?.inputTokens ?? 0)} ↑{tokens(activity?.outputTokens ?? 0)}
            {(activity?.inputTokens ?? 0) > 0 &&
              ` · caché ${Math.round((100 * (activity?.cachedInputTokens ?? 0)) / (activity?.inputTokens ?? 1))}%`}
          </span>
        </div>

        {selection && (
          <div className="rounded border border-line bg-canvas p-2">
            <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
              Herramientas a mano
            </div>
            <p className="mb-1.5 text-[11px] text-ink-faint">{selection.reason}</p>
            <div className="flex flex-wrap gap-1">
              {selection.exposed.map((tool) => (
                <span
                  key={tool}
                  className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                >
                  {tool.replace(/^mcp__/, "")}
                </span>
              ))}
            </div>
          </div>
        )}

        {activity?.lastSummary && (
          <div className="rounded border border-line bg-canvas p-2">
            <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
              Último razonamiento
            </div>
            <p className="whitespace-pre-wrap text-[11px] text-ink-dim">{activity.lastSummary}</p>
          </div>
        )}

        <div>
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
            Su traza
          </div>
          <ul className="space-y-1">
            {own.reverse().map((event) => (
              <li key={event.id} className="text-[11px]">
                {renderEvent(event, (id) => company.roles.find((r) => r.id === id)?.name ?? "?")}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

// --- Barra lateral: mensajería, tareas, entregables, aprobaciones -------------

type Tab = "mensajes" | "tareas" | "entregables" | "aprobaciones";

function Sidebar({
  company,
  bundle,
  runId,
  pendingApprovals,
  onResolved,
}: {
  company: CompanyBundle;
  bundle: import("../api.js").RunBundle | undefined;
  runId: string;
  pendingApprovals: import("@orq/shared").ApprovalRequest[];
  onResolved: () => void;
}) {
  const [tab, setTab] = useState<Tab>("mensajes");
  const companyId = company.company.id;
  const nameOf = (id: string | null): string =>
    company.roles.find((role) => role.id === id)?.name ?? (id ? "?" : "persona");

  // Documentos ya generados por las habilidades. Se consultan solo cuando la
  // pestaña está abierta: mientras mirás el proceso no hacen falta.
  const exports = useQuery({
    queryKey: ["export-tree", companyId],
    queryFn: () => api.exportTree(companyId),
    enabled: tab === "entregables",
    refetchInterval: tab === "entregables" ? 5000 : false,
    // El árbol se aplana acá: para enlazar una descarga solo importan los
    // archivos, no en qué carpeta quedaron.
    select: (raiz) => aplanar(raiz),
  });

  const resolve = useMutation({
    mutationFn: (input: { id: string; decision: "grant" | "deny" }) =>
      api.resolveApproval(runId, input.id, input.decision, ""),
    onSuccess: onResolved,
  });

  const tabs: Tab[] = ["mensajes", "tareas", "entregables", "aprobaciones"];

  return (
    <Panel
      title={
        <div className="flex gap-1">
          {tabs.map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`rounded px-1.5 py-0.5 text-[11px] ${
                tab === item ? "bg-surface-2 text-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {item}
              {item === "aprobaciones" && pendingApprovals.length > 0 && (
                <span className="ml-1 text-approval">({pendingApprovals.length})</span>
              )}
            </button>
          ))}
        </div>
      }
    >
      {tab === "mensajes" &&
        (bundle?.messages.length ? (
          <ul className="divide-y divide-line/60">
            {[...bundle.messages].reverse().map((message) => (
              <li key={message.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline gap-1.5">
                  <span style={{ color: MESSAGE_COLOR[message.type] }} className="text-[10px]">
                    {MESSAGE_LABEL[message.type] ?? message.type}
                  </span>
                  <span className="text-ink-dim">
                    {nameOf(message.fromRoleId)} → {nameOf(message.toRoleId)}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">
                    c{message.tick}
                  </span>
                </div>
                {message.subject && <div className="mt-0.5 text-ink">{message.subject}</div>}
                <p className="mt-0.5 line-clamp-3 text-[11px] whitespace-pre-wrap text-ink-faint">
                  {message.body}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin mensajes todavía.</Empty>
        ))}

      {tab === "tareas" &&
        (bundle?.tasks.length ? (
          <ul className="divide-y divide-line/60">
            {bundle.tasks.map((task) => (
              <li key={task.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink">{task.title}</span>
                  <Status value={task.status === "done" ? "completed" : task.status} />
                </div>
                <div className="mt-0.5 text-[11px] text-ink-faint">
                  {nameOf(task.assigneeRoleId)} · {task.priority}
                </div>
                {task.result && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-ink-dim">{task.result}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin tareas todavía.</Empty>
        ))}

      {tab === "entregables" &&
        (bundle?.artifacts.length ? (
          <ul className="divide-y divide-line/60">
            {[...bundle.artifacts].reverse().map((artifact) => (
              <li key={artifact.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink">{artifact.title}</span>
                  <span className="font-mono text-[10px] text-ink-faint">v{artifact.version}</span>
                </div>
                <div className="text-[11px] text-ink-faint">
                  {artifact.key} · {nameOf(artifact.authorRoleId)}
                </div>
                <Descargas
                  companyId={companyId}
                  artifact={artifact}
                  esUltima={
                    artifact.version ===
                    Math.max(
                      ...(bundle?.artifacts ?? [])
                        .filter((otro) => otro.key === artifact.key)
                        .map((otro) => otro.version),
                    )
                  }
                  exports={exports}
                />
                <details className="mt-1">
                  <summary className="cursor-pointer text-[11px] text-accent">ver contenido</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-canvas p-2 text-[10px] whitespace-pre-wrap text-ink-dim">
                    {artifact.content}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin entregables todavía.</Empty>
        ))}

      {tab === "aprobaciones" &&
        (bundle?.approvals.length ? (
          <ul className="divide-y divide-line/60">
            {[...bundle.approvals].reverse().map((approval) => (
              <li key={approval.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-dim">{nameOf(approval.requestedByRoleId)}</span>
                  <Status value={approval.status === "granted" ? "completed" : approval.status} />
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">{approval.reason}</p>
                {approval.status === "pending" && (
                  <div className="mt-1.5 flex gap-1.5">
                    <Button
                      variant="primary"
                      onClick={() => resolve.mutate({ id: approval.id, decision: "grant" })}
                    >
                      aprobar
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => resolve.mutate({ id: approval.id, decision: "deny" })}
                    >
                      rechazar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin aprobaciones pendientes.</Empty>
        ))}

      {tab === "mensajes" && bundle && (
        <InjectMessage company={company} runId={runId} onSent={onResolved} />
      )}
    </Panel>
  );
}

/** Canal de la persona hacia cualquier agente, en cualquier momento. */
function InjectMessage({
  company,
  runId,
  onSent,
}: {
  company: CompanyBundle;
  runId: string;
  onSent: () => void;
}) {
  const [roleId, setRoleId] = useState(company.roles[0]?.id ?? "");
  const [body, setBody] = useState("");

  const send = useMutation({
    mutationFn: () => api.inject(runId, roleId, "Mensaje de la persona a cargo", body),
    onSuccess: () => {
      setBody("");
      onSent();
    },
  });

  return (
    <form
      className="sticky bottom-0 flex gap-1.5 border-t border-line bg-surface p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim()) send.mutate();
      }}
    >
      <select
        value={roleId}
        onChange={(event) => setRoleId(event.target.value)}
        className="w-24 shrink-0 rounded border border-line bg-canvas px-1 text-[11px] text-ink"
      >
        {company.roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <input
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Escribile a un agente…"
        className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 text-[11px] text-ink outline-none focus:border-accent"
      />
      <Button type="submit" disabled={!body.trim() || send.isPending}>
        enviar
      </Button>
    </form>
  );
}

export { relativeTime };

/**
 * Enlaces de descarga de un entregable.
 *
 * Solo aparecen los formatos que un agente generó de verdad: ofrecer siempre
 * "Word / PDF" daría enlaces muertos, y el archivo se produce cuando el agente
 * usa la habilidad, no cuando escribe el entregable.
 */
function Descargas({
  companyId,
  artifact,
  esUltima,
  exports,
}: {
  companyId: string;
  artifact: import("@orq/shared").Artifact;
  /** Solo la última versión de una clave muestra las descargas. */
  esUltima: boolean;
  exports: { data?: Array<{ filename: string; path: string; sizeBytes: number }> };
}) {
  // Se buscan por clave, no por versión exacta: el archivo se generó con la
  // versión que existía en ese momento, y atarlo a la fila de esa versión
  // dejaba sin enlace justo a la fila que la gente mira, la más nueva.
  const patron = new RegExp(`^${artifact.key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}-v(\\d+)\\.(\\w+)$`);
  const disponibles = (exports.data ?? [])
    .map((file) => ({ ...file, match: patron.exec(file.filename) }))
    .filter((file) => file.match != null);

  if (!esUltima || disponibles.length === 0) return null;

  const etiqueta = (ext: string): string =>
    ext === "docx" ? "Word" : ext === "pdf" ? "PDF" : ext;

  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {disponibles.map((file) => {
        const version = Number(file.match![1]);
        const desactualizado = version !== artifact.version;
        return (
          <a
            key={file.filename}
            href={api.exportUrl(companyId, file.path)}
            download
            title={
              desactualizado
                ? `Generado desde la v${version}; el entregable ya va por la v${artifact.version}.`
                : undefined
            }
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              desactualizado
                ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
                : "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
            }`}
          >
            ↓ {etiqueta(file.match![2]!)}
            {desactualizado && ` v${version}`} · {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
          </a>
        );
      })}
    </div>
  );
}

/** Archivos del árbol de salida, sin la estructura de carpetas. */
function aplanar(
  nodo: import("../api.js").TreeFolder,
): Array<{ filename: string; path: string; sizeBytes: number }> {
  return nodo.children.flatMap((hijo) =>
    hijo.kind === "folder"
      ? aplanar(hijo)
      : [{ filename: hijo.name, path: hijo.path, sizeBytes: hijo.sizeBytes }],
  );
}

/**
 * Controles de la corrida.
 *
 * Se muestran según el estado, no todos siempre: ofrecer "pausar" sobre una
 * corrida terminada, o "continuo" sobre una que ya está corriendo, obliga a
 * adivinar cuál sirve. Cada botón dice qué hace y su `title` explica cuándo
 * conviene usarlo, que era lo que faltaba.
 */
function Controles({
  estado,
  pendiente,
  onAccion,
  onBorrar,
  onLimpiar,
  limpiando,
  terminadas,
}: {
  estado: string | undefined;
  pendiente: boolean;
  onAccion: (accion: "tick" | "resume" | "pause" | "stop") => void;
  onBorrar: () => void;
  onLimpiar: () => void;
  limpiando: boolean;
  terminadas: number;
}) {
  const [confirmando, setConfirmando] = useState<"una" | "todas" | null>(null);

  const corriendo = estado === "running";
  const detenible = corriendo || estado === "paused" || estado === "idle";
  // Una corrida terminada no vuelve: lo único que queda es leerla o sacarla.
  const finalizada = estado != null && !detenible;

  if (confirmando) {
    const todas = confirmando === "todas";
    return (
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[11px] text-warn">
          {todas
            ? `¿Borrar ${terminadas} corridas terminadas? Los entregables se conservan.`
            : "¿Borrar esta corrida? Los entregables se conservan."}
        </span>
        <Button
          variant="danger"
          onClick={() => {
            (todas ? onLimpiar : onBorrar)();
            setConfirmando(null);
          }}
        >
          sí, borrar
        </Button>
        <Button variant="ghost" onClick={() => setConfirmando(null)}>
          cancelar
        </Button>
      </div>
    );
  }

  return (
    <div className="ml-auto flex flex-wrap items-center gap-1.5">
      {!corriendo && detenible && (
        <>
          <Button
            onClick={() => onAccion("tick")}
            disabled={pendiente}
            title="Avanza un solo ciclo y se detiene. Para mirar paso a paso qué hace cada agente."
          >
            ▶ un ciclo
          </Button>
          <Button
            variant="primary"
            onClick={() => onAccion("resume")}
            title="Sigue ciclo tras ciclo sin parar, hasta terminar el trabajo o agotar el presupuesto."
          >
            ▶▶ seguir sin parar
          </Button>
        </>
      )}

      {corriendo && (
        <>
          <Button
            onClick={() => onAccion("pause")}
            disabled={pendiente}
            title="Frena al terminar el ciclo en curso. Podés retomarla donde quedó."
          >
            ❚❚ pausar
          </Button>
          <Button
            variant="danger"
            onClick={() => onAccion("stop")}
            title="Termina la corrida. No se puede retomar: para eso está pausar."
          >
            ■ terminar
          </Button>
        </>
      )}

      {finalizada && (
        <span className="text-[11px] text-ink-faint">
          terminada · abrí <b>+ encargo</b> para darle trabajo nuevo
        </span>
      )}

      {finalizada && (
        <Button
          variant="ghost"
          onClick={() => setConfirmando("una")}
          disabled={limpiando}
          title="Saca esta corrida de la lista. Los entregables que produjo se conservan."
        >
          borrar
        </Button>
      )}

      {terminadas > 1 && (
        <Button
          variant="ghost"
          onClick={() => setConfirmando("todas")}
          disabled={limpiando}
          title="Saca de la lista todas las corridas terminadas. Los entregables se conservan."
        >
          limpiar {terminadas}
        </Button>
      )}
    </div>
  );
}
