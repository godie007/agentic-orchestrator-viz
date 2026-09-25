import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./db.js";
import { Directorios } from "./directorios.js";
import { validarUrlGit } from "./git.js";
import { RepoStore, detectarComandos, esArchivoDeEjecucion } from "./repos.js";

/**
 * El código de una persona, cargado sin tocarlo.
 *
 * La promesa que más importa acá es la primera: **cargar, abrir una sesión y
 * trabajar no escribe nada en el repo original**. Un `git worktree add` directo
 * sobre su repo lo haría —worktrees, refs, índice— y además dispararía sus
 * hooks. El resto fija el cierre: integrar sólo avanza con fast-forward sobre
 * una carpeta limpia, y una copia sin git nunca pisa lo que la persona cambió.
 */

let base: string;
let store: Store;
let repos: RepoStore;
const COMPANY = "cmp_test01";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Persona", "-c", "user.email=p@x", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function repoDePersona(): string {
  const dir = join(base, "mi-app");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "index.js"), "export const suma = (a, b) => a + b;\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "inicial");
  return dir;
}

/** Huella de todo lo que hay adentro de un `.git`: si cambia un byte, cambia. */
function huellaDeGit(dir: string): string {
  const hash = createHash("sha256");
  const recorrer = (ruta: string) => {
    for (const nombre of readdirSync(ruta).sort()) {
      const completa = join(ruta, nombre);
      if (statSync(completa).isDirectory()) recorrer(completa);
      else hash.update(completa).update(readFileSync(completa));
    }
  };
  recorrer(join(dir, ".git"));
  return hash.digest("hex");
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "orq-repos-"));
  store = new Store(join(base, "db.sqlite"));
  store.saveCompany({
    id: COMPANY,
    name: "Prueba código",
    mission: "",
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: { providerId: "openai", modelSlug: null, tier: "standard", escalado: null, temperature: null, maxOutputTokens: 4096 },
    createdAt: 1,
    updatedAt: 1,
  } as never);
  const dirs = new Directorios(join(base, "proyectos"), (id) => store.getCompany(id)?.name ?? null);
  repos = new RepoStore(store, dirs);
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("RepoStore con un origen local con git", () => {
  it("cargar, abrir sesión y hacer checkpoints no escribe nada en el .git original", async () => {
    const origen = repoDePersona();
    const antes = huellaDeGit(origen);

    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "export const suma = (a, b) => b + a;\n");
    await repos.checkpoint(sesion, repo, { nombre: "Tomás", id: "rol_tomas" }, "Invierte la suma");

    expect(huellaDeGit(origen)).toBe(antes);
    expect(repos.rutaClon(repo)).toContain(join("proyectos", "Prueba código", "repos"));
  });

  it("el checkpoint lleva al rol como autor y deja afuera .env y node_modules", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    const wt = repos.rutaWorktree(sesion);
    writeFileSync(join(wt, "nuevo.js"), "1\n");
    writeFileSync(join(wt, ".env"), "SECRETO=1\n");
    mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "x", "i.js"), "1\n");

    const sha = await repos.checkpoint(sesion, repo, { nombre: "Tomás", id: "rol_tomas" }, "Agrega nuevo");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const archivos = sh(wt, "show", "--name-only", "--format=%an", "HEAD").trim().split("\n");
    expect(archivos[0]).toBe("Tomás");
    expect(archivos).toContain("nuevo.js");
    expect(archivos).not.toContain(".env");
    expect(archivos.some((a) => a.startsWith("node_modules"))).toBe(false);
  });

  it("un checkpoint sin cambios no crea un commit vacío", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    expect(await repos.checkpoint(sesion, repo, { nombre: "X", id: "x" }, "nada")).toBeNull();
  });

  it("la sesión es una por repo y abrir de nuevo devuelve la misma", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const una = await repos.abrirSesion(repo);
    const otra = await repos.abrirSesion(repo);
    expect(otra.id).toBe(una.id);
  });

  it("integrar avanza la rama base con fast-forward cuando la carpeta está limpia", async () => {
    const origen = repoDePersona();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "nuevo.js"), "hola\n");

    // Sin commits automáticos, publicar no commitea por la persona.
    const sinCommit = await repos.integrar(sesion, repo);
    expect(sinCommit.ok).toBe(false);
    expect(sinCommit.ok === false && sinCommit.motivo).toMatch(/sin commitear/);
    expect(existsSync(join(origen, "nuevo.js"))).toBe(false);

    await repos.checkpoint(sesion, repo, { nombre: "Persona", id: "persona" }, "");
    const resultado = await repos.integrar(sesion, repo);
    expect(resultado).toMatchObject({ ok: true, modo: "fast-forward", sigueAbierta: true });
    expect(readFileSync(join(origen, "nuevo.js"), "utf8")).toBe("hola\n");
    // En la rama del proyecto publicar no cierra la sesión: se sigue trabajando
    // sobre ella, y la base pasa a ser lo publicado.
    const despues = store.getSesionCodigo(sesion.id)!;
    expect(despues.estado).toBe("abierta");
    expect(despues.baseSha).toBe(sh(origen, "rev-parse", "main").trim());
    expect(existsSync(repos.rutaWorktree(sesion))).toBe(true);
  });

  it("la sesión trabaja en la rama del proyecto, no en una rama inventada", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    expect(sesion.rama).toBe("main");
    expect(sh(repos.rutaWorktree(sesion), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    // El clon la soltó: quedó desprendido, con los mismos archivos.
    expect(sh(repos.rutaClon(repo), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
  });

  it("con la carpeta sucia no integra encima: lo dice y la sesión sigue abierta", async () => {
    const origen = repoDePersona();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "nuevo.js"), "hola\n");
    writeFileSync(join(origen, "index.js"), "// cambio sin commitear\n");

    const resultado = await repos.integrar(sesion, repo);
    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.motivo).toMatch(/sin commitear/);
    expect(existsSync(join(origen, "nuevo.js"))).toBe(false);
    expect(readFileSync(join(origen, "index.js"), "utf8")).toBe("// cambio sin commitear\n");
    expect(store.getSesionCodigo(sesion.id)?.estado).toBe("abierta");
  });

  it("si la base cambió y choca, no integra: nombra los conflictos", async () => {
    const origen = repoDePersona();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "sesion\n");
    await repos.checkpoint(sesion, repo, { nombre: "Persona", id: "persona" }, "");
    writeFileSync(join(origen, "index.js"), "persona\n");
    sh(origen, "commit", "-q", "-am", "cambio de la persona");

    const resultado = await repos.integrar(sesion, repo);
    expect(resultado.ok).toBe(false);
    expect(resultado.ok === false && resultado.conflictos).toEqual(["index.js"]);
    expect(store.getSesionCodigo(sesion.id)?.estado).toBe("abierta");
  });

  it("descartar se lleva el worktree y deja la rama del proyecto como está en el repo de la persona", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    const wt = repos.rutaWorktree(sesion);
    writeFileSync(join(wt, "nuevo.js"), "hola\n");
    await repos.checkpoint(sesion, repo, { nombre: "Rol", id: "rol_x" }, "trabajo que se descarta");
    await repos.descartar(sesion, repo);
    expect(existsSync(wt)).toBe(false);
    const clon = repos.rutaClon(repo);
    // La rama no se borra —es la del proyecto—: vuelve a la de la persona.
    expect(sh(clon, "rev-parse", "main").trim()).toBe(sh(clon, "rev-parse", "origin/main").trim());
    expect(store.getSesionCodigo(sesion.id)?.estado).toBe("descartada");
  });

  it("una instantánea guarda el árbol entero sin tocar la rama ni el índice; deshacer vuelve atrás lo del tramo", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    const wt = repos.rutaWorktree(sesion);
    writeFileSync(join(wt, "de-la-persona.js"), "mío\n");
    const antes = await repos.instantanea(sesion, repo, "run_x-antes");
    // Lo que haría un agente en su turno:
    writeFileSync(join(wt, "index.js"), "// editado por el agente\n");
    writeFileSync(join(wt, "nuevo-del-agente.js"), "x\n");
    const despues = await repos.instantanea(sesion, repo, "run_x-despues");

    expect(sh(wt, "rev-parse", "HEAD").trim()).toBe(sesion.baseSha);
    expect(sh(wt, "diff", "--cached", "--name-only").trim()).toBe("");
    expect((await repos.cambiosEntre(sesion, repo, antes, despues)).map((c) => `${c.estado} ${c.ruta}`).sort()).toEqual([
      "A nuevo-del-agente.js",
      "M index.js",
    ]);

    await repos.deshacerEntre(sesion, repo, antes, despues);
    expect(readFileSync(join(wt, "index.js"), "utf8")).toBe("export const suma = (a, b) => a + b;\n");
    expect(existsSync(join(wt, "nuevo-del-agente.js"))).toBe(false);
    // Lo que la persona tenía antes del pedido sigue ahí.
    expect(readFileSync(join(wt, "de-la-persona.js"), "utf8")).toBe("mío\n");
  });

  it("el diff muestra también lo que todavía no se commiteó", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "nuevo.js"), "hola\n");
    const diff = await repos.diff(sesion, repo);
    expect(diff).toContain("nuevo.js");
    expect(diff).toContain("+hola");
    const estado = await repos.estado(sesion, repo);
    expect(estado.archivos).toEqual([{ estado: "A", ruta: "nuevo.js" }]);
  });
});

describe("RepoStore con una carpeta sin git", () => {
  function carpetaSuelta(): string {
    const dir = join(base, "suelta");
    mkdirSync(join(dir, "node_modules", "pesado"), { recursive: true });
    writeFileSync(join(dir, "app.py"), "print('hola')\n");
    writeFileSync(join(dir, "node_modules", "pesado", "x.js"), "x\n");
    return dir;
  }

  it("se trabaja sobre una copia versionada: la carpeta de la persona no gana un .git", async () => {
    const origen = carpetaSuelta();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    expect(repo.origenSinGit).toBe(true);
    expect(existsSync(join(origen, ".git"))).toBe(false);
    expect(existsSync(join(repos.rutaClon(repo), "node_modules"))).toBe(false);
  });

  it("integrar copia de vuelta lo que cambió", async () => {
    const origen = carpetaSuelta();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "app.py"), "print('chau')\n");
    await repos.checkpoint(sesion, repo, { nombre: "Persona", id: "persona" }, "");
    const resultado = await repos.integrar(sesion, repo);
    expect(resultado).toMatchObject({ ok: true, modo: "copia" });
    expect(readFileSync(join(origen, "app.py"), "utf8")).toBe("print('chau')\n");
  });

  it("no pisa un archivo que la persona cambió desde la base", async () => {
    const origen = carpetaSuelta();
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "app.py"), "print('sesion')\n");
    writeFileSync(join(origen, "app.py"), "print('persona')\n");
    const resultado = await repos.integrar(sesion, repo);
    expect(resultado.ok).toBe(false);
    expect(readFileSync(join(origen, "app.py"), "utf8")).toBe("print('persona')\n");
  });
});

describe("validarUrlGit", () => {
  it("rechaza credenciales embebidas: la URL se guarda y viaja en el blueprint", () => {
    expect(validarUrlGit("https://user:ghp_x@github.com/a/b.git").ok).toBe(false);
    expect(validarUrlGit("https://ghp_x@github.com/a/b.git").ok).toBe(false);
  });
  it("rechaza transportes que ejecutan cosas y argumentos disfrazados de URL", () => {
    expect(validarUrlGit("ext::sh -c touch% /tmp/x").ok).toBe(false);
    expect(validarUrlGit("--upload-pack=touch /tmp/x").ok).toBe(false);
    expect(validarUrlGit("file:///etc").ok).toBe(false);
  });
  it("acepta https, ssh y la forma scp", () => {
    expect(validarUrlGit("https://github.com/a/b.git").ok).toBe(true);
    expect(validarUrlGit("git@github.com:a/b.git").ok).toBe(true);
    expect(validarUrlGit("ssh://git@github.com/a/b.git").ok).toBe(true);
  });
});

describe("detectarComandos y archivos de ejecución", () => {
  it("sugiere lo que el repo declara, sin permitirlo", async () => {
    const dir = join(base, "node");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const sugeridos = await detectarComandos(dir);
    expect(sugeridos.preparar).toEqual(["npm", "ci"]);
    expect(sugeridos.test).toEqual(["npm", "test"]);
    expect(sugeridos.verificar).toEqual(["npm", "run", "typecheck"]);
  });

  it("marca lo que cambia qué se ejecuta", () => {
    expect(esArchivoDeEjecucion("package.json")).toBe(true);
    expect(esArchivoDeEjecucion(".github/workflows/ci.yml")).toBe(true);
    expect(esArchivoDeEjecucion("vitest.config.ts")).toBe(true);
    expect(esArchivoDeEjecucion("src/index.ts")).toBe(false);
  });
});

describe("RepoStore desde el IDE", () => {
  it("sin sesión se lee la rama base y listar no abre una sesión", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    expect(await repos.listarArchivos(repo, null)).toEqual(["index.js", "package.json"]);
    const leido = await repos.leerArchivo(repo, null, "index.js");
    expect(leido.ok && leido.contenido).toContain("suma");
    expect(repos.sesionAbierta(repo.id, COMPANY)).toBeNull();
  });

  it("guardar con el hash de lo que se cargó escribe; con uno viejo no pisa lo que cambió en disco", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    const leido = await repos.leerArchivo(repo, sesion, "index.js");
    if (!leido.ok) throw new Error("no leyó");
    // Un agente edita el archivo mientras la persona lo tenía abierto.
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "// lo cambió un agente\n");
    const conflicto = await repos.escribirArchivo(sesion, repo, "index.js", "// mío", leido.hash);
    expect(conflicto).toMatchObject({ ok: false, conflicto: true });
    expect(readFileSync(join(repos.rutaWorktree(sesion), "index.js"), "utf8")).toBe("// lo cambió un agente\n");

    const actual = await repos.leerArchivo(repo, sesion, "index.js");
    if (!actual.ok) throw new Error("no leyó");
    expect((await repos.escribirArchivo(sesion, repo, "index.js", "// mío\n", actual.hash)).ok).toBe(true);
  });

  it("un archivo nuevo se guarda con hash null, y no se puede escribir en .git ni fuera del árbol", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    expect((await repos.escribirArchivo(sesion, repo, "src/nuevo.js", "1\n", null)).ok).toBe(true);
    expect((await repos.escribirArchivo(sesion, repo, ".git/hooks/pre-commit", "x", null)).ok).toBe(false);
    expect((await repos.escribirArchivo(sesion, repo, "../fuera.js", "x", null)).ok).toBe(false);
    expect(await repos.listarArchivos(repo, sesion)).toContain("src/nuevo.js");
  });

  it("la base del diff es cómo estaba el archivo al abrir la sesión", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "// nuevo\n");
    await repos.checkpoint(sesion, repo, { nombre: "Tomás", id: "rol_t" }, "");
    const base = await repos.leerArchivo(repo, sesion, "index.js", "base");
    expect(base.ok && base.contenido).toContain("suma");
    const nuevo = await repos.leerArchivo(repo, sesion, "no-existia.js", "base");
    expect(nuevo.ok && nuevo.contenido).toBeNull();
  });

  it("confirmar desde el IDE firma con la identidad de la persona y el título que escribió", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "// mío\n");
    expect(await repos.tieneCambiosPendientes(sesion, repo)).toBe(true);
    await repos.checkpoint(sesion, repo, { nombre: "Diego", id: "persona", email: "d@x.com" }, "", {
      titulo: "Arreglo el README",
    });
    const log = sh(repos.rutaWorktree(sesion), "log", "-1", "--format=%an <%ae>|%s").trim();
    expect(log).toBe("Diego <d@x.com>|Arreglo el README");
    expect(await repos.tieneCambiosPendientes(sesion, repo)).toBe(false);
  });

  it("el checkpoint de un agente no repite su nombre en el título", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "// x\n");
    await repos.checkpoint(sesion, repo, { nombre: "Paula", id: "rol_p" }, "Resumen del turno");
    expect(sh(repos.rutaWorktree(sesion), "log", "-1", "--format=%an|%s").trim()).toBe("Paula|index.js");
  });

  it("buscar encuentra texto literal en la sesión, incluidos los archivos nuevos", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "otro.js"), "const x = suma(1, 2);\n");
    const { resultados } = await repos.buscarTexto(repo, sesion, "suma(");
    expect(resultados.map((r) => r.ruta).sort()).toEqual(["otro.js"]);
    const sinSesion = await repos.buscarTexto(repo, null, "suma");
    expect(sinSesion.resultados[0]).toMatchObject({ ruta: "index.js", linea: 1 });
  });
});

describe("repos creados por la empresa", () => {
  it("nace con commit base, comandos de Node permitidos, y no repite nombre", async () => {
    const repo = await repos.crearVacio(COMPANY, "simulador-balistico", "Balística de un francotirador");
    expect(repo.origen).toEqual({ tipo: "creado", descripcion: "Balística de un francotirador" });
    expect(repo.comandos.permitidos).toContainEqual(["npm", "test"]);
    expect(readFileSync(join(repos.rutaClon(repo), "README.md"), "utf8")).toContain("simulador-balistico");
    await expect(repos.crearVacio(COMPANY, "Simulador-Balistico", "")).rejects.toThrow(/Ya hay un repo/);
  });

  it("integrar avanza su propio main: no tiene un afuera", async () => {
    const repo = await repos.crearVacio(COMPANY, "app-nueva", "");
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "index.js"), "console.log(1);\n");
    await repos.checkpoint(sesion, repo, { nombre: "Persona", id: "persona" }, "");
    const resultado = await repos.integrar(sesion, repo);
    expect(resultado).toMatchObject({ ok: true, modo: "fast-forward" });
    expect(readFileSync(join(repos.rutaClon(repo), "index.js"), "utf8")).toBe("console.log(1);\n");
  });

  it("sacar un repo con trabajo sin integrar deja un respaldo que se puede clonar", async () => {
    // Lo pagamos: un simulador entero vivía sólo en la rama de la sesión y se
    // fue con el clon al sacar el repo del proyecto.
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await repos.abrirSesion(repo);
    writeFileSync(join(repos.rutaWorktree(sesion), "nuevo.js"), "export const hecho = true;\n");
    await repos.checkpoint(sesion, repo, { nombre: "Tomás", id: "rol_t" }, "trabajo");

    const { respaldo } = await repos.eliminar(repo);
    expect(respaldo).toMatch(/^respaldos\/.*\.bundle$/);
    const salida = join(base, "proyectos", "Prueba código", "salida");
    const bundle = join(salida, respaldo!);
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(bundle.replace(/\.bundle$/, ".patch"))).toBe(true);
    // El bundle es git de verdad: se clona y trae el trabajo.
    const recuperado = join(base, "recuperado");
    execFileSync("git", ["clone", "-q", "-b", sesion.rama, bundle, recuperado]);
    expect(readFileSync(join(recuperado, "nuevo.js"), "utf8")).toBe("export const hecho = true;\n");
  });

  it("sacar un repo sin trabajo no deja respaldos de más", async () => {
    const { repo } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: repoDePersona() } });
    await repos.abrirSesion(repo);
    expect((await repos.eliminar(repo)).respaldo).toBeNull();
  });
});

describe("una subcarpeta de un repo más grande", () => {
  it("se trabaja como copia de esa carpeta sola, no se clona el repo que la contiene", async () => {
    // Lo pagamos: cargar un programa que vivía en `data/` clonó el orquestador
    // entero adentro de sí mismo.
    const grande = repoDePersona();
    mkdirSync(join(grande, "programas", "juego", "src"), { recursive: true });
    writeFileSync(join(grande, "programas", "juego", "src", "main.js"), "export const juego = 1;\n");
    const { repo, avisos } = await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: join(grande, "programas", "juego") } });
    expect(repo.origenSinGit).toBe(true);
    expect(avisos.join(" ")).toContain("copia de esta carpeta sola");
    const archivos = await repos.listarArchivos(repo, null);
    expect(archivos).toEqual(["src/main.js"]);
  });
});
