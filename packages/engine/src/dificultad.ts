import type { ModelTier, Role } from "@orq/shared";

/**
 * Elección de tier por dificultad del turno.
 *
 * El modelo de un rol deja de ser fijo: si el rol tiene `escalado.activo`, el
 * motor mide qué tan cargado viene el turno y elige el tier dentro del rango
 * permitido. Un turno liviano —contestar un mensaje, cerrar una tarea— corre
 * con el modelo barato; uno pesado —bandeja llena, contexto largo, intentos
 * fallidos que hay que destrabar— sube al caro.
 *
 * Las señales son las mismas que ya consume `presupuestoDeIteraciones`: lo que
 * hace que un turno necesite más vueltas es lo mismo que hace que necesite un
 * modelo mejor. Es una función pura a propósito: se testea con números, sin
 * FakeProvider ni estado, y el motivo que devuelve va al evento
 * `model.selected` para que la elección nunca sea invisible.
 */

export interface SenialesDeDificultad {
  /** Mensajes en la bandeja del turno. */
  mensajes: number;
  /** Tareas abiertas del rol. */
  tareas: number;
  /** Largo del contexto de trabajo (objetivo + bandeja + tareas). */
  caracteres: number;
  autoridad: Role["authority"];
  /** El turno retoma uno interrumpido: ya hay conversación que sostener. */
  reanudando: boolean;
  /** Llamadas a herramienta fallidas consecutivas del rol. */
  fallosRecientes: number;
}

export interface EleccionDeTier {
  tier: ModelTier;
  puntaje: number;
  motivo: string;
}

const ORDEN: ModelTier[] = ["free", "cheap", "standard", "smart"];

function ordenDeTier(tier: ModelTier): number {
  return ORDEN.indexOf(tier);
}

/** Acota un tier al rango permitido por el rol. */
function acotar(tier: ModelTier, minimo: ModelTier, maximo: ModelTier): ModelTier {
  const orden = Math.min(Math.max(ordenDeTier(tier), ordenDeTier(minimo)), ordenDeTier(maximo));
  return ORDEN[orden]!;
}

export function elegirTierPorDificultad(
  seniales: SenialesDeDificultad,
  rango: { tierMinimo: ModelTier; tierMaximo: ModelTier },
): EleccionDeTier {
  // Un rango dado vuelta no tiene interpretación sensata: se normaliza en vez
  // de fallar, porque a esta altura ya no hay quien corrija el dato.
  const [minimo, maximo] =
    ordenDeTier(rango.tierMinimo) <= ordenDeTier(rango.tierMaximo)
      ? [rango.tierMinimo, rango.tierMaximo]
      : [rango.tierMaximo, rango.tierMinimo];

  let puntaje = 0;
  const razones: string[] = [];

  if (seniales.autoridad === "executive") {
    puntaje += 2;
    razones.push("autoridad executive");
  } else if (seniales.autoridad === "manager") {
    puntaje += 1;
    razones.push("autoridad manager");
  }

  if (seniales.mensajes >= 5) {
    puntaje += 2;
    razones.push(`bandeja cargada (${seniales.mensajes} mensajes)`);
  } else if (seniales.mensajes >= 2) {
    puntaje += 1;
    razones.push(`${seniales.mensajes} mensajes en bandeja`);
  }

  if (seniales.tareas >= 3) {
    puntaje += 1;
    razones.push(`${seniales.tareas} tareas abiertas`);
  }

  if (seniales.caracteres >= 20_000) {
    puntaje += 2;
    razones.push("contexto largo");
  } else if (seniales.caracteres >= 8_000) {
    puntaje += 1;
    razones.push("contexto mediano");
  }

  if (seniales.reanudando) {
    puntaje += 2;
    razones.push("retoma un turno interrumpido");
  }

  // Un modelo que viene fallando con la misma herramienta suele necesitar uno
  // mejor, no más intentos. Tope de 2: más fallos ya no dicen nada nuevo.
  const fallos = Math.min(seniales.fallosRecientes, 2);
  if (fallos > 0) {
    puntaje += fallos;
    razones.push(`${seniales.fallosRecientes} fallos recientes`);
  }

  // Cortes enteros y estables: las señales no oscilan dentro de una corrida
  // normal, así que el tier no "flapea" entre turnos vecinos.
  const crudo: ModelTier = puntaje >= 5 ? maximo : puntaje >= 2 ? "standard" : minimo;
  const tier = acotar(crudo, minimo, maximo);

  const resumen = razones.length > 0 ? razones.join(" + ") : "turno liviano";
  return {
    tier,
    puntaje,
    motivo: `${resumen} → ${tier} (puntaje ${puntaje}, rango ${minimo}..${maximo})`,
  };
}
