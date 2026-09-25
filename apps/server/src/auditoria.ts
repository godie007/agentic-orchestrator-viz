import type { TraceEvent } from "@orq/shared";

/**
 * Auditoría procedimental de una corrida.
 *
 * El motor y la UI evalúan el *artefacto*: ¿el entregable quedó bien armado?
 * Esto evalúa la *trayectoria*: ¿el proceso que lo produjo fue el que dice
 * haber sido? Un resultado correcto por un proceso corrupto es tan grave como
 * uno incorrecto y no se ve mirando sólo el artefacto — nos pasó de verdad: un
 * rol con `export_pdf` asignada dejó un `INSTRUCCIONES-PDF.txt` pidiéndole a
 * una persona que imprimiera a mano, e informó la tarea como completada. La
 * corrida terminó "exitosa", el entregable no existía, y nadie lo hubiera
 * notado sin mirar qué herramientas se ejecutaron de verdad.
 *
 * Todo acá es puro: recibe la traza ya persistida (`Store.listEvents`) y no
 * toca la base ni la red, para poder auditar corridas viejas y para que se
 * pueda testear sin `FakeProvider` ni fixtures pesadas.
 */

export interface Hallazgo {
  regla: string;
  severidad: "alta" | "media" | "info";
  tick: number | null;
  roleId: string | null;
  detalle: string;
}

export interface InformeAuditoria {
  hallazgos: Hallazgo[];
  metricas: {
    llamadas: number;
    fallidas: number;
    porRol: Record<string, { llamadas: number; fallidas: number }>;
  };
}

type ToolEnd = Extract<TraceEvent, { type: "tool.end" }>;
type TurnEnd = Extract<TraceEvent, { type: "agent.turn_end" }>;
type ModelSelected = Extract<TraceEvent, { type: "model.selected" }>;

/**
 * Heurística léxica: el summary de un turno "suena" a entrega. Da falsos
 * positivos (un agente que dice "ya envié el borrador para revisión" sin
 * haber ejecutado nada raro entra acá con razón, pero uno que narra un plan
 * futuro en tiempo casi-pasado también puede colarse) — por eso queda como
 * hallazgo para que una persona lo lea, no como un corte automático.
 */
const RX_DECLARA_ENTREGA =
  /entregu|export[eé]|complet[eé]|generad|listo el|termin[eé] (de |la |el )?(producir|generar|exportar)/i;

/** Nombres de herramienta de lectura: releerlas de más no produce nada nuevo. */
const HERRAMIENTAS_DE_LECTURA = new Set(["read_artifact", "fetch_url"]);

/** Exportar sin haber verificado las cifras es la falla que motivó este harness. */
const HERRAMIENTAS_DE_EXPORT = new Set(["export_pdf", "export_docx"]);

/**
 * a. turno-sin-modelo: un turno que cierra sin que el motor haya emitido
 * `model.selected` para ese rol en el mismo tick. `model.selected` se emite
 * en *todo* turno (ver CLAUDE.md) — si falta, algo se saltó el camino normal
 * del loop y el costo/modelo de ese turno queda sin explicar.
 */
function turnoSinModelo(eventos: TraceEvent[]): Hallazgo[] {
  const seleccionados = new Set(
    eventos
      .filter((e): e is ModelSelected => e.type === "model.selected")
      .map((e) => `${e.tick}:${e.roleId}`),
  );
  const hallazgos: Hallazgo[] = [];
  for (const e of eventos) {
    if (e.type !== "agent.turn_end") continue;
    if (seleccionados.has(`${e.tick}:${e.roleId}`)) continue;
    hallazgos.push({
      regla: "turno-sin-modelo",
      severidad: "media",
      tick: e.tick,
      roleId: e.roleId,
      detalle: "El turno terminó sin un evento model.selected previo del mismo rol en el mismo tick.",
    });
  }
  return hallazgos;
}

/**
 * b. exito-sin-respaldo (el corazón del harness): el summary declara una
 * entrega, pero ninguna herramienta de ese rol se ejecutó con éxito en el
 * mismo tick. Es exactamente el caso del INSTRUCCIONES-PDF.txt: el agente
 * "sabe" que tenía que exportar, lo cuenta como hecho, y no ejecutó nada que
 * lo respalde.
 */
function exitoSinRespaldo(eventos: TraceEvent[]): Hallazgo[] {
  const exitosPorTickYRol = new Set(
    eventos
      .filter((e): e is ToolEnd => e.type === "tool.end" && e.ok)
      .map((e) => `${e.tick}:${e.roleId}`),
  );
  const hallazgos: Hallazgo[] = [];
  for (const e of eventos) {
    if (e.type !== "agent.turn_end") continue;
    if (!e.summary || !RX_DECLARA_ENTREGA.test(e.summary)) continue;
    if (exitosPorTickYRol.has(`${e.tick}:${e.roleId}`)) continue;
    hallazgos.push({
      regla: "exito-sin-respaldo",
      severidad: "alta",
      tick: e.tick,
      roleId: e.roleId,
      detalle: `El resumen declara una entrega ("${e.summary.slice(0, 160)}") pero ninguna herramienta de este rol se ejecutó con éxito en el mismo tick.`,
    });
  }
  return hallazgos;
}

/**
 * c. export-sin-verificacion: un export_pdf/export_docx exitoso sin que antes,
 * en cualquier momento de la corrida y de cualquier rol, se haya visto un
 * verificar_cifras exitoso. La verificación es responsabilidad de la empresa,
 * no de un rol puntual: alcanza con que alguien la haya hecho.
 */
function exportSinVerificacion(eventos: TraceEvent[]): Hallazgo[] {
  const ends = eventos.filter((e): e is ToolEnd => e.type === "tool.end");
  const hallazgos: Hallazgo[] = [];
  let huboVerificacion = false;
  for (const e of ends) {
    if (e.ok && e.toolName === "verificar_cifras") {
      huboVerificacion = true;
      continue;
    }
    if (e.ok && HERRAMIENTAS_DE_EXPORT.has(e.toolName) && !huboVerificacion) {
      hallazgos.push({
        regla: "export-sin-verificacion",
        severidad: "alta",
        tick: e.tick,
        roleId: e.roleId,
        detalle: `${e.toolName} se ejecutó con éxito sin que antes hubiera un verificar_cifras exitoso en la corrida.`,
      });
    }
  }
  return hallazgos;
}

/**
 * d. tasa-de-fallos: un rol con al menos 5 llamadas y más del 30% fallidas.
 * Es informativa, no acusa nada por sí sola — un rol puede fallar mucho y
 * recuperarse bien —, pero es la primera señal a mirar cuando algo salió mal.
 */
function tasaDeFallos(eventos: TraceEvent[]): Hallazgo[] {
  const porRol = new Map<string, { llamadas: number; fallidas: number }>();
  for (const e of eventos) {
    if (e.type !== "tool.end") continue;
    const acc = porRol.get(e.roleId) ?? { llamadas: 0, fallidas: 0 };
    acc.llamadas += 1;
    if (!e.ok) acc.fallidas += 1;
    porRol.set(e.roleId, acc);
  }
  const hallazgos: Hallazgo[] = [];
  for (const [roleId, { llamadas, fallidas }] of porRol) {
    if (llamadas < 5) continue;
    const tasa = fallidas / llamadas;
    if (tasa > 0.3) {
      hallazgos.push({
        regla: "tasa-de-fallos",
        severidad: "info",
        tick: null,
        roleId,
        detalle: `${fallidas}/${llamadas} llamadas fallaron (${Math.round(tasa * 100)}%).`,
      });
    }
  }
  return hallazgos;
}

/**
 * e. relectura-repetida: el mismo rol, en el mismo tick, llamando a la misma
 * herramienta de lectura más de 6 veces. No es un error por sí solo — puede
 * ser un documento largo leído por secciones —, pero es la forma que tomó el
 * caso real de 534k tokens de entrada por un argumento de paginación
 * inventado (ver CLAUDE.md, "Un argumento inventado derrota al memo de
 * lecturas"): vale la pena señalarlo para que alguien lo mire.
 */
function relecturaRepetida(eventos: TraceEvent[]): Hallazgo[] {
  const conteo = new Map<string, number>();
  for (const e of eventos) {
    if (e.type !== "tool.end") continue;
    if (!HERRAMIENTAS_DE_LECTURA.has(e.toolName)) continue;
    const clave = `${e.tick}:${e.roleId}:${e.toolName}`;
    conteo.set(clave, (conteo.get(clave) ?? 0) + 1);
  }
  const hallazgos: Hallazgo[] = [];
  for (const [clave, veces] of conteo) {
    if (veces <= 6) continue;
    const [tick, roleId, toolName] = clave.split(":");
    hallazgos.push({
      regla: "relectura-repetida",
      severidad: "info",
      tick: Number(tick),
      roleId: roleId ?? null,
      detalle: `${toolName} se llamó ${veces} veces en el mismo tick.`,
    });
  }
  return hallazgos;
}

/** Cuenta llamadas y fallos totales y por rol, para el pie del informe. */
function calcularMetricas(eventos: TraceEvent[]): InformeAuditoria["metricas"] {
  const porRol: Record<string, { llamadas: number; fallidas: number }> = {};
  let llamadas = 0;
  let fallidas = 0;
  for (const e of eventos) {
    if (e.type !== "tool.end") continue;
    llamadas += 1;
    const acc = porRol[e.roleId] ?? { llamadas: 0, fallidas: 0 };
    acc.llamadas += 1;
    if (!e.ok) {
      fallidas += 1;
      acc.fallidas += 1;
    }
    porRol[e.roleId] = acc;
  }
  return { llamadas, fallidas, porRol };
}

export function auditarCorrida(eventos: TraceEvent[]): InformeAuditoria {
  const hallazgos = [
    ...turnoSinModelo(eventos),
    ...exitoSinRespaldo(eventos),
    ...exportSinVerificacion(eventos),
    ...tasaDeFallos(eventos),
    ...relecturaRepetida(eventos),
  ];
  return { hallazgos, metricas: calcularMetricas(eventos) };
}
