import { describe, expect, it } from "vitest";
import { RunState, type CompanyConfig } from "./state.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

function escenario() {
  const company = makeCompany();
  const dep = makeDepartment(company.id, "Operaciones");
  const jefe = makeRole(company.id, dep.id, "Ana", { title: "CEO", authority: "executive" });
  const empleado = makeRole(company.id, dep.id, "Bruno", {
    title: "Analista",
    authority: "executor",
    reportsTo: jefe.id,
  });
  const config: CompanyConfig = {
    company,
    departments: [dep],
    roles: [jefe, empleado],
    policies: [],
    tools: [],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings: [],
  };
  const run = makeRun(company.id, { objective: "Informe" });
  return { state: new RunState(run.id, config), jefe, empleado };
}

describe("pedidos sin responder", () => {
  it("los reencola y deja de insistir después del tope", async () => {
    const { state, jefe, empleado } = escenario();

    const pedido = await state.sendMessage({
      toRoleId: empleado.id,
      type: "request",
      subject: "informe",
      body: "necesito el informe",
      toDepartmentId: null,
      threadId: null,
      inReplyTo: null,
    }, jefe.id);

    // El empleado lo lee y se queda sin turnos: la bandeja queda vacía.
    state.drainInbox(empleado.id);
    expect(state.rolesWithWork()).not.toContain(empleado.id);

    // Sin el reenvío la corrida terminaría acá, con el pedido abierto.
    expect(state.reencolarSolicitudesSinResponder()).toBe(1);
    expect(state.rolesWithWork()).toContain(empleado.id);

    state.drainInbox(empleado.id);
    expect(state.reencolarSolicitudesSinResponder()).toBe(1);
    state.drainInbox(empleado.id);
    expect(state.reencolarSolicitudesSinResponder()).toBe(0); // se abandona

    // Y si contesta, no se reenvía más.
    const otro = await state.sendMessage({
      toRoleId: empleado.id,
      type: "request",
      subject: "otro",
      body: "y este",
      toDepartmentId: null,
      threadId: null,
      inReplyTo: null,
    }, jefe.id);
    state.drainInbox(empleado.id);
    await state.sendMessage({
      toRoleId: jefe.id,
      type: "response",
      subject: "listo",
      body: "ahí va",
      toDepartmentId: null,
      threadId: otro.threadId,
      inReplyTo: otro.id,
    }, empleado.id);
    expect(state.reencolarSolicitudesSinResponder()).toBe(0);
  });
});
