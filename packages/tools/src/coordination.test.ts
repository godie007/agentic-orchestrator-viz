import { describe, expect, it } from "vitest";
import { coordinationTools } from "./coordination.js";
import type { AgentWorkspace, RegisteredTool, ToolContext } from "./types.js";

/**
 * Las herramientas de coordinación son el único canal por el que la empresa
 * actúa, así que un argumento faltante no puede pasar como éxito: produciría un
 * entregable vacío o un mensaje sin cuerpo, y el agente nunca se enteraría.
 */

const tool = (name: string): RegisteredTool =>
  coordinationTools.find((candidate) => candidate.name === name)!;

/** Workspace que falla si alguien intenta escribir: nada debería llegar acá. */
const strictWorkspace = new Proxy({} as AgentWorkspace, {
  get(_target, property) {
    if (property === "roles" || property === "departments") return [];
    return () => {
      throw new Error(`No se esperaba una escritura: ${String(property)}`);
    };
  },
});

const ctx: ToolContext = {
  runId: "run_test",
  tick: 1,
  actor: {
    id: "rol_1",
    companyId: "cmp_1",
    departmentId: "dep_1",
    name: "Ana",
    title: "CEO",
    systemPrompt: "",
    model: {
      providerId: "openai",
      modelSlug: null,
      tier: "cheap",
      temperature: null,
      maxOutputTokens: 1024,
    },
    toolIds: [],
    authority: "executive",
    reportsTo: null,
    maxTurns: 4,
    spendApprovalThresholdUsd: null,
    position: { x: 0, y: 0 },
  },
  workspace: strictWorkspace,
  currentThreadId: "thr_1",
  currentMessageId: "msg_1",
  replyToRoleId: "rol_2",
};

describe("validación de argumentos obligatorios", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["write_artifact", { key: "propuesta" }, "title, content"],
    ["write_artifact", {}, "key, title, content"],
    ["send_message", { to: "Bruno", type: "request" }, "subject, body"],
    ["reply", {}, "body"],
    ["assign_task", { assignee: "Bruno" }, "title, detail"],
    ["escalate", { reason: "bloqueado" }, "detail"],
    ["request_approval", {}, "reason"],
  ];

  for (const [name, args, expectedMissing] of cases) {
    it(`${name} rechaza cuando faltan: ${expectedMissing}`, async () => {
      const result = await tool(name).execute(args, ctx);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(expectedMissing);
    });
  }

  it("avisa que los argumentos llegaron cortados cuando el JSON se truncó", async () => {
    // `__raw` lo pone el adaptador cuando el modelo agota max_tokens a mitad
    // del JSON. Sin este aviso el agente reintenta con el mismo texto largo.
    const result = await tool("write_artifact").execute({ __raw: '{"key": "prop' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("cortados");
  });

  it("una cadena en blanco cuenta como faltante", async () => {
    const result = await tool("write_artifact").execute(
      { key: "  ", title: "Título", content: "Texto" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("key");
  });
});

describe("un solo entregable por tema", () => {
  const workspaceCon = (keys: string[]): AgentWorkspace =>
    new Proxy({} as AgentWorkspace, {
      get(_t, prop) {
        if (prop === "roles" || prop === "departments") return [];
        if (prop === "listArtifacts")
          return async () => keys.map((key, i) => ({ key, title: `Doc ${i}`, version: 1 }));
        if (prop === "writeArtifact")
          return async (input: { key: string; title: string }) => ({
            ...input,
            id: "art_1",
            version: 1,
          });
        return () => {
          throw new Error(`no esperado: ${String(prop)}`);
        };
      },
    });

  const conArtefactos = (keys: string[]): ToolContext => ({
    ...ctx,
    workspace: workspaceCon(keys),
  });

  const variantes = [
    "propuesta-comercial-ciclo-3",
    "propuesta-comercial-v2",
    "propuesta_comercial_final",
    "propuesta-comercial-2",
  ];

  for (const variante of variantes) {
    it(`rechaza "${variante}" si ya existe "propuesta-comercial"`, async () => {
      const result = await tool("write_artifact").execute(
        { key: variante, title: "Propuesta", content: "…" },
        conArtefactos(["propuesta-comercial"]),
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain("propuesta-comercial");
      expect(result.content).toContain("versión siguiente");
    });
  }

  it("deja crear un documento genuinamente distinto", async () => {
    const result = await tool("write_artifact").execute(
      { key: "analisis-tecnico", title: "Análisis", content: "…" },
      conArtefactos(["propuesta-comercial"]),
    );
    expect(result.ok).toBe(true);
  });

  it("deja versionar reusando la misma clave", async () => {
    const result = await tool("write_artifact").execute(
      { key: "propuesta-comercial", title: "Propuesta", content: "…" },
      conArtefactos(["propuesta-comercial"]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("normalización de claves con marcadores en medio", () => {
  const workspaceCon = (keys: string[]): AgentWorkspace =>
    new Proxy({} as AgentWorkspace, {
      get(_t, prop) {
        if (prop === "roles" || prop === "departments") return [];
        if (prop === "listArtifacts")
          return async () => keys.map((key) => ({ key, title: "Doc", version: 1 }));
        if (prop === "writeArtifact")
          return async (input: { key: string }) => ({ ...input, id: "art_1", version: 1 });
        return () => {
          throw new Error("no esperado");
        };
      },
    });

  // Casos reales observados con el modelo económico.
  const observados = [
    "diagnostico-venta-ciclo2",
    "diagnostico-venta-ciclo3-final",
    "diagnostico-venta-ciclo5_v1",
    "diagnostico-venta-2",
  ];

  // Cuando el marcador no es un número el agente cuelga un sufijo descriptivo
  // del entregable anterior. Es el mismo tema partido en dos.
  const colgados = ["plan-paginacion-detalle", "plan-paginacion-tecnico-anexo"];

  for (const key of colgados) {
    it(`agrupa "${key}" con "plan-paginacion"`, async () => {
      const result = await tool("write_artifact").execute(
        { key, title: "Plan", content: "…" },
        { ...ctx, workspace: workspaceCon(["plan-paginacion"]) },
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain("plan-paginacion");
    });
  }

  it("no confunde dos claves que sólo comparten el arranque", async () => {
    // "plan-paginacion" no cuelga de "plan": son temas distintos, y el corte
    // tiene que ser en la frontera de guion, no en cualquier prefijo.
    const result = await tool("write_artifact").execute(
      { key: "planificacion-comercial", title: "Plan", content: "…" },
      { ...ctx, workspace: workspaceCon(["plan"]) },
    );
    expect(result.ok).toBe(true);
  });

  for (const key of observados) {
    it(`agrupa "${key}" con "diagnostico-venta"`, async () => {
      const result = await tool("write_artifact").execute(
        { key, title: "Diagnóstico", content: "…" },
        { ...ctx, workspace: workspaceCon(["diagnostico-venta"]) },
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain("diagnostico-venta");
    });
  }
});
