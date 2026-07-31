import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  companyBlueprintSchema,
  companySchema,
  createRunSchema,
  departmentSchema,
  ids,
  injectMessageSchema,
  mcpServerSchema,
  policySchema,
  resolveApprovalSchema,
  roleProposalSchema,
  roleSchema,
} from "@orq/shared";
import { resolveAllTiers, type ProviderRegistry } from "@orq/llm";
import type { Store } from "./db.js";
import type { Runtime } from "./runtime.js";
import { contentTypeOf, previewDe, previewLiviano } from "./exports.js";

/**
 * API HTTP.
 *
 * REST convencional para la configuración, y dos streams SSE —uno por corrida y
 * otro para el estado de los MCP— que son los que alimentan la visualización en
 * vivo. La UI no hace polling.
 */

export interface RouteDeps {
  store: Store;
  runtime: Runtime;
  providers: ProviderRegistry;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { store, runtime, providers } = deps;

  // --- Salud y proveedores -------------------------------------------------

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/providers", async () => {
    const configured = providers.list();
    return Promise.all(
      configured.map(async (provider) => {
        const health = await provider.healthCheck();
        const models = health.ok ? await provider.listModels() : [];
        return {
          id: provider.id,
          label: provider.label,
          ...health,
          modelCount: models.length,
          tiers: resolveAllTiers(models),
        };
      }),
    );
  });

  app.get("/api/models", async (request) => {
    const refresh = (request.query as { refresh?: string }).refresh === "true";
    return providers.allModels(refresh);
  });

  // --- Empresas ------------------------------------------------------------

  app.get("/api/companies", async () => store.listCompanies());

  app.get("/api/companies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const company = store.getCompany(id);
    if (!company) return notFound(reply, "empresa", id);
    return {
      company,
      departments: store.listDepartments(id),
      roles: store.listRoles(id),
      policies: store.listPolicies(id),
      mcpServers: store.listMcpServers(id),
      tools: store.listTools(id),
    };
  });

  app.post("/api/companies", async (request, reply) => {
    const now = Date.now();
    const parsed = companySchema
      .partial({ id: true, createdAt: true, updatedAt: true })
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    const company = {
      ...parsed.data,
      id: parsed.data.id ?? ids.company(),
      createdAt: parsed.data.createdAt ?? now,
      updatedAt: now,
    };
    store.saveCompany(company);
    reply.code(201);
    return company;
  });

  app.patch("/api/companies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = store.getCompany(id);
    if (!current) return notFound(reply, "empresa", id);
    const merged = companySchema.safeParse({
      ...current,
      ...(request.body as object),
      id,
      updatedAt: Date.now(),
    });
    if (!merged.success) return invalid(reply, merged.error);
    store.saveCompany(merged.data);
    return merged.data;
  });

  app.delete("/api/companies/:id", async (request) => {
    const { id } = request.params as { id: string };
    store.deleteCompany(id);
    return { ok: true };
  });

  // Exportar / importar: la empresa entera como un JSON versionable en git.
  app.get("/api/companies/:id/blueprint", async (request, reply) => {
    const { id } = request.params as { id: string };
    const company = store.getCompany(id);
    if (!company) return notFound(reply, "empresa", id);
    return {
      version: 1 as const,
      company,
      departments: store.listDepartments(id),
      roles: store.listRoles(id),
      policies: store.listPolicies(id),
      mcpServers: store.listMcpServers(id),
      // Solo las built-in: las de MCP se redescubren al conectar el servidor.
      tools: store.listTools(id).filter((tool) => tool.origin !== "mcp"),
    };
  });

  app.post("/api/companies/import", async (request, reply) => {
    const parsed = companyBlueprintSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    // Se reasignan todos los IDs para poder importar la misma empresa dos veces
    // sin pisar la original. El mapa mantiene coherentes las referencias.
    const blueprint = parsed.data;
    const map = new Map<string, string>();
    const remap = (old: string, next: string): string => {
      map.set(old, next);
      return next;
    };
    const lookup = (old: string | null): string | null =>
      old == null ? null : (map.get(old) ?? old);

    const companyId = remap(blueprint.company.id, ids.company());
    for (const dep of blueprint.departments) remap(dep.id, ids.department());
    for (const role of blueprint.roles) remap(role.id, ids.role());
    for (const tool of blueprint.tools) remap(tool.id, ids.tool());

    const now = Date.now();
    store.saveCompany({ ...blueprint.company, id: companyId, createdAt: now, updatedAt: now });

    for (const dep of blueprint.departments) {
      store.saveDepartment({
        ...dep,
        id: map.get(dep.id)!,
        companyId,
        parentId: lookup(dep.parentId),
      });
    }
    for (const tool of blueprint.tools) {
      store.saveTool(companyId, { ...tool, id: map.get(tool.id)! });
    }
    for (const role of blueprint.roles) {
      store.saveRole({
        ...role,
        id: map.get(role.id)!,
        companyId,
        departmentId: lookup(role.departmentId)!,
        reportsTo: lookup(role.reportsTo),
        toolIds: role.toolIds.map((toolId) => lookup(toolId)!).filter(Boolean),
      });
    }
    for (const policy of blueprint.policies) {
      store.savePolicy({
        ...policy,
        id: ids.policy(),
        companyId,
        appliesToRoleIds: policy.appliesToRoleIds.map((roleId) => lookup(roleId)!).filter(Boolean),
      });
    }
    for (const server of blueprint.mcpServers) {
      store.saveMcpServer({ ...server, id: ids.mcpServer(), companyId });
    }

    reply.code(201);
    return { companyId };
  });

  // --- Sub-entidades de la empresa ----------------------------------------

  registerChild(app, "departments", departmentSchema, ids.department, {
    list: (companyId) => store.listDepartments(companyId),
    save: (value) => store.saveDepartment(value),
    remove: (id) => store.deleteDepartment(id),
  });
  registerChild(app, "roles", roleSchema, ids.role, {
    list: (companyId) => store.listRoles(companyId),
    save: (value) => store.saveRole(value),
    remove: (id, companyId) => {
      // El nombre se lee antes de borrarlo, para poder nombrarlo en la traza.
      const nombre = store.listRoles(companyId).find((role) => role.id === id)?.name ?? id;
      const solicitudes = store.deleteRole(id);
      runtime.removeRoleFromLiveRuns(companyId, id, nombre);
      return solicitudes;
    },
  });
  registerChild(app, "policies", policySchema, ids.policy, {
    list: (companyId) => store.listPolicies(companyId),
    save: (value) => store.savePolicy(value),
    remove: (id) => store.deletePolicy(id),
  });
  registerChild(app, "mcp-servers", mcpServerSchema, ids.mcpServer, {
    list: (companyId) => store.listMcpServers(companyId),
    save: (value) => store.saveMcpServer(value),
    remove: (id) => store.deleteMcpServer(id),
  });

  app.get("/api/companies/:companyId/tools", async (request) => {
    const { companyId } = request.params as { companyId: string };
    // Se levanta el runtime para que las tools MCP aparezcan aunque nunca se
    // haya corrido nada: es lo que hace útil al diseñador de la empresa.
    await runtime.companyRuntime(companyId);
    return store.listTools(companyId);
  });

  // --- Bandeja de solicitudes de los agentes -------------------------------

  app.get("/api/companies/:companyId/requests", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store
      .listRequests(companyId)
      .sort((a, b) => Number(a.status !== "pending") - Number(b.status !== "pending") || b.createdAt - a.createdAt);
  });

  const resolveRequestSchema = z.object({
    decision: z.enum(["approve", "reject"]),
    /** Respuesta a una consulta, o motivo del rechazo. */
    resolution: z.string().max(8000).default(""),
    /** Permite editar la propuesta antes de aceptarla. */
    roleProposal: roleProposalSchema.nullable().default(null),
  });

  /**
   * Resolver una solicitud no es solo marcarla: aprobar `create_role` crea el
   * rol de verdad, `tool_access` asigna las herramientas, y `context` le hace
   * llegar la respuesta al agente que preguntó. Sin eso la bandeja sería un
   * registro decorativo.
   */
  app.post("/api/companies/:companyId/requests/:id", async (req, reply) => {
    const { companyId, id } = req.params as { companyId: string; id: string };
    const parsed = resolveRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    const pedido = store.getRequest(id);
    if (!pedido) return notFound(reply, "solicitud", id);
    if (pedido.status !== "pending") {
      reply.code(409);
      return { error: `La solicitud ya fue ${pedido.status}.` };
    }

    const aprobada = parsed.data.decision === "approve";
    let aplicado: Record<string, unknown> = {};

    if (aprobada) {
      try {
        aplicado = await runtime.applyRequest(companyId, pedido, parsed.data.roleProposal);
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }

    const resuelta = {
      ...pedido,
      status: aprobada ? ("approved" as const) : ("rejected" as const),
      resolution: parsed.data.resolution,
      resolvedAt: Date.now(),
    };
    store.saveRequest(resuelta);

    // El agente que preguntó se entera por su bandeja, como cualquier novedad.
    const entrega = runtime.notifyRequester(resuelta, aplicado);
    // Y la corrida que estaba esperando esta respuesta sigue sola: contestar es
    // destrabar, no hace falta además apretar "continuar".
    runtime.reanudarSiEsperaba(resuelta.runId);
    return { request: resuelta, aplicado, entrega };
  });

  // --- Memoria de la empresa ----------------------------------------------

  app.get("/api/companies/:companyId/learnings", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store
      .listLearnings(companyId)
      .sort((a, b) => b.timesConfirmed - a.timesConfirmed || b.updatedAt - a.updatedAt);
  });

  const learningInput = z.object({
    topic: z.string().min(1).max(120),
    lesson: z.string().min(1).max(4000),
  });

  app.post("/api/companies/:companyId/learnings", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const parsed = learningInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const now = Date.now();
    const learning = {
      id: ids.learning(),
      companyId,
      topic: parsed.data.topic,
      lesson: parsed.data.lesson,
      authorRoleId: null,
      runId: null,
      timesConfirmed: 1,
      createdAt: now,
      updatedAt: now,
    };
    store.saveLearning(learning);
    reply.code(201);
    return learning;
  });

  app.delete("/api/companies/:companyId/learnings/:id", async (request) => {
    const { id } = request.params as { id: string };
    store.deleteLearning(id);
    return { ok: true };
  });

  // --- MCP -----------------------------------------------------------------

  app.get("/api/companies/:companyId/mcp/health", async (request) => {
    const { companyId } = request.params as { companyId: string };
    await runtime.companyRuntime(companyId);
    return runtime.mcpHealth(companyId);
  });

  app.post("/api/companies/:companyId/mcp/:serverId/reconnect", async (request, reply) => {
    const { companyId, serverId } = request.params as { companyId: string; serverId: string };
    const ok = await runtime.reconnectMcp(companyId, serverId);
    if (!ok) return notFound(reply, "servidor MCP", serverId);
    return { ok: true };
  });

  const probeSchema = z.object({
    toolName: z.string().min(1),
    args: z.record(z.unknown()).default({}),
  });

  app.post("/api/companies/:companyId/mcp/probe", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const parsed = probeSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    return runtime.probeTool(companyId, parsed.data.toolName, parsed.data.args);
  });

  // --- Documentos generados por las habilidades ----------------------------

  /** Árbol completo del directorio de salida, para el panel de archivos. */
  app.get("/api/companies/:companyId/exports", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return runtime.exports.tree(companyId);
  });

  const carpetaSchema = z.object({ path: z.string().min(1).max(300) });

  app.post("/api/companies/:companyId/exports/folders", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const parsed = carpetaSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    const creada = await runtime.exports.createFolder(companyId, parsed.data.path);
    if (!creada) {
      reply.code(400);
      return { error: `"${parsed.data.path}" no es una ruta válida dentro de la salida.` };
    }
    reply.code(201);
    return { path: creada };
  });

  /** Borra un archivo del directorio de salida. No hay papelera. */
  app.delete("/api/companies/:companyId/exports/*", async (request, reply) => {
    const { companyId } = request.params as { companyId: string; "*": string };
    const ruta = (request.params as Record<string, string>)["*"] ?? "";
    const resultado = await runtime.exports.remove(companyId, ruta);
    if (!resultado.ok) {
      reply.code(400);
      return { error: resultado.motivo };
    }
    return { ok: true };
  });

  /** Contenido listo para mostrar en pantalla, sin descargar. */
  app.get("/api/companies/:companyId/exports-preview/*", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const ruta = (request.params as Record<string, string>)["*"] ?? "";
    const nombre = ruta.split("/").at(-1) ?? ruta;

    // El video, el PDF y las imágenes los dibuja el navegador desde su URL: se
    // responde con el tamaño y nada más. Leerlos acá era cargar el archivo
    // entero en memoria para después descartarlo.
    const liviano = previewLiviano(nombre);
    if (liviano) {
      const sizeBytes = await runtime.exports.pesoDe(companyId, ruta);
      if (sizeBytes == null) return notFound(reply, "documento", ruta);
      return { ...liviano, sizeBytes };
    }

    const bytes = await runtime.exports.read(companyId, ruta);
    if (!bytes) return notFound(reply, "documento", ruta);
    return { ...(await previewDe(nombre, bytes)), sizeBytes: bytes.length };
  });

  app.get("/api/companies/:companyId/exports/*", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const ruta = (request.params as Record<string, string>)["*"] ?? "";
    const bytes = await runtime.exports.read(companyId, ruta);
    if (!bytes) return notFound(reply, "documento", ruta);

    const nombre = ruta.split("/").at(-1) ?? ruta;
    // Por defecto `attachment`, para que el navegador lo baje en vez de
    // intentar abrirlo. Con `?inline` se sirve para mostrarlo en pantalla: un
    // `attachment` dentro de un iframe dispara la descarga en vez de dibujarse.
    const inline = (request.query as { inline?: string }).inline != null;
    reply.header("content-type", contentTypeOf(nombre));
    reply.header(
      "content-disposition",
      `${inline ? "inline" : "attachment"}; filename="${nombre}"`,
    );

    // Un `<video>` pide rangos para poder adelantar: sin esto la barra de
    // tiempo no se puede arrastrar y el archivo se reproduce sólo de corrido.
    reply.header("accept-ranges", "bytes");
    const rango = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    if (rango) {
      const desde = rango[1] ? Number(rango[1]) : 0;
      const hasta = rango[2] ? Math.min(Number(rango[2]), bytes.length - 1) : bytes.length - 1;
      if (desde > hasta || desde >= bytes.length) {
        reply.code(416).header("content-range", `bytes */${bytes.length}`);
        return reply.send();
      }
      reply.code(206).header("content-range", `bytes ${desde}-${hasta}/${bytes.length}`);
      return reply.send(bytes.subarray(desde, hasta + 1));
    }

    return reply.send(bytes);
  });

  // --- Corridas ------------------------------------------------------------

  /**
   * Borra una corrida y su rastro. Los entregables quedan: son de la empresa,
   * y limpiar la lista no puede costarle el trabajo producido.
   */
  app.delete("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.estaViva(id)) {
      reply.code(409);
      return { error: "La corrida está avanzando. Pausala o terminala antes de borrarla." };
    }
    runtime.olvidarCorrida(id);
    store.deleteRun(id);
    return { ok: true };
  });

  /** Limpieza en lote: saca de la lista todo lo que ya terminó. */
  app.delete("/api/companies/:companyId/runs/terminadas", async (request) => {
    const { companyId } = request.params as { companyId: string };
    const terminadas = store.listRuns(companyId).filter((run) => !runtime.estaViva(run.id));

    for (const run of terminadas) {
      runtime.olvidarCorrida(run.id);
      store.deleteRun(run.id);
    }
    return { borradas: terminadas.length };
  });

  app.post("/api/runs", async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const run = await runtime.startRun(parsed.data);
      reply.code(201);
      return run;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/runs", async (request) => {
    const { companyId } = request.query as { companyId?: string };
    return store.listRuns(companyId);
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = runtime.snapshot(id);
    if (!run) return notFound(reply, "corrida", id);
    return {
      run,
      messages: store.listMessages(id),
      tasks: store.listTasks(id),
      artifacts: store.listArtifacts(id),
      approvals: store.listApprovals(id),
      ledger: store.listLedger(id),
      /** `true` si sigue en memoria y se puede continuar. */
      live: runtime.active(id) != null,
    };
  });

  /** Traza completa: es lo que permite reproducir la corrida con el timeline. */
  app.get("/api/runs/:id/events", async (request) => {
    const { id } = request.params as { id: string };
    return store.listEvents(id);
  });

  for (const action of ["tick", "resume", "pause", "stop"] as const) {
    app.post(`/api/runs/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        if (action === "tick") return await runtime.tick(id);
        if (action === "resume") {
          void runtime.resume(id); // no bloquea la respuesta: puede durar minutos
          return { started: true };
        }
        if (action === "pause") runtime.pause(id);
        if (action === "stop") runtime.stop(id);
        return { ok: true, run: runtime.snapshot(id) };
      } catch (error) {
        reply.code(409);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  app.post("/api/runs/:id/inject", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = injectMessageSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      await runtime.inject(id, parsed.data.toRoleId, parsed.data.subject, parsed.data.body);
      return { ok: true };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/runs/:id/approvals/:approvalId", async (request, reply) => {
    const { id, approvalId } = request.params as { id: string; approvalId: string };
    const parsed = resolveApprovalSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const resolved = runtime.resolveApproval(
        id,
        approvalId,
        parsed.data.decision,
        parsed.data.resolution,
      );
      if (!resolved) return notFound(reply, "aprobación pendiente", approvalId);
      return { ok: true };
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  // --- Streams SSE ---------------------------------------------------------

  app.get("/api/runs/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stream = openSse(reply);

    // Se reenvía la traza ya ocurrida antes de enganchar el vivo: quien abre la
    // pantalla a mitad de una corrida ve todo, no solo lo que pase de ahora en
    // más. Los eventos son idempotentes por id, así que un solapamiento no daña.
    for (const event of store.listEvents(id)) stream.send("trace", event);

    const unsubscribe = runtime.subscribeRun(id, (event) => stream.send("trace", event));
    request.raw.on("close", () => {
      unsubscribe();
      stream.close();
    });
  });

  app.get("/api/mcp/stream", async (request, reply) => {
    const stream = openSse(reply);
    const unsubscribe = runtime.subscribeMcp((health) => stream.send("mcp", health));
    request.raw.on("close", () => {
      unsubscribe();
      stream.close();
    });
  });

  // --- Helpers -------------------------------------------------------------

  type ChildOps<T> = {
    list: (companyId: string) => T[];
    save: (value: T) => void;
    /** Puede devolver cuántas entidades dependientes se llevó en cascada. */
    remove: (id: string, companyId: string) => number | void;
  };

  /**
   * CRUD anidado bajo una empresa. El esquema se tipa con entrada `unknown`
   * porque los campos con `.default()` son opcionales al entrar y obligatorios
   * al salir: fijar ambos al mismo tipo rechazaría los propios esquemas.
   */
  function registerChild<T extends { id: string; companyId: string }>(
    instance: FastifyInstance,
    segment: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    makeId: () => string,
    ops: ChildOps<T>,
  ): void {
    instance.get(`/api/companies/:companyId/${segment}`, async (request) => {
      const { companyId } = request.params as { companyId: string };
      return ops.list(companyId);
    });

    instance.post(`/api/companies/:companyId/${segment}`, async (request, reply) => {
      const { companyId } = request.params as { companyId: string };
      const body = request.body as Record<string, unknown>;
      const parsed = schema.safeParse({ ...body, companyId, id: body.id ?? makeId() });
      if (!parsed.success) return invalid(reply, parsed.error);
      ops.save(parsed.data);
      reply.code(201);
      return parsed.data;
    });

    instance.patch(`/api/companies/:companyId/${segment}/:id`, async (request, reply) => {
      const { companyId, id } = request.params as { companyId: string; id: string };
      const current = ops.list(companyId).find((item) => item.id === id);
      if (!current) return notFound(reply, segment, id);
      const parsed = schema.safeParse({ ...current, ...(request.body as object), id, companyId });
      if (!parsed.success) return invalid(reply, parsed.error);
      ops.save(parsed.data);
      return parsed.data;
    });

    instance.delete(`/api/companies/:companyId/${segment}/:id`, async (request) => {
      const { companyId, id } = request.params as { companyId: string; id: string };
      const cascaded = ops.remove(id, companyId);
      return { ok: true, cascaded: cascaded ?? 0 };
    });
  }
}

function notFound(reply: FastifyReply, kind: string, id: string): { error: string } {
  reply.code(404);
  return { error: `No existe ${kind} con id "${id}".` };
}

function invalid(reply: FastifyReply, error: z.ZodError): { error: string; issues: unknown } {
  reply.code(400);
  return {
    error: "Los datos enviados no son válidos.",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** Server-Sent Events con heartbeat, para que proxies no corten la conexión. */
function openSse(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": conectado\n\n");

  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
  }, 20_000);
  heartbeat.unref?.();

  return {
    send(event: string, data: unknown): void {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close(): void {
      clearInterval(heartbeat);
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}
