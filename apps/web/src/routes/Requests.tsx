import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRequest, RoleProposal } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { Button, Empty, Field, Panel, Status, inputClass, relativeTime } from "../lib/ui.js";

/**
 * Bandeja de solicitudes.
 *
 * Los agentes coordinan entre ellos por mensajes, pero hay cosas que no pueden
 * resolver adentro: incorporar a alguien, conocer un dato del negocio, obtener
 * acceso a una herramienta. Eso llega acá, con destinatario humano y una
 * decisión pendiente.
 *
 * Aprobar no es marcar una casilla: crea el rol de verdad, otorga las
 * herramientas, o le hace llegar la respuesta al agente que preguntó.
 */

const ETIQUETA: Record<AgentRequest["type"], string> = {
  create_role: "incorporar un rol",
  context: "consulta de negocio",
  tool_access: "acceso a herramientas",
};

const ICONO: Record<AgentRequest["type"], string> = {
  create_role: "👤",
  context: "❓",
  tool_access: "🔑",
};

export function Requests({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();

  const requests = useQuery({
    queryKey: ["requests", companyId],
    queryFn: () => api.requests(companyId),
    refetchInterval: 4000,
    refetchIntervalInBackground: true,
  });

  // Dónde terminó la última respuesta. Importa: si la corrida del agente ya
  // había cerrado, no le entra por la bandeja sino a la memoria de la empresa,
  // y conviene decirlo en vez de dar a entender que alguien la está leyendo.
  const [entrega, setEntrega] = useState<"bandeja" | "memoria" | "descartada" | null>(null);

  const items = requests.data ?? [];
  const pendientes = items.filter((item) => item.status === "pending");
  const resueltas = items.filter((item) => item.status !== "pending");

  const nombreDe = (roleId: string | null): string =>
    company.roles.find((role) => role.id === roleId)?.name ?? "un agente";

  return (
    <div className="grid h-full min-h-0 grid-cols-[1fr_340px] gap-2 p-2">
      <Panel
        title={`Pendientes de tu decisión (${pendientes.length})`}
        actions={
          <span className="text-[10px] normal-case text-ink-faint">
            aprobar aplica el cambio de verdad
          </span>
        }
      >
        {entrega && (
          <div
            className={`m-2 rounded border px-3 py-2 text-[11px] ${
              entrega === "bandeja"
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-warn/40 bg-warn/10 text-warn"
            }`}
          >
            {entrega === "bandeja"
              ? "Le llegó a la bandeja del agente: lo va a leer en el próximo ciclo."
              : entrega === "memoria"
                ? "Su corrida ya había terminado, así que la respuesta quedó en la memoria de la empresa. Entra sola en el prompt de la próxima corrida."
                : "No se pudo entregar: la solicitud no tiene autor o quedó sin respuesta escrita."}
          </div>
        )}

        {pendientes.length === 0 ? (
          <Empty>
            No hay solicitudes pendientes. Los agentes pueden pedirte incorporar un rol,
            un dato del negocio o acceso a una herramienta mientras trabajan.
          </Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {pendientes.map((item) => (
              <RequestCard
                key={item.id}
                request={item}
                autor={nombreDe(item.requestedByRoleId)}
                company={company}
                onResolved={(entrega) => {
                  setEntrega(entrega);
                  void queryClient.invalidateQueries({ queryKey: ["requests", companyId] });
                  void queryClient.invalidateQueries({ queryKey: ["company", companyId] });
                  void queryClient.invalidateQueries({ queryKey: ["learnings", companyId] });
                }}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Ya resueltas (${resueltas.length})`}>
        {resueltas.length === 0 ? (
          <Empty>Todavía no resolviste ninguna.</Empty>
        ) : (
          <ul className="divide-y divide-line/60">
            {resueltas.map((item) => (
              <li key={item.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-dim">
                    {ICONO[item.type]} {ETIQUETA[item.type]}
                  </span>
                  {/* Rechazar es una decisión tuya, no una falla del sistema:
                      pintarla de rojo con la palabra "error" hacía parecer que
                      algo se había roto. */}
                  <Status
                    value={item.status === "approved" ? "completed" : "paused"}
                    label={item.status === "approved" ? "resuelta" : "rechazada"}
                  />
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {item.roleProposal?.name ?? item.question ?? item.toolNames.join(", ")}
                </p>
                <p className="text-[10px] text-ink-faint">
                  {nombreDe(item.requestedByRoleId)} ·{" "}
                  {item.resolvedAt ? relativeTime(item.resolvedAt) : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function RequestCard({
  request,
  autor,
  company,
  onResolved,
}: {
  request: AgentRequest;
  autor: string;
  company: CompanyBundle;
  onResolved: (entrega: "bandeja" | "memoria" | "descartada") => void;
}) {
  // La propuesta es editable: el agente sugiere, la persona ajusta y acepta.
  const [propuesta, setPropuesta] = useState<RoleProposal | null>(request.roleProposal);
  const [respuesta, setRespuesta] = useState("");

  const resolver = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.resolveRequest(company.company.id, request.id, decision, respuesta, propuesta),
    onSuccess: (result) => onResolved(result.entrega),
  });

  const set = <K extends keyof RoleProposal>(key: K, value: RoleProposal[K]): void =>
    setPropuesta((previa) => (previa ? { ...previa, [key]: value } : previa));

  return (
    <li className="space-y-3 px-3 py-3">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-accent">
            {ICONO[request.type]} {ETIQUETA[request.type]}
          </span>
          <span className="text-[11px] text-ink-dim">pedido por {autor}</span>
          <span className="ml-auto text-[10px] text-ink-faint">
            {relativeTime(request.createdAt)}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink">{request.reason}</p>
      </div>

      {request.type === "create_role" && propuesta && (
        <div className="grid grid-cols-2 gap-3 rounded border border-line bg-canvas p-3">
          <Field label="Nombre">
            <input
              value={propuesta.name}
              onChange={(event) => set("name", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Cargo">
            <input
              value={propuesta.title}
              onChange={(event) => set("title", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Departamento" hint="Si no existe, se crea.">
            <input
              value={propuesta.departmentName}
              onChange={(event) => set("departmentName", event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Reporta a">
            <select
              value={propuesta.reportsToName ?? ""}
              onChange={(event) => set("reportsToName", event.target.value || null)}
              className={inputClass}
            >
              <option value="">— nadie —</option>
              {company.roles.map((role) => (
                <option key={role.id} value={role.name}>
                  {role.name} ({role.title})
                </option>
              ))}
            </select>
          </Field>
          <div className="col-span-2">
            <Field label="Instrucciones del rol">
              <textarea
                value={propuesta.systemPrompt}
                onChange={(event) => set("systemPrompt", event.target.value)}
                rows={5}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      )}

      {request.type === "tool_access" && (
        <div className="rounded border border-line bg-canvas p-2">
          <div className="mb-1 text-[10px] font-semibold tracking-wide text-ink-dim uppercase">
            Herramientas pedidas
          </div>
          <div className="flex flex-wrap gap-1">
            {request.toolNames.map((name) => {
              const existe = company.tools.some((tool) => tool.name === name);
              return (
                <span
                  key={name}
                  title={existe ? "" : "No existe en el catálogo: se ignora al aprobar"}
                  className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                    existe ? "bg-surface-2 text-ink-dim" : "bg-warn/20 text-warn"
                  }`}
                >
                  {name}
                  {existe ? "" : " ⚠"}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {request.type === "context" && (
        <div className="rounded border border-line bg-canvas p-2">
          <p className="text-xs text-ink">{request.question}</p>
        </div>
      )}

      <Field
        label={request.type === "context" ? "Tu respuesta" : "Comentario (opcional)"}
        hint={
          request.type === "context"
            ? "Le llega al agente a su bandeja y puede seguir trabajando con esto."
            : undefined
        }
      >
        <textarea
          value={respuesta}
          onChange={(event) => setRespuesta(event.target.value)}
          rows={request.type === "context" ? 4 : 2}
          className={inputClass}
        />
      </Field>

      {resolver.error && (
        <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
          {resolver.error.message}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => resolver.mutate("approve")}
          disabled={
            resolver.isPending || (request.type === "context" && !respuesta.trim())
          }
        >
          {request.type === "create_role"
            ? "crear el rol"
            : request.type === "tool_access"
              ? "otorgar acceso"
              : "responder"}
        </Button>
        <Button variant="danger" onClick={() => resolver.mutate("reject")} disabled={resolver.isPending}>
          rechazar
        </Button>
      </div>
    </li>
  );
}
