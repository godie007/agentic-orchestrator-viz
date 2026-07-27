import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
        {cut}/{events.length} · {current ? `ciclo ${current.tick} · ${enCriollo(current)}` : "—"}
      </span>
    </div>
  );
}

/**
 * Un evento dicho en una palabra, para la etiqueta del timeline.
 *
 * Ahí salía el `type` crudo —"run.status", "tool.end", "cost.updated"—, que es
 * el nombre que le pusimos nosotros al evento y no algo que se pueda leer.
 */
function enCriollo(event: TraceEvent): string {
  switch (event.type) {
    case "run.status":
      return `la corrida ${ESTADO_CORRIDA[event.status] ?? event.status}`;
    case "tick.start":
      return "arranca el ciclo";
    case "tick.end":
      return "termina el ciclo";
    case "agent.thinking":
      return "un agente piensa";
    case "agent.turn_end":
      return "un agente cierra su turno";
    case "agent.message":
      return `mensaje: ${MESSAGE_LABEL[event.messageType] ?? event.messageType}`;
    case "tool.selection":
      return "se eligen herramientas";
    case "tool.start":
      return `ejecuta ${event.toolName.replace(/^mcp__/, "")}`;
    case "tool.end":
      return `${event.ok ? "terminó" : "falló"} ${event.toolName.replace(/^mcp__/, "")}`;
    case "mcp.status":
      return `servidor ${event.serverName} ${ESTADO_MCP[event.status] ?? event.status}`;
    case "task.changed":
      return "cambia una tarea";
    case "artifact.created":
      return "hay un entregable nuevo";
    case "request.created":
      return "un agente pide algo";
    case "approval.changed":
      return `aprobación ${ESTADO_APROBACION[event.status] ?? event.status}`;
    case "cost.updated":
      return "se registra el gasto";
    case "log":
      return event.level === "error" ? "un error" : "un aviso";
  }
}

// --- Feed de actividad -------------------------------------------------------

/**
 * Qué está haciendo la empresa, con la misma forma que la traza de un agente.
 *
 * Antes era un volcado: cada evento, un renglón, con su nombre técnico cuando
 * no había nada lindo que mostrar. En pantalla se leía "tick.end",
 * "cost.updated", "agent.turn_end" —tres de cada cinco renglones sin una sola
 * palabra para una persona—, y una llamada a herramienta pesaba lo mismo que
 * el final de la corrida.
 *
 * Ahora es la misma cronología del panel del agente: por ciclo, en orden, con
 * las herramientas colgadas de quien las usó. Que las dos pantallas se lean
 * igual es la mitad de que se entiendan.
 */
function Activity({ events, company }: { events: TraceEvent[]; company: CompanyBundle }) {
  const nameOf = useCallback(
    (id: string | null): string =>
      company.roles.find((role) => role.id === id)?.name ?? (id ? "?" : "la persona"),
    [company.roles],
  );

  // Se dibuja una ventana del final: la traza completa de una corrida larga son
  // miles de eventos y el panel no tiene por qué sostenerlos todos en el DOM.
  const ventana = useMemo(() => events.slice(-400), [events]);

  return (
    <Panel title="Actividad">
      <div className="flex h-full min-h-0 flex-col p-2">
        <Cronologia
          events={ventana}
          nameOf={nameOf}
          conAutor
          titulo="Lo que viene pasando"
          vacio="Todavía no pasó nada. Ejecutá un ciclo para ver a la empresa trabajar."
        />
      </div>
    </Panel>
  );
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
  const own = events.filter((event) => "roleId" in event && event.roleId === roleId).slice(-120);
  const nombreDeRol = useCallback(
    (id: string | null): string => company.roles.find((r) => r.id === id)?.name ?? "?",
    [company.roles],
  );

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
      {/* Tres bloques con un orden fijo: quién es, con qué cuenta, y qué hizo.
          Lo de arriba ocupa lo que necesita; la cronología se queda con el
          resto y hace su propio scroll. Antes los 22 chips de herramientas
          empujaban la traza fuera de la pantalla y había que scrollear el panel
          entero para ver el último paso, que es lo que uno viene a mirar. */}
      <div className="flex h-full min-h-0 flex-col gap-3 p-3 text-xs">
        <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {[
            { rotulo: "cargo", valor: role.title },
            { rotulo: "autoridad", valor: role.authority },
            { rotulo: "turnos", valor: String(activity?.turns ?? 0) },
            { rotulo: "gasto", valor: money(activity?.costUsd ?? 0) },
          ].map((dato) => (
            <div key={dato.rotulo} className="min-w-0">
              <dt className="text-[9px] tracking-wide text-ink-faint uppercase">{dato.rotulo}</dt>
              <dd className="truncate text-[11px] text-ink">{dato.valor}</dd>
            </div>
          ))}
          <div className="col-span-2 min-w-0 sm:col-span-4">
            <dt className="text-[9px] tracking-wide text-ink-faint uppercase">tokens</dt>
            <dd
              className="truncate text-[11px] text-ink"
              title={`${(activity?.inputTokens ?? 0).toLocaleString("es-AR")} de entrada · ${(activity?.outputTokens ?? 0).toLocaleString("es-AR")} de salida`}
            >
              ↓{tokens(activity?.inputTokens ?? 0)} ↑{tokens(activity?.outputTokens ?? 0)}
              {(activity?.inputTokens ?? 0) > 0 && (
                <span className="ml-1.5 text-ink-dim">
                  caché{" "}
                  {Math.round(
                    (100 * (activity?.cachedInputTokens ?? 0)) / (activity?.inputTokens ?? 1),
                  )}
                  %
                </span>
              )}
            </dd>
          </div>
        </dl>

        {selection && (
          // Plegado por defecto: son 22 nombres de herramienta y no es lo que
          // se viene a mirar, pero cuando algo sale raro es lo primero que
          // explica por qué el agente no usó la que correspondía.
          <details className="shrink-0 rounded border border-line bg-canvas">
            <summary className="cursor-pointer list-none px-2 py-1.5 text-[10px] font-semibold tracking-wide text-ink-dim uppercase hover:text-ink">
              Herramientas a mano
              <span className="ml-1.5 font-mono normal-case text-ink-faint">
                {selection.exposed.length} de {selection.candidates.length}
              </span>
            </summary>
            <div className="border-t border-line/60 px-2 py-1.5">
              <p className="mb-1.5 text-[11px] leading-4 text-ink-faint">{selection.reason}</p>
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
          </details>
        )}

        {activity?.lastSummary && (
          <div className="shrink-0 rounded border border-line bg-canvas p-2">
            <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
              Último razonamiento
            </div>
            <p className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-4 text-ink-dim">
              {activity.lastSummary}
            </p>
          </div>
        )}

        <Cronologia events={own} nameOf={nombreDeRol} titulo="Su cronología" vacio="Todavía no hizo nada en esta corrida." />
      </div>
    </Panel>
  );
}

// --- La traza, en un solo lenguaje -------------------------------------------

/**
 * Una fila de la traza, ya resuelta a lo que se dibuja.
 *
 * `nivel` es lo que hace legible el conjunto: no todo lo que pasa está al
 * mismo nivel. Que termine la corrida y que un agente haya leído un archivo
 * son cosas de escala distinta, y mostrarlas con el mismo peso obliga a leer
 * cada renglón para saber si importa.
 *
 *   0 — la corrida: arranca, se detiene, se traba esperando una aprobación.
 *   1 — lo que hace un agente: piensa, escribe, entrega, escala.
 *   2 — con qué lo hizo: cada llamada a herramienta, colgada del agente.
 */
interface Fila {
  id: string;
  at: number;
  nivel: 0 | 1 | 2;
  /** Color del punto en el riel. */
  punto: string;
  titulo: ReactNode;
  detalle?: string | null;
  /** Una herramienta que arrancó y todavía no terminó. */
  enCurso?: boolean;
}

/** Un ciclo con lo que pasó adentro y su resumen. */
interface Ciclo {
  tick: number;
  agentes: number | null;
  mensajes: number | null;
  costoUsd: number | null;
  filas: Fila[];
}

/**
 * Arma la traza como una línea de tiempo legible.
 *
 * Tres decisiones que cambian todo respecto de volcar los eventos crudos:
 *
 * 1. **Va en orden, de lo viejo a lo nuevo.** Antes se mostraba al revés y
 *    seguir lo que hizo la empresa obligaba a leer hacia atrás, que es justo
 *    como no se entiende una secuencia de trabajo.
 * 2. **Una llamada a herramienta es una fila, no dos.** `tool.start` y
 *    `tool.end` son el mismo hecho: mostrarlos separados duplicaba la lista y
 *    escondía el resultado —lo único que importa— dos renglones más abajo.
 *    Mientras la llamada no termina, la fila queda latiendo.
 * 3. **Lo que es contabilidad no es una fila.** `cost.updated`, `tick.end` y
 *    `agent.turn_end` salían impresos con su nombre técnico y sin nada que
 *    leer —"tick.end", "cost.updated"—: ocupaban la mitad del panel para no
 *    decir nada. El costo ya está en la cabecera, y lo que aportaban los otros
 *    dos pasó al encabezado de su ciclo.
 */
function armarCronologia(
  events: TraceEvent[],
  nameOf: (id: string | null) => string,
  opciones: { conAutor: boolean },
): Ciclo[] {
  const ciclos = new Map<number, Ciclo>();
  const abiertas = new Map<string, Fila>();

  const cicloDe = (tick: number): Ciclo => {
    const existente = ciclos.get(tick);
    if (existente) return existente;
    const nuevo: Ciclo = { tick, agentes: null, mensajes: null, costoUsd: null, filas: [] };
    ciclos.set(tick, nuevo);
    return nuevo;
  };
  const push = (tick: number, fila: Fila) => cicloDe(tick).filas.push(fila);

  /** El nombre del agente, sólo donde no se sobreentiende. */
  const autor = (roleId: string | null): ReactNode =>
    opciones.conAutor ? <span className="text-accent">{nameOf(roleId)} </span> : null;

  /**
   * Quién ejecutó la herramienta.
   *
   * En el panel de un agente sobra: todo lo que se ve es suyo. En el feed
   * general no, y ahí importa: los turnos corren en paralelo, así que dos
   * agentes intercalan sus llamadas dentro del mismo ciclo y la sangría sola
   * hacía parecer que la herramienta colgaba del agente del renglón de arriba,
   * que puede ser otro.
   */
  const herramientaDe = (roleId: string | null): ReactNode =>
    opciones.conAutor ? (
      <span className="shrink-0 text-[10px] text-ink-faint">{nameOf(roleId)}</span>
    ) : null;

  for (const event of events) {
    switch (event.type) {
      case "run.status":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 0,
          punto: event.status === "failed" ? "bg-danger" : "bg-ink",
          titulo: (
            <span className="font-medium text-ink">
              la corrida {ESTADO_CORRIDA[event.status] ?? event.status}
            </span>
          ),
          detalle: event.reason,
        });
        break;

      // Los dos límites del ciclo no son filas: son el encabezado del ciclo.
      case "tick.start":
        cicloDe(event.tick).agentes = event.activeRoleIds.length;
        break;
      case "tick.end": {
        const ciclo = cicloDe(event.tick);
        ciclo.mensajes = event.messagesEmitted;
        ciclo.costoUsd = event.costUsd;
        break;
      }

      case "agent.thinking":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: "bg-accent",
          titulo: (
            <span className="text-ink-dim">
              {autor(event.roleId)}
              piensa
              <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                vuelta {event.iteration} · {event.modelSlug.split("/").pop()}
              </span>
            </span>
          ),
        });
        break;

      case "tool.start": {
        const fila: Fila = {
          id: event.id,
          at: event.at,
          nivel: 2,
          punto: "bg-warn",
          enCurso: true,
          titulo: (
            <span className="flex items-baseline gap-1.5">
              {herramientaDe(event.roleId)}
              <span className="truncate font-mono text-[11px] text-ink-dim">
                {event.toolName.replace(/^mcp__/, "")}
              </span>
            </span>
          ),
        };
        abiertas.set(event.callId, fila);
        push(event.tick, fila);
        break;
      }

      case "tool.end": {
        // Se completa la fila que abrió su `tool.start`. Si no aparece —la
        // traza puede venir recortada— se agrega sola, para no perder el
        // resultado.
        const fila = abiertas.get(event.callId);
        const cuerpo = {
          punto: event.ok ? "bg-ok" : "bg-danger",
          enCurso: false,
          detalle: event.error ?? event.preview,
          titulo: (
            <span className="flex items-baseline gap-1.5">
              {herramientaDe(event.roleId)}
              <span
                className={`truncate font-mono text-[11px] ${event.ok ? "text-ink-dim" : "text-danger"}`}
              >
                {event.toolName.replace(/^mcp__/, "")}
              </span>
              <span className="shrink-0 text-[10px] text-ink-faint">{event.durationMs}ms</span>
            </span>
          ),
        };
        if (fila) {
          Object.assign(fila, cuerpo);
          abiertas.delete(event.callId);
        } else {
          push(event.tick, { id: event.id, at: event.at, nivel: 2, ...cuerpo } as Fila);
        }
        break;
      }

      case "agent.message":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: "bg-request",
          titulo: (
            <span>
              <span style={{ color: MESSAGE_COLOR[event.messageType] }}>
                {MESSAGE_LABEL[event.messageType] ?? event.messageType}
              </span>
              <span className="text-ink-dim">
                {" "}
                {opciones.conAutor ? `${nameOf(event.fromRoleId)} → ` : "→ "}
                {nameOf(event.toRoleId)}
              </span>
            </span>
          ),
          detalle: event.subject,
        });
        break;

      case "artifact.created":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: "bg-ok",
          titulo: (
            <span>
              {autor(event.authorRoleId)}
              <span className="text-ok">entregó </span>
              <span className="text-ink">{event.title}</span>{" "}
              <span className="text-ink-faint">v{event.version}</span>
            </span>
          ),
        });
        break;

      case "task.changed":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: "bg-ink-faint",
          titulo: (
            <span className="text-ink-dim">
              {event.created ? "nueva tarea " : "tarea "}
              <span className="text-ink">{event.title}</span>{" "}
              <span className="text-ink-faint">→ {ESTADO_TAREA[event.status] ?? event.status}</span>
            </span>
          ),
        });
        break;

      case "request.created":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: "bg-warn",
          titulo: (
            <span>
              {autor(event.requestedByRoleId)}
              <span className="text-warn">te pide algo</span>
              <span className="ml-1.5 text-[10px] text-ink-faint">{event.summary}</span>
            </span>
          ),
          detalle: event.reason,
        });
        break;

      case "approval.changed":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 0,
          punto: "bg-approval",
          titulo: (
            <span className="text-approval">
              aprobación {ESTADO_APROBACION[event.status] ?? event.status}
              {event.toolName && (
                <span className="ml-1.5 font-mono text-[10px] text-ink-faint">
                  {event.toolName}
                </span>
              )}
            </span>
          ),
          detalle: event.reason,
        });
        break;

      case "mcp.status":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 0,
          punto: event.status === "ready" ? "bg-ok" : "bg-danger",
          titulo: (
            <span className="text-ink-dim">
              servidor <span className="text-ink">{event.serverName}</span>{" "}
              {ESTADO_MCP[event.status] ?? event.status}
            </span>
          ),
          detalle: event.error,
        });
        break;

      case "log":
        push(event.tick, {
          id: event.id,
          at: event.at,
          nivel: 1,
          punto: event.level === "error" ? "bg-danger" : "bg-warn",
          titulo: (
            <span className={event.level === "error" ? "text-danger" : "text-warn"}>
              {event.message}
            </span>
          ),
        });
        break;

      // `agent.turn_end`, `tool.selection` y `cost.updated` no se dibujan: el
      // primero no agrega nada sobre las filas del turno, el segundo vive en el
      // panel del agente —"Herramientas a mano"— y el tercero en la cabecera.
      default:
        break;
    }
  }

  return [...ciclos.values()]
    .sort((a, b) => a.tick - b.tick)
    .map((ciclo) => ({ ...ciclo, filas: ciclo.filas.sort((a, b) => a.at - b.at) }));
}

/** Los estados, dichos como los diría una persona. */
const ESTADO_CORRIDA: Record<string, string> = {
  idle: "está lista para arrancar",
  running: "arrancó",
  paused: "quedó en pausa",
  completed: "terminó",
  stopped: "se detuvo",
  failed: "falló",
  budget_exceeded: "se quedó sin presupuesto",
  awaiting_approval: "espera una aprobación",
};

const ESTADO_TAREA: Record<string, string> = {
  pending: "pendiente",
  in_progress: "en curso",
  done: "terminada",
  blocked: "trabada",
  cancelled: "cancelada",
};

const ESTADO_APROBACION: Record<string, string> = {
  pending: "pendiente",
  granted: "otorgada",
  denied: "denegada",
};

const ESTADO_MCP: Record<string, string> = {
  connecting: "conectando",
  ready: "conectado",
  error: "con problemas",
  reconnecting: "reconectando",
  disabled: "desactivado",
};

const hora = (at: number): string => new Date(at).toLocaleTimeString("es-AR", { hour12: false });

const dinero = (usd: number): string => (usd < 0.01 ? `US$${usd.toFixed(4)}` : `US$${usd.toFixed(3)}`);

/** Sangría y tamaño según el nivel: lo que cuelga de algo se ve que cuelga. */
const SANGRIA: Record<0 | 1 | 2, string> = {
  0: "pl-6",
  1: "pl-6",
  2: "pl-11",
};

function Cronologia({
  events,
  nameOf,
  conAutor = false,
  titulo = "Cronología",
  vacio = "Todavía no pasó nada.",
}: {
  events: TraceEvent[];
  nameOf: (id: string | null) => string;
  conAutor?: boolean;
  titulo?: string;
  vacio?: string;
}) {
  const ciclos = useMemo(
    () => armarCronologia(events, nameOf, { conAutor }),
    [events, nameOf, conAutor],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const pegadoAlFondo = useRef(true);

  // La traza sigue al presente, pero sólo si ya lo estabas mirando. Si
  // scrolleaste para atrás a leer algo, saltar al final en cada evento nuevo
  // —llegan por SSE, varios por segundo— hace imposible leer nada.
  useEffect(() => {
    const caja = scroll.current;
    if (caja && pegadoAlFondo.current) caja.scrollTop = caja.scrollHeight;
  }, [events.length]);

  const conFilas = ciclos.filter((ciclo) => ciclo.filas.length > 0);
  if (conFilas.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1 shrink-0 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
          {titulo}
        </div>
        <p className="text-[11px] text-ink-faint">{vacio}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-baseline justify-between">
        <span className="text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
          {titulo}
        </span>
        <span className="text-[10px] text-ink-faint">de lo primero a lo último</span>
      </div>

      <div
        ref={scroll}
        onScroll={(event) => {
          const caja = event.currentTarget;
          pegadoAlFondo.current = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 40;
        }}
        className="min-h-40 flex-1 overflow-auto rounded border border-line bg-canvas"
      >
        {conFilas.map((ciclo) => (
          <section key={ciclo.tick}>
            {/* El encabezado del ciclo dice de un vistazo qué tan movido fue:
                cuántos trabajaron, cuánto se hablaron y cuánto costó. Eso es lo
                que antes salía como dos renglones ilegibles al final. */}
            <header className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-line/60 bg-canvas/95 px-2 py-1 backdrop-blur">
              <span className="font-mono text-[10px] font-semibold text-ink-dim">
                ciclo {ciclo.tick}
              </span>
              <span className="truncate text-[10px] text-ink-faint">
                {[
                  ciclo.agentes != null &&
                    `${ciclo.agentes} ${ciclo.agentes === 1 ? "agente" : "agentes"}`,
                  ciclo.mensajes != null &&
                    ciclo.mensajes > 0 &&
                    `${ciclo.mensajes} ${ciclo.mensajes === 1 ? "mensaje" : "mensajes"}`,
                  ciclo.costoUsd != null && ciclo.costoUsd > 0 && dinero(ciclo.costoUsd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </header>

            <ol className="relative px-2 py-1.5">
              {/* El riel: una sola línea vertical detrás de todos los puntos. */}
              <span
                aria-hidden
                className="absolute top-0 bottom-0 left-[0.6875rem] w-px bg-line/60"
              />
              {ciclo.filas.map((fila) => (
                <li
                  key={fila.id}
                  className={`fila-traza relative flex gap-2 py-1 ${SANGRIA[fila.nivel]}`}
                >
                  <span
                    className={`absolute top-2 rounded-full ring-2 ring-canvas ${
                      fila.nivel === 2 ? "left-7 size-1.5" : "left-1.5 size-2"
                    } ${fila.punto} ${fila.enCurso ? "punto-en-curso" : ""}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`min-w-0 ${fila.nivel === 0 ? "text-[11.5px]" : "text-[11px]"}`}
                      >
                        {fila.titulo}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                        {hora(fila.at)}
                      </span>
                    </span>
                    {fila.detalle && (
                      <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-ink-faint">
                        {fila.detalle}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
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
