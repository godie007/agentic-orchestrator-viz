import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repositorio, SesionCodigo } from "@orq/shared";
import { Store } from "./db.js";
import { Directorios } from "./directorios.js";
import { RepoStore } from "./repos.js";
import { ControlDeVersiones } from "./scm.js";

/**
 * El panel de Git del IDE sobre la sesión. Lo que se fija: que cada operación
 * haga lo que dice sobre el worktree, que cambiar de rama mueva la sesión (o
 * integrar llevaría la rama equivocada) y que una fusión con conflicto no deje
 * el árbol a medias.
 */

let base: string;
let store: Store;
let repos: RepoStore;
let scm: ControlDeVersiones;
let repo: Repositorio;
let sesion: SesionCodigo;
let wt: string;
const COMPANY = "cmp_scm01";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=P", "-c", "user.email=p@x", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "orq-scm-"));
  store = new Store(join(base, "db.sqlite"));
  store.saveCompany({
    id: COMPANY,
    name: "Prueba scm",
    mission: "",
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: { providerId: "openai", modelSlug: null, tier: "standard", escalado: null, temperature: null, maxOutputTokens: 4096 },
    createdAt: 1,
    updatedAt: 1,
  } as never);
  repos = new RepoStore(store, new Directorios(join(base, "proyectos"), (id) => store.getCompany(id)?.name ?? null));
  scm = new ControlDeVersiones(repos);
  const origen = join(base, "app");
  mkdirSync(origen);
  sh(origen, "init", "-q", "-b", "main");
  writeFileSync(join(origen, "a.txt"), "uno\n");
  sh(origen, "add", "-A");
  sh(origen, "commit", "-q", "-m", "inicial");
  repo = (await repos.cargar(COMPANY, { origen: { tipo: "local", ruta: origen } })).repo;
  sesion = await repos.abrirSesion(repo);
  wt = repos.rutaWorktree(sesion);
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("ControlDeVersiones", () => {
  it("prepara, commitea con mensaje y modifica el último commit", async () => {
    writeFileSync(join(wt, "a.txt"), "dos\n");
    writeFileSync(join(wt, "nuevo.txt"), "hola\n");
    let estado = await scm.estado(sesion, repo);
    expect(estado.cambios.map((c) => `${c.estado} ${c.ruta}`).sort()).toEqual(["? nuevo.txt", "M a.txt"]);
    expect(estado.puedeModificarUltimo).toBe(false);

    await scm.preparar(sesion, repo, ["a.txt"]);
    estado = await scm.estado(sesion, repo);
    expect(estado.preparados).toEqual([{ ruta: "a.txt", estado: "M" }]);

    await scm.commit(sesion, repo, { mensaje: "feat: cambia a\n\n- detalle" });
    expect(sh(wt, "log", "-1", "--format=%B").trim()).toBe("feat: cambia a\n\n- detalle");
    // Lo no preparado quedó afuera del commit.
    expect((await scm.estado(sesion, repo)).cambios).toEqual([{ ruta: "nuevo.txt", estado: "?" }]);

    await scm.preparar(sesion, repo, "todo");
    await scm.commit(sesion, repo, { mensaje: "feat: cambia a y suma nuevo", amend: true });
    expect(sh(wt, "log", "--format=%s", `${sesion.baseSha}..HEAD`).trim()).toBe("feat: cambia a y suma nuevo");
  });

  it("no modifica con amend un commit que es de la base", async () => {
    writeFileSync(join(wt, "a.txt"), "dos\n");
    await expect(scm.commit(sesion, repo, { mensaje: "x", amend: true })).rejects.toThrow(/base/);
  });

  it("descartar vuelve lo rastreado a como estaba y borra lo nuevo", async () => {
    writeFileSync(join(wt, "a.txt"), "roto\n");
    writeFileSync(join(wt, "basura.txt"), "x\n");
    await scm.preparar(sesion, repo, ["basura.txt"]);
    await scm.descartar(sesion, repo, "todo");
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("uno\n");
    expect(existsSync(join(wt, "basura.txt"))).toBe(false);
    const estado = await scm.estado(sesion, repo);
    expect(estado.cambios.length + estado.preparados.length).toBe(0);
  });

  it("stash guarda y trae de vuelta, archivos nuevos incluidos", async () => {
    writeFileSync(join(wt, "a.txt"), "en progreso\n");
    writeFileSync(join(wt, "nuevo.txt"), "hola\n");
    // Lo que deja el diff de la sesión o el mensaje generado: el nuevo marcado
    // con intención de agregar. `git stash` a secas no lo sabe guardar.
    sh(wt, "add", "-A", "--intent-to-add");
    expect((await scm.estado(sesion, repo)).cambios).toContainEqual({ ruta: "nuevo.txt", estado: "?" });
    await scm.guardarStash(sesion, repo, { mensaje: "a medias" });
    let estado = await scm.estado(sesion, repo);
    expect(estado.cambios).toEqual([]);
    expect(estado.stashes.map((s) => s.mensaje)).toEqual(["a medias"]);
    await scm.usarStash(sesion, repo, "stash@{0}", "sacar");
    estado = await scm.estado(sesion, repo);
    expect(estado.stashes).toEqual([]);
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("en progreso\n");
    expect(existsSync(join(wt, "nuevo.txt"))).toBe(true);
    await expect(scm.usarStash(sesion, repo, "HEAD; rm -rf /", "borrar")).rejects.toThrow(/no es un stash/);
  });

  it("crear y cambiar de rama mueve la sesión, y se puede volver a la rama del proyecto", async () => {
    const original = sesion.rama;
    expect(original).toBe("main");
    writeFileSync(join(wt, "a.txt"), "para la rama nueva\n");
    sesion = await scm.crearRama(sesion, repo, "feature/boton");
    expect(sesion.rama).toBe("feature/boton");
    expect(store.getSesionCodigo(sesion.id)?.rama).toBe("feature/boton");
    // Los cambios sin commitear viajan con la rama nueva.
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("para la rama nueva\n");
    await scm.commit(sesion, repo, { mensaje: "en la rama" });

    await expect(scm.crearRama(sesion, repo, "no vale")).rejects.toThrow(/no es un nombre de rama/);

    sesion = await scm.cambiarRama(sesion, repo, original);
    expect(sesion.rama).toBe("main");
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("uno\n");
    const ramas = (await scm.estado(sesion, repo)).ramas;
    expect(ramas.find((r) => r.nombre === "main")?.actual).toBe(true);
    expect(ramas.some((r) => r.ocupada)).toBe(false);

    await scm.borrarRama(sesion, repo, "feature/boton");
    expect((await scm.estado(sesion, repo)).ramas.some((r) => r.nombre === "feature/boton")).toBe(false);
  });

  it("fusionar trae la otra rama; con conflicto aborta y nombra los archivos", async () => {
    const original = sesion.rama;
    sesion = await scm.crearRama(sesion, repo, "otra");
    writeFileSync(join(wt, "b.txt"), "de otra\n");
    await scm.commit(sesion, repo, { mensaje: "suma b" });
    sesion = await scm.cambiarRama(sesion, repo, original);
    const bien = await scm.fusionar(sesion, repo, "otra");
    expect(bien.ok).toBe(true);
    expect(existsSync(join(wt, "b.txt"))).toBe(true);

    sesion = await scm.cambiarRama(sesion, repo, "otra");
    writeFileSync(join(wt, "a.txt"), "versión de otra\n");
    await scm.commit(sesion, repo, { mensaje: "a en otra" });
    sesion = await scm.cambiarRama(sesion, repo, original);
    writeFileSync(join(wt, "a.txt"), "versión de la sesión\n");
    await scm.commit(sesion, repo, { mensaje: "a en la sesión" });
    const choque = await scm.fusionar(sesion, repo, "otra");
    expect(choque.ok).toBe(false);
    expect(choque.ok ? [] : choque.conflictos).toEqual(["a.txt"]);
    // Abortada: el árbol quedó limpio, sin marcas de conflicto.
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("versión de la sesión\n");
    expect((await scm.estado(sesion, repo)).conflictos).toEqual([]);
  });
});

/**
 * El repo de la persona tiene su propia vida: ramas, tags, commits que hace
 * desde su editor mientras la sesión trabaja. El IDE tiene que mostrarla y no
 * pisarla nunca.
 */
describe("el repo de la persona", () => {
  let origen: string;

  beforeEach(async () => {
    // Otro repo, con dev + main + un tag, abierto en dev como el de INSPIA.
    origen = join(base, "inspia");
    mkdirSync(origen);
    sh(origen, "init", "-q", "-b", "main");
    writeFileSync(join(origen, "a.txt"), "uno\n");
    sh(origen, "add", "-A");
    sh(origen, "commit", "-q", "-m", "inicial");
    sh(origen, "tag", "v1");
    sh(origen, "switch", "-q", "-c", "dev");
    writeFileSync(join(origen, "b.txt"), "dev\n");
    sh(origen, "add", "-A");
    sh(origen, "commit", "-q", "-m", "trabajo en dev");
    repo = (await repos.cargar(COMPANY, { nombre: "inspia", origen: { tipo: "local", ruta: origen } })).repo;
    sesion = await repos.abrirSesion(repo);
    wt = repos.rutaWorktree(sesion);
  });

  it("la base es su dev; sus ramas se ven y se pueden abrir", async () => {
    const estado = await scm.estado(sesion, repo);
    expect(estado.base).toMatchObject({ rama: "dev", ref: "origin/dev", adelante: 0, atras: 0 });
    expect(estado.ramasDelRepo.map((r) => r.nombre).sort()).toEqual(["dev", "main"]);

    expect(sesion.rama).toBe("dev");
    sesion = await scm.cambiarRama(sesion, repo, "main");
    expect(sh(wt, "rev-parse", "--abbrev-ref", "main@{upstream}").trim()).toBe("origin/main");
    expect(existsSync(join(wt, "b.txt"))).toBe(false);
    sesion = await scm.cambiarRama(sesion, repo, "dev");
    expect(existsSync(join(wt, "b.txt"))).toBe(true);
  });

  it("la historia es la de la rama entera, con sus ramas y tags, y marca lo no integrado", async () => {
    writeFileSync(join(wt, "c.txt"), "de la sesión\n");
    await scm.commit(sesion, repo, { mensaje: "feat: algo de la sesión" });
    const { commits } = await scm.historial(sesion, repo);
    expect(commits.map((c) => c.asunto)).toEqual(["feat: algo de la sesión", "trabajo en dev", "inicial"]);
    expect(commits[0]!.sinIntegrar).toBe(true);
    expect(commits[1]!.sinIntegrar).toBe(false);
    // Se commitea sobre dev: dev apunta a lo nuevo, y "tu dev" sigue donde estaba.
    expect(commits[0]!.refs).toContain("dev");
    expect(commits[1]!.refs).toContain("origin/dev");
    expect(commits[2]!.refs).toEqual(expect.arrayContaining(["tag: v1", "origin/main"]));
    const { archivos } = await scm.archivosDeCommit(sesion, repo, commits[0]!.sha);
    expect(archivos).toEqual([{ estado: "A", ruta: "c.txt" }]);
  });

  it("sincronizar trae lo que la persona commiteó después, y la sesión lo puede traer", async () => {
    writeFileSync(join(origen, "b.txt"), "dev avanzó\n");
    sh(origen, "commit", "-q", "-am", "la persona sigue en dev");
    await repos.sincronizarConOrigen(repo, true);
    const estado = await scm.estado(sesion, repo);
    expect(estado.base.atras).toBe(1);
    const traer = await scm.fusionar(sesion, repo, "origin/dev");
    expect(traer.ok).toBe(true);
    expect(readFileSync(join(wt, "b.txt"), "utf8")).toBe("dev avanzó\n");
  });

  it("integrar la sesión adelanta el dev de la persona, que lo tiene abierto", async () => {
    writeFileSync(join(wt, "c.txt"), "de la sesión\n");
    await scm.commit(sesion, repo, { mensaje: "feat: algo" });
    const r = await repos.integrar(sesion, repo);
    expect(r).toMatchObject({ ok: true, modo: "fast-forward" });
    expect(sh(origen, "log", "-1", "--format=%s", "dev").trim()).toBe("feat: algo");
    expect(sh(origen, "branch", "--list", "orq/*").trim()).toBe("");
  });

  it("integrar una rama con nombre propio nunca pisa la de la persona", async () => {
    sesion = await scm.cambiarRama(sesion, repo, "main");
    writeFileSync(join(wt, "c.txt"), "desde la sesión\n");
    await scm.commit(sesion, repo, { mensaje: "cambio en main desde la sesión" });
    // Mientras tanto, la persona commitea en su main.
    sh(origen, "switch", "-q", "main");
    writeFileSync(join(origen, "d.txt"), "de la persona\n");
    sh(origen, "add", "-A");
    sh(origen, "commit", "-q", "-m", "la persona en main");
    sh(origen, "switch", "-q", "dev");
    const antes = sh(origen, "rev-parse", "main").trim();

    const r = await repos.integrar(sesion, repo);
    expect(r.ok).toBe(false);
    expect(sh(origen, "rev-parse", "main").trim()).toBe(antes);
    // La sesión sigue abierta: no se dio por integrada.
    expect(repos.sesionAbierta(repo.id, COMPANY)?.id).toBe(sesion.id);
  });
});
