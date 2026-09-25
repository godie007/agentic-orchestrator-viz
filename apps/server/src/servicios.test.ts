import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Servicio } from "@orq/shared";
import { ServiciosVivos, detectarServicios, type EntornoDeArranque } from "./servicios.js";

/**
 * Levantar las partes de un monorepo para la vista previa.
 *
 * Lo que se fija acá es lo que falla en silencio: que el frontend de la vista
 * previa le hable al backend **de la vista previa** (no al de la persona, que
 * está en el puerto original), que un secreto del `.env` no aparezca en los
 * logs que lee un agente, y que detener mate al proceso de verdad.
 */

let base: string;
let vivos: ServiciosVivos;

/** Un servidor HTTP mínimo que devuelve su propio entorno. */
const SERVIDOR = `
const http = require("node:http");
const puerto = Number(process.env.PORT || process.argv[2]);
console.log("arrancando con clave " + process.env.SECRET_KEY);
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ruta: req.url, api: process.env.API_URL || null, frontend: process.env.FRONTEND_URL || null, clave: process.env.SECRET_KEY || null }));
}).listen(puerto, "127.0.0.1");
`;

function servicio(parcial: Partial<Servicio> & Pick<Servicio, "id" | "carpeta" | "tipo">): Servicio {
  return {
    nombre: parcial.id,
    arrancar: null,
    variablePuerto: null,
    puertoOriginal: null,
    salud: null,
    inicio: "/",
    archivosEntorno: [],
    entorno: {},
    ...parcial,
  };
}

function entorno(s: Servicio, hermanos: Servicio[]): EntornoDeArranque {
  return {
    companyId: "cmp_x",
    repoId: "rep_x",
    servicio: s,
    hermanos,
    dir: join(base, "repo"),
    origen: null,
    tmp: join(base, "tmp"),
    aislamiento: null,
  };
}

async function esperar(condicion: () => boolean, ms = 15_000): Promise<void> {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error("no llegó a tiempo");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "orq-servicios-")));
  vivos = new ServiciosVivos(join(base, "pids.json"));
  for (const carpeta of ["api", "web"]) {
    mkdirSync(join(base, "repo", carpeta, "node_modules"), { recursive: true });
    writeFileSync(join(base, "repo", carpeta, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    writeFileSync(join(base, "repo", carpeta, "server.js"), SERVIDOR);
  }
  writeFileSync(join(base, "api.env"), "PORT=3001\nFRONTEND_URL=http://localhost:5173,https://staging.x.co\nSECRET_KEY=super-secreta-123\n");
  writeFileSync(join(base, "web.env"), "API_URL=http://localhost:3001/api\n");
});

afterEach(() => {
  vivos.detenerTodos();
  rmSync(base, { recursive: true, force: true });
});

describe("ServiciosVivos", () => {
  it("el frontend de la vista previa le habla al backend de la vista previa, y los secretos no salen en los logs", async () => {
    const api = servicio({
      id: "api",
      carpeta: "api",
      tipo: "api",
      arrancar: ["node", "server.js"],
      variablePuerto: "PORT",
      puertoOriginal: 3001,
      salud: "/health",
      archivosEntorno: [join(base, "api.env")],
    });
    const web = servicio({
      id: "web",
      carpeta: "web",
      tipo: "web",
      arrancar: ["node", "server.js", "{puerto}"],
      puertoOriginal: 5173,
      archivosEntorno: [join(base, "web.env")],
    });

    await vivos.arrancar(entorno(api, [api, web]));
    await esperar(() => vivos.vista("rep_x", "api").estado === "listo");
    const urlApi = vivos.vista("rep_x", "api").url!;
    expect(urlApi).not.toContain(":3001");

    await vivos.arrancar(entorno(web, [api, web]));
    await esperar(() => vivos.vista("rep_x", "web").estado === "listo");

    const respuesta = await vivos.probar("rep_x", "web", { metodo: "GET", ruta: "/" });
    expect(JSON.parse(respuesta.cuerpo)).toMatchObject({ api: `${urlApi}/api` });
    expect(vivos.vista("rep_x", "web").redirecciones).toEqual([
      { clave: "API_URL", antes: "http://localhost:3001/api", despues: `${urlApi}/api` },
    ]);

    // La clave llegó al proceso (el backend la necesita), pero lo que lee un
    // agente —logs y respuestas— la muestra tapada.
    const deApi = await vivos.probar("rep_x", "api", { metodo: "GET", ruta: "/health" });
    expect(deApi.cuerpo).not.toContain("super-secreta-123");
    expect(deApi.cuerpo).toContain("«secreto»");
    await esperar(() => (vivos.ultimas("rep_x", "api", 50) ?? "").includes("arrancando"));
    expect(vivos.ultimas("rep_x", "api", 50)).not.toContain("super-secreta-123");
    expect(vivos.vista("rep_x", "api").variables).toContain("SECRET_KEY");
  });

  it("detener mata el proceso: el puerto deja de responder", async () => {
    const api = servicio({ id: "api", carpeta: "api", tipo: "api", arrancar: ["node", "server.js"], variablePuerto: "PORT" });
    await vivos.arrancar(entorno(api, [api]));
    await esperar(() => vivos.vista("rep_x", "api").estado === "listo");
    const url = vivos.vista("rep_x", "api").url!;
    vivos.detener("rep_x", "api");
    expect(vivos.vista("rep_x", "api").estado).toBe("detenido");
    let responde = true;
    const limite = Date.now() + 8_000;
    while (responde && Date.now() < limite) {
      responde = await fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
      if (responde) await new Promise((r) => setTimeout(r, 200));
    }
    expect(responde).toBe(false);
  });

  it("un proceso que se cae queda en fallo con su salida, no en 'arrancando' para siempre", async () => {
    writeFileSync(join(base, "repo", "api", "server.js"), 'console.error("Error: falta SUPABASE_URL"); process.exit(1);');
    const api = servicio({ id: "api", carpeta: "api", tipo: "api", arrancar: ["node", "server.js"] });
    await vivos.arrancar(entorno(api, [api]));
    await esperar(() => vivos.vista("rep_x", "api").estado === "fallo");
    expect(vivos.vista("rep_x", "api").detalle).toMatch(/código 1/);
    expect(vivos.ultimas("rep_x", "api", 20)).toContain("falta SUPABASE_URL");
  });

  it("sin dependencias no arranca y lo dice", async () => {
    rmSync(join(base, "repo", "api", "node_modules"), { recursive: true });
    const api = servicio({ id: "api", carpeta: "api", tipo: "api", arrancar: ["node", "server.js"] });
    await expect(vivos.arrancar(entorno(api, [api]))).rejects.toThrow(/preparalo/);
  });
});

describe("detectarServicios", () => {
  it("un monorepo como el de INSPIA: API, web, móvil y documentación; la raíz con sólo tests no cuenta", async () => {
    const repo = join(base, "mono");
    const escribir = (ruta: string, contenido: string) => {
      mkdirSync(join(repo, ruta, ".."), { recursive: true });
      writeFileSync(join(repo, ruta), contenido);
    };
    escribir("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    escribir("backend/package.json", JSON.stringify({ scripts: { dev: "ts-node-dev src/index.ts" }, dependencies: { express: "^4" } }));
    escribir("backend/src/index.ts", "const PORT = Number(process.env.PORT) || 3001;\napp.get('/health', h);\n");
    escribir("frontend/package.json", JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }));
    escribir("frontend/vite.config.ts", "export default { server: { host: '::', port: 5173, strictPort: true } }");
    escribir("mobile/package.json", JSON.stringify({ scripts: { web: "expo start --web" }, dependencies: { expo: "~56" } }));
    escribir("inspia-obsidian/00 - Inicio.md", "# Inicio\n");
    escribir("inspia-obsidian/01 - Arquitectura/Backend.md", "# Backend\n");
    escribir("scripts/x.mjs", "");
    // El vault de Obsidian es el repo entero, pero las notas están en su carpeta.
    escribir(".obsidian/app.json", "{}");
    escribir("README.md", "# INSPIA\n");

    const origen = join(base, "persona");
    mkdirSync(join(origen, "backend"), { recursive: true });
    writeFileSync(join(origen, "backend", ".env"), "PORT=3001\n");

    const servicios = await detectarServicios(repo, origen);
    expect(servicios.map((s) => [s.id, s.tipo])).toEqual([
      ["backend", "api"],
      ["frontend", "web"],
      ["inspia-obsidian", "docs"],
      ["mobile", "movil"],
    ]);
    const backend = servicios.find((s) => s.id === "backend")!;
    expect(backend).toMatchObject({ puertoOriginal: 3001, salud: "/health", archivosEntorno: [join(origen, "backend", ".env")] });
    expect(servicios.find((s) => s.id === "frontend")?.puertoOriginal).toBe(5173);
  });
});
