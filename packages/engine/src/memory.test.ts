import { describe, expect, it } from "vitest";
import { ProviderRegistry, RunLedger } from "@orq/llm";
import { ToolRegistry } from "@orq/tools";
import type { Learning } from "@orq/shared";
import { EventBus } from "./events.js";
import { RunState, type CompanyConfig, type Persistence } from "./state.js";
import { Orchestrator } from "./scheduler.js";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt.js";
import { FakeProvider, alreadyActed } from "./testing/fake-provider.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

/**
 * Memoria de la empresa y presión de cierre.
 *
 * Son los dos mecanismos que hacen que la empresa produzca algo en vez de
 * gastar el presupuesto conversando: uno evita re-derivar lo que ya se sabe, el
 * otro fuerza a converger en un entregable antes de quedarse sin margen.
 *
 * Todo corre con el proveedor falso: verificar esto no debe costar tokens.
 */

function scenario(learnings: Learning[] = []) {
  const company = makeCompany();
  const dep = makeDepartment(company.id, "Comercial");
  const role = makeRole(company.id, dep.id, "Ana", { authority: "executive" });
  const config: CompanyConfig = {
    company,
    departments: [dep],
    roles: [role],
    policies: [],
    tools: [],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings,
  };
  const run = makeRun(company.id, { maxTicks: 10, budgetUsd: 1 });
  return { company, role, run, config };
}

function learning(topic: string, lesson: string, overrides: Partial<Learning> = {}): Learning {
  const now = Date.now();
  return {
    id: `lrn_${topic}_${lesson.slice(0, 5)}`,
    companyId: "cmp_1",
    topic,
    lesson,
    authorRoleId: null,
    runId: null,
    timesConfirmed: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("memoria de la empresa", () => {
  it("lo aprendido entra en el prompt, sin que el agente gaste un turno en buscarlo", () => {
    const { role, run, config } = scenario([
      learning("precios", "La tarifa senior es US$45/hora."),
      learning("cliente:retail", "Retail prioriza continuidad operativa."),
    ]);
    const state = new RunState(run.id, config);

    const prompt = buildSystemPrompt(state, role, "Preparar una propuesta");

    expect(prompt).toContain("Lo que esta empresa ya aprendió");
    expect(prompt).toContain("US$45/hora");
    expect(prompt).toContain("continuidad operativa");
    // Agrupado por tema, para que el modelo lo lea como conocimiento y no como
    // una lista suelta de frases.
    expect(prompt).toContain("**precios**");
    expect(prompt).toContain("**cliente:retail**");
  });

  it("sin memoria no ensucia el prompt", () => {
    const { role, run, config } = scenario();
    const prompt = buildSystemPrompt(new RunState(run.id, config), role, "Objetivo");
    expect(prompt).not.toContain("Lo que esta empresa ya aprendió");
  });

  it("acota cuántas lecciones inyecta, priorizando las más reafirmadas", () => {
    // Una memoria que crece sin control costaría más tokens de los que ahorra.
    const many = Array.from({ length: 40 }, (_, index) =>
      learning("tema", `Lección número ${index}`, {
        id: `lrn_${index}`,
        timesConfirmed: index, // la 39 es la más reafirmada
      }),
    );
    const { role, run, config } = scenario(many);
    const prompt = buildSystemPrompt(new RunState(run.id, config), role, "Objetivo");

    expect(prompt).toContain("Lección número 39");
    expect(prompt).not.toContain("Lección número 0");
    expect(prompt).toContain("no se muestran");
  });

  it("acota la memoria por tamaño, no sólo por cantidad", () => {
    // Tres lecciones enormes entran en el tope de 25, pero solas ocupaban el
    // 54% del prompt del sistema y se reenviaban en cada llamada: medimos 825k
    // tokens en una corrida gastados en material ajeno al turno.
    const enormes = Array.from({ length: 3 }, (_, index) =>
      learning(`tema-${index}`, "L".repeat(5_000), {
        id: `lrn_${index}`,
        timesConfirmed: 10 - index,
      }),
    );
    const { role, run, config } = scenario(enormes);
    const prompt = buildSystemPrompt(new RunState(run.id, config), role, "Objetivo");

    const desde = prompt.indexOf("## Lo que esta empresa ya aprendió");
    const hasta = prompt.indexOf("\n## ", desde + 1);
    const memoria = prompt.slice(desde, hasta > 0 ? hasta : undefined);
    // Sin el tope esto eran 15.000 caracteres sólo de memoria.
    expect(memoria.length).toBeLessThan(2_500);
    expect(memoria).toContain("recortada");
  });

  it("registrar la misma lección la refuerza en vez de duplicarla", async () => {
    const saved: Learning[] = [];
    const persistence: Persistence = {
      saveMessage: () => {},
      saveTask: () => {},
      saveArtifact: () => {},
      saveApproval: () => {},
      saveRequest: () => {},
    saveRole: () => {},
      saveLearning: (value) => saved.push(value),
    };
    const { role, run, config } = scenario();
    const state = new RunState(run.id, config, persistence);
    const workspace = state.forActor(role.id);

    await workspace.recordLesson({ topic: "precios", lesson: "La tarifa senior es US$45/hora." });
    // Misma idea con otra puntuación y mayúsculas: sigue siendo la misma.
    const second = await workspace.recordLesson({
      topic: "Precios",
      lesson: "la tarifa senior es us$45/hora",
    });

    expect(state.learnings).toHaveLength(1);
    expect(second.timesConfirmed).toBe(2);
    expect(saved).toHaveLength(2); // se persiste el refuerzo, no una fila nueva
  });

  it("una lección registrada durante la corrida queda atribuida a su autor", async () => {
    const { role, run, config } = scenario();
    const state = new RunState(run.id, config);
    const registrada = await state
      .forActor(role.id)
      .recordLesson({ topic: "proceso", lesson: "Conviene validar precio antes de escribir." });

    expect(registrada.authorRoleId).toBe(role.id);
    expect(registrada.runId).toBe(run.id);
  });
});

describe("presión de cierre", () => {
  const { role, run, config } = scenario();
  const state = new RunState(run.id, config);

  const turnPrompt = (tick: number, spentUsd: number): string => {
    state.tick = tick;
    return buildTurnPrompt(state, role, [], [], {
      tick,
      maxTicks: 10,
      spentUsd,
      budgetUsd: 1,
    });
  };

  it("no molesta cuando sobra margen", () => {
    const prompt = turnPrompt(1, 0.05);
    expect(prompt).not.toContain("Queda poco margen");
    expect(prompt).not.toContain("Cerrá ahora");
  });

  it("avisa a mitad de camino que deje de abrir pedidos", () => {
    const prompt = turnPrompt(6, 0.6);
    expect(prompt).toContain("Queda poco margen");
    expect(prompt).toContain("Dejá de abrir pedidos nuevos");
  });

  it("exige el entregable cuando queda poco, aunque esté incompleto", () => {
    const prompt = turnPrompt(9, 0.92);
    expect(prompt).toContain("Cerrá ahora");
    expect(prompt).toContain("write_artifact");
    expect(prompt).toContain("parcial");
  });

  it("el presupuesto manda aunque sobren ciclos", () => {
    // Ciclo 1 de 10, pero ya se gastó el 95%: no alcanza para seguir explorando.
    const prompt = turnPrompt(1, 0.95);
    expect(prompt).toContain("Cerrá ahora");
  });
});

describe("la lección sobrevive a la corrida", () => {
  it("lo registrado se persiste con ámbito empresa, no corrida", async () => {
    const persisted: Learning[] = [];
    const { role, run, config } = scenario();
    const state = new RunState(run.id, config, {
      saveMessage: () => {},
      saveTask: () => {},
      saveArtifact: () => {},
      saveApproval: () => {},
      saveRequest: () => {},
    saveRole: () => {},
      saveLearning: (value) => persisted.push(value),
    });

    const provider = new FakeProvider((req) => {
      if (alreadyActed(req)) return { text: "Listo." };
      return {
        toolCalls: [
          {
            name: "record_lesson",
            arguments: {
              topic: "estimación",
              lesson: "Los módulos de integración con POS se subestiman siempre.",
            },
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
      toRoleId: role.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: "Trabajá y registrá lo aprendido.",
      threadId: null,
      inReplyTo: null,
    });
    await orchestrator.tick();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.companyId).toBe(config.company.id);
    expect(persisted[0]!.lesson).toContain("POS");

    // Y una corrida nueva de la misma empresa la recibe ya en su prompt.
    const siguiente = new RunState(
      "run_siguiente",
      { ...config, learnings: persisted },
    );
    expect(buildSystemPrompt(siguiente, role, "Otro encargo")).toContain("POS");
  });
});

describe("resiliencia", () => {
  it("un agente que falla no tumba la corrida: los demás siguen", async () => {
    // Con modelos gratuitos el proveedor se satura seguido. Que un rol pierda
    // su turno es aceptable; que la empresa entera se detenga, no.
    const company = makeCompany();
    const dep = makeDepartment(company.id, "Operaciones");
    const jefa = makeRole(company.id, dep.id, "Ana", { authority: "executive" });
    const sano = makeRole(company.id, dep.id, "Bruno", { reportsTo: jefa.id });
    const config: CompanyConfig = {
      company,
      departments: [dep],
      roles: [jefa, sano],
      policies: [],
      tools: [],
      mcpServers: [],
      learnings: [],
      requests: [],
      artifacts: [],
    };
    const run = makeRun(company.id, { maxTicks: 5, budgetUsd: 1 });
    const state = new RunState(run.id, config);
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((event) => {
      if (event.type === "log") events.push(event.message);
    });

    const provider = new FakeProvider((req) => {
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      // Ana siempre falla; Bruno trabaja normalmente.
      if (system.includes("Sos Ana")) throw new Error("Upstream error: ResourceExhausted");
      if (alreadyActed(req)) return { text: "Listo." };
      return {
        toolCalls: [
          {
            name: "write_artifact",
            arguments: { key: "informe", title: "Informe", content: "Contenido." },
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
      concurrency: 2,
    });

    for (const role of [jefa, sano]) {
      await state.forActor(null).sendMessage({
        toRoleId: role.id,
        toDepartmentId: null,
        type: "human",
        subject: "Encargo",
        body: "Trabajá.",
        threadId: null,
        inReplyTo: null,
      });
    }

    const result = await orchestrator.tick();

    // La corrida sigue viva y el agente sano produjo su entregable.
    expect(orchestrator.snapshot.status).not.toBe("failed");
    expect(state.artifacts).toHaveLength(1);
    expect(result.advanced).toBe(true);
    // Y el fallo quedó visible, no silenciado.
    expect(events.some((message) => message.includes("Ana no pudo completar"))).toBe(true);
  });
});

describe("estado visual del agente", () => {
  it("un turno que falla igual emite turn_end, para que el nodo deje de 'pensar'", async () => {
    // La UI enciende el nodo con `agent.thinking` y lo apaga con `agent.turn_end`.
    // Si un turno falla sin emitir el cierre, el agente queda pulsando para
    // siempre aunque la corrida haya terminado.
    const { role, run, config } = scenario();
    const state = new RunState(run.id, config);
    const bus = new EventBus();
    const tipos: string[] = [];
    bus.subscribe((event) => tipos.push(event.type));

    const provider = new FakeProvider(() => {
      throw new Error("OpenRouter: 402 Insufficient credits");
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
      toRoleId: role.id,
      toDepartmentId: null,
      type: "human",
      subject: "Encargo",
      body: "Trabajá.",
      threadId: null,
      inReplyTo: null,
    });
    await orchestrator.tick();

    expect(tipos).toContain("agent.thinking");
    expect(tipos).toContain("agent.turn_end");
    // Y el cierre va después del inicio, no antes.
    expect(tipos.lastIndexOf("agent.turn_end")).toBeGreaterThan(tipos.indexOf("agent.thinking"));
  });
});

describe("la empresa crece durante la corrida", () => {
  it("un rol incorporado empieza a trabajar y los demás lo ven", async () => {
    // Si el rol aprobado esperara a la corrida siguiente, quien lo pidió
    // seguiría bloqueado y volvería a proponerlo sin verlo entre sus colegas.
    const { role, run, config } = scenario();
    const state = new RunState(run.id, config);
    const bus = new EventBus();

    const nuevo = makeRole(config.company.id, config.departments[0]!.id, "Bruno", {
      reportsTo: role.id,
    });
    state.addRole(nuevo);

    // Aparece en la lista de colegas del prompt: sin eso el agente no puede escribirle.
    expect(buildSystemPrompt(state, role, "Objetivo")).toContain("Bruno");
    expect(state.roles).toHaveLength(2);

    // Y tiene bandeja propia: puede recibir trabajo en el ciclo siguiente.
    await state.forActor(role.id).sendMessage({
      toRoleId: nuevo.id,
      toDepartmentId: null,
      type: "request",
      subject: "Arrancá",
      body: "Tomá este trabajo.",
      threadId: null,
      inReplyTo: null,
    });
    expect(state.inbox(nuevo.id)).toHaveLength(1);
    expect(state.rolesWithWork()).toContain(nuevo.id);
    expect(bus).toBeDefined();
  });
});
