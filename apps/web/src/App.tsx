import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { Empty } from "./lib/ui.js";
import { Board } from "./routes/Board.js";
import { LiveProcess } from "./routes/LiveProcess.js";
import { McpHub } from "./routes/McpHub.js";
import { Proyectos } from "./routes/Proyectos.js";
import { CompanyDesigner, Costs, Providers } from "./routes/Settings.js";
import { Memory } from "./routes/Memory.js";
import { Requests } from "./routes/Requests.js";
import { Output } from "./routes/Output.js";

const TABS = [
  { id: "proyectos", label: "Proyectos" },
  { id: "proceso", label: "Proceso en vivo" },
  { id: "tablero", label: "Tablero" },
  { id: "mcp", label: "MCP Hub" },
  { id: "solicitudes", label: "Solicitudes" },
  { id: "empresa", label: "Empresa" },
  { id: "salida", label: "Salida" },
  { id: "memoria", label: "Memoria" },
  { id: "costos", label: "Costos" },
  { id: "proveedores", label: "Proveedores" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Las pestañas que no dependen de que haya un proyecto elegido.
 *
 * Proyectos es donde se crea el primero, así que exigirle uno sería un callejón
 * sin salida en una instalación nueva; Proveedores es configuración global.
 */
const SIN_PROYECTO = new Set<TabId>(["proyectos", "proveedores"]);

export function App() {
  // Arranca en Proyectos: es la puerta de entrada, y con más de una empresa
  // cargada lo primero que hay que decidir es con cuál se trabaja.
  const [tab, setTab] = useState<TabId>("proyectos");
  const [companyId, setCompanyId] = useState<string | null>(null);

  const companies = useQuery({ queryKey: ["companies"], queryFn: () => api.companies() });
  const activeId = companyId ?? companies.data?.[0]?.id ?? null;

  const company = useQuery({
    queryKey: ["company", activeId],
    queryFn: () => api.company(activeId!),
    enabled: activeId != null,
  });

  const abrirProyecto = (id: string) => {
    setCompanyId(id);
    setTab("empresa");
  };

  /** Al borrar el proyecto activo hay que soltarlo o queda un id muerto. */
  const soltarProyecto = (id: string) => {
    if (companyId === id) setCompanyId(null);
  };

  const contenido = () => {
    if (tab === "proyectos") {
      return <Proyectos activeId={activeId} onAbrir={abrirProyecto} onBorrado={soltarProyecto} />;
    }
    if (tab === "proveedores") return <Providers />;

    if (companies.isLoading) return <Empty>Cargando…</Empty>;
    if (!activeId) {
      return (
        <Empty>
          No hay ningún proyecto. Creá uno desde <b>Proyectos</b>, o ejecutá{" "}
          <code className="mx-1 text-accent">npm run db:seed</code> para traer el de ejemplo.
        </Empty>
      );
    }
    // Un proyecto que se borró desde otra pestaña deja la consulta en error, no
    // cargando: sin distinguirlas, la pantalla decía "Cargando…" para siempre.
    if (company.isError) {
      return (
        <Empty>
          Ese proyecto ya no existe. Elegí otro en <b>Proyectos</b>.
        </Empty>
      );
    }
    if (company.isLoading || !company.data) return <Empty>Cargando el proyecto…</Empty>;

    const datos = company.data;
    switch (tab) {
      case "proceso":
        return <LiveProcess key={activeId} company={datos} />;
      case "tablero":
        return <Board key={activeId} company={datos} />;
      case "mcp":
        return <McpHub key={activeId} company={datos} />;
      case "solicitudes":
        return <Requests key={activeId} company={datos} />;
      case "empresa":
        return (
          <CompanyDesigner
            key={activeId}
            company={datos}
            // Al borrarla hay que soltar la selección: `activeId` seguiría
            // apuntando a un proyecto que ya no existe.
            onCompanyGone={() => setCompanyId(null)}
          />
        );
      case "salida":
        return <Output company={datos} />;
      case "memoria":
        return <Memory key={activeId} company={datos} />;
      case "costos":
        return <Costs key={activeId} company={datos} />;
    }
  };

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">Orquestador Agéntico</span>
          <span className="text-[11px] text-ink-faint">empresa simulada</span>
        </div>

        <nav className="flex gap-1">
          {TABS.map((item) => {
            const bloqueada = !SIN_PROYECTO.has(item.id) && !activeId;
            return (
              <button
                key={item.id}
                disabled={bloqueada}
                title={bloqueada ? "Elegí o creá un proyecto primero." : undefined}
                onClick={() => setTab(item.id)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                  tab === item.id
                    ? "bg-accent/15 text-accent"
                    : "text-ink-dim hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* El selector queda para alternar rápido entre dos proyectos sin volver
            a la pantalla; la gestión (crear, borrar, ver el estado) vive allá. */}
        <div className="ml-auto">
          <select
            value={activeId ?? ""}
            disabled={(companies.data ?? []).length === 0}
            onChange={(event) => setCompanyId(event.target.value)}
            className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink disabled:opacity-40"
          >
            {(companies.data ?? []).length === 0 && <option value="">sin proyectos</option>}
            {(companies.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="min-h-0">{contenido()}</main>
    </div>
  );
}
