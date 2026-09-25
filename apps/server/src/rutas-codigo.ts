import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  argvATexto,
  argvSchema,
  decidirComando,
  origenRepositorioSchema,
  parsearDotenv,
  servicioSchema,
  tokenizar,
  validarPrefijoPermitido,
  type Repositorio,
  type SesionCodigo,
} from "@orq/shared";
import type { Store } from "./db.js";
import type { Runtime } from "./runtime.js";
import { invalid, openSse } from "./routes.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { resolverEnWorktree } from "@orq/tools";
import { ErrorGit } from "./git.js";

/**
 * API del código de un proyecto: cargar repos, mirar la sesión, integrar.
 *
 * Integrar y descartar viven sólo acá, del lado de la persona: no hay
 * herramienta de agente que haga ninguna de las dos. Es la misma regla que
 * publicar — un agente produce, una persona decide qué sale.
 */

const cargaSchema = z.object({
  nombre: z.string().max(120).optional(),
  origen: origenRepositorioSchema,
  ramaBase: z.string().max(200).optional(),
  incluirCambiosSinCommitear: z.boolean().optional(),
});

const comandosSchema = z.object({
  permitidos: z.array(argvSchema).optional(),
  preparar: argvSchema.nullable().optional(),
  test: argvSchema.nullable().optional(),
  verificar: argvSchema.nullable().optional(),
  sinAislamiento: z.boolean().optional(),
});

export function registrarRutasDeCodigo(app: FastifyInstance, deps: { store: Store; runtime: Runtime }): void {
  const { store, runtime } = deps;
  const repos = runtime.repos;

  const conRepo = (id: string): Repositorio | null => store.getRepositorio(id);
  const conSesion = (id: string): { sesion: SesionCodigo; repo: Repositorio } | null => {
    const sesion = store.getSesionCodigo(id);
    const repo = sesion ? store.getRepositorio(sesion.repoId) : null;
    return sesion && repo ? { sesion, repo } : null;
  };

  /** Un error de git se muestra tal cual: es lo único que explica qué pasó. */
  const fallo = (reply: { code: (n: number) => unknown }, error: unknown) => {
    reply.code(error instanceof ErrorGit ? 422 : 400);
    return { error: error instanceof Error ? error.message : String(error) };
  };

  app.get("/api/companies/:companyId/repos", async (request) => {
    const { companyId } = request.params as { companyId: string };
    return store.listRepositorios(companyId).map((repo) => ({
      repo,
      sesion: repos.sesionAbierta(repo.id, companyId),
      clon: repos.rutaClon(repo),
    }));
  });

  app.post("/api/companies/:companyId/repos", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    if (!store.getCompany(companyId)) {
      reply.code(404);
      return { error: "No existe la empresa." };
    }
    const parsed = cargaSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const cargado = await repos.cargar(companyId, {
        origen: parsed.data.origen,
        ...(parsed.data.nombre ? { nombre: parsed.data.nombre } : {}),
        ...(parsed.data.ramaBase ? { ramaBase: parsed.data.ramaBase } : {}),
        ...(parsed.data.incluirCambiosSinCommitear ? { incluirCambiosSinCommitear: true } : {}),
      });
      await runtime.registrarHerramientasDeCodigo(companyId);
      return cargado;
    } catch (error) {
      return fallo(reply, error);
    }
  });

  /**
   * La allowlist la edita una persona. Cada entrada se valida con la misma
   * regla que usa la herramienta: un prefijo que lo permite todo (`npx`,
   * `bash`, `npm run` a secas) no entra, y el rechazo dice cuál y por qué.
   */
  app.patch("/api/repos/:repoId/comandos", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const parsed = comandosSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    for (const prefijo of parsed.data.permitidos ?? []) {
      const validacion = validarPrefijoPermitido(prefijo);
      if (!validacion.ok) {
        reply.code(400);
        return { error: `"${prefijo.join(" ")}": ${validacion.motivo}` };
      }
    }
    const limpio = Object.fromEntries(
      Object.entries(parsed.data).filter(([, valor]) => valor !== undefined),
    ) as Partial<Repositorio["comandos"]>;
    return repos.actualizarComandos(repo, limpio);
  });

  // Renombrar no pide detener la corrida: el repo también se encuentra por su
  // slug, que no cambia, así que un agente que en este turno todavía dice el
  // nombre viejo sigue llegando al mismo lugar.
  app.post("/api/repos/:repoId/renombrar", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const { nombre } = (request.body ?? {}) as { nombre?: unknown };
    if (typeof nombre !== "string") {
      reply.code(400);
      return { error: "Falta el nombre." };
    }
    try {
      return repos.renombrar(repo, nombre);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/repos/:repoId", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    if (runtime.tieneCorridaViva(repo.companyId)) {
      reply.code(409);
      return { error: "Hay una corrida en curso trabajando sobre el código. Detenela antes." };
    }
    runtime.servicios.detenerDelRepo(repo.id);
    const { respaldo } = await repos.eliminar(repo);
    await runtime.registrarHerramientasDeCodigo(repo.companyId);
    return { ok: true, respaldo };
  });

  app.post("/api/repos/:repoId/sesion", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    try {
      return await repos.abrirSesion(repo);
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.get("/api/sesiones/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const encontrada = conSesion(id);
    if (!encontrada) {
      reply.code(404);
      return { error: "No existe la sesión." };
    }
    const { sesion, repo } = encontrada;
    if (sesion.estado !== "abierta") return { sesion, estado: null, log: [] };
    try {
      return {
        sesion,
        estado: await repos.estado(sesion, repo),
        log: await repos.log(sesion, repo),
      };
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.get("/api/sesiones/:id/diff", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { ruta } = request.query as { ruta?: string };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    try {
      return { diff: await repos.diff(encontrada.sesion, encontrada.repo, ruta) };
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.get("/api/sesiones/:id/patch", async (request, reply) => {
    const { id } = request.params as { id: string };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    const patch = await repos.patch(encontrada.sesion, encontrada.repo);
    reply
      .header("content-type", "text/x-patch; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${encontrada.repo.slug}-${encontrada.sesion.rama.replace(/\//g, "-")}.patch"`,
      );
    return patch;
  });

  app.post("/api/sesiones/:id/integrar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const encontrada = conSesion(id);
    if (!encontrada) {
      reply.code(404);
      return { error: "No existe la sesión." };
    }
    if (runtime.tieneCorridaViva(encontrada.repo.companyId)) {
      reply.code(409);
      return { error: "Hay una corrida en curso escribiendo en esta sesión. Esperá a que termine o detenela." };
    }
    try {
      // Los servicios corren sobre el worktree que integrar se lleva.
      runtime.servicios.detenerDelRepo(encontrada.repo.id);
      const resultado = await repos.integrar(encontrada.sesion, encontrada.repo);
      if (!resultado.ok) {
        reply.code(409);
        return { error: resultado.motivo, ...resultado };
      }
      return resultado;
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.post("/api/sesiones/:id/descartar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const encontrada = conSesion(id);
    if (!encontrada) {
      reply.code(404);
      return { error: "No existe la sesión." };
    }
    if (runtime.tieneCorridaViva(encontrada.repo.companyId)) {
      reply.code(409);
      return { error: "Hay una corrida en curso escribiendo en esta sesión. Detenela antes de descartar." };
    }
    runtime.servicios.detenerDelRepo(encontrada.repo.id);
    await repos.descartar(encontrada.sesion, encontrada.repo);
    return { ok: true };
  });

  // --- Servicios (vista previa de un monorepo) ------------------------------

  /**
   * La configuración de cada servicio más su estado vivo. Los `.env` se
   * describen —qué archivo, si existe, cuántas variables— pero sus valores no
   * salen nunca del servidor.
   */
  app.get("/api/repos/:repoId/servicios", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const preparados = runtime.serviciosPreparados(repo);
    return {
      servicios: await Promise.all(
        repo.servicios.map(async (servicio) => ({
          ...servicio,
          archivosEntorno: await Promise.all(
            servicio.archivosEntorno.map(async (ruta) => {
              try {
                const texto = await readFile(ruta, "utf8");
                return { ruta, existe: true, variables: Object.keys(parsearDotenv(texto)).length };
              } catch {
                return { ruta, existe: false, variables: 0 };
              }
            }),
          ),
          preparado: preparados[servicio.id] ?? null,
          vivo: runtime.servicios.vista(repo.id, servicio.id),
        })),
      ),
    };
  });

  app.post("/api/repos/:repoId/servicios/detectar", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    return repos.redetectarServicios(repo);
  });

  /** Alta o edición de un servicio. El id no cambia: es lo que nombran los agentes. */
  app.put("/api/repos/:repoId/servicios/:servicioId", async (request, reply) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const parsed = servicioSchema.safeParse({ ...(request.body as object), id: servicioId });
    if (!parsed.success) return invalid(reply, parsed.error);
    const servicio = parsed.data;
    // Sólo archivos que se llaman como un `.env`: el servidor los lee y los
    // inyecta en un proceso que corre código de un agente, así que esto no
    // puede ser la forma de meterle `~/.ssh/id_rsa` como variable.
    const noEsEnv = servicio.archivosEntorno.find((ruta) => !isAbsolute(ruta) || !/^\.env(\..+)?$|\.env$/.test(basename(ruta)));
    if (noEsEnv) {
      reply.code(400);
      return { error: `"${noEsEnv}" no es un archivo .env con ruta absoluta.` };
    }
    if (servicio.carpeta) {
      const dentro = await resolverEnWorktree(repos.rutaClon(repo), servicio.carpeta);
      if (!dentro.ok) {
        reply.code(400);
        return { error: dentro.motivo };
      }
      servicio.carpeta = dentro.relativa;
    }
    const lista = repo.servicios.some((s) => s.id === servicioId)
      ? repo.servicios.map((s) => (s.id === servicioId ? servicio : s))
      : [...repo.servicios, servicio];
    return repos.actualizarServicios(repo, lista);
  });

  app.delete("/api/repos/:repoId/servicios/:servicioId", async (request, reply) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    runtime.servicios.detener(repo.id, servicioId);
    return repos.actualizarServicios(repo, repo.servicios.filter((s) => s.id !== servicioId));
  });

  // Preparar tarda (una instalación son minutos): se contesta al toque y el
  // avance se ve en los logs. El `.catch` no es decorativo: una promesa sin
  // dueño tira el servidor entero (ver "Trampas conocidas").
  app.post("/api/repos/:repoId/servicios/:servicioId/preparar", async (request, reply) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const repo = conRepo(repoId);
    if (!repo?.servicios.some((s) => s.id === servicioId)) {
      reply.code(404);
      return { error: "No existe el servicio." };
    }
    void runtime.prepararServicio(repo, servicioId).catch((error: unknown) => {
      request.log.warn({ err: error }, "no se pudo preparar el servicio");
    });
    return { ok: true };
  });

  app.post("/api/repos/:repoId/servicios/:servicioId/arrancar", async (request, reply) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const repo = conRepo(repoId);
    if (!repo?.servicios.some((s) => s.id === servicioId)) {
      reply.code(404);
      return { error: "No existe el servicio." };
    }
    try {
      return await runtime.arrancarServicio(repo, servicioId);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/repos/:repoId/servicios/:servicioId/detener", async (request) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    runtime.servicios.detener(repoId, servicioId);
    return runtime.servicios.vista(repoId, servicioId);
  });

  app.get("/api/repos/:repoId/servicios/:servicioId/logs", async (request) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const desde = Number((request.query as { desde?: string }).desde ?? 0) || 0;
    return { ...runtime.servicios.lineasDesde(repoId, servicioId, desde), vivo: runtime.servicios.vista(repoId, servicioId) };
  });

  const probarSchema = z.object({
    metodo: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    ruta: z.string().min(1).max(2000),
    cuerpo: z.string().max(200_000).optional(),
    cabeceras: z.record(z.string().max(8_000)).optional(),
  });

  /** La consola de la API: el pedido sale del servidor, así no depende del CORS del backend. */
  app.post("/api/repos/:repoId/servicios/:servicioId/probar", async (request, reply) => {
    const { repoId, servicioId } = request.params as { repoId: string; servicioId: string };
    const parsed = probarSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      return await runtime.servicios.probar(repoId, servicioId, {
        metodo: parsed.data.metodo,
        ruta: parsed.data.ruta,
        ...(parsed.data.cuerpo != null ? { cuerpo: parsed.data.cuerpo } : {}),
        ...(parsed.data.cabeceras ? { cabeceras: parsed.data.cabeceras } : {}),
      });
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  // --- IDE ------------------------------------------------------------------

  /**
   * El árbol del repo para el explorador, con el estado git de cada archivo y
   * quién está escribiendo ahora. Sin sesión se muestra la rama base en sólo
   * lectura: mirar no abre una sesión.
   */
  app.get("/api/repos/:repoId/archivos", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const sesion = repos.sesionAbierta(repo.id, repo.companyId);
    try {
      const archivos = await repos.listarArchivos(repo, sesion);
      const estado = sesion ? await repos.estado(sesion, repo) : null;
      return {
        sesion,
        archivos,
        cambios: estado?.archivos ?? [],
        sensibles: estado?.sensibles ?? [],
        commits: estado?.commits ?? 0,
        pendientes: sesion ? await repos.tieneCambiosPendientes(sesion, repo) : false,
        escritor: runtime.titularDeEscritura(repo.id),
        corridaViva: runtime.tieneCorridaViva(repo.companyId),
      };
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.get("/api/repos/:repoId/buscar", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { q, mayusculas, regex } = request.query as { q?: string; mayusculas?: string; regex?: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    return repos.buscarTexto(repo, repos.sesionAbierta(repo.id, repo.companyId), q ?? "", {
      mayusculas: mayusculas === "1",
      regex: regex === "1",
    });
  });

  app.get("/api/repos/:repoId/archivo", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { ruta, ref } = request.query as { ruta?: string; ref?: string };
    const repo = conRepo(repoId);
    if (!repo || !ruta) {
      reply.code(404);
      return { error: "Falta el repo o la ruta." };
    }
    const sesion = repos.sesionAbierta(repo.id, repo.companyId);
    const referencia = ref === "base" || (ref && /^[0-9a-f]{7,40}\^?$/.test(ref)) ? ref : "actual";
    const leido = await repos.leerArchivo(repo, sesion, ruta, referencia);
    if (!leido.ok) {
      reply.code(404);
      return { error: leido.motivo };
    }
    return { ruta, ...leido };
  });

  const guardarSchema = z.object({
    ruta: z.string().min(1).max(1000),
    contenido: z.string(),
    /** Hash de lo que cargó el editor; `null` si es un archivo nuevo. */
    hash: z.string().nullable().optional(),
  });

  /**
   * Guarda lo que editó una persona. No mientras un agente tiene el arriendo:
   * dos escritores sobre el mismo árbol se pisan, sean agentes o no. Y no si
   * el archivo cambió en disco desde que se abrió (409 con `conflicto`).
   */
  app.put("/api/repos/:repoId/archivo", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const parsed = guardarSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const escritor = runtime.titularDeEscritura(repo.id);
    if (escritor) {
      reply.code(409);
      return { error: `${escritor} está editando este repo en su turno. Guardá cuando termine: tu cambio sigue en el editor.` };
    }
    try {
      const sesion = await repos.abrirSesion(repo);
      const resultado = await repos.escribirArchivo(
        sesion,
        repo,
        parsed.data.ruta,
        parsed.data.contenido,
        parsed.data.hash,
      );
      if (!resultado.ok) {
        reply.code(resultado.conflicto ? 409 : 400);
        return { error: resultado.motivo, conflicto: resultado.conflicto ?? false };
      }
      return { ...resultado, sesionId: sesion.id };
    } catch (error) {
      return fallo(reply, error);
    }
  });

  app.delete("/api/repos/:repoId/archivo", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { ruta } = request.query as { ruta?: string };
    const repo = conRepo(repoId);
    if (!repo || !ruta) {
      reply.code(404);
      return { error: "Falta el repo o la ruta." };
    }
    const escritor = runtime.titularDeEscritura(repo.id);
    if (escritor) {
      reply.code(409);
      return { error: `${escritor} está editando este repo en su turno.` };
    }
    const sesion = await repos.abrirSesion(repo);
    const resultado = await repos.borrarArchivo(sesion, repo, ruta);
    if (!resultado.ok) {
      reply.code(400);
      return { error: resultado.motivo };
    }
    return resultado;
  });

  /** "Confirmar" del control de código: un commit firmado por la persona. */
  // --- Control de versiones (stage, commit, stash, ramas) ----------------------

  /**
   * El estado git de la sesión abierta del repo. Sin sesión no hay nada que
   * preparar ni commitear: mirar el código no abre una.
   */
  app.get("/api/repos/:repoId/scm", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const sesion = repos.sesionAbierta(repo.id, repo.companyId);
    // Lo que la persona commiteó en su repo desde otro lado aparece solo: se
    // trae en segundo plano (limitado a una vez cada 45 s) y la próxima
    // consulta ya lo muestra. El `.catch` es obligatorio: sin dueño, una
    // promesa rechazada tira el servidor.
    void repos.sincronizarConOrigen(repo).catch((error: unknown) => request.log.warn({ err: error }, "no se pudo sincronizar"));
    if (!sesion) return { sesion: null, estado: null };
    return { sesion, estado: await runtime.scm.estado(sesion, repo), escritor: runtime.titularDeEscritura(repo.id) };
  });

  /** Traer ya lo nuevo del repo de la persona. No toca el worktree: se puede con un agente trabajando. */
  app.post("/api/sesiones/:id/scm/sincronizar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const encontrada = conSesion(id);
    if (!encontrada) {
      reply.code(404);
      return { error: "No existe la sesión." };
    }
    const r = await repos.sincronizarConOrigen(encontrada.repo, true);
    if (!r.ok) reply.code(409);
    return r.ok ? r : { error: r.detalle };
  });

  app.get("/api/sesiones/:id/scm/historial", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { desde?: string; cantidad?: string; rama?: string };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    try {
      return await runtime.scm.historial(encontrada.sesion, encontrada.repo, {
        desde: Number(q.desde ?? 0) || 0,
        cantidad: Number(q.cantidad ?? 60) || 60,
        ...(q.rama ? { rama: q.rama } : {}),
      });
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/api/sesiones/:id/scm/commit/:sha", async (request, reply) => {
    const { id, sha } = request.params as { id: string; sha: string };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    try {
      return await runtime.scm.archivosDeCommit(encontrada.sesion, encontrada.repo, sha);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * Lo que escribe en la sesión espera a que ningún agente esté en su turno
   * —un stash o un cambio de rama le moverían el árbol debajo—; lo que mueve
   * la rama o el árbol entero espera además a que no haya una corrida viva,
   * porque su próximo turno arrancaría sobre otra cosa sin saberlo.
   */
  const operacionScm = (
    ruta: string,
    trabajo: (sesion: SesionCodigo, repo: Repositorio, cuerpo: Record<string, unknown>) => Promise<unknown>,
    opciones: { sinCorrida?: boolean } = {},
  ) =>
    app.post(`/api/sesiones/:id/scm/${ruta}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      const encontrada = conSesion(id);
      if (!encontrada || encontrada.sesion.estado !== "abierta") {
        reply.code(404);
        return { error: "No existe la sesión abierta." };
      }
      const escritor = runtime.titularDeEscritura(encontrada.repo.id);
      if (escritor) {
        reply.code(409);
        return { error: `${escritor} está escribiendo en su turno. Esperá a que termine.` };
      }
      if (opciones.sinCorrida && runtime.tieneCorridaViva(encontrada.repo.companyId)) {
        reply.code(409);
        return { error: "Hay una corrida en curso trabajando sobre esta sesión: cambiarle la rama o el árbol la dejaría trabajando sobre otra cosa. Esperá a que termine o detenela." };
      }
      try {
        const resultado = await trabajo(encontrada.sesion, encontrada.repo, (request.body ?? {}) as Record<string, unknown>);
        return resultado ?? { ok: true };
      } catch (error) {
        reply.code(409);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

  const listaDeRutas = (valor: unknown): string[] | "todo" =>
    valor === "todo" ? "todo" : Array.isArray(valor) ? valor.map(String).slice(0, 2_000) : [];
  const texto = (valor: unknown) => (typeof valor === "string" ? valor : "");

  operacionScm("preparar", (sesion, repo, b) => runtime.scm.preparar(sesion, repo, listaDeRutas(b.rutas)));
  operacionScm("quitar", (sesion, repo, b) => runtime.scm.quitar(sesion, repo, listaDeRutas(b.rutas)));
  operacionScm("descartar", (sesion, repo, b) => runtime.scm.descartar(sesion, repo, listaDeRutas(b.rutas)));
  operacionScm("commit", (sesion, repo, b) =>
    runtime.scm.commit(sesion, repo, { mensaje: texto(b.mensaje), todo: b.todo === true, amend: b.amend === true }),
  );
  operacionScm("mensaje", async (sesion, repo) => ({ mensaje: await runtime.generarMensajeDeCommit(sesion, repo) }));
  operacionScm(
    "stash",
    (sesion, repo, b) =>
      runtime.scm.guardarStash(sesion, repo, {
        mensaje: texto(b.mensaje),
        incluirNuevos: b.incluirNuevos !== false,
        soloPreparados: b.soloPreparados === true,
      }),
    { sinCorrida: true },
  );
  operacionScm(
    "stash/usar",
    (sesion, repo, b) => {
      const accion = b.accion === "sacar" || b.accion === "borrar" ? b.accion : "aplicar";
      return runtime.scm.usarStash(sesion, repo, texto(b.ref), accion);
    },
    { sinCorrida: true },
  );
  operacionScm("ramas/crear", (sesion, repo, b) => runtime.scm.crearRama(sesion, repo, texto(b.nombre), texto(b.desde) || undefined), {
    sinCorrida: true,
  });
  operacionScm("ramas/cambiar", (sesion, repo, b) => runtime.scm.cambiarRama(sesion, repo, texto(b.nombre)), { sinCorrida: true });
  operacionScm("ramas/borrar", (sesion, repo, b) => runtime.scm.borrarRama(sesion, repo, texto(b.nombre)));
  operacionScm("ramas/fusionar", (sesion, repo, b) => runtime.scm.fusionar(sesion, repo, texto(b.nombre)), { sinCorrida: true });

  app.post("/api/sesiones/:id/confirmar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { mensaje } = (request.body ?? {}) as { mensaje?: string };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    if (runtime.titularDeEscritura(encontrada.repo.id)) {
      reply.code(409);
      return { error: "Un agente está escribiendo en su turno. Confirmá cuando termine." };
    }
    const persona = await repos.identidadDePersona();
    const sha = await repos.checkpoint(
      encontrada.sesion,
      encontrada.repo,
      { nombre: persona.nombre, id: "persona", email: persona.email },
      "",
      { titulo: (mensaje ?? "").trim() || "Cambios desde el IDE" },
    );
    return { sha };
  });

  /**
   * La terminal del IDE: sólo lo permitido para el repo, en el sandbox. Una
   * persona que quiere correr otra cosa lo agrega a la lista a sabiendas —o
   * abre su propia terminal—; lo que no puede pasar es que esta API corra lo
   * que le mande cualquier página abierta en el navegador.
   */
  app.post("/api/repos/:repoId/ejecutar", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const { comando, segundos, carpeta } = (request.body ?? {}) as { comando?: string; segundos?: number; carpeta?: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const tokens = tokenizar(comando ?? "");
    if (!tokens.ok) {
      reply.code(400);
      return { error: tokens.motivo };
    }
    if (repo.pendienteDeConfirmar) {
      reply.code(409);
      return { error: "Los comandos de este repo vinieron importados: confirmalos primero en Repositorio." };
    }
    const decision = decidirComando(tokens.argv, { permitidos: repo.comandos.permitidos, unaVez: [] });
    if (!decision.permitido) {
      reply.code(403);
      return {
        error: `"${argvATexto(tokens.argv)}" no está en los comandos permitidos del repo. Agregalo en Repositorio → Comandos si querés que se pueda correr desde acá (y por los agentes).`,
      };
    }
    const corte = Math.max(5, Math.min(600, Number(segundos ?? 300) || 300)) * 1000;
    try {
      return await runtime.ejecutarComoPersona(repo, tokens.argv, corte, carpeta?.trim() || "");
    } catch (error) {
      return fallo(reply, error);
    }
  });

  // --- Chat de IA y vista previa -------------------------------------------------

  /** El agente del chat: se crea con un click, una sola vez por empresa. */
  app.post("/api/companies/:companyId/mejorador", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    if (!store.getCompany(companyId)) {
      reply.code(404);
      return { error: "No existe la empresa." };
    }
    try {
      return await runtime.crearMejorador(companyId);
    } catch (error) {
      return fallo(reply, error);
    }
  });

  /** Las corridas enfocadas en un repo: la historia del chat. */
  app.get("/api/repos/:repoId/pedidos", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    // Con `conversacion`, sólo esa. `anteriores` son los pedidos de antes de
    // que existieran las conversaciones: se ven juntos, como se veían.
    const { conversacion } = request.query as { conversacion?: string };
    return store
      .listRuns(repo.companyId)
      .filter((run) => run.foco?.repoId === repo.id)
      .filter((run) =>
        !conversacion
          ? true
          : conversacion === "anteriores"
            ? !run.foco?.conversacionId
            : run.foco?.conversacionId === conversacion,
      )
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 30);
  });

  /** Las conversaciones del chat de un repo, la más reciente primero. */
  app.get("/api/repos/:repoId/conversaciones", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    const grupos = new Map<string, { id: string; titulo: string; pedidos: number; desde: number; ultima: number }>();
    const pedidos = store
      .listRuns(repo.companyId)
      .filter((run) => run.foco?.repoId === repo.id)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const run of pedidos) {
      const id = run.foco?.conversacionId ?? "anteriores";
      const grupo = grupos.get(id);
      if (grupo) {
        grupo.pedidos += 1;
        grupo.ultima = run.startedAt;
      } else {
        grupos.set(id, {
          id,
          titulo: id === "anteriores" ? "Pedidos anteriores" : run.objective.replace(/\s+/g, " ").slice(0, 80),
          pedidos: 1,
          desde: run.startedAt,
          ultima: run.startedAt,
        });
      }
    }
    return [...grupos.values()].sort((a, b) => b.ultima - a.ultima).slice(0, 50);
  });

  app.get("/api/sesiones/:id/commit/:sha", async (request, reply) => {
    const { id, sha } = request.params as { id: string; sha: string };
    const encontrada = conSesion(id);
    if (!encontrada) {
      reply.code(404);
      return { error: "No existe la sesión." };
    }
    return { archivos: await repos.archivosDeCommit(encontrada.sesion, encontrada.repo, sha) };
  });

  /** "Deshacer" del chat: revierte los checkpoints de un pedido. */
  app.post("/api/sesiones/:id/revertir", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { shas } = (request.body ?? {}) as { shas?: unknown };
    const encontrada = conSesion(id);
    if (!encontrada || encontrada.sesion.estado !== "abierta") {
      reply.code(404);
      return { error: "No existe la sesión abierta." };
    }
    if (!Array.isArray(shas) || shas.length === 0 || !shas.every((sha) => typeof sha === "string")) {
      reply.code(400);
      return { error: "Faltan los checkpoints a deshacer." };
    }
    const escritor = runtime.titularDeEscritura(encontrada.repo.id);
    if (escritor) {
      reply.code(409);
      return { error: `${escritor} está escribiendo en su turno. Deshacé cuando termine.` };
    }
    const resultado = await repos.revertir(
      encontrada.sesion,
      encontrada.repo,
      shas as string[],
      await repos.identidadDePersona(),
    );
    if (!resultado.ok) {
      reply.code(409);
      return { error: resultado.motivo };
    }
    return resultado;
  });

  /**
   * Vista previa: sirve los archivos del worktree (o de la base, sin sesión)
   * para verlos correr en un iframe del IDE.
   *
   * El iframe va con `sandbox="allow-scripts"` **sin** `allow-same-origin`: es
   * código que escribió un agente, y con el mismo origen que la app podría
   * llamar a toda la API —borrar empresas, correr comandos— con sólo cargarse.
   * Con origen opaco, los ES modules necesitan CORS para cargar, y por eso
   * estas respuestas —y sólo éstas— van con `Access-Control-Allow-Origin: *`.
   */
  app.get("/api/repos/:repoId/vista/*", async (request, reply) => {
    const { repoId } = request.params as { repoId: string };
    const pedida = decodeURIComponent((request.params as Record<string, string>)["*"] ?? "") || "index.html";
    const repo = conRepo(repoId);
    if (!repo) {
      reply.code(404);
      return { error: "No existe el repo." };
    }
    let raiz: string;
    try {
      raiz = await realpath(repos.raizDeVista(repo));
    } catch {
      reply.code(404);
      return { error: "El repo no tiene copia de trabajo." };
    }
    let resuelta = await resolverEnWorktree(raiz, pedida);
    if (!resuelta.ok) {
      reply.code(404);
      return { error: resuelta.motivo };
    }
    try {
      if ((await stat(resuelta.absoluta)).isDirectory()) {
        resuelta = await resolverEnWorktree(raiz, join(resuelta.relativa, "index.html"));
        if (!resuelta.ok) throw new Error("sin index");
      }
      const bytes = await readFile(resuelta.absoluta);
      reply
        .header("content-type", tipoWeb(resuelta.relativa))
        // El mismo sandbox que el iframe, pero puesto por el servidor: así
        // también vale si alguien abre la vista en una pestaña aparte, donde
        // ningún atributo `sandbox` la protege y correría con el origen de la
        // app —con acceso a toda la API por el proxy—.
        .header("content-security-policy", "sandbox allow-scripts allow-pointer-lock allow-forms")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff");
      return reply.send(bytes);
    } catch {
      reply.code(404).header("access-control-allow-origin", "*");
      return { error: `No existe "${pedida}".` };
    }
  });

  app.get("/api/companies/:companyId/codigo/stream", async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    const stream = openSse(reply);
    const soltar = runtime.subscribeCodigo(companyId, (evento) => stream.send("codigo", evento));
    request.raw.on("close", () => {
      soltar();
      stream.close();
    });
  });
}

/** Tipos de contenido para servir un sitio: sin el de JS, un ES module no carga. */
function tipoWeb(ruta: string): string {
  const ext = ruta.slice(ruta.lastIndexOf(".") + 1).toLowerCase();
  const tipos: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    wasm: "application/wasm",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    avif: "image/avif",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    glsl: "text/plain; charset=utf-8",
    frag: "text/plain; charset=utf-8",
    vert: "text/plain; charset=utf-8",
    xml: "application/xml",
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
  };
  return tipos[ext] ?? "application/octet-stream";
}
