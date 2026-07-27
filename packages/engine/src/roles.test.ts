import { describe, expect, it } from "vitest";
import { ProviderRegistry, RunLedger } from "@orq/llm";
import { ToolRegistry } from "@orq/tools";
import { EventBus } from "./events.js";
import { RunState, noPersistence, type CompanyConfig } from "./state.js";
import { Orchestrator } from "./scheduler.js";
import { FakeProvider, actorOf, alreadyActed } from "./testing/fake-provider.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

/**
 * Borrar un agente desde la configuración tiene que sacarlo también de la
 * corrida en curso. Los roles se cargan al arrancar, así que sin esto el agente
 * eliminado sigue tomando turnos, gastando presupuesto y abriendo solicitudes
 * que ya no puede responder nadie.
 */

function escenario() {
  const company = makeCompany();
  const dep = makeDepartment(company.id, "Dirección");
  const jefa = makeRole(company.id, dep.id, "Ana", { authority: "executive" });
  const analista = makeRole(company.id, dep.id, "Bruno", { reportsTo: jefa.id });
  const becario = makeRole(company.id, dep.id, "Carla", { reportsTo: analista.id });

  const config: CompanyConfig = {
    company,
    departments: [dep],
    roles: [jefa, analista, becario],
    policies: [],
    tools: [],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings: [],
  };
  const run = makeRun(company.id);
  return { company, jefa, analista, becario, run, state: new RunState(run.id, config) };
}

describe("RunState.removeRole", () => {
  it("se lleva las solicitudes pendientes del agente eliminado", async () => {
    const { analista, jefa, state } = escenario();

    await state.forActor(analista.id).createRequest({
      type: "context",
      reason: "Necesito el precio por tenant",
      question: "¿Cuánto se factura por tenant?",
      roleProposal: null,
      toolNames: [],
    });
    await state.forActor(jefa.id).createRequest({
      type: "context",
      reason: "Necesito el ciclo de venta",
      question: "¿Cuánto dura el ciclo?",
      roleProposal: null,
      toolNames: [],
    });
    expect(state.requests).toHaveLength(2);

    state.removeRole(analista.id);

    // Solo se va la suya: la de Ana sigue esperando respuesta.
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.requestedByRoleId).toBe(jefa.id);
  });

  it("reasigna a quien le reportaba en vez de dejarlo apuntando al vacío", () => {
    const { jefa, analista, becario, state } = escenario();

    state.removeRole(analista.id);

    const carla = state.roles.find((role) => role.id === becario.id);
    expect(carla?.reportsTo).toBe(jefa.id);
    expect(state.roles.map((role) => role.id)).not.toContain(analista.id);
  });

  it("conserva los mensajes que ya había enviado", async () => {
    const { jefa, analista, state } = escenario();

    await state.forActor(analista.id).sendMessage({
      toRoleId: jefa.id,
      toDepartmentId: null,
      type: "report",
      subject: "Avance",
      body: "Voy por la mitad.",
      threadId: null,
      inReplyTo: null,
    });

    state.removeRole(analista.id);

    // Borrarlos dejaría hilos con respuestas sin pregunta: son historia.
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.fromRoleId).toBe(analista.id);
  });

  it("es inocuo si el rol ya no está", () => {
    const { analista, state } = escenario();
    state.removeRole(analista.id);
    expect(() => state.removeRole(analista.id)).not.toThrow();
    expect(state.roles).toHaveLength(2);
  });

  it("el agente eliminado deja de tomar turnos aunque tenga bandeja", async () => {
    const { jefa, analista, run, state } = escenario();

    const provider = new FakeProvider((req) => {
      if (alreadyActed(req)) return { text: "Listo." };
      return {
        toolCalls: [
          {
            name: "send_message",
            arguments: { to: "Ana", type: "report", subject: `de ${actorOf(req)}`, body: "." },
          },
        ],
      };
    });
    const providers = new ProviderRegistry();
    providers.register(provider);
    const orchestrator = new Orchestrator(run, state, {
      bus: new EventBus(),
      providers,
      tools: new ToolRegistry(),
      ledger: new RunLedger(run.budgetUsd),
    });

    await state.forActor(null).sendMessage({
      toRoleId: analista.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: "Informá a Ana.",
      threadId: null,
      inReplyTo: null,
    });

    // Se lo elimina con la bandeja cargada, antes de que llegue a su turno.
    state.removeRole(analista.id);
    await orchestrator.tick();

    expect(state.messages.filter((m) => m.fromRoleId === analista.id)).toHaveLength(0);
    expect(jefa.id).toBeTruthy();
  });
});

/**
 * Los entregables son de la empresa, no de la corrida.
 *
 * Antes el estado arrancaba vacío en cada corrida: un área no podía leer lo que
 * otra escribió la semana pasada, y al usar la misma clave empezaba de v1
 * pisando el historial. Es lo que hace que el trabajo se acumule en vez de
 * reescribirse.
 */
describe("entregables compartidos entre áreas", () => {
  const previo = (key: string, version: number, runId: string) => ({
    id: `art_${key}_${version}`,
    runId,
    key,
    title: "Informe de estado",
    contentType: "markdown" as const,
    content: "Lo que ya se había escrito.",
    version,
    authorRoleId: "rol_viejo",
    tick: 1,
    createdAt: Date.now() - 10_000,
  });

  function conPrevios(artifacts: ReturnType<typeof previo>[]) {
    const company = makeCompany();
    const dep = makeDepartment(company.id, "Dirección");
    const jefa = makeRole(company.id, dep.id, "Ana", { authority: "executive" });
    const config: CompanyConfig = {
      company,
      departments: [dep],
      roles: [jefa],
      policies: [],
      tools: [],
      mcpServers: [],
      requests: [],
      learnings: [],
      artifacts,
    };
    const run = makeRun(company.id);
    return { jefa, state: new RunState(run.id, config) };
  }

  it("otra área puede leer lo que se escribió antes", async () => {
    const { jefa, state } = conPrevios([previo("informe-estado", 2, "run_viejo")]);
    const leido = await state.forActor(jefa.id).readArtifact("informe-estado");
    expect(leido?.content).toBe("Lo que ya se había escrito.");
    expect(leido?.version).toBe(2);
  });

  it("versiona sobre lo existente en vez de volver a empezar de v1", async () => {
    const { jefa, state } = conPrevios([previo("informe-estado", 2, "run_viejo")]);

    const nuevo = await state.forActor(jefa.id).writeArtifact({
      key: "informe-estado",
      title: "Informe de estado",
      contentType: "markdown",
      content: "Actualizado este trimestre.",
    });

    // Pisar el historial con un v1 nuevo es exactamente lo que había que evitar.
    expect(nuevo.version).toBe(3);
  });

  it("distingue los de antes de los de ahora", async () => {
    const { jefa, state } = conPrevios([previo("informe-estado", 1, "run_viejo")]);
    await state.forActor(jefa.id).writeArtifact({
      key: "plan-nuevo",
      title: "Plan",
      contentType: "markdown",
      content: "x",
    });

    const listado = await state.forActor(jefa.id).listArtifacts();
    const porClave = new Map(listado.map((a) => [a.key, a]));

    // Sin esta marca el agente cree que lo escribió él y lo publica sin leerlo.
    expect(porClave.get("informe-estado")?.deOtraCorrida).toBe(true);
    expect(porClave.get("plan-nuevo")?.deOtraCorrida).toBe(false);
  });

  it("no vuelve a persistir lo que ya estaba guardado", () => {
    const guardados: string[] = [];
    const company = makeCompany();
    const dep = makeDepartment(company.id, "Dirección");
    const jefa = makeRole(company.id, dep.id, "Ana");
    const run = makeRun(company.id);

    new RunState(
      run.id,
      {
        company,
        departments: [dep],
        roles: [jefa],
        policies: [],
        tools: [],
        mcpServers: [],
        requests: [],
        learnings: [],
        artifacts: [previo("informe-estado", 2, "run_viejo")],
      },
      { ...noPersistence, saveArtifact: (a) => guardados.push(a.id) },
    );

    // Duplicarlos rompería el versionado y llenaría la base de copias.
    expect(guardados).toHaveLength(0);
  });
});
