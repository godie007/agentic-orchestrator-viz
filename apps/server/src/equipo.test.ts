import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ids } from "@orq/shared";
import { ProviderRegistry } from "@orq/llm";
import { Store } from "./db.js";
import { Runtime } from "./runtime.js";
import type { Env } from "./env.js";

/**
 * Generar un equipo desde una plantilla tiene que dejar filas usables: roles
 * con `toolIds` que apuntan a herramientas reales (la lección del seed que
 * filtraba sólo capability y dejaba a los roles sin poder exportar), jerarquía
 * resuelta por nombre, y las herramientas que faltan **nombradas** en la
 * respuesta, nunca descartadas en silencio.
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

function proveedorFalso(id: "anthropic" | "openrouter") {
  return {
    id,
    label: id,
    listModels: async () => [],
    healthCheck: async () => ({ ok: true, detail: "" }),
    // eslint-disable-next-line require-yield
    chat: async function* () {
      throw new Error("no se usa");
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orq-equipo-"));
  store = new Store(join(dir, "test.sqlite"));
  const providers = new ProviderRegistry();
  providers.register(proveedorFalso("openrouter"));
  providers.register(proveedorFalso("anthropic"));
  runtime = new Runtime(store, providers, envDePrueba(dir));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function empresaVacia(): Promise<string> {
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
  return companyId;
}

describe("generarEquipo", () => {
  it("crea el equipo con toolIds válidos y jerarquía resuelta", async () => {
    const companyId = await empresaVacia();
    const resultado = await runtime.generarEquipo(companyId, "consultora");

    expect(resultado.roles.length).toBeGreaterThanOrEqual(3);

    const guardados = store.listRoles(companyId);
    expect(guardados.length).toBe(resultado.roles.length);

    // Todos los toolIds apuntan a filas reales del catálogo sembrado.
    const vigentes = new Set(store.listTools(companyId).map((tool) => tool.id));
    for (const rol of guardados) {
      for (const toolId of rol.toolIds) {
        expect(vigentes.has(toolId), `${rol.name} apunta a ${toolId}`).toBe(true);
      }
    }

    // La jerarquía se resolvió por nombre: hay un executive sin jefe y el
    // resto reporta a alguien que existe.
    const porId = new Map(guardados.map((rol) => [rol.id, rol]));
    const executive = guardados.find((rol) => rol.authority === "executive");
    expect(executive?.reportsTo).toBeNull();
    for (const rol of guardados) {
      if (rol.reportsTo != null) expect(porId.has(rol.reportsTo)).toBe(true);
    }

    // El escalado quedó activo con el proveedor preferido (anthropic gana
    // sobre openrouter).
    for (const rol of guardados) {
      expect(rol.model.providerId).toBe("anthropic");
      expect(rol.model.escalado?.activo).toBe(true);
      expect(rol.model.modelSlug).toBeNull();
    }
  });

  it("las habilidades quedaron incluidas: alguien puede exportar", async () => {
    const companyId = await empresaVacia();
    await runtime.generarEquipo(companyId, "consultora");

    const tools = store.listTools(companyId);
    const exportPdf = tools.find((tool) => tool.name === "export_pdf");
    expect(exportPdf).toBeDefined();
    const roles = store.listRoles(companyId);
    expect(roles.some((rol) => rol.toolIds.includes(exportPdf!.id))).toBe(true);
  });

  it("una plantilla desconocida falla con nombre y las faltantes se nombran", async () => {
    const companyId = await empresaVacia();
    await expect(runtime.generarEquipo(companyId, "no-existe")).rejects.toThrow(/no-existe/);

    // Las únicas herramientas que pueden faltar son las condicionadas al
    // entorno (API key de imágenes, navegador instalado): una habilidad que no
    // se puede cumplir no se registra, y la plantilla la nombra en vez de
    // callarla. Cualquier otro nombre faltante es un typo en la plantilla.
    const condicionadas = new Set([
      "generar_imagen",
      "revisar_lamina",
      "export_video_estudio",
      "grabar_clip",
      "export_video_clips",
      "extraer_cuadros",
    ]);
    const resultado = await runtime.generarEquipo(companyId, "estudio-audiovisual");
    for (const faltante of resultado.herramientasFaltantes) {
      expect(condicionadas.has(faltante), `"${faltante}" no existe en el registro`).toBe(true);
    }
    expect(resultado.mcpSugeridos.length).toBeGreaterThan(0);
  });
});
