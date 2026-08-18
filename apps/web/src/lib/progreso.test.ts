import { describe, expect, it } from "vitest";
import type { Run } from "@orq/shared";
import { calcularProgreso, duracion } from "./progreso.js";

const AHORA = 1_800_000_000_000;

const corrida = (extra: Partial<Run> = {}): Run =>
  ({
    id: "run1",
    companyId: "c1",
    objective: "producir el video",
    status: "running",
    mode: "manual",
    tick: 3,
    maxTicks: 24,
    budgetUsd: 5,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: AHORA - 3_600_000,
    endedAt: null,
    ...extra,
  }) as Run;

describe("calcularProgreso", () => {
  it("cuenta desde que arrancó y muestra el ciclo", () => {
    const p = calcularProgreso(corrida(), { acciones: 264, ultimaSenalAt: AHORA - 5_000 }, true, AHORA);
    expect(p.transcurrido).toBe("1h 0m");
    expect(p.ciclo).toBe("3/24");
    expect(p.acciones).toBe(264);
    expect(p.desdeUltimaSenal).toBe("5s");
    expect(p.salud).toBe("trabajando");
  });

  it("un silencio corto no es alarma: una grabación de clip tarda hasta 100s", () => {
    const p = calcularProgreso(corrida(), { acciones: 10, ultimaSenalAt: AHORA - 90_000 }, true, AHORA);
    expect(p.salud).toBe("trabajando");
  });

  it("a los dos minutos avisa, y a los seis pide que alguien mire", () => {
    const callado = calcularProgreso(
      corrida(),
      { acciones: 10, ultimaSenalAt: AHORA - 180_000 },
      true,
      AHORA,
    );
    expect(callado.salud).toBe("callado");
    const mudo = calcularProgreso(
      corrida(),
      { acciones: 10, ultimaSenalAt: AHORA - 600_000 },
      true,
      AHORA,
    );
    expect(mudo.salud).toBe("sin-señal");
    expect(mudo.desdeUltimaSenal).toBe("10m 0s");
  });

  it("una corrida terminada congela su reloj en el final", () => {
    // Si siguiera contando, mañana diría que el encargo llevó veinte horas.
    const p = calcularProgreso(
      corrida({ status: "stopped", endedAt: AHORA - 3_000_000 }),
      { acciones: 5, ultimaSenalAt: AHORA - 3_000_000 },
      false,
      AHORA,
    );
    expect(p.transcurrido).toBe("10m 0s");
    expect(p.salud).toBe("detenida");
  });

  it("una corrida que no está viva en memoria no se dibuja como trabajando", () => {
    // Es la corrida que no sobrevivió a un reinicio: la base la muestra
    // `running` y en realidad no la está corriendo nadie.
    const p = calcularProgreso(corrida(), { acciones: 5, ultimaSenalAt: AHORA }, false, AHORA);
    expect(p.salud).toBe("detenida");
  });

  it("sin eventos todavía, no inventa un silencio", () => {
    const p = calcularProgreso(corrida(), { acciones: 0, ultimaSenalAt: null }, true, AHORA);
    expect(p.desdeUltimaSenal).toBeNull();
    expect(p.salud).toBe("trabajando");
  });
});

describe("duracion", () => {
  it("bajo un minuto cuenta segundos: ahí está la diferencia que se mira", () => {
    expect(duracion(5_000)).toBe("5s");
    expect(duracion(59_000)).toBe("59s");
  });

  it("después pasa a minutos y a horas", () => {
    expect(duracion(90_000)).toBe("1m 30s");
    expect(duracion(3_725_000)).toBe("1h 2m");
  });
});
