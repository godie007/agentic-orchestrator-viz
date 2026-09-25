import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ids } from "@orq/shared";
import { armarEntorno, type EntornoDePrueba } from "./testing/entorno.js";

/**
 * Renombrar un proyecto se lleva detrás todo lo que dependía del nombre.
 *
 * La fila sola es lo fácil. Lo que se rompe en silencio es el resto: el vault
 * se resuelve por nombre y abría uno vacío al lado del que tenía la memoria; la
 * carpeta de `data/proyectos/` seguía diciendo el nombre viejo; y al mudarla,
 * git queda con rutas absolutas a la carpeta anterior en los dos lados del
 * worktree, así que un `git status` dentro de la sesión falla.
 */

let entorno: EntornoDePrueba;

function empresa(nombre: string): string {
  const companyId = ids.company();
  const now = Date.now();
  entorno.store.saveCompany({
    id: companyId,
    name: nombre,
    mission: "",
    voz: { unaSolaVoz: false, pronunciacion: {} },
    marca: { acento: "#40a0f8", panel: "#232f4d", rotulos: false },
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: {
      providerId: "openai",
      modelSlug: null,
      tier: "standard",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    },
    createdAt: now,
    updatedAt: now,
  });
  return companyId;
}

function repoDePersona(): string {
  const dir = join(entorno.dir, "mi-app");
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=P", "-c", "user.email=p@x", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "index.js"), "export const uno = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "inicial");
  return dir;
}

beforeEach(() => {
  entorno = armarEntorno();
});

afterEach(() => {
  entorno.cerrar();
});

describe("renombrar un proyecto", () => {
  it("muda la carpeta del proyecto y deja la sesión de código andando", async () => {
    const { runtime } = entorno;
    const companyId = empresa("Prueba 3");
    const { repo } = await runtime.repos.cargar(companyId, { origen: { tipo: "local", ruta: repoDePersona() } });
    const sesion = await runtime.repos.abrirSesion(repo);
    const worktreeViejo = runtime.repos.rutaWorktree(sesion);
    expect(worktreeViejo).toContain(`${join("proyectos", "Prueba 3")}`);

    const resultado = await runtime.renombrarEmpresa(companyId, "Simulador");
    expect(resultado.ok).toBe(true);
    expect(entorno.store.getCompany(companyId)?.name).toBe("Simulador");

    const carpeta = runtime.directorios.ruta(companyId);
    expect(basename(carpeta)).toBe("Simulador");
    expect(existsSync(join(entorno.dir, "proyectos", "Prueba 3"))).toBe(false);
    expect(readFileSync(join(carpeta, ".empresa"), "utf8")).toBe(companyId);

    // Git sin ayuda: desde adentro del worktree, que es como lo abre una
    // persona en su terminal. Sin `worktree repair` su `.git` apunta al clon
    // en la carpeta vieja y esto falla.
    const worktree = runtime.repos.rutaWorktree(sesion);
    expect(worktree.startsWith(carpeta)).toBe(true);
    const estado = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(estado).toBe("");

    // Y por el camino del orquestador (git-dir explícito).
    await expect(runtime.repos.estado(sesion, repo)).resolves.toMatchObject({ archivos: [] });
  });

  it("el vault sigue al nombre: la memoria no queda en una carpeta que nadie lee", async () => {
    const { runtime } = entorno;
    const companyId = empresa("Viejo nombre");
    await runtime.contexto.escribir({ id: companyId, nombre: "Viejo nombre" }, "clientes/acme", "# Acme\n\nPaga a 60 días.");

    const resultado = await runtime.renombrarEmpresa(companyId, "Nuevo nombre");
    expect(resultado.ok).toBe(true);

    const leido = await runtime.contexto.leer({ id: companyId, nombre: "Nuevo nombre" }, "clientes/acme");
    expect(JSON.stringify(leido)).toContain("Paga a 60 días");
    expect(existsSync(join(entorno.dir, "contexto", "Viejo nombre"))).toBe(false);
  });

  it("no pisa la carpeta de otro proyecto que ya se llama así", async () => {
    const { runtime } = entorno;
    const otro = empresa("Simulador");
    runtime.directorios.asegurar(otro);
    const companyId = empresa("Borrador");
    runtime.directorios.asegurar(companyId);

    const resultado = await runtime.renombrarEmpresa(companyId, "Simulador");
    expect(resultado.ok).toBe(true);
    expect(basename(runtime.directorios.ruta(otro))).toBe("Simulador");
    expect(basename(runtime.directorios.ruta(companyId))).toBe(`Simulador (${companyId.slice(-6)})`);
  });

  it("rechaza un nombre vacío", async () => {
    const companyId = empresa("Algo");
    const resultado = await entorno.runtime.renombrarEmpresa(companyId, "   ");
    expect(resultado.ok).toBe(false);
    expect(entorno.store.getCompany(companyId)?.name).toBe("Algo");
  });
});

describe("renombrar un repo", () => {
  it("cambia el nombre y no la carpeta; un nombre repetido se rechaza", async () => {
    const { runtime } = entorno;
    const companyId = empresa("Con código");
    const { repo } = await runtime.repos.cargar(companyId, { origen: { tipo: "local", ruta: repoDePersona() } });
    const otro = await runtime.repos.crearVacio(companyId, "Otro", "de prueba");
    const clonAntes = runtime.repos.rutaClon(repo);

    const renombrado = runtime.repos.renombrar(repo, "  Motor de física ");
    expect(renombrado.nombre).toBe("Motor de física");
    expect(entorno.store.getRepositorio(repo.id)?.nombre).toBe("Motor de física");
    expect(runtime.repos.rutaClon(renombrado)).toBe(clonAntes);

    expect(() => runtime.repos.renombrar(renombrado, "otro")).toThrow(/Ya hay un repo/);
    expect(() => runtime.repos.renombrar(otro, "")).toThrow(/vacío/);
  });
});
