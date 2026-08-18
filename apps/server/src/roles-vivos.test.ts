import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ids, toolSchema } from "@orq/shared";
import { ProviderRegistry } from "@orq/llm";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import type { Env } from "./env.js";

/**
 * Lo que una persona edita en la configuración tiene que llegar a la corrida
 * que está andando.
 *
 * El caso medido: Brave instalado desde la tienda, conectado y `ready`, con sus
 * dos herramientas otorgadas a los tres roles. La base quedó impecable y la
 * corrida siguió sin verlas —congela el organigrama al arrancar— así que los
 * agentes gastaron el ciclo insistiendo con `web_search`, que su proveedor no
 * soporta, con el servidor que sí podía buscar al lado y con cero
 * invocaciones.
 */

let dir: string;
let store: Store;
let runtime: Runtime;

function envDePrueba(base: string): Env {
  return {
    port: 0,
    databaseUrl: join(base, "db.sqlite"),
    exportsDir: join(base, "exports"),
    musicaDir: join(base, "musica"),
    contextoDir: join(base, "contexto"),
    defaultBudgetUsd: 1,
    defaultMaxTicks: 10,
    agentConcurrency: 1,
    emailWebhookUrl: null,
    appUrl: "http://localhost:5173",
    apiUrl: "http://localhost:3001",
    misionTickMs: 60_000,
  };
}

function proveedorFalso() {
  return {
    id: "anthropic" as const,
    label: "anthropic",
    listModels: async () => [],
    healthCheck: async () => ({ ok: true, detail: "" }),
    // eslint-disable-next-line require-yield
    chat: async function* () {
      throw new Error("no se usa: la corrida arranca en modo manual");
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orq-roles-vivos-"));
  store = new Store(join(dir, "test.sqlite"));
  const providers = new ProviderRegistry();
  providers.register(proveedorFalso());
  runtime = new Runtime(store, providers, envDePrueba(dir));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function empresaConEquipo(): Promise<string> {
  const now = Date.now();
  const companyId = ids.company();
  store.saveCompany({
    id: companyId,
    name: "De prueba",
    mission: "",
    voz: { unaSolaVoz: false, pronunciacion: {} },
    marca: { acento: "#40a0f8", panel: "#232f4d", rotulos: false },
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: {
      providerId: "anthropic",
      modelSlug: null,
      tier: "standard",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    },
    createdAt: now,
    updatedAt: now,
  });
  await runtime.generarEquipo(companyId, "consultora");
  return companyId;
}

/** Una herramienta MCP recién descubierta, como la deja instalar la tienda. */
function herramientaDeMcp(companyId: string) {
  const tool = toolSchema.parse({
    id: ids.tool(),
    name: "mcp__brave__brave_web_search",
    origin: "mcp",
    description: "Búsqueda web de Brave.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    mcpServerId: ids.mcpServer(),
    readOnly: true,
  });
  store.saveTool(companyId, tool);
  return tool;
}

describe("actualizarRolEnCorridasVivas", () => {
  it("una herramienta otorgada desde la configuración llega a la corrida en curso", async () => {
    const companyId = await empresaConEquipo();
    const run = await runtime.startRun({
      companyId,
      objective: "Investigar el mercado",
      mode: "manual",
    });

    const tool = herramientaDeMcp(companyId);
    const rol = store.listRoles(companyId)[0]!;

    // La corrida arrancó antes de que existiera: no la conoce.
    const viva = runtime.active(run.id)!;
    expect(viva.state.tools.some((candidata) => candidata.id === tool.id)).toBe(false);

    // Es lo que hace la UI al asignarle la herramienta al rol.
    const otorgado = { ...rol, toolIds: [...rol.toolIds, tool.id] };
    store.saveRole(otorgado);
    expect(runtime.actualizarRolEnCorridasVivas(companyId, otorgado)).toBe(1);

    // Ahora está en el catálogo de la corrida y en las del rol: el agente la
    // ve en su próximo turno, sin esperar a la corrida siguiente.
    expect(viva.state.tools.some((candidata) => candidata.id === tool.id)).toBe(true);
    const enLaCorrida = viva.state.roles.find((candidato) => candidato.id === rol.id)!;
    expect(enLaCorrida.toolIds).toContain(tool.id);
  });

  it("no toca las corridas de otra empresa ni las que no tienen ese rol", async () => {
    const companyId = await empresaConEquipo();
    const otra = await empresaConEquipo();
    await runtime.startRun({ companyId: otra, objective: "Otro encargo", mode: "manual" });

    const tool = herramientaDeMcp(companyId);
    const rol = store.listRoles(companyId)[0]!;
    const otorgado = { ...rol, toolIds: [...rol.toolIds, tool.id] };

    // La empresa no tiene ninguna corrida viva: no hay nada que actualizar, y
    // la de la otra empresa no se toca.
    expect(runtime.actualizarRolEnCorridasVivas(companyId, otorgado)).toBe(0);
  });
});
