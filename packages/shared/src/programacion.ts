/**
 * Cuándo le toca a una misión.
 *
 * Cálculo puro: entra una programación y un instante, sale el próximo disparo.
 * Vive acá y no en el servidor porque es una regla del dominio y porque así se
 * testea sin relojes ni timers —el bug clásico de un scheduler es que anda en la
 * máquina de quien lo escribió y no el domingo a medianoche—.
 *
 * Todo se resuelve en la **hora local del servidor**. Es lo que espera alguien
 * que escribe "todos los días a las 7": las 7 de su mañana, no UTC.
 */

import type { Programacion } from "./schema.js";

const MINUTO = 60_000;

const MS_POR_UNIDAD: Record<"minutos" | "horas" | "dias" | "semanas", number> = {
  minutos: MINUTO,
  horas: 60 * MINUTO,
  dias: 24 * 60 * MINUTO,
  semanas: 7 * 24 * 60 * MINUTO,
};

/**
 * Un campo de cron a los valores que acepta.
 *
 * Cubre `*`, `5`, `1-5`, `1,3,5`, `*∕15` y `1-9/2`, que es lo que la gente
 * escribe. Devuelve `null` si no lo entiende, y quien llama trata eso como
 * expresión inválida en vez de disparar a cualquier hora.
 */
function valoresDeCampo(campo: string, minimo: number, maximo: number): Set<number> | null {
  const valores = new Set<number>();

  for (const parte of campo.split(",")) {
    const [rango, pasoTexto] = parte.split("/");
    if (rango === undefined || rango === "") return null;

    const paso = pasoTexto === undefined ? 1 : Number(pasoTexto);
    if (!Number.isInteger(paso) || paso < 1) return null;

    let desde: number;
    let hasta: number;
    if (rango === "*") {
      desde = minimo;
      hasta = maximo;
    } else if (rango.includes("-")) {
      const [a, b] = rango.split("-");
      desde = Number(a);
      hasta = Number(b);
    } else {
      desde = Number(rango);
      hasta = pasoTexto === undefined ? desde : maximo;
    }

    if (!Number.isInteger(desde) || !Number.isInteger(hasta)) return null;
    if (desde < minimo || hasta > maximo || desde > hasta) return null;

    for (let valor = desde; valor <= hasta; valor += paso) valores.add(valor);
  }

  return valores.size > 0 ? valores : null;
}

interface Cron {
  minuto: Set<number>;
  hora: Set<number>;
  dia: Set<number>;
  mes: Set<number>;
  semana: Set<number>;
  /** `*` en día-del-mes o día-de-semana no restringe; un valor sí. */
  diaLibre: boolean;
  semanaLibre: boolean;
}

export function parseCron(expresion: string): Cron | null {
  const campos = expresion.trim().split(/\s+/);
  if (campos.length !== 5) return null;

  const [min, hor, dia, mes, sem] = campos as [string, string, string, string, string];
  const minuto = valoresDeCampo(min, 0, 59);
  const hora = valoresDeCampo(hor, 0, 23);
  const dias = valoresDeCampo(dia, 1, 31);
  const meses = valoresDeCampo(mes, 1, 12);
  // El 7 y el 0 son ambos domingo en las implementaciones de siempre.
  const semanas = valoresDeCampo(sem.replace(/\b7\b/g, "0"), 0, 6);
  if (!minuto || !hora || !dias || !meses || !semanas) return null;

  return {
    minuto,
    hora,
    dia: dias,
    mes: meses,
    semana: semanas,
    diaLibre: dia === "*",
    semanaLibre: sem === "*",
  };
}

/**
 * Si un instante cae dentro de la expresión.
 *
 * Con día-del-mes y día-de-semana los dos restringidos, cron dispara si se
 * cumple **cualquiera** de los dos, no los dos. Es contraintuitivo pero es el
 * comportamiento histórico, y cambiarlo haría que `0 0 1 * 1` —el primero del
 * mes o los lunes— no dispare casi nunca.
 */
function coincide(cron: Cron, fecha: Date): boolean {
  if (!cron.minuto.has(fecha.getMinutes())) return false;
  if (!cron.hora.has(fecha.getHours())) return false;
  if (!cron.mes.has(fecha.getMonth() + 1)) return false;

  const porDia = cron.dia.has(fecha.getDate());
  const porSemana = cron.semana.has(fecha.getDay());
  if (cron.diaLibre && cron.semanaLibre) return true;
  if (cron.diaLibre) return porSemana;
  if (cron.semanaLibre) return porDia;
  return porDia || porSemana;
}

/** Dos años de búsqueda alcanzan para cualquier expresión que dispare alguna vez. */
const MINUTOS_A_MIRAR = 2 * 366 * 24 * 60;

/**
 * El próximo disparo después de `desde`, o `null` si nunca dispararía.
 *
 * Siempre **estrictamente posterior** a `desde`: si no, una misión que acaba de
 * correr volvería a dispararse en el mismo minuto, para siempre.
 */
export function proximaCorrida(programacion: Programacion, desde: number = Date.now()): number | null {
  if (programacion.type === "intervalo") {
    return desde + programacion.cada * MS_POR_UNIDAD[programacion.unidad];
  }

  if (programacion.type === "semanal") {
    const dias = new Set(programacion.dias);
    // Se arranca del próximo minuto y se avanza día por día hasta encontrarlo.
    for (let salto = 0; salto <= 7; salto++) {
      const fecha = new Date(desde);
      fecha.setDate(fecha.getDate() + salto);
      fecha.setHours(programacion.hora, programacion.minuto, 0, 0);
      if (fecha.getTime() > desde && dias.has(fecha.getDay())) return fecha.getTime();
    }
    return null;
  }

  const cron = parseCron(programacion.expresion);
  if (!cron) return null;

  // Minuto a minuto: es lento de escribir pero imposible de equivocar, y sólo
  // corre cuando hay que recalcular el próximo disparo.
  const inicio = new Date(desde);
  inicio.setSeconds(0, 0);
  for (let i = 1; i <= MINUTOS_A_MIRAR; i++) {
    const fecha = new Date(inicio.getTime() + i * MINUTO);
    if (coincide(cron, fecha)) return fecha.getTime();
  }
  return null;
}

/** Cómo se lee una programación en pantalla. */
export function describirProgramacion(programacion: Programacion): string {
  if (programacion.type === "intervalo") {
    const { cada, unidad } = programacion;
    return cada === 1 ? `cada ${unidad.replace(/s$/, "")}` : `cada ${cada} ${unidad}`;
  }
  if (programacion.type === "semanal") {
    const nombres = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    const dias = [...programacion.dias].sort((a, b) => a - b).map((d) => nombres[d]);
    const hora = `${String(programacion.hora).padStart(2, "0")}:${String(programacion.minuto).padStart(2, "0")}`;
    const cuando =
      dias.length === 7
        ? "todos los días"
        : dias.length === 1
          ? `los ${dias[0]}`
          : `${dias.slice(0, -1).join(", ")} y ${dias.at(-1)}`;
    return `${cuando} a las ${hora}`;
  }
  return `cron: ${programacion.expresion}`;
}
