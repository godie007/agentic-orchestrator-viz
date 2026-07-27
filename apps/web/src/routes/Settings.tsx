import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelTier, Role } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { Button, Empty, Field, Panel, Status, inputClass, money } from "../lib/ui.js";

/**
 * Pantallas de apoyo: proveedores y modelos, diseñador de la empresa y costos.
 *
 * El diseñador es un editor por formulario, no un canvas de arrastrar y soltar:
 * el organigrama visual ya existe en la Live Process View, y duplicarlo como
 * editor habría costado mucho más de lo que aporta.
 */

// --- Proveedores y modelos ---------------------------------------------------

export function Providers() {
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api.providers() });

  if (providers.isLoading) return <Empty>Consultando proveedores…</Empty>;

  const configured = providers.data ?? [];

  return (
    <div className="h-full overflow-auto p-2">
      {configured.length === 0 ? (
        <Panel title="Proveedores">
          <Empty>
            No hay ningún proveedor configurado. Copiá <code>.env.example</code> a{" "}
            <code>.env</code>, completá al menos una API key y reiniciá el servidor.
          </Empty>
        </Panel>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {configured.map((provider) => (
            <Panel
              key={provider.id}
              title={provider.label}
              actions={<Status value={provider.ok ? "ready" : "error"} />}
            >
              <div className="space-y-3 p-3">
                <p className="text-xs text-ink-dim">{provider.detail}</p>

                <div className="space-y-2">
                  <div className="text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
                    Tiers resueltos contra el catálogo vivo
                  </div>
                  {(["free", "cheap", "standard", "smart"] as ModelTier[]).map((tier) => {
                    const resolution = provider.tiers[tier];
                    return (
                      <div key={tier} className="rounded border border-line bg-canvas p-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium text-ink">{tier}</span>
                          {resolution && (
                            <span className="font-mono text-[10px] text-ink-faint">
                              US${resolution.blendedPriceUsdPerMTok.toFixed(3)}/MTok
                            </span>
                          )}
                        </div>
                        {resolution ? (
                          <>
                            <div className="font-mono text-[11px] text-accent">
                              {resolution.model.slug}
                            </div>
                            <p className="mt-0.5 text-[10px] text-ink-faint">{resolution.reason}</p>
                          </>
                        ) : (
                          <p className="text-[11px] text-warn">
                            Sin candidatos. Asigná un modelo explícito a los roles que usen este tier.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Diseñador de la empresa -------------------------------------------------

export function CompanyDesigner({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(company.roles[0]?.id ?? null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newDepartment, setNewDepartment] = useState(false);
  const role = company.roles.find((candidate) => candidate.id === selectedId);

  const models = useQuery({ queryKey: ["models"], queryFn: () => api.models() });
  // Para avisar en la confirmación de borrado qué solicitudes se van con el
  // agente: son pedidos que quedaron esperando una respuesta de la persona.
  const requests = useQuery({
    queryKey: ["requests", companyId],
    queryFn: () => api.requests(companyId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["company", companyId] });

  const save = useMutation({
    mutationFn: (updated: Role) => api.updateRole(companyId, updated),
    onSuccess: () => refresh(),
  });

  /**
   * A quién reporta un agente recién creado.
   *
   * En orden: quien ya dirige ese departamento; si nadie dirige, el mismo jefe
   * que tienen sus futuros compañeros —un QA nuevo entra bajo el jefe de la QA
   * que ya está—; y solo si el departamento está vacío, el ejecutivo.
   *
   * Colgarlos todos del CEO, que es lo que se hacía antes, arma una jerarquía
   * plana y falsa apenas la empresa pasa de tres roles, y obliga a corregirlo a
   * mano en cada alta.
   */
  const jefeSugerido = (departmentId: string): string | null => {
    const delDepto = company.roles.filter((item) => item.departmentId === departmentId);
    const dirige = delDepto.find(
      (item) => item.authority === "manager" || item.authority === "executive",
    );
    if (dirige) return dirige.id;

    // El jefe que comparten los del departamento. Se ignoran los que no
    // reportan a nadie: ésos ya serían la cima y los habría tomado el paso
    // anterior si tuvieran la autoridad declarada.
    const jefeDeCompañeros = delDepto.find((item) => item.reportsTo != null)?.reportsTo;
    if (jefeDeCompañeros) return jefeDeCompañeros;

    return company.roles.find((item) => item.authority === "executive")?.id ?? null;
  };

  const createRole = useMutation({
    mutationFn: ({ departmentId, name }: { departmentId: string; name: string }) =>
      api.createRole(companyId, {
        companyId,
        departmentId,
        name,
        title: name,
        systemPrompt: "",
        // Hereda el modelo por defecto de la empresa: un agente nuevo sin
        // modelo no podría correr, y elegirlo debería ser opcional.
        model: { ...company.company.defaultModel },
        toolIds: [],
        authority: "executor",
        reportsTo: jefeSugerido(departmentId),
        maxTurns: 8,
        spendApprovalThresholdUsd: null,
        position: { x: 100, y: 100 },
      }),
    onSuccess: (created) => {
      setAddingTo(null);
      setSelectedId(created.id);
      void refresh();
    },
  });

  const removeRole = useMutation({
    mutationFn: async (target: Role) => {
      // Quien le reportaba quedaría apuntando a un rol inexistente: se los
      // reasigna al superior del eliminado antes de borrarlo.
      const orphans = company.roles.filter((item) => item.reportsTo === target.id);
      for (const orphan of orphans) {
        await api.updateRole(companyId, { ...orphan, reportsTo: target.reportsTo });
      }
      return api.deleteRole(companyId, target.id);
    },
    onSuccess: () => {
      setSelectedId(null);
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ["requests", companyId] });
    },
  });

  const createDepartment = useMutation({
    mutationFn: (name: string) =>
      api.createDepartment(companyId, {
        companyId,
        name,
        purpose: "",
        parentId: null,
        position: { x: 100, y: 100 },
      }),
    onSuccess: () => {
      setNewDepartment(false);
      void refresh();
    },
  });

  const removeDepartment = useMutation({
    mutationFn: async (departmentId: string) => {
      // Un departamento sin roles se borra directo; con roles adentro habría
      // que decidir a dónde van, así que se bloquea y se avisa.
      const members = company.roles.filter((item) => item.departmentId === departmentId);
      if (members.length > 0) {
        throw new Error(
          `Tiene ${members.length} agente(s). Movelos o eliminalos antes de borrar el departamento.`,
        );
      }
      await api.deleteDepartment(companyId, departmentId);
    },
    onSuccess: () => void refresh(),
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-[280px_1fr] gap-2 p-2">
      <Panel
        title={`Organización (${company.roles.length})`}
        actions={
          <Button variant="ghost" onClick={() => setNewDepartment(true)}>
            + departamento
          </Button>
        }
      >
        {newDepartment && (
          <InlineCreate
            placeholder="Nombre del departamento"
            onCancel={() => setNewDepartment(false)}
            onSubmit={(name) => createDepartment.mutate(name)}
            pending={createDepartment.isPending}
          />
        )}
        {(removeDepartment.error || createRole.error || removeRole.error) && (
          <p className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
            {(removeDepartment.error ?? createRole.error ?? removeRole.error)?.message}
          </p>
        )}
        <ul className="divide-y divide-line/60">
          {company.departments.map((department) => {
            const members = company.roles.filter((item) => item.departmentId === department.id);
            return (
              <li key={department.id}>
                <div className="group flex items-center justify-between gap-1 bg-surface-2/60 px-3 py-1">
                  <span className="truncate text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
                    {department.name}
                  </span>
                  <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title="Agregar un agente a este departamento"
                      onClick={() => setAddingTo(department.id)}
                      className="rounded px-1 text-[11px] text-ink-faint hover:bg-accent/20 hover:text-accent"
                    >
                      + agente
                    </button>
                    <button
                      title="Eliminar el departamento"
                      onClick={() => removeDepartment.mutate(department.id)}
                      className="rounded px-1 text-[11px] text-ink-faint hover:bg-danger/20 hover:text-danger"
                    >
                      ×
                    </button>
                  </span>
                </div>

                {addingTo === department.id && (
                  <InlineCreate
                    placeholder="Nombre del agente"
                    onCancel={() => setAddingTo(null)}
                    onSubmit={(name) => createRole.mutate({ departmentId: department.id, name })}
                    pending={createRole.isPending}
                  />
                )}

                {members.length === 0 && addingTo !== department.id && (
                  <p className="px-3 py-1.5 text-[11px] text-ink-faint">Sin agentes.</p>
                )}
                {members.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`block w-full px-3 py-1.5 text-left text-xs ${
                      item.id === selectedId ? "bg-surface-2 text-ink" : "text-ink-dim hover:bg-surface-2/60"
                    }`}
                  >
                    <div>{item.name}</div>
                    <div className="text-[10px] text-ink-faint">
                      {item.title} · {item.model.modelSlug ?? item.model.tier}
                    </div>
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      </Panel>

      {role ? (
        <RoleEditor
          key={role.id}
          role={role}
          company={company}
          models={models.data ?? []}
          onSave={(updated) => save.mutate(updated)}
          onDelete={() => removeRole.mutate(role)}
          solicitudes={
            (requests.data ?? []).filter(
              (item) => item.requestedByRoleId === role.id && item.status === "pending",
            ).length
          }
          saving={save.isPending}
        />
      ) : (
        <Panel title="Agente">
          <Empty>
            Elegí un agente para editarlo, o agregá uno nuevo con <b>+ agente</b> en un
            departamento.
          </Empty>
        </Panel>
      )}
    </div>
  );
}

/** Alta rápida en línea: pedir solo el nombre y editar el resto después. */
function InlineCreate({
  placeholder,
  onSubmit,
  onCancel,
  pending,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex gap-1 border-b border-line bg-canvas px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
        placeholder={placeholder}
        className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      />
      <Button type="submit" variant="primary" disabled={!name.trim() || pending}>
        ✓
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        ×
      </Button>
    </form>
  );
}

function RoleEditor({
  role,
  company,
  models,
  onSave,
  onDelete,
  solicitudes,
  saving,
}: {
  role: Role;
  company: CompanyBundle;
  models: import("@orq/shared").ModelInfo[];
  onSave: (role: Role) => void;
  onDelete: () => void;
  /** Solicitudes pendientes suyas: se borran con él, así que se avisa antes. */
  solicitudes: number;
  saving: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState<Role>(role);
  const update = <K extends keyof Role>(key: K, value: Role[K]): void =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const toggleTool = (toolId: string): void =>
    update(
      "toolIds",
      draft.toolIds.includes(toolId)
        ? draft.toolIds.filter((id) => id !== toolId)
        : [...draft.toolIds, toolId],
    );

  const providerModels = models.filter((model) => model.providerId === draft.model.providerId);

  return (
    <Panel
      title={`${draft.name} — ${draft.title}`}
      actions={
        <div className="flex gap-1.5">
          {confirming ? (
            <>
              <span className="self-center text-[11px] text-ink-dim">
                ¿Eliminar {draft.name}?
                {solicitudes > 0 && (
                  <b className="text-warn">
                    {" "}
                    {solicitudes === 1
                      ? "Se borra su solicitud pendiente."
                      : `Se borran sus ${solicitudes} solicitudes pendientes.`}
                  </b>
                )}
              </span>
              <Button variant="danger" onClick={onDelete}>
                sí, eliminar
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                cancelar
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                eliminar
              </Button>
              <Button variant="primary" onClick={() => onSave(draft)} disabled={saving}>
                {saving ? "guardando…" : "guardar"}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nombre">
            <input
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Cargo">
            <input
              value={draft.title}
              onChange={(event) => update("title", event.target.value)}
              className={inputClass}
            />
          </Field>
        </div>

        <Field
          label="Instrucciones del rol"
          hint="Se compone con el contexto de la empresa y las políticas que le apliquen."
        >
          <textarea
            value={draft.systemPrompt}
            onChange={(event) => update("systemPrompt", event.target.value)}
            rows={7}
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Proveedor">
            <select
              value={draft.model.providerId}
              onChange={(event) =>
                update("model", {
                  ...draft.model,
                  providerId: event.target.value as Role["model"]["providerId"],
                  modelSlug: null,
                })
              }
              className={inputClass}
            >
              {["openrouter", "anthropic", "openai", "ollama"].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Tier" hint="Se usa si no fijás un modelo.">
            <select
              value={draft.model.tier}
              onChange={(event) =>
                update("model", { ...draft.model, tier: event.target.value as ModelTier })
              }
              className={inputClass}
            >
              <option value="free">free — sin costo, con límites</option>
              <option value="cheap">cheap — rutina</option>
              <option value="standard">standard — día a día</option>
              <option value="smart">smart — decisiones difíciles</option>
            </select>
          </Field>

          <Field label="Autoridad">
            <select
              value={draft.authority}
              onChange={(event) => update("authority", event.target.value as Role["authority"])}
              className={inputClass}
            >
              <option value="executor">executor — ejecuta y escala</option>
              <option value="manager">manager — decide en su área</option>
              <option value="executive">executive — decide por la empresa</option>
            </select>
          </Field>
        </div>

        <Field label="Modelo exacto" hint="Vacío = usar el tier. Los precios son del catálogo vivo.">
          <select
            value={draft.model.modelSlug ?? ""}
            onChange={(event) =>
              update("model", { ...draft.model, modelSlug: event.target.value || null })
            }
            className={inputClass}
          >
            <option value="">— resolver por tier —</option>
            {providerModels.map((model) => (
              <option key={model.slug} value={model.slug}>
                {model.slug}
                {model.inputPricePerMTok != null
                  ? ` · US$${model.inputPricePerMTok.toFixed(2)}/${model.outputPricePerMTok?.toFixed(2)} por MTok`
                  : ""}
                {model.supportsTools ? "" : " · sin tool-calling"}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Reporta a">
            <select
              value={draft.reportsTo ?? ""}
              onChange={(event) => update("reportsTo", event.target.value || null)}
              className={inputClass}
            >
              <option value="">— nadie —</option>
              {company.roles
                .filter((item) => item.id !== draft.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.title})
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Iteraciones base por turno"
            hint="Es el piso, no el techo: el motor suma vueltas según la carga del turno y las estira mientras el agente avance."
          >
            <input
              type="number"
              min={1}
              max={50}
              value={draft.maxTurns}
              onChange={(event) => update("maxTurns", Number(event.target.value))}
              className={inputClass}
            />
          </Field>
          <Field label="Umbral de aprobación (USD)" hint="Vacío = sin límite propio.">
            <input
              type="number"
              min={0}
              value={draft.spendApprovalThresholdUsd ?? ""}
              onChange={(event) =>
                update(
                  "spendApprovalThresholdUsd",
                  event.target.value === "" ? null : Number(event.target.value),
                )
              }
              className={inputClass}
            />
          </Field>
        </div>

        <AsignacionDeHerramientas
          tools={company.tools}
          mcpServers={company.mcpServers}
          asignadas={draft.toolIds}
          onToggle={toggleTool}
          onGrupo={(ids, marcar) =>
            update(
              "toolIds",
              marcar
                ? [...new Set([...draft.toolIds, ...ids])]
                : draft.toolIds.filter((id) => !ids.includes(id)),
            )
          }
        />
      </div>
    </Panel>
  );
}

/**
 * Asignación de herramientas, agrupada por lo que significan para el rol.
 *
 * Antes era una lista plana: con dos servidores MCP conectados son cuarenta
 * casillas seguidas donde una habilidad —lo que el rol sabe **producir**— se ve
 * igual que el decimoquinto acceso de lectura de un servidor. Nadie encuentra
 * nada así, y la decisión que se está tomando ahí es de las importantes.
 *
 * Ahora cada grupo dice qué es, cuántas hay asignadas y se puede marcar entero.
 * Las de coordinación no son casillas: el motor se las da a todos los roles sin
 * mirar `toolIds`, así que dibujarlas como algo que se puede quitar es mentira.
 */
function AsignacionDeHerramientas({
  tools,
  mcpServers,
  asignadas,
  onToggle,
  onGrupo,
}: {
  tools: CompanyBundle["tools"];
  mcpServers: CompanyBundle["mcpServers"];
  asignadas: string[];
  onToggle: (toolId: string) => void;
  onGrupo: (toolIds: string[], marcar: boolean) => void;
}) {
  const [filtro, setFiltro] = useState("");

  const coincide = (tool: CompanyBundle["tools"][number]): boolean => {
    const aguja = filtro.trim().toLowerCase();
    if (!aguja) return true;
    return (
      tool.name.toLowerCase().includes(aguja) || tool.description.toLowerCase().includes(aguja)
    );
  };

  const visibles = tools.filter(coincide);
  const de = (origin: string) => visibles.filter((tool) => tool.origin === origin);

  const coordinacion = de("coordination");
  const grupos: Array<{
    clave: string;
    titulo: string;
    detalle: string;
    tools: CompanyBundle["tools"];
  }> = [
    {
      clave: "skill",
      titulo: "Habilidades",
      detalle: "Lo que este rol sabe producir.",
      tools: de("skill"),
    },
    {
      clave: "capability",
      titulo: "Capacidades",
      detalle: "Accesos generales, como buscar en la web.",
      tools: de("capability"),
    },
    // Un grupo por servidor: mezclar dos MCP en una sola lista hace que el
    // nombre de la herramienta sea lo único que distingue de dónde sale.
    ...mcpServers.map((server) => ({
      clave: `mcp:${server.id}`,
      titulo: server.name,
      detalle: "Servidor MCP conectado.",
      tools: de("mcp").filter((tool) => tool.mcpServerId === server.id),
    })),
    {
      clave: "mcp:sueltas",
      titulo: "Otras herramientas MCP",
      detalle: "De un servidor que ya no está configurado.",
      tools: de("mcp").filter(
        (tool) => !mcpServers.some((server) => server.id === tool.mcpServerId),
      ),
    },
  ];

  const total = tools.filter((tool) => tool.origin !== "coordination").length;
  const puestas = asignadas.length;

  return (
    <Field
      label="Herramientas asignadas"
      hint="Las de coordinación las tiene siempre. Acá elegís qué sabe producir y a qué accede."
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={filtro}
            onChange={(event) => setFiltro(event.target.value)}
            placeholder="Buscar herramienta…"
            className={inputClass}
          />
          <span className="shrink-0 rounded border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] text-ink-dim">
            {puestas}/{total}
          </span>
        </div>

        <div className="max-h-80 space-y-3 overflow-auto rounded border border-line bg-canvas p-2">
          {tools.length === 0 && (
            <p className="text-xs text-ink-faint">
              No hay herramientas registradas. Conectá un servidor MCP desde el Hub.
            </p>
          )}

          {grupos
            .filter((grupo) => grupo.tools.length > 0)
            .map((grupo) => {
              const ids = grupo.tools.map((tool) => tool.id);
              const marcadas = ids.filter((id) => asignadas.includes(id)).length;
              const todas = marcadas === ids.length;
              return (
                <section key={grupo.clave}>
                  <header className="mb-1 flex items-baseline justify-between gap-2 border-b border-line/60 pb-1">
                    <div className="min-w-0">
                      <h4 className="truncate text-[11px] font-semibold tracking-wide text-ink uppercase">
                        {grupo.titulo}
                      </h4>
                      <p className="truncate text-[10px] text-ink-faint">{grupo.detalle}</p>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-2">
                      <span className="font-mono text-[10px] text-ink-faint">
                        {marcadas}/{ids.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => onGrupo(ids, !todas)}
                        className="rounded px-1 text-[10px] text-accent hover:bg-surface-2"
                      >
                        {todas ? "ninguna" : "todas"}
                      </button>
                    </div>
                  </header>

                  <div className="space-y-0.5">
                    {grupo.tools.map((tool) => {
                      const puesta = asignadas.includes(tool.id);
                      return (
                        <label
                          key={tool.id}
                          className={`flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 transition-colors hover:bg-surface-2 ${
                            puesta ? "bg-surface-2/50" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={puesta}
                            onChange={() => onToggle(tool.id)}
                            className="mt-0.5 accent-accent"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5">
                              <span
                                className={`truncate font-mono text-[11px] ${puesta ? "text-ink" : "text-ink-dim"}`}
                              >
                                {tool.name.replace(/^mcp__[^_]+__/, "")}
                              </span>
                              {tool.requiresApproval && (
                                <span className="shrink-0 rounded bg-warn/15 px-1 text-[9px] text-warn">
                                  pide aprobación
                                </span>
                              )}
                              {/* Sólo donde el dato es cierto. En MCP `readOnly`
                                  sale de una anotación que casi ningún servidor
                                  manda, y por defecto es `false`: rotular
                                  "escribe" a un `read_file` es peor que no
                                  decir nada. */}
                              {tool.origin !== "mcp" && !tool.readOnly && (
                                <span className="shrink-0 text-[9px] text-ink-faint">escribe</span>
                              )}
                            </span>
                            <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-ink-faint">
                              {tool.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              );
            })}

          {coordinacion.length > 0 && (
            <section>
              <header className="mb-1 flex items-baseline justify-between gap-2 border-b border-line/60 pb-1">
                <div>
                  <h4 className="text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
                    Coordinación
                  </h4>
                  <p className="text-[10px] text-ink-faint">
                    Cómo habla con el resto. Las tiene siempre, no se asignan.
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                  {coordinacion.length}
                </span>
              </header>
              <div className="flex flex-wrap gap-1">
                {coordinacion.map((tool) => (
                  <span
                    key={tool.id}
                    title={tool.description}
                    className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </Field>
  );
}

// --- Costos ------------------------------------------------------------------

export function Costs({ company }: { company: CompanyBundle }) {
  const runs = useQuery({
    queryKey: ["runs", company.company.id],
    queryFn: () => api.runs(company.company.id),
  });
  const [runId, setRunId] = useState<string | null>(null);
  const selected = runId ?? runs.data?.[0]?.id ?? null;

  const bundle = useQuery({
    queryKey: ["run", selected],
    queryFn: () => api.run(selected!),
    enabled: selected != null,
  });

  const entries = bundle.data?.ledger ?? [];
  const nameOf = (id: string | null): string =>
    company.roles.find((role) => role.id === id)?.name ?? "sistema";

  const byRole = new Map<string, { cost: number; calls: number; tokens: number }>();
  const byModel = new Map<string, { cost: number; calls: number; tokens: number }>();
  for (const entry of entries) {
    const tokens = entry.inputTokens + entry.outputTokens;
    for (const [map, key] of [
      [byRole, nameOf(entry.roleId)],
      [byModel, `${entry.providerId}/${entry.modelSlug}`],
    ] as const) {
      const current = map.get(key) ?? { cost: 0, calls: 0, tokens: 0 };
      current.cost += entry.costUsd;
      current.calls += 1;
      current.tokens += tokens;
      map.set(key, current);
    }
  }

  const total = entries.reduce((sum, entry) => sum + entry.costUsd, 0);
  const budget = bundle.data?.run.budgetUsd ?? 0;

  return (
    <div className="h-full space-y-2 overflow-auto p-2">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
        <select
          value={selected ?? ""}
          onChange={(event) => setRunId(event.target.value)}
          className="rounded border border-line bg-canvas px-2 py-1 text-xs text-ink"
        >
          {(runs.data ?? []).map((run) => (
            <option key={run.id} value={run.id}>
              {new Date(run.startedAt).toLocaleString()} — {run.objective.slice(0, 40)}
            </option>
          ))}
        </select>
        <span className="text-xs text-ink-dim">
          {money(total)} de {money(budget)} · {entries.length} llamadas
        </span>
        <div className="ml-auto h-1.5 w-48 overflow-hidden rounded-full bg-line">
          <div
            className={`h-full ${total / (budget || 1) > 0.8 ? "bg-warn" : "bg-accent"}`}
            style={{ width: `${Math.min(100, (total / (budget || 1)) * 100)}%` }}
          />
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <CostTable title="Por agente" rows={byRole} />
        <CostTable title="Por modelo" rows={byModel} mono />
      </div>
    </div>
  );
}

function CostTable({
  title,
  rows,
  mono,
}: {
  title: string;
  rows: Map<string, { cost: number; calls: number; tokens: number }>;
  mono?: boolean;
}) {
  const sorted = [...rows.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const max = sorted[0]?.[1].cost ?? 1;

  return (
    <Panel title={title}>
      {sorted.length === 0 ? (
        <Empty>Sin datos todavía.</Empty>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {sorted.map(([key, value]) => (
              <tr key={key} className="border-b border-line/40">
                <td className={`px-3 py-1.5 ${mono ? "font-mono text-[11px]" : ""} text-ink-dim`}>
                  {key}
                </td>
                <td className="w-32 px-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${(value.cost / max) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-ink">
                  {money(value.cost)}
                </td>
                <td className="px-3 py-1.5 text-right text-[10px] text-ink-faint">
                  {value.calls} llamadas · {(value.tokens / 1000).toFixed(1)}k tok
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
