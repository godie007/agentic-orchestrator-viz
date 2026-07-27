import { describe, expect, it } from "vitest";
import { ProviderRegistry, RunLedger } from "@orq/llm";
import { ToolRegistry, type RegisteredTool } from "@orq/tools";
import type { TraceEvent } from "@orq/shared";
import { EventBus } from "./events.js";
import { RunState, type CompanyConfig } from "./state.js";
import { podarSinRespuesta, presupuestoDeIteraciones, runAgentTurn } from "./loop.js";
import { FakeProvider } from "./testing/fake-provider.js";
import { makeCompany, makeDepartment, makeRole, makeRun } from "./testing/factory.js";

/**
 * Un agente que choca contra un error que no puede resolver —una ruta MCP fuera
 * del directorio permitido es el caso real que lo destapó— reintentaba la misma
 * llamada hasta agotar `maxTurns`. El turno se perdía entero: no delegaba, no
 * producía nada, y la corrida moría sin entregable.
 */

/** Herramienta que siempre falla igual, como un MCP con acceso denegado. */
function toolQueSiempreFalla(nombre = "leer_archivo"): RegisteredTool {
  return {
    name: nombre,
    description: "Lee un archivo.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    origin: "mcp",
    readOnly: true,
    requiresApproval: false,
    mcpServerId: "mcp_1",
    execute: async () => ({
      ok: false,
      content: "ERROR: Access denied - path outside allowed directories",
    }),
  };
}

function escenario(toolIds: string[] = ["tool_1"]) {
  const company = makeCompany();
  const dep = makeDepartment(company.id, "Tecnología");
  const agente = makeRole(company.id, dep.id, "Diego", { maxTurns: 10, toolIds });

  const config: CompanyConfig = {
    company,
    departments: [dep],
    roles: [agente],
    policies: [],
    tools: [
      {
        id: "tool_1",
        name: "leer_archivo",
        description: "Lee un archivo.",
        origin: "mcp",
        inputSchema: {},
        readOnly: true,
        requiresApproval: false,
        mcpServerId: "mcp_1",
      },
    ],
    mcpServers: [],
    requests: [],
    artifacts: [],
    learnings: [],
  };

  const run = makeRun(company.id);
  const state = new RunState(run.id, config);
  const bus = new EventBus();
  const eventos: TraceEvent[] = [];
  bus.subscribe((event) => eventos.push(event));

  const tools = new ToolRegistry();
  tools.register(toolQueSiempreFalla());

  return { agente, run, state, bus, eventos, tools };
}

describe("agente atascado en la misma llamada fallida", () => {
  it("corta el turno en vez de gastar las 10 iteraciones", async () => {
    const { agente, run, state, bus, eventos, tools } = escenario();

    // Insiste siempre con exactamente la misma llamada, como hacía el modelo.
    const provider = new FakeProvider(() => ({
      text: "Voy a leer el archivo.",
      toolCalls: [{ name: "leer_archivo", arguments: { path: "/fuera/del/alcance.ts" } }],
    }));
    const providers = new ProviderRegistry();
    providers.register(provider);

    const result = await runAgentTurn(state, agente, {
      bus,
      providers,
      tools,
      ledger: new RunLedger(10),
      objective: "Leer el código",
      maxTicks: 5,
    });

    // Antes llegaba a 10. Ahora se avisa a la tercera y se corta a la cuarta.
    expect(result.iterations).toBeLessThanOrEqual(4);
    expect(result.iterations).toBeLessThan(agente.maxTurns);

    const aviso = eventos.find(
      (event) => event.type === "log" && event.message.includes("mismo error"),
    );
    expect(aviso).toBeDefined();

    // Y el turno igual cierra bien: el nodo del organigrama no queda pensando.
    expect(eventos.some((event) => event.type === "agent.turn_end")).toBe(true);
  });

  it("le avisa al modelo en su contexto, no solo en el log", async () => {
    const { agente, run, state, bus, tools } = escenario();

    const provider = new FakeProvider(() => ({
      toolCalls: [{ name: "leer_archivo", arguments: { path: "/fuera/del/alcance.ts" } }],
    }));
    const providers = new ProviderRegistry();
    providers.register(provider);

    await runAgentTurn(state, agente, {
      bus,
      providers,
      tools,
      ledger: new RunLedger(10),
      objective: "Leer el código",
      maxTicks: 5,
    });

    // Avisar solo por el log no sirve: el modelo no lo ve y vuelve a intentar.
    const ultimaPeticion = provider.calls[provider.calls.length - 1]!;
    const frenada = ultimaPeticion.messages.find(
      (message) => message.role === "user" && message.content.includes("Frená"),
    );
    expect(frenada).toBeDefined();
    expect(frenada?.content).toContain("leer_archivo");
    expect(run.id).toBeTruthy();
  });

  it("le da aire al que cambia de argumentos, pero no infinito", async () => {
    const { agente, run, state, bus, tools } = escenario();

    // Probar rutas distintas es exploración legítima, así que no se corta a la
    // tercera como con la llamada idéntica. Pero si el error es siempre el
    // mismo, la pared no se mueve: a la quinta se lo frena igual.
    let i = 0;
    const provider = new FakeProvider(() => {
      i++;
      if (i > 5) return { text: "Listo, no puedo leerlo." };
      return {
        toolCalls: [{ name: "leer_archivo", arguments: { path: `/intento/${i}.ts` } }],
      };
    });
    const providers = new ProviderRegistry();
    providers.register(provider);

    const result = await runAgentTurn(state, agente, {
      bus,
      providers,
      tools,
      ledger: new RunLedger(10),
      objective: "Leer el código",
      maxTicks: 5,
    });

    expect(result.iterations).toBeGreaterThan(4);
    expect(result.iterations).toBeLessThanOrEqual(7);
    expect(run.id).toBeTruthy();
  });
});

/**
 * El ciclo termina cuando termina el último agente, así que un turno lento
 * bloquea a todos. Medimos una llamada de 649 segundos que dejó a tres agentes
 * esperando once minutos: sin corte por tiempo, un proveedor colgado le cuesta
 * a la empresa entera.
 */
describe("una llamada lenta no puede bloquear el ciclo", () => {
  /** Proveedor que nunca responde hasta que lo aborten. */
  function proveedorColgado(): ProviderRegistry & { intentos: () => number } {
    let intentos = 0;
    const provider = new FakeProvider(() => ({ text: "nunca llega" }));

    provider.chat = async function* (req) {
      intentos++;
      await new Promise((_, reject) => {
        req.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), {
          once: true,
        });
      });
      yield { type: "text_delta", text: "" } as never;
    } as typeof provider.chat;

    const registry = new ProviderRegistry();
    registry.register(provider);
    return Object.assign(registry, { intentos: () => intentos });
  }

  it("corta y reintenta en vez de esperar para siempre", async () => {
    const { agente, state, bus, tools } = escenario([]);
    const providers = proveedorColgado();

    const inicio = Date.now();
    await expect(
      runAgentTurn(state, agente, {
        bus,
        providers,
        tools,
        ledger: new RunLedger(10),
        objective: "x",
        maxTicks: 5,
        llmTimeoutMs: 60,
      }),
    ).rejects.toThrow();

    // Cortó por tiempo, no se quedó colgado.
    expect(Date.now() - inicio).toBeLessThan(20_000);
    // Y reintentó: un timeout es recuperable, a diferencia de un stop humano.
    expect(providers.intentos()).toBeGreaterThan(1);
  }, 30_000);

  it("un stop de la persona no se reintenta", async () => {
    const { agente, state, bus, tools } = escenario([]);
    const providers = proveedorColgado();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);

    await expect(
      runAgentTurn(state, agente, {
        bus,
        providers,
        tools,
        ledger: new RunLedger(10),
        objective: "x",
        maxTicks: 5,
        llmTimeoutMs: 10_000,
        signal: abort.signal,
      }),
    ).rejects.toThrow();

    // Detener la corrida significa detenerla, no reintentar cuatro veces.
    expect(providers.intentos()).toBe(1);
  }, 30_000);
});

describe("un turno cortado continúa, no reempieza", () => {
  it("guarda la conversación y la retoma en el ciclo siguiente", async () => {
    const { agente, state, bus, eventos, tools } = escenario();

    // Primera vuelta: ejecuta una herramienta y después el proveedor se cae.
    let llamadas = 0;
    const caido = new FakeProvider(() => {
      llamadas++;
      if (llamadas === 1) {
        return {
          text: "Empiezo por leer el archivo.",
          toolCalls: [{ name: "leer_archivo", arguments: { path: "/a.ts" } }],
        };
      }
      throw new Error("proveedor saturado");
    });
    const providers = new ProviderRegistry();
    providers.register(caido);

    await expect(
      runAgentTurn(state, agente, {
        bus,
        providers,
        tools,
        ledger: new RunLedger(10),
        objective: "Leer el código",
        maxTicks: 5,
      }),
    ).rejects.toThrow();

    const guardado = eventos.find(
      (event) => event.type === "log" && event.message.includes("queda guardado"),
    );
    expect(guardado).toBeDefined();

    // El rol sigue teniendo trabajo aunque su bandeja esté vacía: si no, nadie
    // lo volvería a convocar y la conversación guardada moriría ahí.
    expect(state.rolesWithWork()).toContain(agente.id);

    // Segunda vuelta: un proveedor sano retoma.
    const sano = new FakeProvider(() => ({ text: "Ya lo tenía leído; cierro." }));
    const providers2 = new ProviderRegistry();
    providers2.register(sano);

    const result = await runAgentTurn(state, agente, {
      bus,
      providers: providers2,
      tools,
      ledger: new RunLedger(10),
      objective: "Leer el código",
      maxTicks: 5,
    });

    expect(result.iterations).toBe(1);

    // La clave: el turno retomado arranca con lo que ya había hecho, no de cero.
    // Ojo: `messages` es el mismo array que el loop sigue usando, así que se
    // busca por contenido y no por posición.
    const contexto = sano.calls[0]!.messages;
    expect(contexto.some((m) => m.content.includes("Empiezo por leer el archivo"))).toBe(true);
    expect(contexto.some((m) => m.content.includes("se cortó antes de terminar"))).toBe(true);

    // Y ya no queda nada pendiente: el turno se consume una sola vez.
    expect(state.rolesWithWork()).not.toContain(agente.id);
  });

  it("no guarda una llamada a herramienta sin su resultado", () => {
    // El protocolo exige que a cada tool call le siga su resultado. Guardar la
    // cola sin responder haría fallar el retome con un 400, para siempre.
    const podada = podarSinRespuesta([
      { role: "user", content: "hola" },
      { role: "assistant", content: "leo", toolCalls: [{ id: "c1", name: "leer_archivo", arguments: {} }] },
    ]);
    expect(podada).toHaveLength(1);
  });
});

describe("presupuesto dinámico de iteraciones", () => {
  const rol = (maxTurns: number) => ({ maxTurns }) as never;

  it("le da más vueltas al que tiene más trabajo encima", () => {
    const liviano = presupuestoDeIteraciones(rol(8), {
      mensajes: 1,
      tareas: 0,
      caracteres: 500,
      reanudando: false,
    });
    const cargado = presupuestoDeIteraciones(rol(8), {
      mensajes: 5,
      tareas: 3,
      caracteres: 40_000,
      reanudando: false,
    });

    expect(cargado.base).toBeGreaterThan(liviano.base);
    expect(liviano.base).toBeGreaterThanOrEqual(8); // el del rol es el piso
    expect(cargado.techo).toBeLessThanOrEqual(50); // y el esquema es el techo
  });

  it("al retomar pide menos: ya se gastaron vueltas antes", () => {
    const entero = presupuestoDeIteraciones(rol(10), {
      mensajes: 2,
      tareas: 0,
      caracteres: 0,
      reanudando: false,
    });
    const retomado = presupuestoDeIteraciones(rol(10), {
      mensajes: 2,
      tareas: 0,
      caracteres: 0,
      reanudando: true,
    });
    expect(retomado.base).toBeLessThan(entero.base);
    expect(retomado.base).toBeGreaterThanOrEqual(3);
  });
});
