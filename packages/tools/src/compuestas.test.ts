import { describe, expect, it } from "vitest";
import type { Tool } from "@orq/shared";
import {
  crearToolCompuesta,
  createCrearHerramienta,
  extraerParametros,
} from "./compuestas.js";
import { fail, ok, type AgentWorkspace, type RegisteredTool, type ToolContext } from "./types.js";

/**
 * Las compuestas son las únicas herramientas cuyo comportamiento define un
 * agente, así que sus frenos no pueden vivir sólo en el prompt: acá se fija que
 * el ejecutor rechaza lo que escala permisos, lo que recursa y lo que se
 * quedaría esperando una aprobación por la mitad.
 */

const componente = (
  name: string,
  opciones: Partial<Pick<RegisteredTool, "origin" | "requiresApproval">> = {},
): RegisteredTool => ({
  name,
  origin: opciones.origin ?? "coordination",
  description: `herramienta ${name}`,
  inputSchema: { type: "object", properties: {} },
  readOnly: false,
  requiresApproval: opciones.requiresApproval ?? false,
  execute: async (args) => ok(`${name} ejecutada con ${JSON.stringify(args)}`),
});

const filaCompuesta = (pasos: Array<{ tool: string; args: Record<string, unknown> }>): Tool => ({
  id: "tool_compuesta",
  name: "informe_completo",
  origin: "creada",
  description: "Lee y exporta",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  mcpServerId: null,
  requiresApproval: false,
  readOnly: false,
  composicion: { pasos, creadaPorRoleId: "rol_1" },
});

function makeCtx(opciones: {
  authority?: "executive" | "manager" | "executor";
  toolIds?: string[];
  tools?: Tool[];
  incorporadas?: Tool[];
}): ToolContext {
  const incorporadas = opciones.incorporadas ?? [];
  const workspace = {
    tools: opciones.tools ?? [],
    mcpServers: [],
    roles: [],
    departments: [],
    incorporarHerramienta: (tool: Tool) => {
      incorporadas.push(tool);
    },
  } as unknown as AgentWorkspace;

  return {
    runId: "run_test",
    tick: 1,
    actor: {
      id: "rol_1",
      companyId: "cmp_1",
      departmentId: "dep_1",
      name: "Ana",
      title: "Directora",
      systemPrompt: "",
      model: {
        providerId: "openai",
        modelSlug: null,
        tier: "cheap",
        temperature: null,
        maxOutputTokens: 1024,
      },
      toolIds: opciones.toolIds ?? [],
      authority: opciones.authority ?? "executive",
      reportsTo: null,
      maxTurns: 4,
      spendApprovalThresholdUsd: null,
      position: { x: 0, y: 0 },
    },
    workspace,
    currentThreadId: null,
    currentMessageId: null,
    replyToRoleId: null,
  };
}

describe("extraerParametros", () => {
  it("encuentra los huecos anidados, en orden y sin repetir", () => {
    const parametros = extraerParametros({
      pasos: [
        { tool: "a", args: { key: "{{clave}}", meta: { titulo: "Informe {{mes}}" } } },
        { tool: "b", args: { lista: ["{{clave}}", "fijo"] } },
      ],
      creadaPorRoleId: null,
    });
    expect(parametros).toEqual(["clave", "mes"]);
  });
});

describe("ejecución de una compuesta", () => {
  const registro = new Map<string, RegisteredTool>([
    ["leer", componente("leer")],
    ["exportar", componente("exportar")],
  ]);
  const resolver = (name: string) => registro.get(name);

  it("sustituye los huecos y encadena los pasos en orden", async () => {
    const tool = crearToolCompuesta(
      filaCompuesta([
        { tool: "leer", args: { key: "{{clave}}" } },
        { tool: "exportar", args: { key: "{{clave}}", formato: "pdf" } },
      ]),
      resolver,
    );
    const resultado = await tool.execute({ clave: "propuesta" }, makeCtx({}));
    expect(resultado.ok).toBe(true);
    expect(resultado.content).toContain('[paso 1: leer]');
    expect(resultado.content).toContain('"key":"propuesta"');
    expect(resultado.content).toContain('[paso 2: exportar]');
  });

  it("rechaza la invocación si falta un parámetro", async () => {
    const tool = crearToolCompuesta(
      filaCompuesta([{ tool: "leer", args: { key: "{{clave}}" } }]),
      resolver,
    );
    const resultado = await tool.execute({}, makeCtx({}));
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("clave");
  });

  it("se detiene en el paso que falla y dice cuál fue", async () => {
    const conFalla = new Map(registro);
    conFalla.set("verificar", {
      ...componente("verificar"),
      execute: async () => fail("cifra sin fuente"),
    });
    const tool = crearToolCompuesta(
      filaCompuesta([
        { tool: "leer", args: {} },
        { tool: "verificar", args: {} },
        { tool: "exportar", args: {} },
      ]),
      (name) => conFalla.get(name),
    );
    const resultado = await tool.execute({}, makeCtx({}));
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("falló el paso 2 (verificar)");
    // El paso 3 no se ejecutó: un pipeline que sigue tras un fallo produce
    // basura con cara de éxito.
    expect(resultado.content).not.toContain("[paso 3");
  });

  it("nombra al componente que ya no está disponible", async () => {
    const tool = crearToolCompuesta(
      filaCompuesta([{ tool: "mcp__github__crear_issue", args: {} }]),
      () => undefined,
    );
    const resultado = await tool.execute({}, makeCtx({}));
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("mcp__github__crear_issue");
  });
});

describe("crear_herramienta: los frenos viven en el ejecutor", () => {
  const filaSkill: Tool = {
    id: "tool_pdf",
    name: "export_pdf",
    origin: "skill",
    description: "",
    inputSchema: {},
    mcpServerId: null,
    requiresApproval: false,
    readOnly: false,
    composicion: null,
  };

  const registro = new Map<string, RegisteredTool>([
    ["read_artifact", componente("read_artifact")],
    ["export_pdf", componente("export_pdf", { origin: "skill" })],
    ["borrar_todo", componente("borrar_todo", { requiresApproval: true })],
    ["ya_compuesta", componente("ya_compuesta", { origin: "creada" })],
  ]);
  const registradas: RegisteredTool[] = [];
  const crear = createCrearHerramienta({
    registrar: (tool) => registradas.push(tool),
    resolver: (name) => registro.get(name) ?? registradas.find((t) => t.name === name),
  });

  const pasosValidos = [
    { tool: "read_artifact", args: { key: "{{clave}}" } },
    { tool: "export_pdf", args: { key: "{{clave}}" } },
  ];

  it("un executor no crea herramientas", async () => {
    const resultado = await crear.execute(
      { name: "x", description: "y", pasos: pasosValidos },
      makeCtx({ authority: "executor" }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("request_tool_access");
  });

  it("no compone lo que el creador no tiene asignado", async () => {
    const resultado = await crear.execute(
      { name: "informe", description: "lee y exporta", pasos: pasosValidos },
      makeCtx({ tools: [filaSkill], toolIds: [] }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("export_pdf");
  });

  it("no acepta pasos que requieren aprobación humana", async () => {
    const resultado = await crear.execute(
      { name: "limpieza", description: "borra", pasos: [{ tool: "borrar_todo", args: {} }] },
      makeCtx({}),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("aprobación");
  });

  it("no acepta compuestas de compuestas", async () => {
    const resultado = await crear.execute(
      { name: "meta", description: "recursa", pasos: [{ tool: "ya_compuesta", args: {} }] },
      makeCtx({}),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("compuesta");
  });

  it("crea, registra en vivo y persiste vía el workspace", async () => {
    const incorporadas: Tool[] = [];
    const resultado = await crear.execute(
      { name: "Informe-Completo", description: "lee y exporta", pasos: pasosValidos },
      makeCtx({ tools: [filaSkill], toolIds: ["tool_pdf"], incorporadas }),
    );
    expect(resultado.ok).toBe(true);
    // El nombre se normaliza al formato de las demás herramientas.
    expect(registradas.some((tool) => tool.name === "informe_completo")).toBe(true);
    expect(incorporadas).toHaveLength(1);
    expect(incorporadas[0]!.origin).toBe("creada");
    expect(incorporadas[0]!.composicion?.pasos).toHaveLength(2);
    // Los parámetros abiertos quedan declarados en el esquema, con la puerta
    // cerrada: es lo que hace funcionar al memo de lecturas del loop.
    expect(incorporadas[0]!.inputSchema).toMatchObject({
      required: ["clave"],
      additionalProperties: false,
    });
  });

  it("rechaza un nombre que ya existe", async () => {
    const resultado = await crear.execute(
      { name: "read_artifact", description: "otra", pasos: pasosValidos },
      makeCtx({ tools: [filaSkill], toolIds: ["tool_pdf"] }),
    );
    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("Ya existe");
  });
});
