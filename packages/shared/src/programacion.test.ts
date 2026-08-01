import { describe, expect, it } from "vitest";
import { describirProgramacion, parseCron, proximaCorrida } from "./programacion.js";

/**
 * Un scheduler que se equivoca no falla: dispara de más, de menos, o nunca, y
 * nadie se entera hasta que la misión no corrió el domingo. Todo lo que sigue usa
 * instantes fijos —no `Date.now()`— para que el resultado no dependa de cuándo
 * se corren los tests.
 */

/** Hora local, para que el caso se lea igual que se escribió. */
const local = (texto: string): number => new Date(texto).getTime();

describe("intervalo", () => {
  it("suma la unidad pedida", () => {
    const desde = local("2026-03-10T08:00:00");

    expect(proximaCorrida({ type: "intervalo", cada: 30, unidad: "minutos" }, desde)).toBe(
      local("2026-03-10T08:30:00"),
    );
    expect(proximaCorrida({ type: "intervalo", cada: 2, unidad: "horas" }, desde)).toBe(
      local("2026-03-10T10:00:00"),
    );
    expect(proximaCorrida({ type: "intervalo", cada: 1, unidad: "semanas" }, desde)).toBe(
      local("2026-03-17T08:00:00"),
    );
  });
});

describe("semanal", () => {
  const lunesYJueves = {
    type: "semanal" as const,
    dias: [1, 4],
    hora: 9,
    minuto: 30,
  };

  it("cae en el próximo día pedido, a la hora pedida", () => {
    // 2026-03-10 es martes: el próximo es el jueves 12.
    const proxima = proximaCorrida(lunesYJueves, local("2026-03-10T08:00:00"));

    expect(proxima).toBe(local("2026-03-12T09:30:00"));
  });

  it("si hoy es el día pero ya pasó la hora, salta a la próxima vuelta", () => {
    // Jueves 12 a las 10: la de las 9:30 ya pasó, sigue el lunes 16.
    const proxima = proximaCorrida(lunesYJueves, local("2026-03-12T10:00:00"));

    expect(proxima).toBe(local("2026-03-16T09:30:00"));
  });

  it("nunca devuelve el mismo instante: si no, se dispararía en bucle", () => {
    const justo = local("2026-03-12T09:30:00");

    expect(proximaCorrida(lunesYJueves, justo)).toBe(local("2026-03-16T09:30:00"));
  });

  it("todos los días es válido y cae al día siguiente", () => {
    const todos = { type: "semanal" as const, dias: [0, 1, 2, 3, 4, 5, 6], hora: 7, minuto: 0 };

    expect(proximaCorrida(todos, local("2026-03-10T08:00:00"))).toBe(local("2026-03-11T07:00:00"));
  });
});

describe("cron", () => {
  it("interpreta los cinco campos", () => {
    const proxima = proximaCorrida(
      { type: "cron", expresion: "0 7 * * *" },
      local("2026-03-10T08:00:00"),
    );

    expect(proxima).toBe(local("2026-03-11T07:00:00"));
  });

  it("acepta pasos y listas", () => {
    expect(
      proximaCorrida({ type: "cron", expresion: "*/15 * * * *" }, local("2026-03-10T08:02:00")),
    ).toBe(local("2026-03-10T08:15:00"));

    expect(
      proximaCorrida({ type: "cron", expresion: "0 9,18 * * *" }, local("2026-03-10T10:00:00")),
    ).toBe(local("2026-03-10T18:00:00"));
  });

  it("acepta rangos de día de semana", () => {
    // Sábado 14: el próximo día hábil es el lunes 16.
    const proxima = proximaCorrida(
      { type: "cron", expresion: "30 8 * * 1-5" },
      local("2026-03-14T12:00:00"),
    );

    expect(proxima).toBe(local("2026-03-16T08:30:00"));
  });

  it("el domingo se puede escribir 0 o 7", () => {
    const conCero = proximaCorrida(
      { type: "cron", expresion: "0 10 * * 0" },
      local("2026-03-10T08:00:00"),
    );
    const conSiete = proximaCorrida(
      { type: "cron", expresion: "0 10 * * 7" },
      local("2026-03-10T08:00:00"),
    );

    expect(conCero).toBe(local("2026-03-15T10:00:00"));
    expect(conSiete).toBe(conCero);
  });

  it("con día del mes y día de semana restringidos, dispara con cualquiera", () => {
    // Comportamiento histórico de cron: es un OR, no un AND. Con AND, esta
    // expresión —el primero del mes o los lunes— casi no dispararía.
    const proxima = proximaCorrida(
      { type: "cron", expresion: "0 0 1 * 1" },
      local("2026-03-10T08:00:00"),
    );

    expect(proxima).toBe(local("2026-03-16T00:00:00")); // el lunes que viene
  });

  it("una expresión inválida no dispara a cualquier hora: devuelve null", () => {
    for (const expresion of ["", "0 7 * *", "99 7 * * *", "0 7 * * ocho", "0 7 * * */0"]) {
      expect(proximaCorrida({ type: "cron", expresion }, local("2026-03-10T08:00:00"))).toBeNull();
    }
  });

  it("parseCron rechaza rangos dados vuelta", () => {
    expect(parseCron("0 18-9 * * *")).toBeNull();
  });
});

describe("describirProgramacion", () => {
  it("se lee sin explicación", () => {
    expect(describirProgramacion({ type: "intervalo", cada: 1, unidad: "horas" })).toBe("cada hora");
    expect(describirProgramacion({ type: "intervalo", cada: 6, unidad: "horas" })).toBe(
      "cada 6 horas",
    );
    expect(
      describirProgramacion({ type: "semanal", dias: [1], hora: 9, minuto: 0 }),
    ).toBe("los lunes a las 09:00");
    expect(
      describirProgramacion({ type: "semanal", dias: [1, 3, 5], hora: 7, minuto: 30 }),
    ).toBe("lunes, miércoles y viernes a las 07:30");
    expect(
      describirProgramacion({ type: "semanal", dias: [0, 1, 2, 3, 4, 5, 6], hora: 7, minuto: 0 }),
    ).toBe("todos los días a las 07:00");
  });
});
