import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
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
  /** `true` si es la cima de la jerarquía: va al centro del organigrama. */
  alMando: boolean;
  /** Tono del área, en grados. */
  tono: number;
  department: Department | undefined;
  activity: DerivedState["roles"] extends Map<string, infer V> ? V | undefined : never;
  selected: boolean;
  inboxCount: number;
}

/**
 * Un color por área, repartidos por el ángulo áureo.
 *
 * Es la única señal que agrupa visualmente a los agentes de un área cuando
 * están sobre un anillo y dejaron de estar uno al lado del otro.
 *
 * El tono sale de la **posición** del departamento, no de un hash de su id:
 * hasheando, los ids de una misma empresa —que comparten prefijo y momento de
 * creación— caían en tonos casi iguales y las tres áreas se veían del mismo
 * violeta. Por índice, dos áreas nunca comparten color hasta pasar las 20.
 */
function tonosPorArea(departments: Department[]): Map<string, number> {
  return new Map(
    departments.map((department, i) => [department.id, Math.round((i * 137.508) % 360)]),
  );
}

/** Iniciales del nombre, hasta dos. "Diego Fernando Echeverry" → "DE". */
function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return `${partes[0]![0]}${partes[partes.length - 1]![0]}`.toUpperCase();
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { role, department, activity, selected, inboxCount, alMando } = data;
  const thinking = activity?.thinking ?? false;
  const tool = activity?.runningTool ?? null;
  const color = `oklch(0.72 0.14 ${data.tono})`;

  return (
    <div
      className={`relative w-52 rounded-xl border px-3 py-2.5 shadow-lg transition-all ${
        alMando ? "bg-surface-2" : "bg-surface"
      } ${thinking ? "is-thinking" : selected ? "border-accent/70" : "border-line"}`}
    >
      {/* Los anclajes van al centro y sin dibujar: en un organigrama radial las
          líneas salen en todas las direcciones, y clavarlas arriba y abajo
          hacía que las de los costados dieran una vuelta antes de llegar. */}
      <Handle
        type="target"
        position={Position.Top}
        className="!top-1/2 !left-1/2 !size-0 !border-0 !bg-transparent"
      />

      <div className="flex items-center gap-2.5">
        <div
          className={`relative grid shrink-0 place-items-center rounded-full font-semibold ${
            alMando ? "size-11 text-[15px]" : "size-9 text-[13px]"
          }`}
          style={{
            background: `color-mix(in oklch, ${color} 22%, transparent)`,
            color,
            boxShadow: `inset 0 0 0 1.5px color-mix(in oklch, ${color} 55%, transparent)`,
          }}
        >
          {iniciales(role.name)}
          {inboxCount > 0 && (
            <span
              title={`${inboxCount} mensajes sin leer`}
              className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-warn text-[9px] font-bold text-canvas"
            >
              {inboxCount > 9 ? "9+" : inboxCount}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-tight font-semibold text-ink">{role.name}</div>
          <div className="truncate text-[11px] leading-tight text-ink-dim">{role.title}</div>
        </div>
      </div>

      {/* La franja inferior es el estado: qué está ejecutando, o con qué modelo
          corre cuando está quieto. El área va como puntito de color, que ocupa
          menos que repetir el nombre del departamento en cada tarjeta. */}
      <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-1.5">
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: color }}
          title={department?.name ?? "sin área"}
        />
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

      <Handle
        type="source"
        position={Position.Bottom}
        className="!top-1/2 !left-1/2 !size-0 !border-0 !bg-transparent"
      />
    </div>
  );
}

/**
 * Los anillos de la jerarquía, dibujados detrás de todo.
 *
 * Sin ellos la disposición radial se lee como nodos desparramados: con cinco o
 * seis agentes, tres puntos sobre una circunferencia no alcanzan para que el
 * ojo complete el círculo. La guía hace visible que cada anillo es un escalón.
 */
function AnillosNode({ data }: NodeProps<Node<{ radios: number[] }>>) {
  const maximo = Math.max(...data.radios, 1);
  const ancho = maximo * 2 * ACHATADO;
  const alto = maximo * 2;
  return (
    <svg width={ancho} height={alto} className="pointer-events-none overflow-visible">
      {data.radios.map((radio, i) => (
        <ellipse
          key={radio}
          cx={ancho / 2}
          cy={alto / 2}
          rx={radio * ACHATADO}
          ry={radio}
          fill="none"
          stroke="var(--color-line)"
          strokeOpacity={0.9 - i * 0.18}
          strokeDasharray="2 8"
        />
      ))}
    </svg>
  );
}

const nodeTypes = { agent: AgentNode, anillos: AnillosNode };

/** Medidas del nodo (`w-52` = 208px) y separación mínima entre anillos. */
const ANCHO_NODO = 208;
const ALTO_NODO = 96;
/** Separación radial entre dos anillos: la altura de una tarjeta más aire. */
const PASO_ANILLO = 180;
/** Aire mínimo entre la tarjeta del centro y la del primer anillo. */
const CLARO = 70;
/**
 * Cuánto se estira el círculo a lo ancho.
 *
 * El lienzo es apaisado —ancho de sobra, alto justo— y una circunferencia
 * perfecta queda limitada por el alto: el encuadre la achica hasta que los
 * nombres no se leen y deja media pantalla vacía a los costados. Una elipse se
 * sigue leyendo como disposición radial y entra bastante más grande. Además
 * las tarjetas son más anchas que altas, así que el estiramiento va justo en
 * la dirección en que necesitan lugar.
 */
const ACHATADO = 1.5;

/**
 * Acomoda la empresa en anillos concéntricos alrededor de quien la dirige.
 *
 * La disposición dice algo: al centro está quien decide, y cada anillo hacia
 * afuera es un escalón de la jerarquía. Las líneas de reporte salen del centro
 * como radios, así que la estructura se lee de un vistazo sin seguir una sola
 * arista.
 *
 * Antes era un árbol en filas. Con cinco o seis roles se veía bien, pero a
 * partir de ahí la fila más ancha se iba de pantalla y el zoom para que
 * entrara dejaba los nombres ilegibles. Un anillo crece hacia los costados
 * **y** hacia arriba, así que aprovecha el lienzo en las dos direcciones.
 *
 * Cada rama se reparte el ángulo de su padre en proporción a cuántas hojas
 * cuelgan de ella: sin eso un jefe con seis reportes queda encimado al lado de
 * uno que tiene uno solo, y las aristas se cruzan.
 */
function radialLayout(roles: Role[]): {
  posiciones: Map<string, { x: number; y: number }>;
  radios: number[];
} {
  const posiciones = new Map<string, { x: number; y: number }>();
  if (roles.length === 0) return { posiciones, radios: [] };

  const porId = new Map(roles.map((role) => [role.id, role]));
  const hijosDe = new Map<string, Role[]>();
  const raices: Role[] = [];

  for (const role of roles) {
    const jefe = role.reportsTo ? porId.get(role.reportsTo) : undefined;
    // Un `reportsTo` que apunta a un rol borrado cuenta como raíz: el nodo
    // tiene que aparecer igual, no desaparecer del organigrama.
    if (!jefe || jefe.id === role.id) raices.push(role);
    else hijosDe.set(jefe.id, [...(hijosDe.get(jefe.id) ?? []), role]);
  }

  /** Hojas que cuelgan de un rol: es cuánto ángulo necesita su rama. */
  const hojas = new Map<string, number>();
  const contarHojas = (role: Role, visitados: Set<string>): number => {
    if (visitados.has(role.id)) return 1; // un ciclo en `reportsTo` no cuelga esto
    visitados.add(role.id);
    const hijos = hijosDe.get(role.id) ?? [];
    const total = hijos.length === 0
      ? 1
      : hijos.reduce((suma, hijo) => suma + contarHojas(hijo, visitados), 0);
    hojas.set(role.id, total);
    return total;
  };
  for (const raiz of raices) contarHojas(raiz, new Set());

  /**
   * Radio de cada anillo. Además del paso fijo, se abre lo necesario para que
   * los nodos del anillo no se toquen: con doce agentes en un mismo nivel, el
   * perímetro tiene que dar para doce tarjetas.
   */
  const enNivel = new Map<number, number>();
  const medirNivel = (role: Role, nivel: number, visitados: Set<string>): void => {
    if (visitados.has(role.id)) return;
    visitados.add(role.id);
    enNivel.set(nivel, (enNivel.get(nivel) ?? 0) + 1);
    for (const hijo of hijosDe.get(role.id) ?? []) medirNivel(hijo, nivel + 1, visitados);
  };
  const centrado = raices.length === 1;
  for (const raiz of raices) medirNivel(raiz, centrado ? 0 : 1, new Set());

  // Los radios se acumulan en vez de multiplicar por el nivel: cada anillo se
  // separa del anterior lo que necesita y nada más. Con un paso fijo por nivel,
  // un anillo de dos nodos ocupaba lo mismo que uno de doce y el conjunto salía
  // enorme para lo que mostraba.
  const radiosPorNivel = new Map<number, number>();
  const radioDe = (nivel: number): number => {
    if (nivel <= 0) return 0;
    const cacheado = radiosPorNivel.get(nivel);
    if (cacheado != null) return cacheado;

    const cuantos = enNivel.get(nivel) ?? 1;
    // El perímetro de la elipse tiene que alcanzar para todas las tarjetas del
    // anillo; se aproxima por el radio medio de los dos ejes.
    const perimetroNecesario = cuantos * (ANCHO_NODO + 40);
    const porPerimetro = perimetroNecesario / (Math.PI * (1 + ACHATADO));

    const radio = Math.max(
      nivel === 1 ? ANCHO_NODO + CLARO : radioDe(nivel - 1) + PASO_ANILLO,
      porPerimetro,
    );
    radiosPorNivel.set(nivel, radio);
    return radio;
  };

  // Se ubica cada rama dentro del sector angular que le tocó. El centro del
  // sector es el ángulo del nodo; sus hijos se reparten ese mismo sector.
  const ubicar = (
    role: Role,
    nivel: number,
    desde: number,
    hasta: number,
    visitados: Set<string>,
  ): void => {
    if (visitados.has(role.id)) return;
    visitados.add(role.id);

    const angulo = (desde + hasta) / 2;
    const radio = radioDe(nivel);
    posiciones.set(role.id, {
      // Se resta medio nodo porque React Flow posiciona por la esquina
      // superior izquierda, no por el centro: sin esto cada anillo queda
      // corrido media tarjeta y el círculo se ve deformado.
      x: Math.cos(angulo) * radio * ACHATADO - ANCHO_NODO / 2,
      y: Math.sin(angulo) * radio - ALTO_NODO / 2,
    });

    const hijos = hijosDe.get(role.id) ?? [];
    if (hijos.length === 0) return;

    // El ángulo se reparte por la **raíz cuadrada** de las hojas, no por las
    // hojas. Proporcional puro deja el círculo torcido apenas una rama es más
    // grande que la otra —con 2 hojas contra 1, una se llevaba 240° y la otra
    // 120°—; con la raíz la diferencia se nota pero el conjunto sigue leyéndose
    // como un círculo.
    const peso = (hijo: Role): number => Math.sqrt(hojas.get(hijo.id) ?? 1);
    const total = hijos.reduce((suma, hijo) => suma + peso(hijo), 0) || 1;
    let cursor = desde;
    for (const hijo of hijos) {
      const parte = (peso(hijo) / total) * (hasta - desde);
      ubicar(hijo, nivel + 1, cursor, cursor + parte, visitados);
      cursor += parte;
    }
  };

  const visitados = new Set<string>();
  if (centrado) {
    // Se arranca desde arriba (-90°) para que el primer reporte quede en la
    // parte alta del círculo y no a la derecha, que se lee peor.
    ubicar(raices[0]!, 0, -Math.PI / 2, Math.PI * 1.5, visitados);
  } else {
    const peso = (raiz: Role): number => Math.sqrt(hojas.get(raiz.id) ?? 1);
    const totalHojas = raices.reduce((suma, raiz) => suma + peso(raiz), 0) || 1;
    let cursor = -Math.PI / 2;
    for (const raiz of raices) {
      const parte = (peso(raiz) / totalHojas) * Math.PI * 2;
      ubicar(raiz, 1, cursor, cursor + parte, visitados);
      cursor += parte;
    }
  }

  // Los que quedaron fuera del recorrido —un ciclo cerrado sobre sí mismo— se
  // cuelgan del anillo exterior en vez de apilarse en el origen.
  const sueltos = roles.filter((role) => !posiciones.has(role.id));
  sueltos.forEach((role, i) => {
    const angulo = (i / Math.max(1, sueltos.length)) * Math.PI * 2;
    const radio = radioDe(enNivel.size + 1);
    posiciones.set(role.id, {
      x: Math.cos(angulo) * radio * ACHATADO - ANCHO_NODO / 2,
      y: Math.sin(angulo) * radio - ALTO_NODO / 2,
    });
  });

  const radios = [...enNivel.keys()]
    .filter((nivel) => nivel > 0)
    .sort((a, b) => a - b)
    .map(radioDe);

  return { posiciones, radios };
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
  const { posiciones, radios } = useMemo(() => radialLayout(roles), [roles]);
  const tonos = useMemo(() => tonosPorArea(departments), [departments]);

  /**
   * Los nodos se **actualizan**, no se rearman.
   *
   * React Flow mide cada nodo con un ResizeObserver y lo deja en
   * `visibility: hidden` hasta tener su tamaño. Si en cada render le pasás
   * objetos nuevos, pierde esa medición y vuelve a empezar: con la traza
   * llegando por SSE y la bandeja refrescándose cada 3s, nunca terminaba de
   * medir y **el organigrama quedaba invisible** — nodos en el DOM, ninguno en
   * pantalla—. Reusar el objeto anterior conserva `measured` y el nodo se
   * dibuja.
   */
  const [nodes, setNodes] = useNodesState<Node<AgentNodeData>>([]);

  useEffect(() => {
    setNodes((previos) => {
      const agentes = roles.map((role) => {
        const anterior = previos.find((nodo) => nodo.id === role.id);
        const data: AgentNodeData = {
          role,
          alMando: !role.reportsTo,
          tono: tonos.get(role.departmentId) ?? 250,
          department: departments.find((dep) => dep.id === role.departmentId),
          activity: state.roles.get(role.id),
          selected: role.id === selectedRoleId,
          inboxCount: inboxCounts.get(role.id) ?? 0,
        };
        const position = posiciones.get(role.id) ?? role.position;
        return anterior
          ? { ...anterior, position, data }
          : { id: role.id, type: "agent", position, data, zIndex: 1 };
      });

      if (radios.length === 0) return agentes as Node<AgentNodeData>[];

      // La guía es un nodo más —React Flow no tiene una capa de decoración—,
      // pero no se puede seleccionar ni arrastrar y va por debajo de todo.
      const maximo = Math.max(...radios);
      const anillos = {
        id: "__anillos",
        type: "anillos",
        position: { x: -maximo * ACHATADO, y: -maximo },
        data: { radios },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: 0,
      };
      return [anillos, ...agentes] as Node<AgentNodeData>[];
    });
  }, [roles, departments, tonos, state.roles, selectedRoleId, inboxCounts, posiciones, radios, setNodes]);

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = [];

    // Líneas de reporte: la estructura estable de la empresa.
    for (const role of roles) {
      if (!role.reportsTo) continue;
      const key = `${role.reportsTo}->${role.id}`;
      const reverse = `${role.id}->${role.reportsTo}`;
      const activeType = activeEdges.get(key) ?? activeEdges.get(reverse);
      // En radial las líneas son largas y cruzan el lienzo: con el gris del
      // borde se perdían contra el fondo y la estructura no se leía. Se tiñen
      // del color del área a la que van, que es la misma señal que el avatar.
      const tono = tonos.get(role.departmentId);
      const reposo = tono != null ? `oklch(0.62 0.09 ${tono})` : "var(--color-line)";
      result.push({
        id: `org-${role.id}`,
        source: role.reportsTo,
        target: role.id,
        type: "straight",
        className: activeType ? "edge-active" : "",
        // Sin flecha a propósito: los anclajes van al centro de la tarjeta, así
        // que la punta queda tapada por el nodo y no se ve. La dirección ya la
        // da la disposición —hacia adentro se manda, hacia afuera se reporta—.
        style: {
          stroke: activeType ? MESSAGE_COLOR[activeType] : reposo,
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
  }, [roles, activeEdges, tonos]);

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

  // Un cambio de empresa —o de disposición— trae otro conjunto de nodos: hay
  // que volver a encuadrar.
  //
  // Y hay que esperar a que React Flow los mida. `fitView` sobre nodos sin
  // medir encuadra sobre un tamaño de cero y deja la mitad de la empresa fuera
  // de pantalla; se ve como si el grafo estuviera corrido. Dos frames alcanzan:
  // uno para que el DOM exista y otro para que el ResizeObserver haya corrido.
  useEffect(() => {
    fitted.current = false;
    let frame = 0;
    const encuadrar = (intentos: number) => {
      frame = requestAnimationFrame(() => {
        refit();
        if (intentos > 0) encuadrar(intentos - 1);
      });
    };
    encuadrar(2);
    return () => cancelAnimationFrame(frame);
  }, [roles.length, posiciones, refit]);

  return (
    <div ref={container} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodeClick={(_, node) => node.id !== "__anillos" && onSelect(node.id)}
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
