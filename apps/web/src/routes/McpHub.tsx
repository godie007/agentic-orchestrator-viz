import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parsearConfigMcp } from "@orq/shared";
import type { McpServerHealth, Tool } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { useMcpStream } from "../lib/stream.js";
import { Button, Empty, Field, Panel, Status, inputClass } from "../lib/ui.js";

/**
 * MCP Hub: qué está conectado y quién lo usa.
 *
 * Los servidores MCP dejan de ser configuración escondida y pasan a ser un
 * objeto visible: estado en vivo, herramientas descubiertas, qué agente tiene
 * permiso sobre cuál, y un probador manual para verificar una tool sin tener
 * que arrancar toda la empresa.
 */
export function McpHub({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const [selectedServer, setSelectedServer] = useState<string | null>(null);

  const health = useQuery({
    queryKey: ["mcp-health", companyId],
    queryFn: () => api.mcpHealth(companyId),
    refetchInterval: 10_000,
  });

  const tools = useQuery({
    queryKey: ["tools", companyId],
    queryFn: () => api.tools(companyId),
    refetchInterval: 10_000,
  });

  // El stream pisa el polling: un cambio de estado se ve al instante.
  const streamed = useMcpStream();
  const servers = useMemo(() => {
    const merged = new Map<string, McpServerHealth>();
    for (const entry of health.data ?? []) merged.set(entry.serverId, entry);
    for (const [id, entry] of streamed) merged.set(id, entry);
    // Sólo los que siguen configurados: el stream conserva el último estado de
    // un servidor ya borrado, y eso se veía como un servidor fantasma en
    // `ready`, con botón de reconectar y sin forma de sacarlo de la lista.
    const vigentes = new Set(company.mcpServers.map((server) => server.id));
    return [...merged.values()].filter((entry) => vigentes.has(entry.serverId));
  }, [health.data, streamed, company.mcpServers]);

  const reconnect = useMutation({
    mutationFn: (serverId: string) => api.reconnectMcp(companyId, serverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mcp-health", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["tools", companyId] });
    },
  });

  const mcpTools = (tools.data ?? []).filter((tool) => tool.origin === "mcp");
  const active = selectedServer
    ? servers.find((server) => server.serverId === selectedServer)
    : null;

  const [agregando, setAgregando] = useState(false);

  const olvidar = useMutation({
    mutationFn: (serverId: string) => api.borrarMcpServer(companyId, serverId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-health", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["tools", companyId] });
    },
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-[380px_1fr] gap-2 p-2">
      {/* Ambas filas acotadas con minmax(0,…): con `auto`, la lista de
          servidores crece sin techo, desborda la columna y su cabecera termina
          tapando la tabla de accesos de abajo. */}
      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Panel
          title="Servidores MCP"
          actions={
            <Button variant="primary" onClick={() => setAgregando((v) => !v)}>
              {agregando ? "cancelar" : "+ servidor"}
            </Button>
          }
        >
          {agregando && (
            <AltaDeServidor companyId={companyId} onListo={() => setAgregando(false)} />
          )}
          {servers.length === 0 && !agregando ? (
            <Empty>
              Todavía no hay ningún servidor MCP conectado. Tocá «+ servidor» y pegá la
              configuración que publica el servidor —la misma que usás en Claude o en Cursor—.
            </Empty>
          ) : (
            <ul className="divide-y divide-line/60">
              {servers.map((server) => {
                const config = company.mcpServers.find((item) => item.id === server.serverId);
                const count = mcpTools.filter(
                  (tool) => tool.mcpServerId === server.serverId,
                ).length;
                return (
                  <li key={server.serverId}>
                    <button
                      onClick={() =>
                        setSelectedServer(
                          selectedServer === server.serverId ? null : server.serverId,
                        )
                      }
                      className={`w-full px-3 py-2 text-left transition-colors ${
                        selectedServer === server.serverId ? "bg-surface-2" : "hover:bg-surface-2/60"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm text-ink">{server.serverName}</span>
                        <Status value={server.status} />
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-faint">
                        <span>{count || server.toolCount} herramientas</span>
                        {server.handshakeMs != null && <span>{server.handshakeMs}ms</span>}
                        <span>{server.invocations} invocaciones</span>
                        {server.errors > 0 && (
                          <span className="text-danger">{server.errors} errores</span>
                        )}
                        {server.reconnectAttempts > 0 && (
                          <span className="text-warn">
                            reintento #{server.reconnectAttempts}
                          </span>
                        )}
                      </div>
                      {config && (
                        <div className="mt-0.5 truncate text-[11px] text-ink-faint">
                          {config.transport.type === "stdio"
                            ? `${config.transport.command} ${config.transport.args.join(" ")}`
                            : config.transport.url}
                        </div>
                      )}
                      {server.lastError && (
                        <div className="mt-1 line-clamp-2 rounded bg-danger/10 px-1.5 py-1 text-[10px] text-danger">
                          {server.lastError}
                        </div>
                      )}
                    </button>
                    <div className="flex gap-1 px-3 pb-2">
                      <Button onClick={() => reconnect.mutate(server.serverId)}>reconectar</Button>
                      {config && (
                        <Button
                          variant="danger"
                          title="Saca el servidor de esta empresa. Sus herramientas dejan de existir para los agentes."
                          onClick={() => olvidar.mutate(server.serverId)}
                        >
                          quitar
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <ConnectivityGraph company={company} servers={servers} tools={mcpTools} />
      </div>

      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
        <ToolCatalog
          company={company}
          tools={active ? mcpTools.filter((tool) => tool.mcpServerId === active.serverId) : mcpTools}
          title={active ? `Herramientas de ${active.serverName}` : "Todas las herramientas MCP"}
        />
        <Prober companyId={companyId} tools={mcpTools} />
      </div>
    </div>
  );
}

/**
 * Alta de servidores pegando la configuración que ya tenés.
 *
 * El formato `{"mcpServers": {…}}` es el que publica cada servidor en su README
 * y el que ya está pegado en Claude y en Cursor. Pedir que se traduzca a mano
 * campo por campo era, en los hechos, la razón por la que MCP no se usaba: la
 * capacidad estaba entera del lado del motor y el único camino para llegar a
 * ella era un `curl`.
 *
 * Los secretos **no** se importan: `parsearConfigMcp` guarda el nombre de la
 * variable y descarta el valor literal, avisando. Es la garantía de que una
 * empresa exportada a JSON no lleva credenciales adentro.
 */
function AltaDeServidor({
  companyId,
  onListo,
}: {
  companyId: string;
  onListo: () => void;
}) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");

  const lectura = useMemo(
    () => (texto.trim() ? parsearConfigMcp(texto) : { servidores: [], avisos: [] }),
    [texto],
  );

  const crear = useMutation({
    mutationFn: async () => {
      for (const servidor of lectura.servidores) {
        await api.crearMcpServer(companyId, {
          name: servidor.name,
          description: servidor.description,
          transport: servidor.transport,
          enabled: true,
          autoApproveTools: true,
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-health", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["tools", companyId] });
      setTexto("");
      onListo();
    },
  });

  return (
    <div className="space-y-2 border-b border-line bg-canvas p-3">
      <Field
        label="Pegá la configuración del servidor"
        hint="La misma que usás en Claude o en Cursor. Los secretos no se guardan acá: dejá el nombre de la variable de entorno y el valor en el .env."
      >
        <textarea
          value={texto}
          onChange={(event) => setTexto(event.target.value)}
          rows={7}
          spellCheck={false}
          placeholder={'{\n  "mcpServers": {\n    "browsermcp": {\n      "command": "npx",\n      "args": ["@browsermcp/mcp@latest"]\n    }\n  }\n}'}
          className={`${inputClass} font-mono text-[11px]`}
        />
      </Field>

      {lectura.servidores.length > 0 && (
        <ul className="space-y-1 rounded border border-line bg-surface p-2">
          {lectura.servidores.map((servidor) => (
            <li key={servidor.name} className="text-[11px]">
              <span className="font-mono text-ink">{servidor.name}</span>
              <span className="ml-2 text-ink-faint">
                {servidor.transport.type === "stdio"
                  ? `${servidor.transport.command} ${servidor.transport.args.join(" ")}`
                  : servidor.transport.url}
              </span>
            </li>
          ))}
        </ul>
      )}

      {lectura.avisos.map((aviso) => (
        <p key={aviso} className="rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">
          {aviso}
        </p>
      ))}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={lectura.servidores.length === 0 || crear.isPending}
          onClick={() => crear.mutate()}
        >
          {crear.isPending
            ? "conectando…"
            : `conectar ${lectura.servidores.length || ""} servidor${
                lectura.servidores.length === 1 ? "" : "es"
              }`}
        </Button>
        {crear.isError && (
          <span className="text-[11px] text-danger">
            {crear.error instanceof Error ? crear.error.message : "No se pudo guardar."}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Quién puede usar qué, y también el editor de accesos.
 *
 * Las herramientas MCP se descubren al conectar el servidor, así que ningún
 * agente las tiene asignadas de entrada. Hacer clic en una celda le da (o le
 * quita) a ese agente todas las herramientas de ese servidor: es la operación
 * que se necesita el 90% de las veces, y hacerla sobre el mismo mapa donde se
 * ve el problema evita ir a buscarla a otra pantalla.
 */
function ConnectivityGraph({
  company,
  servers,
  tools,
}: {
  company: CompanyBundle;
  servers: McpServerHealth[];
  tools: Tool[];
}) {
  const queryClient = useQueryClient();

  const toggleAccess = useMutation({
    mutationFn: async ({ roleId, serverId }: { roleId: string; serverId: string }) => {
      const role = company.roles.find((candidate) => candidate.id === roleId);
      if (!role) return;
      const serverToolIds = tools
        .filter((tool) => tool.mcpServerId === serverId)
        .map((tool) => tool.id);
      const hasAll = serverToolIds.every((id) => role.toolIds.includes(id));
      const toolIds = hasAll
        ? role.toolIds.filter((id) => !serverToolIds.includes(id))
        : [...new Set([...role.toolIds, ...serverToolIds])];
      await api.updateRole(company.company.id, { ...role, toolIds });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["company", company.company.id] }),
  });

  const byRole = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const role of company.roles) {
      const perServer = new Map<string, number>();
      for (const tool of tools) {
        if (!role.toolIds.includes(tool.id) || !tool.mcpServerId) continue;
        perServer.set(tool.mcpServerId, (perServer.get(tool.mcpServerId) ?? 0) + 1);
      }
      map.set(role.id, perServer);
    }
    return map;
  }, [company.roles, tools]);

  const statusColor: Record<string, string> = {
    ready: "bg-ok",
    connecting: "bg-warn",
    reconnecting: "bg-warn",
    error: "bg-danger",
    disabled: "bg-line",
  };

  return (
    <Panel
      title="Quién usa qué"
      actions={
        <span className="text-[10px] normal-case text-ink-faint">
          clic en una celda para dar o quitar acceso
        </span>
      }
    >
      {servers.length === 0 ? (
        <Empty>Conectá un servidor MCP para ver el mapa de accesos.</Empty>
      ) : (
        // `table-fixed` es necesario: con layout automático el ancho mínimo del
        // contenido supera los 380px de la columna, la tabla desborda y sus
        // botones quedan por debajo del panel vecino, que se come los clics.
        <table className="w-full table-fixed text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-line">
              <th className="w-36 px-3 py-1.5 text-left font-medium text-ink-dim">Agente</th>
              {servers.map((server) => (
                <th key={server.serverId} className="px-2 py-1.5 text-center font-medium">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className={`size-1.5 rounded-full ${statusColor[server.status] ?? "bg-line"}`}
                    />
                    <span className="font-mono text-[10px] text-ink-dim">{server.serverName}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {company.roles.map((role) => (
              <tr key={role.id} className="border-b border-line/40">
                <td className="px-3 py-1.5 text-ink-dim">
                  <div className="truncate">{role.name}</div>
                  <div className="truncate text-[10px] text-ink-faint">{role.title}</div>
                </td>
                {servers.map((server) => {
                  const count = byRole.get(role.id)?.get(server.serverId) ?? 0;
                  return (
                    <td key={server.serverId} className="px-2 py-1 text-center">
                      <button
                        onClick={() =>
                          toggleAccess.mutate({ roleId: role.id, serverId: server.serverId })
                        }
                        disabled={toggleAccess.isPending}
                        title={
                          count > 0
                            ? `Quitarle a ${role.name} el acceso a ${server.serverName}`
                            : `Darle a ${role.name} las ${server.toolCount} herramientas de ${server.serverName}`
                        }
                        className={`w-full rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                          count > 0
                            ? "bg-accent/20 text-accent hover:bg-accent/30"
                            : "text-ink-faint hover:bg-surface-2"
                        }`}
                      >
                        {count > 0 ? count : "·"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ToolCatalog({
  company,
  tools,
  title,
}: {
  company: CompanyBundle;
  tools: Tool[];
  title: string;
}) {
  return (
    <Panel title={`${title} (${tools.length})`}>
      {tools.length === 0 ? (
        <Empty>No hay herramientas descubiertas. Verificá que el servidor esté conectado.</Empty>
      ) : (
        <ul className="divide-y divide-line/60">
          {tools.map((tool) => {
            const users = company.roles.filter((role) => role.toolIds.includes(tool.id));
            return (
              <li key={tool.id} className="px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs text-ink">
                    {tool.name.replace(/^mcp__/, "")}
                  </span>
                  {tool.requiresApproval && (
                    <span className="rounded bg-approval/20 px-1.5 py-0.5 text-[10px] text-approval">
                      requiere aprobación
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">{tool.description}</p>
                <div className="mt-1 text-[10px] text-ink-faint">
                  {users.length > 0 ? (
                    <>usan: {users.map((role) => role.name).join(", ")}</>
                  ) : (
                    <span className="text-warn">
                      sin asignar — ningún agente puede usarla todavía
                    </span>
                  )}
                </div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-accent">ver schema</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-canvas p-2 text-[10px] text-ink-dim">
                    {JSON.stringify(tool.inputSchema, null, 2)}
                  </pre>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** Ejecutar una tool a mano: la forma más rápida de saber si un MCP sirve. */
function Prober({ companyId, tools }: { companyId: string; tools: Tool[] }) {
  const [toolName, setToolName] = useState("");
  const [args, setArgs] = useState("{}");

  useEffect(() => {
    if (!toolName && tools[0]) setToolName(tools[0].name);
  }, [tools, toolName]);

  const probe = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(args) as Record<string, unknown>;
      } catch {
        throw new Error("Los argumentos no son JSON válido.");
      }
      return api.probeTool(companyId, toolName, parsed);
    },
  });

  const selected = tools.find((tool) => tool.name === toolName);

  return (
    <Panel title="Probar una herramienta">
      <div className="space-y-2 p-3">
        <Field label="Herramienta">
          <select
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            className={inputClass}
          >
            {tools.map((tool) => (
              <option key={tool.id} value={tool.name}>
                {tool.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Argumentos (JSON)"
          hint={
            selected
              ? `Campos: ${Object.keys(
                  (selected.inputSchema as { properties?: Record<string, unknown> }).properties ??
                    {},
                ).join(", ") || "ninguno"}`
              : undefined
          }
        >
          <textarea
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            rows={3}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>

        <Button variant="primary" onClick={() => probe.mutate()} disabled={probe.isPending}>
          {probe.isPending ? "ejecutando…" : "ejecutar"}
        </Button>

        {(probe.data || probe.error) && (
          <pre
            className={`max-h-48 overflow-auto rounded border p-2 text-[11px] whitespace-pre-wrap ${
              probe.error || probe.data?.ok === false
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-ok/40 bg-ok/10 text-ink-dim"
            }`}
          >
            {probe.error ? probe.error.message : probe.data?.content}
          </pre>
        )}
      </div>
    </Panel>
  );
}
