import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CATALOGO_MCP,
  PLANTILLAS_EQUIPO,
  articuloDeTienda,
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
  misionSchema,
  normalizarLeccion,
} from "@orq/shared";
import { resolverTodosLosTiers, type ProviderRegistry } from "@orq/llm";
import type { Store } from "./db.js";
import type { Runtime } from "./runtime.js";
import { contentTypeOf, previewDe, previewLiviano } from "./exports.js";
import type { MisionScheduler } from "./misiones.js";

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
  misiones: MisionScheduler;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { store, runtime, providers, misiones } = deps;

  /**
   * Saca de la lista las corridas que ya no van a avanzar.
   *
   * "Terminada" es "no está viva ahora", que incluye la pausada: si no avanza,
   * se puede limpiar. Cada una se suelta del runtime antes de borrarla de la
   * base, o queda un orquestador escribiendo eventos de algo que ya no existe.
   */
  const limpiarTerminadas = (corridas: readonly { id: string }[]): number => {
    // `estaViva` es sólo `running`: con ese filtro la limpieza se llevaba
    // puestas las corridas pausadas y las que esperaban una respuesta, que no
    // avanzan pero se pueden continuar. Se borra lo que ya no vuelve.
    const terminadas = corridas.filter((run) => !runtime.sePuedeContinuar(run.id));
    for (const run of terminadas) {
      runtime.olvidarCorrida(run.id);
      store.deleteRun(run.id);
    }
    return terminadas.length;
  };

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
          tiers: resolverTodosLosTiers(provider.id, models),
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

  /**
   * Una línea por proyecto, con lo que hace falta para elegir sin abrirlo.
   *
   * Es lo que alimenta la pantalla de Proyectos. Convive con `/companies/:id`
   * porque el router resuelve el segmento estático antes que el paramétrico.
   *
   * El peso en disco se mide con `medirEmpresa`, que **no crea la carpeta**:
   * hacerlo acá dejaría un directorio por proyecto con sólo mirar la lista.
   */
  app.get("/api/companies/resumen", async () => {
    const resumenes = store.resumenEmpresas();
    return Promise.all(
      resumenes.map(async (resumen) => ({
        ...resumen,
        corridaViva: runtime.tieneCorridaViva(resumen.id),
        disco: await runtime.exports.medirEmpresa(resumen.id),
      })),
    );
  });

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

  app.get("/api/plantillas", async () =>
    // El proveedor preferido viaja junto: el onboarding lo muestra en vez de
    // hardcodear openrouter, y con él decide si puede ofrecer escalado.
    ({ plantillas: PLANTILLAS_EQUIPO, proveedorPreferido: runtime.proveedorPreferido() }),
  );

  app.post("/api/companies", async (request, reply) => {
    const now = Date.now();
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { plantillaId, ...cuerpo } = body;
    const parsed = companySchema
      .partial({ id: true, createdAt: true, updatedAt: true })
      .safeParse(cuerpo);
    if (!parsed.success) return invalid(reply, parsed.error);

    const company = {
      ...parsed.data,
      id: parsed.data.id ?? ids.company(),
      createdAt: parsed.data.createdAt ?? now,
      updatedAt: now,
    };
    store.saveCompany(company);
    // Un proyecto nuevo nace con sus herramientas built-in registradas: si no,
    // no hay nada que asignarle a un agente y el primero que intente exportar
    // algo va a informar que no encuentra la herramienta.
    await runtime.sembrarHerramientas(company.id);

    // Con plantilla, el proyecto nace con su equipo: roles, jerarquía y
    // herramientas resueltas. Las faltantes y los MCP sugeridos vuelven en la
    // respuesta para que la UI los ofrezca — instalarlos lo decide una persona.
    let equipo: Awaited<ReturnType<typeof runtime.generarEquipo>> | null = null;
    if (typeof plantillaId === "string" && plantillaId) {
      try {
        equipo = await runtime.generarEquipo(company.id, plantillaId);
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }

    reply.code(201);
    return { ...company, ...(equipo ? { equipo } : {}) };
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
    // Un cambio de nombre por acá dejaría la carpeta y el vault con el viejo.
    if (merged.data.name !== current.name) {
      const renombre = await runtime.renombrarEmpresa(id, merged.data.name);
      if (!renombre.ok) {
        reply.code(409);
        return { error: renombre.motivo };
      }
    }
    store.saveCompany(merged.data);
    return merged.data;
  });

  // Renombrar no es un PATCH más: se lleva detrás la carpeta del proyecto, el
  // vault y las rutas que guardaban los worktrees y los servidores MCP.
  app.post("/api/companies/:id/renombrar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { nombre } = (request.body ?? {}) as { nombre?: unknown };
    if (typeof nombre !== "string") {
      reply.code(400);
      return { error: "Falta el nombre." };
    }
    const resultado = await runtime.renombrarEmpresa(id, nombre);
    if (!resultado.ok) {
      reply.code(resultado.motivo === "La empresa no existe." ? 404 : 409);
      return { error: resultado.motivo };
    }
    return { company: resultado.company, carpeta: resultado.carpeta };
  });

  /**
   * Borra la empresa y todo lo suyo: memoria del servidor, base y disco.
   *
   * No alcanza con `store.deleteCompany`: eso deja las conexiones MCP vivas y la
   * carpeta de salida con los archivos producidos, sin nadie a quien pertenecer.
   */
  app.delete("/api/companies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const resultado = await runtime.eliminarEmpresa(id);
    if (!resultado.ok) {
      reply.code(409);
      return { error: resultado.motivo };
    }
    return { ok: true, archivos: resultado.archivos, bytes: resultado.bytes };
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
      // Sólo los repos que se pueden volver a traer desde otra máquina: una
      // ruta local de ésta no significa nada allá. Sin los permisos de una vez,
      // que eran de una sesión.
      repositorios: store
        .listRepositorios(id)
        .filter((repo) => repo.origen.tipo === "git")
        .map((repo) => ({
          ...repo,
          baseSha: null,
          comandos: { ...repo.comandos, unaVez: [] },
          // Los `.env` son rutas de esta máquina, igual que un origen local.
          servicios: repo.servicios.map((servicio) => ({ ...servicio, archivosEntorno: [] })),
        })),
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

    // Los repos se vuelven a clonar en segundo plano —puede tardar minutos— y
    // sus comandos llegan **pendientes de confirmar**: importar un JSON no puede
    // autorizar a correr nada en esta máquina. El `.catch` es obligatorio: una
    // promesa sin dueño que falla tira el servidor entero.
    const reposImportados = blueprint.repositorios.filter((repo) => repo.origen.tipo === "git");
    for (const importado of reposImportados) {
      void runtime.repos
        .cargar(companyId, {
          nombre: importado.nombre,
          origen: importado.origen,
          ramaBase: importado.ramaBase,
        })
        .then(({ repo }) => {
          store.saveRepositorio({
            ...repo,
            comandos: { ...importado.comandos, unaVez: [] },
            pendienteDeConfirmar: true,
          });
          return runtime.registrarHerramientasDeCodigo(companyId);
        })
        .catch((error: unknown) => {
          app.log.warn(
            `No se pudo clonar ${importado.nombre} al importar: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    reply.code(201);
    return { companyId, reposClonando: reposImportados.map((repo) => repo.nombre) };
  });

  // --- Sub-entidades de la empresa ----------------------------------------

  registerChild(app, "departments", departmentSchema, ids.department, {
    list: (companyId) => store.listDepartments(companyId),
    save: (value) => store.saveDepartment(value),
    remove: (id) => store.deleteDepartment(id),
  });
  registerChild(app, "roles", roleSchema, ids.role, {
    list: (companyId) => store.listRoles(companyId),
    save: (value) => {
      store.saveRole(value);
      // La corrida viva congela el organigrama al arrancar: sin esto, otorgarle
      // una herramienta a un agente desde la configuración no le llega hasta la
      // corrida siguiente, y mientras tanto insiste con la que no puede usar.
      runtime.actualizarRolEnCorridasVivas(value.companyId, value);
    },
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
  // Las misiones no usan `registerChild`: al guardarlas hay que recalcular el
  // próximo disparo, y ese cálculo lo hace el planificador.
  app.get("/api/companies/:companyId/misiones", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store.listMisiones(companyId);
  });

  app.post("/api/companies/:companyId/misiones", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const now = Date.now();
    const parsed = misionSchema.safeParse({
      ...(request.body as object),
      companyId,
      id: (request.body as { id?: string }).id ?? ids.mision(),
      createdAt: now,
      updatedAt: now,
    });
    if (!parsed.success) return invalid(reply, parsed.error);

    const mision = misiones.reprogramar(parsed.data);
    reply.code(201);
    return mision;
  });

  app.patch("/api/companies/:companyId/misiones/:id", async (request, reply) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    const actual = store.listMisiones(companyId).find((mision) => mision.id === id);
    if (!actual) return notFound(reply, "misión", id);

    const parsed = misionSchema.safeParse({
      ...actual,
      ...(request.body as object),
      id,
      companyId,
    });
    if (!parsed.success) return invalid(reply, parsed.error);

    // Cambiar la programación —o volver a habilitarla— corre el próximo turno.
    return misiones.reprogramar(parsed.data);
  });

  app.delete("/api/companies/:companyId/misiones/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    store.deleteMision(id);
    reply.code(204);
    return null;
  });

  /** Dispara la misión ahora, sin esperar su turno. Para probarla. */
  app.post("/api/companies/:companyId/misiones/:id/run", async (request, reply) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    const mision = store.listMisiones(companyId).find((m) => m.id === id);
    if (!mision) return notFound(reply, "misión", id);

    const run = await misiones.disparar(mision);
    if (!run) {
      reply.code(409);
      return {
        error:
          "La empresa ya tiene una corrida en curso. Esperá a que termine: dos equipos " +
          "trabajando a la vez se pisan los entregables.",
      };
    }
    return run;
  });

  // Los servidores MCP no usan `registerChild`: el alta tiene que conectar y
  // descubrir al toque (no en la próxima corrida), el nombre no puede repetirse
  // —es el segmento de `mcp__<servidor>__<tool>`— y el borrado va en cascada:
  // sin eso quedaban herramientas fantasma en la base y roles apuntando a ids
  // muertos.
  app.get("/api/companies/:companyId/mcp-servers", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store.listMcpServers(companyId);
  });

  app.post("/api/companies/:companyId/mcp-servers", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const body = request.body as Record<string, unknown>;
    const parsed = mcpServerSchema.safeParse({
      ...body,
      companyId,
      id: body.id ?? ids.mcpServer(),
    });
    if (!parsed.success) return invalid(reply, parsed.error);
    if (store.listMcpServers(companyId).some((server) => server.name === parsed.data.name)) {
      reply.code(409);
      return {
        error:
          `Ya hay un servidor llamado "${parsed.data.name}". El nombre es parte del id de ` +
          `cada herramienta, así que no puede repetirse.`,
      };
    }
    store.saveMcpServer(parsed.data);
    await runtime.companyRuntime(companyId); // conecta y descubre ahora
    reply.code(201);
    return parsed.data;
  });

  app.patch("/api/companies/:companyId/mcp-servers/:id", async (request, reply) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    const current = store.listMcpServers(companyId).find((server) => server.id === id);
    if (!current) return notFound(reply, "mcp-servers", id);
    const parsed = mcpServerSchema.safeParse({
      ...current,
      ...(request.body as object),
      id,
      companyId,
    });
    if (!parsed.success) return invalid(reply, parsed.error);
    if (
      store
        .listMcpServers(companyId)
        .some((server) => server.id !== id && server.name === parsed.data.name)
    ) {
      reply.code(409);
      return { error: `Ya hay otro servidor llamado "${parsed.data.name}".` };
    }
    store.saveMcpServer(parsed.data);
    await runtime.companyRuntime(companyId); // el sync reconecta lo que cambió
    return parsed.data;
  });

  app.delete("/api/companies/:companyId/mcp-servers/:id", async (request) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    const resultado = await runtime.eliminarServidorMcp(companyId, id);
    return { ok: true, cascaded: resultado.herramientas, rolesPodados: resultado.rolesPodados };
  });

  // --- Tienda de servidores MCP -------------------------------------------

  /**
   * La vuelta del navegador después de autorizar un servidor MCP con OAuth.
   * Se contesta una página, no JSON: la abre la persona en su navegador.
   */
  app.get("/api/mcp/oauth/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as Record<string, string | undefined>;
    const pagina = (titulo: string, detalle: string) =>
      reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>${titulo}</title><body style="font:15px system-ui;padding:3rem;max-width:36rem;margin:auto;color:#222"><h2>${titulo}</h2><p>${detalle}</p><p style="color:#777">Podés cerrar esta pestaña y volver al orquestador.</p><script>setTimeout(()=>window.close(),2500)</script></body>`,
        );
    const escapar = (t: string) => t.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
    if (error) return pagina("No se autorizó", escapar(error_description ?? error));
    if (!code || !state) return pagina("Falta información", "La vuelta no trajo el código de autorización.");
    try {
      const hecho = await runtime.completarAutorizacionMcp(state, code);
      return hecho
        ? pagina(`Listo: ${escapar(hecho.nombre)} está autorizado`, "El servidor se conectó y sus herramientas ya están disponibles para los agentes.")
        : pagina("No encontré ese pedido", "Puede que ya se haya completado, o que el servidor se haya reiniciado. Volvé a apretar Autorizar en el Hub.");
    } catch (fallo) {
      return pagina("No se pudo completar la autorización", escapar(fallo instanceof Error ? fallo.message : String(fallo)));
    }
  });

  app.get("/api/tienda-mcp", async (request) => {
    const { companyId } = request.query as { companyId?: string };
    const instalados = companyId
      ? store.listMcpServers(companyId)
      : ([] as ReturnType<typeof store.listMcpServers>);
    return CATALOGO_MCP.map((articulo) => ({
      ...articulo,
      instalado: instalados.some(
        (server) => server.catalogoId === articulo.id || server.name === articulo.servidor.name,
      ),
      envFaltantes: articulo.envRequeridas
        .filter((entrada) => entrada.obligatoria && !process.env[entrada.ref])
        .map((entrada) => entrada.ref),
    }));
  });

  app.post("/api/companies/:companyId/tienda-mcp/:articuloId", async (request, reply) => {
    const { companyId, articuloId } = request.params as {
      companyId: string;
      articuloId: string;
    };
    const articulo = articuloDeTienda(articuloId);
    if (!articulo) return notFound(reply, "artículo de la tienda", articuloId);

    const resultado = await runtime.instalarServidoresMcp(companyId, [
      {
        name: articulo.servidor.name,
        description: articulo.servidor.description || articulo.descripcion,
        transport: articulo.servidor.transport,
        envRequeridas: articulo.envRequeridas,
        catalogoId: articulo.id,
      },
    ]);

    if (resultado.instalados.length === 0) {
      reply.code(409);
      return {
        error: `"${articulo.nombre}" ya está instalado en este proyecto.`,
        avisos: resultado.avisos,
      };
    }
    return resultado;
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
    /** Para `comando`: permitirlo siempre (con un prefijo recortable) o sólo esta vez. */
    comando: z
      .object({
        alcance: z.enum(["siempre", "una-vez"]),
        prefijo: z.array(z.string().min(1).max(400)).max(40).optional(),
      })
      .nullable()
      .default(null),
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
        aplicado = await runtime.applyRequest(
          companyId,
          pedido,
          parsed.data.roleProposal,
          parsed.data.comando,
        );
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

  /**
   * El pulso del proyecto: qué corrida hay y cómo viene.
   *
   * Vive aparte de `/runs` porque lo consume el shell —está en pantalla en
   * todas las secciones— y tiene que ser barato: agregados sobre el índice de
   * eventos y una sola fila leída, en vez de la traza entera. El cliente calcula
   * el reloj solo; acá va lo que sólo el servidor sabe.
   */
  app.get("/api/companies/:companyId/progreso", async (request) => {
    const { companyId } = request.params as { companyId: string };
    // La más reciente, viva o no: después de un reinicio, saber cuándo terminó
    // la última y por qué es tan útil como ver una en curso.
    const run = store.listRuns(companyId)[0] ?? null;
    if (!run) return { run: null, viva: false, progreso: null };
    return {
      // El estado autoritativo es el del orquestador vivo: `run.status` de la
      // base queda viejo cuando la corrida se pausó o se detuvo.
      run: runtime.snapshot(run.id) ?? run,
      viva: runtime.estaViva(run.id),
      progreso: store.progresoDeCorrida(run.id),
    };
  });

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

    // La misma regla de dedupe que `record_lesson`: sin esto, lo que la
    // herramienta consideraba repetido esta puerta lo creaba como fila gemela.
    // Cargarla de nuevo cuenta como confirmación de una persona.
    const gemela = store
      .listLearnings(companyId)
      .find(
        (candidata) =>
          normalizarLeccion(candidata.topic) === normalizarLeccion(parsed.data.topic) &&
          normalizarLeccion(candidata.lesson) === normalizarLeccion(parsed.data.lesson),
      );
    if (gemela) {
      gemela.timesConfirmed += 1;
      if (gemela.confirmaciones.length < 20) {
        gemela.confirmaciones.push({ roleId: null, runId: null, at: now });
      }
      gemela.updatedAt = now;
      store.saveLearning(gemela);
      const duena = store.getCompany(companyId);
      if (duena) await runtime.espejarAprendizajes(duena, gemela.topic);
      return gemela;
    }

    const learning = {
      id: ids.learning(),
      companyId,
      topic: parsed.data.topic,
      lesson: parsed.data.lesson,
      authorRoleId: null,
      runId: null,
      timesConfirmed: 1,
      // Sin gate: la escribió una persona, y eso es la procedencia.
      evidencia: "cargada a mano por la persona a cargo",
      estado: "activa" as const,
      refutacion: null,
      confirmaciones: [],
      createdAt: now,
      updatedAt: now,
    };
    store.saveLearning(learning);
    // Al vault también: la memoria entra por dos puertas y las dos tienen que
    // llegar al árbol, o lo que carga una persona no se ve en Obsidian.
    const empresa = store.getCompany(companyId);
    if (empresa) await runtime.espejarAprendizajes(empresa, learning.topic);
    reply.code(201);
    return learning;
  });

  const learningPatch = z
    .object({
      topic: z.string().min(1).max(120),
      lesson: z.string().min(1).max(4000),
      estado: z.enum(["activa", "cuestionada", "refutada"]),
      /** Obligatorio al refutar: el tombstone es el motivo, no el estado. */
      motivoDeRefutacion: z.string().min(1).max(600),
    })
    .partial();

  /**
   * Edición y refutación de una lección: la revisión humana de la memoria.
   *
   * Refutar no borra: la lección queda con su motivo, fuera del prompt. El
   * registro de por qué algo se creyó y por qué era falso vale tanto como la
   * lección — borrarla invita a re-aprender el mismo error.
   */
  app.patch("/api/companies/:companyId/learnings/:id", async (request, reply) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    const parsed = learningPatch.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);

    const actual = store.listLearnings(companyId).find((candidata) => candidata.id === id);
    if (!actual) return notFound(reply, "lección", id);

    if (parsed.data.estado === "refutada" && !parsed.data.motivoDeRefutacion) {
      reply.code(400);
      return { error: "Refutar exige el motivo: es lo que evita re-aprender el mismo error." };
    }

    const temaAnterior = actual.topic;
    const editada = {
      ...actual,
      ...(parsed.data.topic != null ? { topic: parsed.data.topic } : {}),
      ...(parsed.data.lesson != null ? { lesson: parsed.data.lesson } : {}),
      ...(parsed.data.estado != null ? { estado: parsed.data.estado } : {}),
      refutacion:
        parsed.data.estado === "refutada"
          ? { motivo: parsed.data.motivoDeRefutacion!, at: Date.now() }
          : parsed.data.estado != null
            ? null // restaurar limpia el tombstone
            : actual.refutacion,
      updatedAt: Date.now(),
    };
    store.saveLearning(editada);

    const empresa = store.getCompany(companyId);
    if (empresa) {
      // Si cambió el tema, la nota vieja tiene que soltar la lección (o
      // desaparecer si quedó vacía) y la nueva recibirla.
      await runtime.espejarAprendizajes(empresa, editada.topic);
      if (temaAnterior !== editada.topic) await runtime.espejarAprendizajes(empresa, temaAnterior);
    }
    return editada;
  });

  app.delete("/api/companies/:companyId/learnings/:id", async (request) => {
    const { companyId, id } = request.params as { companyId: string; id: string };
    // El tema se lee **antes** de borrar: después ya no está para saber qué
    // nota del vault hay que reescribir.
    const tema = store.listLearnings(companyId).find((l) => l.id === id)?.topic ?? null;
    store.deleteLearning(id);
    // La memoria entra por dos puertas y tiene que salir por las dos. Sin esto
    // el vault conserva una lección ya borrada: lo pagamos con dos lecciones
    // equivocadas —un falso positivo que mandaba a los agentes a "corregir" un
    // documento sano— que seguían en Obsidian después de sacarlas de la base.
    const empresa = store.getCompany(companyId);
    if (empresa && tema) await runtime.espejarAprendizajes(empresa, tema);
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

  /**
   * Publicar: la decisión humana del circuito de misiones.
   *
   * Un agente puede producir el video y avisar por correo, pero no puede
   * publicarlo. Esto es lo que aprieta la persona cuando lo revisó.
   */
  app.post("/api/companies/:companyId/exports-publicar/*", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const ruta = (request.params as Record<string, string>)["*"] ?? "";
    const { reemplazar } = request.query as { reemplazar?: string };
    const resultado = await runtime.exports.publicar(companyId, ruta, {
      reemplazar: reemplazar === "1" || reemplazar === "true",
    });
    if (!resultado.ok) {
      // 409 cuando ya hay una versión publicada: la UI pregunta y reintenta
      // con `?reemplazar=1`, en vez de pisarla sin avisar.
      reply.code(resultado.existe ? 409 : 400);
      return { error: resultado.motivo, existe: resultado.existe ?? false };
    }
    return resultado;
  });

  /**
   * Vacía la salida de una empresa dejando lo que trajo una persona.
   *
   * El criterio es el manifiesto de procedencia, no la extensión: el logo de la
   * marca es un `.png` que subiste vos y vive en una ruta fija, así que un
   * "borrá toda la multimedia" se lo lleva y no se vuelve a generar solo.
   */
  app.post("/api/companies/:companyId/exports-vaciar", async (request) => {
    const { companyId } = request.params as { companyId: string };
    const resultado = await runtime.exports.vaciarGenerado(companyId);
    return {
      borrados: resultado.borrados.length,
      conservados: resultado.conservados.length,
      bytes: resultado.bytes,
    };
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
    if (runtime.sePuedeContinuar(id)) {
      reply.code(409);
      return {
        error:
          "La corrida está en pausa o esperando una respuesta: todavía se puede continuar. " +
          "Terminala si querés cerrarla, y recién ahí borrala.",
      };
    }
    runtime.olvidarCorrida(id);
    store.deleteRun(id);
    return { ok: true };
  });

  /** Limpieza en lote: saca de la lista todo lo que ya terminó. */
  app.delete("/api/companies/:companyId/runs/terminadas", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return { borradas: limpiarTerminadas(store.listRuns(companyId)) };
  });

  // --- Mantenimiento --------------------------------------------------------

  /**
   * Qué hay para limpiar, sin borrar nada.
   *
   * Va separado del borrado a propósito: lo que se acumula acá es invisible
   * desde el resto de la aplicación —una carpeta sin empresa no aparece en
   * ninguna pantalla, porque todas navegan por empresa— y una acción destructiva
   * a ciegas no es una que alguien vaya a apretar.
   */
  app.get("/api/mantenimiento", async () => {
    const vivas = store.listCompanies().map((company) => company.id);
    return {
      base: { bytes: store.pesoEnDisco(), residuos: store.residuos() },
      carpetas: await runtime.exports.carpetasResiduales(vivas),
      corridasTerminadas: store.listAllRuns().filter((run) => !runtime.sePuedeContinuar(run.id))
        .length,
    };
  });

  const purgaSchema = z.object({
    /** Filas que quedaron apuntando a una empresa o corrida inexistente. */
    residuos: z.boolean().default(false),
    /** Nombres de carpeta, tal como los devuelve el diagnóstico. */
    carpetas: z.array(z.string()).default([]),
    /** Corridas terminadas de todas las empresas. */
    corridas: z.boolean().default(false),
    /** `VACUUM`. Sin esto el archivo sigue pesando lo mismo después de purgar. */
    compactar: z.boolean().default(false),
  });

  app.post("/api/mantenimiento/purgar", async (request, reply) => {
    const parsed = purgaSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const { residuos, carpetas, corridas, compactar } = parsed.data;

    // Se mide antes de tocar nada: si se leyera después de purgar, "la base pasó
    // de X a Y" estaría informando sólo el efecto del `VACUUM` y no el de la
    // limpieza. Sin compactar los dos números son iguales a propósito —SQLite
    // marca las páginas libres y las reusa— y eso es justamente lo que explica
    // para qué está la opción.
    const baseAntes = store.pesoEnDisco();

    const corridasBorradas = corridas ? limpiarTerminadas(store.listAllRuns()) : 0;
    // Después de borrar corridas, porque cada una deja huérfanas sus propias
    // filas: purgar antes obliga a correrlo dos veces para que quede limpio.
    const residuosPurgados = residuos ? store.purgarResiduos() : null;

    // Sólo se borran carpetas que el diagnóstico marcó como residuales: si entre
    // el diagnóstico y el borrado alguien creó la empresa, su carpeta ya no está
    // en la lista y no se toca.
    const residualesAhora = new Set(
      (await runtime.exports.carpetasResiduales(store.listCompanies().map((c) => c.id))).map(
        (entrada) => entrada.carpeta,
      ),
    );
    let carpetasBorradas = 0;
    let bytesEnDisco = 0;
    const rechazadas: Array<{ carpeta: string; motivo: string }> = [];
    for (const carpeta of carpetas) {
      if (!residualesAhora.has(carpeta)) {
        rechazadas.push({ carpeta, motivo: "Ya no figura como residual." });
        continue;
      }
      const resultado = await runtime.exports.removeCarpeta(carpeta);
      if (resultado.ok) {
        carpetasBorradas += 1;
        bytesEnDisco += resultado.bytes;
      } else {
        rechazadas.push({ carpeta, motivo: resultado.motivo });
      }
    }

    // `VACUUM` va al final y fuera de toda transacción: SQLite no lo admite
    // adentro de una.
    if (compactar) store.vacuum();

    return {
      corridas: corridasBorradas,
      residuos: residuosPurgados,
      carpetas: carpetasBorradas,
      rechazadas,
      bytesEnDisco,
      base: { antes: baseAntes, despues: store.pesoEnDisco() },
    };
  });

  /**
   * Lo mismo, para todas las empresas de una.
   *
   * Convive con `DELETE /api/runs/:id` porque el router de Fastify resuelve el
   * segmento estático antes que el paramétrico, sin importar en qué orden se
   * declaren: `terminadas` no se toma por el id de una corrida. Si alguna vez
   * hace falta borrar una corrida que se llame así, este es el motivo por el que
   * no se puede.
   */
  app.delete("/api/runs/terminadas", async () => ({
    borradas: limpiarTerminadas(store.listAllRuns()),
  }));

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
          // `snapshot` valida que la corrida siga viva en memoria **antes** de
          // contestar: sin eso, retomar una corrida que no sobrevivió a un
          // reinicio devolvía `started: true` y el error viajaba por una
          // promesa sin dueño — una rechazada sin manejar **mata el proceso
          // entero de Node**, así que un pedido inválido bajaba el servidor y
          // con él todas las corridas vivas. Lo medimos dos veces.
          if (!runtime.estaEnMemoria(id)) {
            throw new Error(
              `La corrida "${id}" no está activa en memoria: no sobrevivió a un reinicio ` +
                `del servidor. Podés leer su traza, pero para seguir el trabajo hay que ` +
                `arrancar una corrida nueva — las tareas abiertas se heredan.`,
            );
          }
          void runtime.resume(id).catch((error: unknown) => {
            // Lo que falle después de contestar ya no tiene a quién avisarle
            // por HTTP; queda en el log del servidor y en la traza de la
            // corrida, que es donde alguien lo va a buscar.
            app.log.error({ err: error, runId: id }, "la corrida se cortó al retomar");
          });
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
      const resolved = await runtime.resolveApproval(
        id,
        approvalId,
        parsed.data.decision,
        parsed.data.resolution,
      );
      if (!resolved) return notFound(reply, "aprobación pendiente", approvalId);
      // Igual que al contestar una consulta: si era la última pendiente, la
      // corrida sigue sola. Aprobar y que no pase nada convierte una espera
      // asincrónica en una intervención manual.
      runtime.reanudarSiEsperaba(id);
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

export function invalid(reply: FastifyReply, error: z.ZodError): { error: string; issues: unknown } {
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
export function openSse(reply: FastifyReply) {
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
