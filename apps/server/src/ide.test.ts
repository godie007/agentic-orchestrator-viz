import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Repositorio, Role, Run } from "@orq/shared";
import { FakeProvider } from "@orq/engine";
import { construirApp } from "./app.js";
import { MisionScheduler } from "./misiones.js";
import { armarEntorno, type EntornoDePrueba } from "./testing/entorno.js";

/**
 * El IDE por HTTP: la corrida enfocada del chat, deshacer un pedido, la vista
 * previa y el CORS cerrado.
 *
 * Lo que más importa fijar es la frontera de la vista previa: sirve código que
 * escribió un agente para que corra en el navegador, así que no puede leer
 * `.git`, y la API no puede contestarle a cualquier origen.
 */

let entorno: EntornoDePrueba;
let app: FastifyInstance;

beforeEach(async () => {
  // Un proveedor que contesta y cierra el turno sin herramientas: alcanza para
  // ver qué recibe el agente y qué abre el turno de código.
  entorno = armarEntorno([new FakeProvider(() => ({ text: "Listo, mejoré la función." }))]);
  const misiones = new MisionScheduler(entorno.store, entorno.runtime, entorno.runtime.correo, "http://localhost:5173", 60_000);
  app = await construirApp(
    { store: entorno.store, runtime: entorno.runtime, providers: entorno.providers, misiones },
    { origenes: ["http://localhost:5173"] },
  );
});

afterEach(async () => {
  await app.close();
  entorno.cerrar();
});

function repoLocal(nombre: string, archivos: Record<string, string>): string {
  const dir = join(entorno.dir, nombre);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  for (const [ruta, contenido] of Object.entries(archivos)) {
    mkdirSync(join(dir, ruta, ".."), { recursive: true });
    writeFileSync(join(dir, ruta), contenido);
  }
  execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@x", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=p", "-c", "user.email=p@x", "commit", "-qm", "base"], { cwd: dir });
  return dir;
}

async function empresaConRepos(): Promise<{ companyId: string; repos: Repositorio[] }> {
  const empresa = await app.inject({
    method: "POST",
    url: "/api/companies",
    payload: { name: "IDE", mission: "", budgetUsd: 1, defaultModel: { providerId: "openai", tier: "standard" } },
  });
  const companyId = (empresa.json() as { id: string }).id;
  const repos: Repositorio[] = [];
  for (const nombre of ["web", "api"]) {
    const r = await app.inject({
      method: "POST",
      url: `/api/companies/${companyId}/repos`,
      payload: {
        origen: {
          tipo: "local",
          ruta: repoLocal(nombre, {
            "index.html": '<script type="module" src="src/app.js"></script>',
            "src/app.js": "export const x = 1;\n",
          }),
        },
      },
    });
    expect(r.statusCode).toBe(200);
    repos.push((r.json() as { repo: Repositorio }).repo);
  }
  return { companyId, repos };
}

describe("el agente del chat", () => {
  it("se crea una sola vez, con todas las herramientas de código", async () => {
    const { companyId } = await empresaConRepos();
    const uno = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/mejorador` })).json() as Role;
    const dos = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/mejorador` })).json() as Role;
    expect(dos.id).toBe(uno.id);
    const nombres = entorno.store
      .listTools(companyId)
      .filter((tool) => uno.toolIds.includes(tool.id))
      .map((tool) => tool.name);
    expect(nombres).toEqual(expect.arrayContaining(["editar_codigo", "leer_codigo", "ejecutar_comando"]));
  });

  it("una corrida enfocada tiene un solo agente, le llega el contexto y trabaja sobre el repo elegido", async () => {
    const { companyId, repos } = await empresaConRepos();
    const rol = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/mejorador` })).json() as Role;
    // El modelo del proveedor de prueba, fijo: el tier no resuelve sin precios reales.
    entorno.store.saveRole({ ...rol, model: { ...rol.model, providerId: "openai", modelSlug: "fake-model" } });
    // Otro rol en la empresa, que la corrida enfocada no tiene que convocar.
    entorno.store.saveRole({ ...rol, id: "rol_otro", name: "Otro", toolIds: [] });

    const creada = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        companyId,
        objective: "Mejorá app.js",
        mode: "manual",
        foco: { rolId: rol.id, repoId: repos[1]!.id, contexto: "### Archivo src/app.js\nexport const x = 1;" },
      },
    });
    expect(creada.statusCode).toBe(201);
    const run = creada.json() as Run;
    expect(run.foco).toEqual({ rolId: rol.id, repoId: repos[1]!.id });
    expect(run.maxTicks).toBe(4);

    const viva = entorno.runtime.active(run.id)!;
    expect(viva.state.getRole("rol_otro")).toBeUndefined();
    const mensaje = viva.state.messages[0]!;
    expect(mensaje.toRoleId).toBe(rol.id);
    expect(mensaje.body).toContain("Mejorá app.js");
    expect(mensaje.body).toContain("### Archivo src/app.js");

    await app.inject({ method: "POST", url: `/api/runs/${run.id}/tick` });
    // El turno abrió la sesión del repo elegido (el segundo), no la del primero.
    expect(entorno.runtime.repos.sesionAbierta(repos[1]!.id, companyId)).not.toBeNull();
    expect(entorno.runtime.repos.sesionAbierta(repos[0]!.id, companyId)).toBeNull();

    const pedidos = (await app.inject({ method: "GET", url: `/api/repos/${repos[1]!.id}/pedidos` })).json() as Run[];
    expect(pedidos.map((p) => p.id)).toEqual([run.id]);
  });
});

describe("deshacer un pedido", () => {
  it("revierte el checkpoint y nombra los archivos que había tocado", async () => {
    const { companyId, repos } = await empresaConRepos();
    const repo = repos[0]!;
    const sesion = await entorno.runtime.repos.abrirSesion(repo);
    const archivo = join(entorno.runtime.repos.rutaWorktree(sesion), "src/app.js");
    writeFileSync(archivo, "export const x = 2;\n");
    const sha = await entorno.runtime.repos.checkpoint(sesion, repo, { nombre: "Mejorador", id: "rol_m" }, "");

    const tocados = (await app.inject({ method: "GET", url: `/api/sesiones/${sesion.id}/commit/${sha}` })).json() as {
      archivos: Array<{ ruta: string }>;
    };
    expect(tocados.archivos.map((a) => a.ruta)).toEqual(["src/app.js"]);

    const r = await app.inject({ method: "POST", url: `/api/sesiones/${sesion.id}/revertir`, payload: { shas: [sha] } });
    expect(r.json()).toEqual({ ok: true, revertidos: 1 });
    expect(readFileSync(archivo, "utf8")).toBe("export const x = 1;\n");
    expect(companyId).toBeTruthy();
  });

  it("no revierte algo que no es un checkpoint de la sesión", async () => {
    const { repos } = await empresaConRepos();
    const sesion = await entorno.runtime.repos.abrirSesion(repos[0]!);
    const r = await app.inject({
      method: "POST",
      url: `/api/sesiones/${sesion.id}/revertir`,
      payload: { shas: [sesion.baseSha] },
    });
    expect(r.statusCode).toBe(409);
  });
});

describe("vista previa", () => {
  it("sirve el sitio con el tipo correcto y CORS abierto sólo para sí misma", async () => {
    const { repos } = await empresaConRepos();
    const pagina = await app.inject({ method: "GET", url: `/api/repos/${repos[0]!.id}/vista/` });
    expect(pagina.statusCode).toBe(200);
    expect(pagina.headers["content-type"]).toContain("text/html");
    expect(pagina.headers["access-control-allow-origin"]).toBe("*");
    // El sandbox lo pone también el servidor: abierta en una pestaña aparte, sin
    // iframe, la página no puede correr con el origen de la app.
    expect(pagina.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(pagina.headers["content-security-policy"]).not.toContain("allow-same-origin");
    const modulo = await app.inject({ method: "GET", url: `/api/repos/${repos[0]!.id}/vista/src/app.js` });
    // Sin el tipo de JS un ES module no carga en el navegador.
    expect(modulo.headers["content-type"]).toContain("text/javascript");
  });

  it("no deja leer .git ni salir del repo", async () => {
    const { repos } = await empresaConRepos();
    for (const ruta of [".git/config", "..%2F..%2Fdb.sqlite", "src/..%2F..%2F..%2Fdb.sqlite"]) {
      const r = await app.inject({ method: "GET", url: `/api/repos/${repos[0]!.id}/vista/${ruta}` });
      expect(r.statusCode, ruta).toBe(404);
    }
  });
});

describe("CORS", () => {
  it("la API le contesta a la app y no a cualquier página del navegador", async () => {
    const desdeLaApp = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://localhost:5173" } });
    expect(desdeLaApp.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const desdeOtro = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://malicioso.example" } });
    expect(desdeOtro.headers["access-control-allow-origin"]).toBeUndefined();
    // Y el JavaScript de la vista previa corre con origen opaco: tampoco.
    const desdeLaVista = await app.inject({ method: "GET", url: "/api/health", headers: { origin: "null" } });
    expect(desdeLaVista.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("comandos sobre un árbol que no cambió", () => {
  it("se reutiliza el resultado; si cambia un archivo, o se pide repetir, se vuelve a correr", async () => {
    const { companyId, repos } = await empresaConRepos();
    const repo = { ...repos[0]!, comandos: { ...repos[0]!.comandos, sinAislamiento: true } };
    entorno.store.saveRepositorio(repo);
    const { crearCodigoStorage, ArriendosDeCodigo } = await import("./codigo-servidor.js");
    const storage = crearCodigoStorage({
      store: entorno.store,
      repos: entorno.runtime.repos,
      directorios: entorno.runtime.directorios,
      arriendos: new ArriendosDeCodigo(),
      servicios: entorno.runtime.servicios,
      companyId,
    });
    const e = await storage.espacio(repo.id, { runId: "run_x" } as never);
    if (!e.ok) throw new Error(e.motivo);
    const argv = [process.execPath, "-e", "console.log(Math.random())"];

    const primero = await storage.ejecutar(e.espacio, argv, { corteMs: 10_000 });
    expect(primero.reutilizadoHaceMs).toBeUndefined();
    const segundo = await storage.ejecutar(e.espacio, argv, { corteMs: 10_000 });
    expect(segundo.reutilizadoHaceMs).toBeGreaterThanOrEqual(0);
    expect(segundo.salida).toBe(primero.salida);

    writeFileSync(join(e.espacio.dir, "src/app.js"), "export const x = 2;\n");
    const tercero = await storage.ejecutar(e.espacio, argv, { corteMs: 10_000 });
    expect(tercero.reutilizadoHaceMs).toBeUndefined();
    expect(tercero.salida).not.toBe(primero.salida);

    const forzado = await storage.ejecutar(e.espacio, argv, { corteMs: 10_000, repetir: true });
    expect(forzado.reutilizadoHaceMs).toBeUndefined();
  });
});

describe("un equipo sin repo que tiene que construir un programa", () => {
  it("el turno se entera de que el código va en un repo nuevo, no en la salida", async () => {
    const empresa = await app.inject({
      method: "POST",
      url: "/api/companies",
      payload: { name: "Sin repo", mission: "", budgetUsd: 1, defaultModel: { providerId: "openai", tier: "standard" }, plantillaId: "desarrollo-software" },
    });
    const companyId = (empresa.json() as { id: string }).id;
    const cto = entorno.store.listRoles(companyId).find((r) => r.name === "Andrés")!;
    const tomas = entorno.store.listRoles(companyId).find((r) => r.name === "Tomás")!;
    const { abrirTurnoDeCodigo, ArriendosDeCodigo, crearCodigoStorage } = await import("./codigo-servidor.js");
    const deps = {
      store: entorno.store,
      repos: entorno.runtime.repos,
      directorios: entorno.runtime.directorios,
      arriendos: new ArriendosDeCodigo(),
      servicios: entorno.runtime.servicios,
      companyId,
    };

    const turno = await abrirTurnoDeCodigo(deps, cto, "run_x");
    expect(turno?.dir).toBeNull();
    expect(turno?.resumen).toContain("crear_repositorio");
    expect(turno?.resumen).toContain("NO va a la salida");

    // Crear lo decide quien coordina: un ejecutor lo pide.
    const storage = crearCodigoStorage(deps);
    const porEjecutor = await storage.crear("x", "", { runId: "run_x", actor: tomas } as never);
    expect(porEjecutor.ok).toBe(false);
    const porCto = await storage.crear("simulador", "demo", { runId: "run_x", actor: cto } as never);
    expect(porCto.ok).toBe(true);
    expect(entorno.store.listRepositorios(companyId).map((r) => r.nombre)).toEqual(["simulador"]);
  });
});

describe("aprobar una dependencia", () => {
  it("vuelve a validar lo que llegó a la base: un paquete que no es del registro no se instala", async () => {
    const { companyId, repos } = await empresaConRepos();
    const request = {
      id: "req_mal",
      companyId,
      runId: null,
      requestedByRoleId: null,
      type: "dependencia" as const,
      reason: "x",
      roleProposal: null,
      question: null,
      toolNames: [],
      mcpProposal: [],
      comando: null,
      dependencia: { repoId: repos[0]!.id, gestor: "npm" as const, paquetes: ["git+ssh://evil/x.git"], dev: false, carpeta: "" },
      status: "pending" as const,
      resolution: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    await expect(entorno.runtime.applyRequest(companyId, request, null)).rejects.toThrow(/no es un paquete del registro/);
  });
});
