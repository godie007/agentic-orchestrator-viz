import { describe, expect, it } from "vitest";
import { ids } from "@orq/shared";
import type { Task } from "@orq/shared";
import { RunState, type CompanyConfig, type Persistence } from "./state.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

/**
 * Un encargo largo no entra en una sola corrida. Hasta acá, la corrida nueva
 * arrancaba con el tablero vacío: los entregables sobrevivían pero el trabajo
 * abierto no, así que nadie sabía qué había quedado a medias y el equipo
 * volvía a empezar. Estos tests fijan la adopción de tareas entre corridas.
 */

function tarea(runId: string, assigneeRoleId: string, overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: ids.task(),
    runId,
    title: "Grabar la escena 3",
    detail: "",
    assigneeRoleId,
    createdByRoleId: null,
    status: "in_progress",
    priority: "normal",
    dueTick: null,
    result: null,
    heredadaDeRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function escenario(tasks: Task[] = []) {
  const company = makeCompany();
  const dep = makeDepartment(company.id, "Producción");
  const agente = makeRole(company.id, dep.id, "Diego");

  const config: CompanyConfig = {
    company,
    departments: [dep],
    roles: [agente],
    policies: [],
    tools: [],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings: [],
    tasks,
  };

  const guardadas: Task[] = [];
  const persistence: Persistence = {
    saveMessage: () => undefined,
    saveTask: (task) => guardadas.push(task),
    saveArtifact: () => undefined,
    saveApproval: () => undefined,
    saveLearning: () => undefined,
    saveRequest: () => undefined,
    saveRole: () => undefined,
    saveTool: () => undefined,
  };

  const run = makeRun(company.id);
  const state = new RunState(run.id, config, persistence);
  return { state, agente, run, guardadas };
}

describe("tareas heredadas de una corrida anterior", () => {
  it("las adopta, recuerda de dónde vienen y las persiste", () => {
    const runAnterior = ids.run();
    const previa = tarea(runAnterior, "rol-x");
    const { state, guardadas, run } = escenario([{ ...previa, assigneeRoleId: "rol-x" }]);

    expect(state.tasks).toHaveLength(1);
    const adoptada = state.tasks[0]!;
    // Pasa a esta corrida —así el tablero de la UI la muestra— pero no olvida
    // de dónde viene: su dueño tiene que saber que no la abrió recién.
    expect(adoptada.runId).toBe(run.id);
    expect(adoptada.heredadaDeRunId).toBe(runAnterior);
    expect(adoptada.title).toBe(previa.title);
    // Cambió de dueño: hay que guardarla, al revés que los entregables.
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]?.runId).toBe(run.id);
  });

  it("una tarea que ya venía heredada conserva su origen original", () => {
    const primera = ids.run();
    const segunda = ids.run();
    const { state } = escenario([
      tarea(segunda, "rol-x", { heredadaDeRunId: primera }),
    ]);
    expect(state.tasks[0]?.heredadaDeRunId).toBe(primera);
  });

  it("no adopta lo que ya es de esta corrida", () => {
    const { state, run, guardadas } = escenario();
    // Simula el caso de una config que trae tareas de la corrida en curso.
    const otra = new RunState(run.id, {
      ...(state as unknown as { config: CompanyConfig })["config"],
      tasks: [tarea(run.id, "rol-x")],
    });
    expect(otra.tasks).toHaveLength(0);
    expect(guardadas).toHaveLength(0);
  });

  it("sin tareas previas el tablero arranca vacío", () => {
    const { state } = escenario();
    expect(state.tasks).toHaveLength(0);
  });

  it("el dueño de una tarea heredada tiene trabajo desde el primer ciclo", async () => {
    const { state, agente } = escenario();
    const config = (state as unknown as { config: CompanyConfig })["config"];
    const conTrabajo = new RunState(ids.run(), {
      ...config,
      tasks: [tarea(ids.run(), agente.id)],
    });
    // Es lo que hace que el scheduler lo convoque sin que nadie le escriba.
    expect(conTrabajo.rolesWithWork()).toContain(agente.id);
    expect(await conTrabajo.listTasks(agente.id)).toHaveLength(1);
  });
});
