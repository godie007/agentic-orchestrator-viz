import { describe, expect, it } from "vitest";
import { ProviderRegistry, RunLedger } from "@orq/llm";
import { ToolRegistry, type RegisteredTool } from "@orq/tools";
import type { TraceEvent } from "@orq/shared";
import { EventBus } from "./events.js";
import { RunState, type CompanyConfig } from "./state.js";
import { runAgentTurn } from "./loop.js";
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
      (event) => event.type === "log" && event.message.includes("misma llamada fallida"),
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

  it("no corta cuando el agente cambia de argumentos", async () => {
    const { agente, run, state, bus, tools } = escenario();

    // Reintentar con otra ruta es corregirse, no atascarse: hay que dejarlo.
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

    expect(result.iterations).toBe(6);
    expect(run.id).toBeTruthy();
  });
});
