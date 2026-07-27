import { describe, expect, it } from "vitest";
import { ProviderRegistry, RunLedger } from "@orq/llm";
import { ToolRegistry } from "@orq/tools";
import type { TraceEvent } from "@orq/shared";
import { EventBus } from "./events.js";
import { RunState, type CompanyConfig } from "./state.js";
import { Orchestrator } from "./scheduler.js";
import { FakeProvider, actorOf, alreadyActed } from "./testing/fake-provider.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

/**
 * Checkpoint del motor: dos agentes se escriben, delegan y cierran el hilo.
 *
 * Corre con un proveedor falso, así que es determinista y no gasta tokens. Es
 * la prueba de que la coordinación funciona —bandejas, hilos, jerarquía y el
 * retardo de un ciclo entre enviar y recibir— sin depender de ningún LLM real.
 */

function buildScenario() {
  const company = makeCompany();
  const dirección = makeDepartment(company.id, "Dirección");
  const análisis = makeDepartment(company.id, "Análisis");

  const ceo = makeRole(company.id, dirección.id, "Ana", {
    title: "CEO",
    authority: "executive",
  });
  const analista = makeRole(company.id, análisis.id, "Bruno", {
    title: "Analista",
    authority: "executor",
    reportsTo: ceo.id,
  });

  const config: CompanyConfig = {
    company,
    departments: [dirección, análisis],
    roles: [ceo, analista],
    policies: [],
    tools: [],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings: [],
  };

  const run = makeRun(company.id, { objective: "Preparar el informe trimestral" });
  const state = new RunState(run.id, config);
  const bus = new EventBus();
  const events: TraceEvent[] = [];
  bus.subscribe((event) => events.push(event));

  return { company, ceo, analista, run, state, bus, events };
}

describe("Orchestrator", () => {
  it("delega y cierra el hilo en dos ciclos", async () => {
    const { ceo, analista, run, state, bus, events } = buildScenario();

    // El CEO delega en el primer turno; el analista responde cuando le llega.
    // Tras actuar, el turno termina: es lo que hace un modelo real, y sin eso
    // el guion repetiría la misma llamada hasta agotar maxTurns.
    const provider = new FakeProvider((req) => {
      if (alreadyActed(req)) return { text: "Listo." };
      const actor = actorOf(req);
      if (actor === "Ana") {
        return {
          text: "Le pido el análisis a Bruno.",
          toolCalls: [
            {
              name: "send_message",
              arguments: {
                to: "Bruno",
                type: "request",
                subject: "Análisis trimestral",
                body: "Necesito el análisis de ventas del trimestre.",
              },
            },
          ],
        };
      }
      if (actor === "Bruno") {
        return {
          text: "Respondo con el análisis.",
          toolCalls: [
            { name: "reply", arguments: { body: "Ventas +12% contra el trimestre anterior." } },
          ],
        };
      }
      return { text: "" };
    });

    const providers = new ProviderRegistry();
    providers.register(provider);

    const orchestrator = new Orchestrator(run, state, {
      bus,
      providers,
      tools: new ToolRegistry(),
      ledger: new RunLedger(run.budgetUsd),
      concurrency: 2,
    });

    // Arranca con un encargo de la persona a cargo al CEO.
    await state.forActor(null).sendMessage({
      toRoleId: ceo.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: "Prepará el informe trimestral.",
      threadId: null,
      inReplyTo: null,
    });

    // Ciclo 1: solo el CEO tiene bandeja; delega en Bruno.
    await orchestrator.tick();
    expect(state.inbox(analista.id)).toHaveLength(1);
    expect(state.inbox(ceo.id)).toHaveLength(0);

    // Ciclo 2: Bruno responde y el hilo del CEO se reabre con la respuesta.
    await orchestrator.tick();
    const respuesta = state.messages.find((message) => message.type === "response");
    expect(respuesta).toBeDefined();
    expect(respuesta?.fromRoleId).toBe(analista.id);
    expect(respuesta?.toRoleId).toBe(ceo.id);

    // La respuesta va en el mismo hilo que el pedido: es una conversación, no
    // dos mensajes sueltos.
    const pedido = state.messages.find(
      (message) => message.type === "request" && message.fromRoleId === ceo.id,
    );
    expect(respuesta?.threadId).toBe(pedido?.threadId);
    expect(pedido?.status).toBe("answered");

    // Y todo quedó visible en la traza, que es lo que dibuja la UI.
    const tipos = events.map((event) => event.type);
    expect(tipos).toContain("tick.start");
    expect(tipos).toContain("agent.thinking");
    expect(tipos).toContain("tool.selection");
    expect(tipos).toContain("tool.start");
    expect(tipos).toContain("agent.message");
    expect(tipos).toContain("cost.updated");
  });

  it("respeta la jerarquía: nadie asigna tareas fuera de su equipo", async () => {
    const { ceo, analista, run, state, bus } = buildScenario();

    // Bruno (executor, sin equipo) intenta asignarle una tarea a su jefa.
    const provider = new FakeProvider((req) => {
      if (alreadyActed(req)) return { text: "Listo." };
      if (actorOf(req) !== "Bruno") return { text: "" };
      return {
        toolCalls: [
          {
            name: "assign_task",
            arguments: { assignee: "Ana", title: "Revisar esto", detail: "..." },
          },
        ],
      };
    });

    const providers = new ProviderRegistry();
    providers.register(provider);
    const orchestrator = new Orchestrator(run, state, {
      bus,
      providers,
      tools: new ToolRegistry(),
      ledger: new RunLedger(run.budgetUsd),
    });

    await state.forActor(null).sendMessage({
      toRoleId: analista.id,
      toDepartmentId: null,
      type: "human",
      subject: "Prueba",
      body: "Probá asignar una tarea hacia arriba.",
      threadId: null,
      inReplyTo: null,
    });

    await orchestrator.tick();

    // La herramienta rechaza la llamada: la jerarquía se valida en código, no
    // solo en el prompt, así que el agente no puede saltearla.
    expect(state.tasks).toHaveLength(0);
    const toolResult = provider.calls
      .flatMap((call) => call.messages)
      .find((message) => message.role === "tool");
    expect(toolResult?.content).toContain("no te reporta");
    expect(ceo.id).toBeTruthy();
  });

  it("corta la corrida cuando se agota el presupuesto", async () => {
    const { ceo, run, state, bus } = buildScenario();

    const provider = new FakeProvider(() => ({
      toolCalls: [
        {
          name: "send_message",
          arguments: { to: "Bruno", type: "request", subject: "x", body: "y" },
        },
      ],
    }));
    const providers = new ProviderRegistry();
    providers.register(provider);

    // Presupuesto ínfimo: la primera llamada ya lo supera.
    const ledger = new RunLedger(0.0001);
    const orchestrator = new Orchestrator(run, state, {
      bus,
      providers,
      tools: new ToolRegistry(),
      ledger,
    });

    await state.forActor(null).sendMessage({
      toRoleId: ceo.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: "Hacé algo.",
      threadId: null,
      inReplyTo: null,
    });

    await orchestrator.tick();
    await orchestrator.tick();

    expect(orchestrator.snapshot.status).toBe("budget_exceeded");
    expect(orchestrator.snapshot.stopReason).toContain("Presupuesto agotado");
  });
});

describe("atribución de autoría con turnos en paralelo", () => {
  it("cada mensaje queda atribuido a quien realmente lo envió", async () => {
    // Regresión: el actor del turno vivía en un campo mutable de RunState. Con
    // varios turnos en paralelo —y muchos `await` entre que un turno empieza y
    // ejecuta sus herramientas— un agente pisaba el actor de otro, y los
    // mensajes quedaban firmados por el rol equivocado. Llegamos a ver mensajes
    // de un rol a sí mismo, que `send_message` rechaza explícitamente.
    const company = makeCompany();
    const dep = makeDepartment(company.id, "Operaciones");
    const jefa = makeRole(company.id, dep.id, "Ana", { authority: "executive" });
    const equipo = ["Bruno", "Carla", "Diego", "Elena"].map((name) =>
      makeRole(company.id, dep.id, name, { reportsTo: jefa.id }),
    );

    const config: CompanyConfig = {
      company,
      departments: [dep],
      roles: [jefa, ...equipo],
      policies: [],
      tools: [],
      mcpServers: [],
      learnings: [],
      requests: [],
      artifacts: [],
    };
    const run = makeRun(company.id);
    const state = new RunState(run.id, config);
    const bus = new EventBus();

    // Todos le escriben a Ana a la vez. El retardo desigual fuerza el
    // entrelazado de turnos que destapaba el bug.
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
      bus,
      providers,
      tools: new ToolRegistry(),
      ledger: new RunLedger(run.budgetUsd),
      concurrency: 4, // el bug solo aparece con turnos concurrentes
    });

    for (const role of equipo) {
      await state.forActor(null).sendMessage({
        toRoleId: role.id,
        toDepartmentId: null,
        type: "human",
        subject: "Arranque",
        body: "Informá a Ana.",
        threadId: null,
        inReplyTo: null,
      });
    }

    await orchestrator.tick();

    const informes = state.messages.filter((message) => message.type === "report");
    expect(informes).toHaveLength(equipo.length);

    // Nadie se escribe a sí mismo: eso era el síntoma visible del bug.
    expect(informes.filter((m) => m.fromRoleId === m.toRoleId)).toHaveLength(0);

    // Y el asunto —escrito por el agente— coincide con el emisor registrado.
    const nombre = (id: string | null): string =>
      config.roles.find((role) => role.id === id)?.name ?? "?";
    for (const informe of informes) {
      expect(informe.subject).toBe(`de ${nombre(informe.fromRoleId)}`);
    }
  });
});
