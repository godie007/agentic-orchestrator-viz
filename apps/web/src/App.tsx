import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { Empty } from "./lib/ui.js";
import { Board } from "./routes/Board.js";
import { LiveProcess } from "./routes/LiveProcess.js";
import { McpHub } from "./routes/McpHub.js";
import { CompanyDesigner, Costs, Providers } from "./routes/Settings.js";
import { Memory } from "./routes/Memory.js";
import { Requests } from "./routes/Requests.js";
import { Output } from "./routes/Output.js";

const TABS = [
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

export function App() {
  const [tab, setTab] = useState<TabId>("proceso");
  const [companyId, setCompanyId] = useState<string | null>(null);

  const companies = useQuery({ queryKey: ["companies"], queryFn: () => api.companies() });
  const activeId = companyId ?? companies.data?.[0]?.id ?? null;

  const company = useQuery({
    queryKey: ["company", activeId],
    queryFn: () => api.company(activeId!),
    enabled: activeId != null,
  });

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">Orquestador Agéntico</span>
          <span className="text-[11px] text-ink-faint">empresa simulada</span>
        </div>

        <nav className="flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === item.id
                  ? "bg-accent/15 text-accent"
                  : "text-ink-dim hover:bg-surface-2 hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto">
          <select
            value={activeId ?? ""}
            onChange={(event) => setCompanyId(event.target.value)}
            className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink"
          >
            {(companies.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="min-h-0">
        {companies.isLoading ? (
          <Empty>Cargando…</Empty>
        ) : !activeId ? (
          <Empty>
            No hay ninguna empresa. Ejecutá <code className="mx-1 text-accent">npm run db:seed</code>{" "}
            para crear la de ejemplo.
          </Empty>
        ) : company.isLoading || !company.data ? (
          <Empty>Cargando la empresa…</Empty>
        ) : tab === "proceso" ? (
          <LiveProcess key={activeId} company={company.data} />
        ) : tab === "tablero" ? (
          <Board key={activeId} company={company.data} />
        ) : tab === "mcp" ? (
          <McpHub key={activeId} company={company.data} />
        ) : tab === "solicitudes" ? (
          <Requests key={activeId} company={company.data} />
        ) : tab === "empresa" ? (
          <CompanyDesigner key={activeId} company={company.data} />
        ) : tab === "salida" ? (
          <Output company={company.data} />
        ) : tab === "memoria" ? (
          <Memory key={activeId} company={company.data} />
        ) : tab === "costos" ? (
          <Costs key={activeId} company={company.data} />
        ) : (
          <Providers />
        )}
      </main>
    </div>
  );
}
