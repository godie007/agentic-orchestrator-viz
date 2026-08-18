import { useQuery } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";
import {
  Activity,
  Brain,
  FolderOutput,
  Inbox,
  KanbanSquare,
  LayoutGrid,
  Network,
  Plug,
  Receipt,
  ServerCog,
  Store,
} from "lucide-react";
import { api, type CompanyBundle } from "./api.js";
import { Empty, Skeleton, BotonDeTema, PulsoDeCorrida, ToastProvider } from "./ui/index.js";
import { Board } from "./routes/Board.js";
import { LiveProcess } from "./routes/LiveProcess.js";
import { McpHub } from "./routes/McpHub.js";
import { Proyectos } from "./routes/Proyectos.js";
import { CompanyDesigner, Costs, Providers } from "./routes/Settings.js";
import { Memory } from "./routes/Memory.js";
import { Requests } from "./routes/Requests.js";
import { Output } from "./routes/Output.js";
import { Tienda } from "./routes/Tienda.js";

/**
 * El shell de la aplicación: header global + sidebar por proyecto, con la
 * selección viviendo en la URL.
 *
 * Antes la navegación era un `useState` con diez pestañas: sin URLs no había
 * forma de mandar un enlace a una corrida, refrescar perdía el lugar, y el
 * back del navegador no hacía nada. `companyId` viaja en `/p/:companyId/…`,
 * así que "qué proyecto está abierto" ya no es estado de React.
 */

const SECCIONES = [
  { path: "proceso", etiqueta: "Proceso", icono: Activity, title: "La corrida en vivo: organigrama animado, timeline y controles." },
  { path: "tablero", etiqueta: "Tablero", icono: KanbanSquare, title: "Las tareas de la corrida como kanban." },
  { path: "empresa", etiqueta: "Empresa", icono: Network, title: "La organización: áreas, agentes y sus herramientas." },
  { path: "solicitudes", etiqueta: "Solicitudes", icono: Inbox, title: "Lo que los agentes te piden: roles, datos, accesos, servidores." },
  { path: "tienda", etiqueta: "Tienda", icono: Store, title: "Catálogo de servidores MCP, instalables en un click." },
  { path: "mcp", etiqueta: "MCP", icono: Plug, title: "Servidores MCP conectados: salud, reconexión y probador." },
  { path: "salida", etiqueta: "Salida", icono: FolderOutput, title: "Los archivos que la empresa produjo." },
  { path: "memoria", etiqueta: "Memoria", icono: Brain, title: "Lo que la empresa aprendió entre corridas." },
  { path: "costos", etiqueta: "Costos", icono: Receipt, title: "Cuánto gastó cada corrida, por agente y por modelo." },
] as const;

export function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Navigate to="/proyectos" replace />} />
            <Route path="/proyectos" element={<ProyectosRuta />} />
            <Route path="/proveedores" element={<Providers />} />
            <Route path="/p/:companyId" element={<ProyectoLayout />}>
              <Route index element={<Navigate to="empresa" replace />} />
              <Route path="proceso" element={<Pantalla render={(c) => <LiveProcess key={c.company.id} company={c} />} />} />
              <Route path="tablero" element={<Pantalla render={(c) => <Board key={c.company.id} company={c} />} />} />
              <Route path="empresa" element={<EmpresaRuta />} />
              <Route path="solicitudes" element={<Pantalla render={(c) => <Requests key={c.company.id} company={c} />} />} />
              <Route path="tienda" element={<Pantalla render={(c) => <Tienda key={c.company.id} company={c} />} />} />
              <Route path="mcp" element={<Pantalla render={(c) => <McpHub key={c.company.id} company={c} />} />} />
              <Route path="salida" element={<Pantalla render={(c) => <Output company={c} />} />} />
              <Route path="memoria" element={<Pantalla render={(c) => <Memory key={c.company.id} company={c} />} />} />
              <Route path="costos" element={<Pantalla render={(c) => <Costs key={c.company.id} company={c} />} />} />
            </Route>
            <Route path="*" element={<Navigate to="/proyectos" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

/** Header global: marca, selector de proyecto y tema. */
function Shell() {
  const navigate = useNavigate();
  const { companyId } = useParams();
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => api.companies() });

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2">
        <NavLink to="/proyectos" className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">Orquestador Agéntico</span>
        </NavLink>

        <nav className="flex gap-1">
          <NavLink
            to="/proyectos"
            className={({ isActive }) =>
              `flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                isActive ? "bg-accent/15 text-accent" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
              }`
            }
          >
            <LayoutGrid className="size-3.5" aria-hidden />
            Proyectos
          </NavLink>
          <NavLink
            to="/proveedores"
            className={({ isActive }) =>
              `flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                isActive ? "bg-accent/15 text-accent" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
              }`
            }
          >
            <ServerCog className="size-3.5" aria-hidden />
            Proveedores
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Cuánto lleva el proyecto trabajando su encargo. Vive en el shell y
              no en la pantalla de proceso porque un encargo dura horas y quien
              lo sigue está en el tablero o en la salida, no mirando la traza. */}
          {companyId && <PulsoDeCorrida companyId={companyId} />}
          {/* Alterna rápido entre proyectos conservando la sección abierta. */}
          <select
            value={companyId ?? ""}
            disabled={(companies.data ?? []).length === 0}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              const seccion = window.location.pathname.split("/")[3] ?? "empresa";
              void navigate(`/p/${id}/${seccion}`);
            }}
            className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink disabled:opacity-40"
          >
            {!companyId && <option value="">elegir proyecto…</option>}
            {(companies.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <BotonDeTema />
        </div>
      </header>

      <main className="min-h-0">
        <Outlet />
      </main>
    </div>
  );
}

/** Sidebar + carga del proyecto activo. Las secciones reciben el bundle por contexto. */
function ProyectoLayout() {
  const { companyId } = useParams();
  const navigate = useNavigate();

  const company = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => api.company(companyId!),
    enabled: companyId != null,
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-[52px_1fr]">
      <aside className="flex flex-col items-center gap-1 border-r border-line bg-surface py-2">
        {SECCIONES.map((seccion) => (
          <NavLink
            key={seccion.path}
            to={seccion.path}
            title={`${seccion.etiqueta} — ${seccion.title}`}
            className={({ isActive }) =>
              `flex w-11 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 transition-colors ${
                isActive ? "bg-accent/15 text-accent" : "text-ink-faint hover:bg-surface-2 hover:text-ink"
              }`
            }
          >
            <seccion.icono className="size-4" aria-hidden />
            <span className="text-[9px] font-medium leading-none">{seccion.etiqueta}</span>
          </NavLink>
        ))}
      </aside>

      <div className="min-h-0 min-w-0">
        {company.isError ? (
          <Empty>
            Ese proyecto ya no existe.{" "}
            <button className="text-accent underline" onClick={() => void navigate("/proyectos")}>
              Volver a Proyectos
            </button>
          </Empty>
        ) : company.isLoading || !company.data ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <Outlet context={company.data} />
        )}
      </div>
    </div>
  );
}

/** Adaptador: toma el bundle del contexto del layout y lo pasa como prop. */
function Pantalla({ render }: { render: (company: CompanyBundle) => React.ReactElement }) {
  const company = useOutletContext<CompanyBundle>();
  return render(company);
}

function EmpresaRuta() {
  const company = useOutletContext<CompanyBundle>();
  const navigate = useNavigate();
  return (
    <CompanyDesigner
      key={company.company.id}
      company={company}
      // Al borrar el proyecto hay que soltar la URL que lo apunta, o la
      // pantalla queda cargando un id muerto para siempre.
      onCompanyGone={() => void navigate("/proyectos")}
    />
  );
}

function ProyectosRuta() {
  const navigate = useNavigate();
  const { companyId } = useParams();
  return (
    <Proyectos
      activeId={companyId ?? null}
      onAbrir={(id) => void navigate(`/p/${id}/empresa`)}
      onBorrado={() => undefined /* la selección vive en la URL: acá no hay nada que soltar */}
    />
  );
}
