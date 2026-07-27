import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { Department, Role } from "@orq/shared";
import { MESSAGE_COLOR, type DerivedState } from "../lib/derive.js";

/**
 * El organigrama como escenario vivo.
 *
 * Los nodos son los agentes y pulsan mientras piensan; las aristas son las
 * líneas de reporte y se animan cuando un mensaje viaja por ellas. Es la
 * pantalla que responde "¿cómo trabaja esta empresa?" sin leer un solo log.
 */

interface AgentNodeData extends Record<string, unknown> {
  role: Role;
  department: Department | undefined;
  activity: DerivedState["roles"] extends Map<string, infer V> ? V | undefined : never;
  selected: boolean;
  inboxCount: number;
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { role, department, activity, selected, inboxCount } = data;
  const thinking = activity?.thinking ?? false;
  const tool = activity?.runningTool ?? null;

  return (
    <div
      className={`w-56 rounded-lg border bg-surface px-3 py-2 shadow-lg transition-all ${
        thinking ? "is-thinking" : selected ? "border-accent/60" : "border-line"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-line" />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">{role.name}</div>
          <div className="truncate text-[11px] text-ink-dim">{role.title}</div>
        </div>
        {inboxCount > 0 && (
          <span
            title={`${inboxCount} mensajes sin leer`}
            className="shrink-0 rounded-full bg-warn/20 px-1.5 py-0.5 text-[10px] font-semibold text-warn"
          >
            {inboxCount}
          </span>
        )}
      </div>

      {department && (
        <div className="mt-1 truncate text-[10px] text-ink-faint">{department.name}</div>
      )}

      {/* La franja inferior es el estado: qué modelo usa y qué está ejecutando. */}
      <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-1.5">
        {thinking ? (
          <span className="truncate text-[10px] font-medium text-accent">
            {tool ? `⚙ ${tool.replace(/^mcp__/, "")}` : "pensando…"}
          </span>
        ) : (
          <span className="truncate font-mono text-[10px] text-ink-faint">
            {activity?.modelSlug?.split("/").pop() ?? role.model.tier}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-line" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

/** Ancho del nodo (`w-56` = 224px) más aire, y separación entre niveles. */
const PASO_X = 260;
const PASO_Y = 150;

/**
 * Acomoda los agentes por jerarquía cuando sus posiciones guardadas se pisan.
 *
 * Un rol creado desde la UI o aprobado desde una propuesta nace en (0,0)
 * —nadie lo arrastró todavía—, así que la empresa entera se apilaba en el mismo
 * punto: el organigrama se veía vacío, o con un solo nodo encima del resto,
 * justo cuando aparece un agente nuevo y es cuando más importa verlo.
 *
 * Sólo interviene si hay posiciones repetidas. Si vos ya los moviste, respeta
 * lo que hiciste.
 */
function autoLayout(roles: Role[]): Map<string, { x: number; y: number }> {
  const posiciones = new Map<string, { x: number; y: number }>();
  const vistas = new Set(roles.map((role) => `${role.position.x},${role.position.y}`));
  if (vistas.size === roles.length) return posiciones;

  // Nivel = distancia a la cima. Un ciclo en `reportsTo` no puede colgar esto,
  // así que se corta al superar la cantidad de roles.
  const nivelDe = (role: Role): number => {
    let nivel = 0;
    let actual = role;
    while (actual.reportsTo && nivel <= roles.length) {
      const jefe = roles.find((candidate) => candidate.id === actual.reportsTo);
      if (!jefe) break;
      actual = jefe;
      nivel++;
    }
    return nivel;
  };

  const porNivel = new Map<number, Role[]>();
  for (const role of roles) {
    const nivel = nivelDe(role);
    porNivel.set(nivel, [...(porNivel.get(nivel) ?? []), role]);
  }

  for (const [nivel, pares] of porNivel) {
    // Cada fila se centra sobre el eje, para que el árbol quede simétrico.
    const desde = -((pares.length - 1) * PASO_X) / 2;
    pares.forEach((role, i) => {
      posiciones.set(role.id, { x: desde + i * PASO_X, y: nivel * PASO_Y });
    });
  }
  return posiciones;
}

export function OrgGraph({
  roles,
  departments,
  state,
  activeEdges,
  inboxCounts,
  selectedRoleId,
  onSelect,
}: {
  roles: Role[];
  departments: Department[];
  state: DerivedState;
  activeEdges: Map<string, string>;
  inboxCounts: Map<string, number>;
  selectedRoleId: string | null;
  onSelect: (roleId: string) => void;
}) {
  const posiciones = useMemo(() => autoLayout(roles), [roles]);

  const nodes = useMemo<Node<AgentNodeData>[]>(
    () =>
      roles.map((role) => ({
        id: role.id,
        type: "agent",
        position: posiciones.get(role.id) ?? role.position,
        data: {
          role,
          department: departments.find((dep) => dep.id === role.departmentId),
          activity: state.roles.get(role.id),
          selected: role.id === selectedRoleId,
          inboxCount: inboxCounts.get(role.id) ?? 0,
        },
      })),
    [roles, departments, state.roles, selectedRoleId, inboxCounts, posiciones],
  );

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = [];

    // Líneas de reporte: la estructura estable de la empresa.
    for (const role of roles) {
      if (!role.reportsTo) continue;
      const key = `${role.reportsTo}->${role.id}`;
      const reverse = `${role.id}->${role.reportsTo}`;
      const activeType = activeEdges.get(key) ?? activeEdges.get(reverse);
      result.push({
        id: `org-${role.id}`,
        source: role.reportsTo,
        target: role.id,
        type: "smoothstep",
        className: activeType ? "edge-active" : "",
        style: {
          stroke: activeType ? MESSAGE_COLOR[activeType] : "var(--color-line)",
          strokeWidth: activeType ? 2.5 : 1.5,
          color: activeType ? MESSAGE_COLOR[activeType] : undefined,
        },
      });
    }

    // Mensajes entre pares: no hay línea de reporte, pero la conversación
    // existe y tiene que verse, o la mitad de la coordinación queda invisible.
    const reporting = new Set(
      roles.flatMap((role) =>
        role.reportsTo ? [`${role.reportsTo}->${role.id}`, `${role.id}->${role.reportsTo}`] : [],
      ),
    );
    for (const [key, type] of activeEdges) {
      if (reporting.has(key)) continue;
      const [source, target] = key.split("->");
      if (!source || !target) continue;
      result.push({
        id: `flow-${key}`,
        source,
        target,
        type: "straight",
        className: "edge-active",
        animated: true,
        style: {
          stroke: MESSAGE_COLOR[type] ?? "var(--color-accent)",
          strokeWidth: 2,
          strokeDasharray: "4 4",
          color: MESSAGE_COLOR[type],
        },
      });
    }

    return result;
  }, [roles, activeEdges]);

  // `fitView` corre una sola vez, al inicializar. Si en ese momento el
  // contenedor todavía mide cero —pasa seguido dentro de un grid flexible— el
  // encuadre queda inválido y el lienzo se ve vacío aunque los nodos existan.
  // Se re-encuadra cuando el contenedor pasa a tener tamaño real.
  const container = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);
  const fitted = useRef(false);

  const refit = useCallback(() => {
    if (!instance) return;
    const box = container.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    instance.fitView({ padding: 0.15 });
    fitted.current = true;
  }, [instance]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!fitted.current) refit();
    });
    observer.observe(element);
    refit();
    return () => observer.disconnect();
  }, [refit]);

  // Un cambio de empresa trae otro conjunto de nodos: hay que volver a encuadrar.
  useEffect(() => {
    fitted.current = false;
    refit();
  }, [roles.length, refit]);

  return (
    <div ref={container} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        minZoom={0.25}
        className="bg-canvas"
      >
        <Background color="var(--color-line)" gap={20} size={1} />
        <Controls className="!border-line !bg-surface [&_button]:!border-line [&_button]:!bg-surface [&_button]:!fill-ink-dim" />
      </ReactFlow>
    </div>
  );
}
