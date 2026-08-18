import type { Run } from "@orq/shared";

/**
 * Cuánto lleva corriendo el encargo y si sigue dando señales.
 *
 * El tiempo solo no dice nada: una corrida puede llevar dos horas trabajando o
 * dos horas colgada, y desde afuera se ven igual. Lo que las distingue es
 * **hace cuánto pasó algo**, así que las dos cifras van juntas. Es la misma
 * pregunta que uno se hace mirando la traza a mano —"¿esto avanza?"— resuelta
 * de una vez.
 *
 * La función es pura y recibe `ahora`: así el contador se puede fijar con tests
 * en vez de depender del reloj, igual que la fecha del motor y el render de
 * documentos.
 */

export type Salud = "trabajando" | "callado" | "sin-señal" | "detenida";

/**
 * Cuándo un silencio empieza a ser sospechoso, en milisegundos.
 *
 * Los cortes salen de lo que tarda el trabajo real: una grabación de clip son
 * 20 a 100 segundos y un turno delegado entero puede pasar minutos entre
 * herramienta y herramienta. Avisar a los 30 segundos sería gritar todo el
 * tiempo; a los dos minutos ya es raro, y arriba de seis vale la pena mirar.
 */
const CALLADO_MS = 120_000;
const SIN_SENAL_MS = 360_000;

export interface Progreso {
  /** Cuánto lleva la corrida, ya formateado. */
  transcurrido: string;
  /** Hace cuánto se emitió el último evento, ya formateado. `null` si nunca. */
  desdeUltimaSenal: string | null;
  salud: Salud;
  /** Ciclo actual sobre el máximo, para ver el avance del encargo. */
  ciclo: string;
  /** Herramientas ejecutadas: el trabajo fino, que es lo que siempre ocurre. */
  acciones: number;
}

export function calcularProgreso(
  run: Run,
  progreso: { acciones: number; ultimaSenalAt: number | null } | null,
  viva: boolean,
  ahora: number,
): Progreso {
  // Una corrida terminada no sigue contando: su reloj se congela en el final.
  const hasta = run.endedAt ?? ahora;
  const silencio = progreso?.ultimaSenalAt != null ? ahora - progreso.ultimaSenalAt : null;

  return {
    transcurrido: duracion(Math.max(0, hasta - run.startedAt)),
    desdeUltimaSenal: silencio != null ? duracion(silencio) : null,
    salud: salud(viva, run.status, silencio),
    ciclo: `${run.tick}/${run.maxTicks}`,
    acciones: progreso?.acciones ?? 0,
  };
}

function salud(viva: boolean, status: Run["status"], silencio: number | null): Salud {
  if (!viva || status !== "running") return "detenida";
  if (silencio == null) return "trabajando";
  if (silencio > SIN_SENAL_MS) return "sin-señal";
  if (silencio > CALLADO_MS) return "callado";
  return "trabajando";
}

/**
 * Duración legible y **corta**: esto vive en una barra superior, no en un
 * informe. Bajo un minuto se cuentan segundos porque ahí la diferencia entre 5
 * y 50 es justamente lo que se está mirando.
 */
export function duracion(ms: number): string {
  const segundos = Math.floor(ms / 1000);
  if (segundos < 60) return `${segundos}s`;
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${minutos}m ${segundos % 60}s`;
  const horas = Math.floor(minutos / 60);
  return `${horas}h ${minutos % 60}m`;
}
