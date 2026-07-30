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

  it("un párrafo interminable se guarda pero se avisa", async () => {
    // Rechazarlo costaba un turno por intento —un agente agotó sus 8
    // iteraciones peleando con esto— y el documento ya tenía estructura: es un
    // problema de estilo, no de validez.
    const largo = ["# Informe", "", "## Detalle", "", "x".repeat(950)].join("\n");
    const result = await escribir("Informe", largo);

    expect(result.ok).toBe(true);
    expect(result.content).toContain("próxima versión");
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

/**
 * Corregir un entregable no puede costar reescribirlo entero.
 *
 * Medido sobre una corrida real: v16→v19 del mismo documento cambiaron el 4% de
 * las líneas y reescribieron las 184 cada vez, el 21% de todos los tokens de
 * salida. Además es la vía más común a la llamada truncada.
 */
describe("editar un entregable por reemplazo", () => {
  const documento =
    "# Paquete comercial\n\n## Estado\n\n| Rol | Tests |\n| --- | --- |\n" +
    "| director | 100/100 |\n| inspector | 92/92 |\n| admin | 92/92 |\n\n## Riesgos\n\nNinguno declarado.\n";

  function conArtefacto(contenido = documento) {
    const guardados: Array<{ key: string; content: string }> = [];
    const workspace = {
      ...strictWorkspace,
      readArtifact: async () => ({
        id: "art_1",
        runId: "run_test",
        companyId: "cmp_1",
        key: "paquete",
        title: "Paquete comercial",
        contentType: "markdown" as const,
        content: contenido,
        version: 16,
        authorRoleId: "rol_1",
        createdAt: 0,
      }),
      listArtifacts: async () => [],
      writeArtifact: async (input: { key: string; content: string }) => {
        guardados.push(input);
        return { ...input, version: 17, title: "Paquete comercial" };
      },
    } as unknown as AgentWorkspace;
    return { workspace, guardados };
  }

  it("aplica el cambio y versiona sin recibir el documento entero", async () => {
    const { workspace, guardados } = conArtefacto();
    const result = await tool("edit_artifact").execute(
      { key: "paquete", cambios: [{ buscar: "| director | 100/100 |", reemplazar: "| director | 86/86 |" }] },
      { ...ctx, workspace },
    );

    expect(result.ok).toBe(true);
    expect(guardados[0]!.content).toContain("| director | 86/86 |");
    expect(guardados[0]!.content).not.toContain("100/100");
    // Y lo que no se tocó sigue igual: no se regeneró el resto.
    expect(guardados[0]!.content).toContain("| inspector | 92/92 |");
  });

  it("rechaza un texto ambiguo en vez de tocar el lugar equivocado", async () => {
    const { workspace, guardados } = conArtefacto();
    const result = await tool("edit_artifact").execute(
      // "92/92" está en dos filas: reemplazar a ciegas tocaría la equivocada.
      { key: "paquete", cambios: [{ buscar: "92/92", reemplazar: "78/92" }] },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("2 veces");
    expect(guardados).toHaveLength(0);
  });

  it("si un cambio no aplica, no deja el documento a medias", async () => {
    const { workspace, guardados } = conArtefacto();
    const result = await tool("edit_artifact").execute(
      {
        key: "paquete",
        cambios: [
          { buscar: "Ninguno declarado.", reemplazar: "Ver tabla." },
          { buscar: "texto que no existe", reemplazar: "algo" },
        ],
      },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(guardados).toHaveLength(0);
  });

  it("no crea una versión nueva si nada cambió", async () => {
    const { workspace, guardados } = conArtefacto();
    const result = await tool("edit_artifact").execute(
      { key: "paquete", cambios: [{ buscar: "## Riesgos", reemplazar: "## Riesgos" }] },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(guardados).toHaveLength(0);
  });
});

/**
 * Los modelos copian el texto a buscar aplanando los saltos de línea: una tabla
 * markdown vuelve como una sola línea con pipes. Medido en una corrida real:
 * era la causa de 3 de los 5 rechazos de edit_artifact.
 */
describe("editar tolerando cómo quedó partido el espacio", () => {
  const conTabla =
    "# Informe\n\n## Deuda\n\n| # | Deuda | Severidad |\n|---|-------|-----------|\n" +
    "| 1 | BUG-016 | Media |\n\n## Cierre\n\nNada más.\n";

  function workspaceCon(contenido: string) {
    const guardados: Array<{ content: string }> = [];
    const workspace = {
      ...strictWorkspace,
      readArtifact: async () => ({
        key: "informe",
        title: "Informe",
        contentType: "markdown" as const,
        content: contenido,
        version: 3,
      }),
      listArtifacts: async () => [],
      writeArtifact: async (input: { content: string }) => {
        guardados.push(input);
        return { ...input, version: 4, title: "Informe" };
      },
    } as unknown as AgentWorkspace;
    return { workspace, guardados };
  }

  it("encuentra la tabla aunque venga en una sola línea", async () => {
    const { workspace, guardados } = workspaceCon(conTabla);
    const result = await tool("edit_artifact").execute(
      {
        key: "informe",
        cambios: [
          {
            // Tal como lo mandó el modelo: sin los saltos de línea originales.
            buscar: "| 1 | BUG-016 | Media |",
            reemplazar: "| 1 | BUG-016 | Alta |",
          },
        ],
      },
      { ...ctx, workspace },
    );

    expect(result.ok).toBe(true);
    expect(guardados[0]!.content).toContain("| 1 | BUG-016 | Alta |");
    // Y el resto del documento quedó intacto, saltos de línea incluidos.
    expect(guardados[0]!.content).toContain("|---|-------|-----------|\n");
  });

  it("sigue rechazando si al aflojar el espacio hay más de un candidato", async () => {
    const repetido = "## A\n\n| x | 1 |\n\n## B\n\n| x | 1 |\n";
    const { workspace, guardados } = workspaceCon(repetido);
    const result = await tool("edit_artifact").execute(
      { key: "informe", cambios: [{ buscar: "| x | 1 |", reemplazar: "| x | 2 |" }] },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(guardados).toHaveLength(0);
  });
});

/**
 * Un coordinador que no recuerda lo que ya repartió asigna dos veces la misma
 * tarea. En el tablero aparecen dos tarjetas idénticas que se mueven por
 * separado: el asignado hace el trabajo una vez y la copia queda colgada.
 */
describe("assign_task no duplica trabajo ya asignado", () => {
  function workspaceCon(tareas: Array<{ id: string; title: string; status: string }>) {
    const creadas: Array<{ title: string }> = [];
    const bruno = { id: "rol_2", name: "Bruno", title: "Analista" };
    const workspace = {
      roles: [bruno],
      departments: [],
      directReports: () => [bruno],
      listTasks: async () => tareas,
      createTask: async (input: { title: string }) => {
        creadas.push(input);
        return { id: "tsk_nueva", title: input.title };
      },
    } as unknown as AgentWorkspace;
    return { workspace, creadas };
  }

  it("rechaza una tarea abierta con el mismo título, aunque cambie el formato", async () => {
    const { workspace, creadas } = workspaceCon([
      { id: "tsk_1", title: "Control de Calidad de entregables", status: "in_progress" },
    ]);

    const result = await tool("assign_task").execute(
      {
        assignee: "Bruno",
        title: "control de calidad de ENTREGABLES.",
        detail: "Revisá lo que produzcan.",
      },
      { ...ctx, workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("tsk_1");
    expect(creadas).toHaveLength(0);
  });

  it("deja reasignar si la anterior ya se cerró", async () => {
    const { workspace, creadas } = workspaceCon([
      { id: "tsk_1", title: "Control de Calidad de entregables", status: "done" },
    ]);

    const result = await tool("assign_task").execute(
      {
        assignee: "Bruno",
        title: "Control de Calidad de entregables",
        detail: "Segunda vuelta sobre la v6.",
      },
      { ...ctx, workspace },
    );

    expect(result.ok).toBe(true);
    expect(creadas).toHaveLength(1);
  });
});

/**
 * Un coordinador movía tareas ajenas: medimos a una CEO asignar el diagnóstico
 * y acto seguido moverlo ella a "in_progress" y después a "blocked", sin que la
 * asignada hubiera empezado. El tablero mostraba a alguien trabado en algo que
 * nunca tocó, y un tablero que miente es peor que no tener tablero.
 */
describe("update_task: cada uno mueve sólo lo suyo", () => {
  function workspaceCon(propias: Array<{ id: string; title: string }>) {
    const movidas: string[] = [];
    const workspace = {
      roles: [],
      departments: [],
      listTasks: async () => propias,
      updateTask: async (id: string, patch: { status: string }) => {
        movidas.push(`${id}→${patch.status}`);
        return { id, title: "Diagnóstico", status: patch.status };
      },
    } as unknown as AgentWorkspace;
    return { workspace, movidas };
  }

  it("rechaza mover la tarea de otro y le dice qué hacer en su lugar", async () => {
    const { workspace, movidas } = workspaceCon([]);
    const result = await tool("update_task").execute(
      { task_id: "tsk_de_sofia", status: "blocked" },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("send_message");
    expect(movidas).toHaveLength(0);
  });

  it("deja mover la propia", async () => {
    const { workspace, movidas } = workspaceCon([{ id: "tsk_mia", title: "Diagnóstico" }]);
    const result = await tool("update_task").execute(
      { task_id: "tsk_mia", status: "in_review" },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(true);
    expect(movidas).toEqual(["tsk_mia→in_review"]);
  });
});

/**
 * Los agentes insisten: medimos diez mensajes de un coordinador a la misma
 * persona en una corrida —pedido, recordatorio, seguimiento, escalamiento—
 * todos sobre lo mismo. Y el que insiste se queda esperando en vez de avanzar
 * con lo que sí puede hacer.
 */
describe("send_message: uno por persona hasta que conteste", () => {
  function workspaceCon(sinResponder: Array<{ toRoleId: string; subject: string }>) {
    const bruno = { id: "rol_2", name: "Bruno", title: "Analista" };
    const ana = { id: "rol_3", name: "Ana Gómez", title: "Diseñadora" };
    const enviados: string[] = [];
    const workspace = {
      roles: [bruno, ana],
      departments: [],
      mensajesSinResponder: () => sinResponder,
      sendMessage: async (input: { toRoleId: string }) => {
        enviados.push(input.toRoleId);
        return { id: "msg_1", ...input };
      },
    } as unknown as AgentWorkspace;
    return { workspace, enviados };
  }

  it("rechaza insistirle a quien todavía no contestó", async () => {
    const { workspace, enviados } = workspaceCon([
      { toRoleId: "rol_2", subject: "Necesito la estimación" },
    ]);
    const result = await tool("send_message").execute(
      { to: "Bruno", type: "request", subject: "Recordatorio: estimación", body: "¿La tenés?" },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Necesito la estimación");
    expect(enviados).toHaveLength(0);
  });

  it("no frena escribirle a otra persona: eso es avanzar en paralelo", async () => {
    const { workspace, enviados } = workspaceCon([
      { toRoleId: "rol_2", subject: "Necesito la estimación" },
    ]);
    const result = await tool("send_message").execute(
      { to: "Ana Gómez", type: "request", subject: "Costeo", body: "Necesito el precio." },
      { ...ctx, workspace },
    );
    expect(result.ok).toBe(true);
    expect(enviados).toEqual(["rol_3"]);
  });
});
