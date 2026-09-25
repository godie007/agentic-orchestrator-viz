import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "@orq/shared";
import { armarEntorno, type EntornoDePrueba } from "./testing/entorno.js";

/**
 * Una conversación del chat del IDE: cada pedido es una corrida nueva, así que
 * lo anterior tiene que viajar en el mensaje o "ahora hacelo azul" no se
 * refiere a nada. Y una conversación nueva arranca limpia.
 */

let entorno: EntornoDePrueba;
beforeEach(() => {
  entorno = armarEntorno();
});
afterEach(() => entorno.cerrar());

function pedido(id: string, objetivo: string, conversacionId: string | undefined, startedAt: number, respuesta: string): void {
  const run: Run = {
    id,
    companyId: "cmp_x",
    objective: objetivo,
    status: "completed",
    mode: "continuous",
    tick: 1,
    maxTicks: 4,
    budgetUsd: 1,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt,
    endedAt: startedAt + 10,
    foco: { rolId: "rol_x", repoId: "rep_x", ...(conversacionId ? { conversacionId } : {}) },
  };
  entorno.store.saveRun(run);
  entorno.store.saveEvent({
    id: `evt_${id}`,
    runId: id,
    tick: 1,
    at: startedAt + 5,
    type: "agent.turn_end",
    roleId: "rol_x",
    iterations: 1,
    costUsd: 0,
    summary: respuesta,
  });
}

describe("historiaDeConversacion", () => {
  it("trae los pedidos de esa conversación, el más nuevo primero, y nada de las otras", () => {
    pedido("run_a", "Agregá un botón de exportar", "conv_uno", 1_000, "Agregué ExportButton en Header.tsx.");
    pedido("run_b", "Ahora hacelo azul", "conv_uno", 2_000, "Le puse bg-blue-600.");
    pedido("run_c", "Otra cosa", "conv_dos", 3_000, "Nada que ver.");

    const historia = entorno.runtime.historiaDeConversacion("cmp_x", "rep_x", "conv_uno", "run_nuevo");
    expect(historia).toContain("Ahora hacelo azul");
    expect(historia).toContain("Agregué ExportButton en Header.tsx.");
    expect(historia.indexOf("Ahora hacelo azul")).toBeLessThan(historia.indexOf("Agregá un botón"));
    expect(historia).not.toContain("Otra cosa");
    expect(historia.trim().endsWith("Pedido nuevo:")).toBe(true);
  });

  it("una conversación nueva no arrastra nada", () => {
    pedido("run_a", "Algo", "conv_uno", 1_000, "Hecho.");
    expect(entorno.runtime.historiaDeConversacion("cmp_x", "rep_x", "conv_nueva", "run_nuevo")).toBe("");
  });
});
