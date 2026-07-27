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

/**
 * Lo que hace que un PDF se vea pobre no es el maquetado sino lo que llega:
 * documentos sobre el propio proceso del agente, o un muro de texto sin una
 * sola sección. El render puede maquetar lo que reciba, pero no puede inventar
 * una estructura que no está.
 */
describe("un entregable tiene que parecer un documento", () => {
  const conArtefactos = (): ToolContext => ({
    ...ctx,
    workspace: new Proxy({} as AgentWorkspace, {
      get(_t, prop) {
        if (prop === "roles" || prop === "departments") return [];
        if (prop === "listArtifacts") return async () => [];
        if (prop === "writeArtifact")
          return async (input: { key: string }) => ({ ...input, id: "art_1", version: 1 });
        return () => {
          throw new Error("no esperado");
        };
      },
    }),
  });

  const escribir = (title: string, content: string) =>
    tool("write_artifact").execute({ key: "informe", title, content }, conArtefactos());

  const documento = [
    "# Informe de estado",
    "",
    "## Qué se puede prometer",
    "- Cobertura RETIE y RETILAP",
    "- Trazabilidad con firma",
    "",
    "## Qué falta",
    "1. Paginación en no conformidades",
  ].join("\n");

  it("acepta un documento con secciones y listas", async () => {
    expect((await escribir("Informe de estado", documento)).ok).toBe(true);
  });

  // Títulos observados de verdad, escritos por los agentes.
  const titulosDeProceso = [
    "Respuesta a pedido de exportación (Ciclo 4 - Bandeja de entrada)",
    "Informe estado - Ciclo 2 (calidad y demo)",
    "Seguimiento del pedido de Andrés",
  ];
  for (const titulo of titulosDeProceso) {
    it(`rechaza el título "${titulo.slice(0, 34)}…"`, async () => {
      const result = await escribir(titulo, documento);
      expect(result.ok).toBe(false);
      // El motivo tiene que decir qué hacer, no solo que está mal.
      expect(result.content).toMatch(/titulalo|resuelve/i);
    });
  }

  it("rechaza un muro de texto sin una sola sección", async () => {
    // Texto real de un entregable producido por la empresa: todo en punto y
    // coma, sin un título. Exportado a PDF se ve exactamente así de mal.
    const muro =
      "Estado técnico actual (verificable): flujos principales estables " +
      "(asignación→planificación→inspección offline→NC moderadas→cierre→PDF); offline-first " +
      "funcional; imágenes optimizadas; notificaciones en tiempo real; multi-tenant por plan " +
      "con límites; migración checklists hecha; verificar columns inspector_site_payload y " +
      "acta_payload antes de demos. Próximos pasos: implementar paginación para " +
      "non-conformities, documents, projects y equipos; monitoreo PDF alta concurrencia; " +
      "reglas de negocio en tabla regulations. Qué puede prometerse (respaldado): cobertura " +
      "RETIE/RETILAP; trazabilidad y firma PDF con audit trail; ciclo completo online con " +
      "modo offline; integración básica ERP; seguridad y auditoría por tenant.";
    const result = await escribir("Informe de estado", muro);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("sin estructura");
  });

  it("deja pasar una nota corta: no todo necesita secciones", async () => {
    expect((await escribir("Nota", "Confirmado con el cliente para el jueves.")).ok).toBe(true);
  });

  it("rechaza un párrafo interminable aunque haya secciones", async () => {
    const largo = ["# Informe", "", "## Detalle", "", "x".repeat(950)].join("\n");
    const result = await escribir("Informe", largo);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("sin cortes");
  });

  it("no confunde una tabla larga con un párrafo interminable", async () => {
    const tabla = [
      "# Planes",
      "",
      "| Cupo | Descripción |",
      "|---|---|",
      ...Array.from({ length: 40 }, (_, i) => `| cupo_${i} | Descripción larga del cupo ${i} |`),
    ].join("\n");

    expect((await escribir("Planes", tabla)).ok).toBe(true);
  });
});

/**
 * Un revisor que solo lee los mensajes revisa lo que los agentes *cuentan*.
 * La clase de error que más apareció es justo la otra: un agente ejecuta algo
 * con éxito y después informa que no pudo.
 */
describe("auditar lo que los agentes hicieron", () => {
  const actividad = [
    { roleId: "rol_2", tick: 3, tool: "export_pdf", ok: true, detail: "informe.pdf" },
    { roleId: "rol_2", tick: 4, tool: "send_message", ok: true, detail: "→ Ana" },
    { roleId: "rol_3", tick: 4, tool: "read_file", ok: false, detail: "ERROR: Access denied" },
  ];

  const roles = [
    { id: "rol_2", name: "Lucas", title: "Desarrollador" },
    { id: "rol_3", name: "Luisa", title: "QA" },
  ];

  const conActividad = (entradas = actividad): ToolContext => ({
    ...ctx,
    workspace: new Proxy({} as AgentWorkspace, {
      get(_t, prop) {
        if (prop === "roles") return roles;
        if (prop === "departments") return [];
        if (prop === "listActivity") return () => entradas;
        return () => {
          throw new Error("no esperado");
        };
      },
    }),
  });

  const auditar = (args: Record<string, unknown> = {}) =>
    tool("check_activity").execute(args, conActividad());

  it("muestra qué ejecutó cada agente y con qué resultado", async () => {
    const result = await auditar();

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Lucas");
    expect(result.content).toContain("export_pdf");
    expect(result.content).toContain("FALLÓ");
  });

  it("permite ir directo a lo que se rompió", async () => {
    const result = await auditar({ only_failures: true });

    expect(result.content).toContain("read_file");
    // Sin ruido: lo que salió bien no aparece.
    expect(result.content).not.toContain("export_pdf");
  });

  it("filtra por rol, por nombre y no por id", async () => {
    // Los modelos manejan mal los identificadores opacos.
    const result = await auditar({ role: "Lucas" });

    expect(result.content).toContain("export_pdf");
    expect(result.content).not.toContain("read_file");
  });

  it("cuando el rol no existe devuelve los válidos", async () => {
    const result = await auditar({ role: "Fantasma" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Lucas");
  });

  it("dice que no hay nada en vez de mostrar una lista vacía", async () => {
    const result = await tool("check_activity").execute({}, conActividad([]));

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Todavía no");
  });

  it("es de solo lectura: auditar no cambia nada", () => {
    expect(tool("check_activity").readOnly).toBe(true);
  });
});
