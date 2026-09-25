import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ids,
  slugTecnico,
  type Argv,
  type ComandosRepositorio,
  type OrigenRepositorio,
  type Repositorio,
  type Servicio,
  type SesionCodigo,
} from "@orq/shared";
import type { Store } from "./db.js";
import type { Directorios } from "./directorios.js";
import { ErrorGit, git, validarUrlGit } from "./git.js";
import { detectarServicios } from "./servicios.js";
import { createHash } from "node:crypto";
import { resolverEnWorktree } from "@orq/tools";

/**
 * El código que una persona le da a un proyecto, y las sesiones donde trabajan
 * los agentes.
 *
 * ## La carpeta original no se toca
 *
 * Todo pasa sobre un **clon gestionado** en `<proyecto>/repos/<slug>`, nunca
 * sobre el repo de la persona. Un `git worktree add` directo sobre su repo
 * parecería inofensivo y no lo es: escribe en su `.git` (la lista de
 * worktrees, las refs `orq/*`, el índice), dispara sus hooks y deja estado que
 * ella no pidió. El único momento en que se escribe en su carpeta es cuando
 * **ella** aprieta Integrar, y aun ahí sólo se crea una rama y se avanza con
 * fast-forward si su carpeta está limpia.
 *
 * ## Una sesión por repo, que sobrevive a la corrida
 *
 * Un cambio grande no entra en una corrida. La sesión —un worktree con su
 * rama `orq/…`— queda abierta hasta que una persona la integra o la descarta, y
 * la corrida siguiente encuentra el trabajo donde quedó, igual que las tareas
 * heredadas. Cada turno que escribe cierra con un **checkpoint**: un commit con
 * el rol como autor. Eso cubre también lo que editó el CLI de Claude con su
 * propio `Edit`, y le da a la UI historia y reversión por turno.
 */

/** Lo que no entra al commit base ni a un checkpoint, aunque el repo no lo ignore. */
const EXCLUIDOS = [
  "# Escrito por el orquestador. Vale para el clon y todos sus worktrees.",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  "*.log",
  ".DS_Store",
];

/** Lo que no se copia de una carpeta sin git: lo regenerable y lo secreto. */
const NO_SE_COPIA = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "dist", "build"]);
const MAX_ARCHIVO_COPIADO = 5 * 1024 * 1024;

export interface EventoDeCodigo {
  tipo:
    | "repo_cargado"
    | "repo_eliminado"
    | "sesion_abierta"
    | "sesion_integrada"
    | "sesion_descartada"
    | "checkpoint"
    | "servicio";
  companyId: string;
  repoId: string;
  sesionId?: string;
  detalle: string;
  at: number;
}

export interface CargaDeRepositorio {
  nombre?: string;
  origen: OrigenRepositorio;
  ramaBase?: string;
  /**
   * Suma al commit base los cambios sin commitear de la carpeta original
   * (sólo los archivos rastreados: `git diff HEAD`, que no escribe nada en su
   * repo). Los archivos nuevos que no agregó a git no entran.
   */
  incluirCambiosSinCommitear?: boolean;
}

export interface EstadoDeSesion {
  archivos: Array<{ estado: string; ruta: string }>;
  /** Archivos de ejecución tocados: los que convierten un cambio en código que se va a correr. */
  sensibles: string[];
  commits: number;
}

/** Lo que cambia qué se ejecuta: hay que mirarlo con otros ojos antes de integrar. */
export function esArchivoDeEjecucion(ruta: string): boolean {
  const nombre = basename(ruta).toLowerCase();
  return (
    nombre === "package.json" ||
    nombre === "makefile" ||
    nombre === "dockerfile" ||
    nombre === "pyproject.toml" ||
    nombre === "setup.py" ||
    nombre === "cargo.toml" ||
    nombre === ".npmrc" ||
    /^(vite|vitest|jest|playwright|webpack|rollup|tsup|babel)\.config\./.test(nombre) ||
    ruta.startsWith(".github/") ||
    ruta.startsWith(".gitlab-ci") ||
    ruta.startsWith(".husky/") ||
    nombre.endsWith(".sh")
  );
}

export class RepoStore {
  /** Ayudante de credenciales de la persona, leído una vez. */
  private ayudante: Promise<string[]> | null = null;

  constructor(
    private readonly store: Store,
    private readonly directorios: Directorios,
    private readonly emitir: (evento: EventoDeCodigo) => void = () => {},
  ) {}

  // --- Rutas -----------------------------------------------------------------

  rutaClon(repo: Repositorio): string {
    return join(this.directorios.sub(repo.companyId, "repos"), repo.slug);
  }

  rutaWorktree(sesion: SesionCodigo): string {
    const destino = resolve(this.directorios.ruta(sesion.companyId), sesion.carpeta);
    if (!this.directorios.contiene(sesion.companyId, destino)) {
      throw new Error("La carpeta de la sesión se sale del proyecto.");
    }
    return destino;
  }

  /**
   * El `--git-dir` de un worktree, calculado desde el clon.
   *
   * Nunca se descubre desde el worktree: su `.git` es un archivo de texto que
   * cualquier cosa que corra adentro puede reescribir para apuntar a otro repo.
   */
  gitDirDe(sesion: SesionCodigo, repo: Repositorio): string {
    return join(this.rutaClon(repo), ".git", "worktrees", basename(this.rutaWorktree(sesion)));
  }

  /**
   * `cwd` también, y no es redundante con `--work-tree`: varios comandos
   * (`grep --untracked`, `ls-files -o`, los pathspec relativos) trabajan sobre
   * el directorio actual. Sin él corrían sobre el cwd del servidor —la raíz del
   * orquestador— y buscar en la sesión devolvía archivos del orquestador.
   */
  private gitSesion(sesion: SesionCodigo, repo: Repositorio) {
    const workTree = this.rutaWorktree(sesion);
    return { gitDir: this.gitDirDe(sesion, repo), workTree, cwd: workTree };
  }

  // --- Carga -----------------------------------------------------------------

  async cargar(companyId: string, carga: CargaDeRepositorio): Promise<{
    repo: Repositorio;
    sugeridos: Partial<ComandosRepositorio>;
    avisos: string[];
  }> {
    if (carga.origen.tipo === "creado") throw new Error("Un repo nuevo se crea con crearVacio, no se carga.");
    const avisos: string[] = [];
    const existentes = this.store.listRepositorios(companyId);
    const nombre = (carga.nombre?.trim() || nombreDeOrigen(carga.origen)).slice(0, 120);
    let slug = slugTecnico(nombre, "repo");
    for (let n = 2; existentes.some((r) => r.slug === slug); n++) slug = `${slugTecnico(nombre, "repo")}-${n}`;

    const reposDir = this.directorios.sub(companyId, "repos", true);
    const destino = join(reposDir, slug);
    if (existsSync(destino)) throw new Error(`Ya existe ${destino}.`);

    let origenSinGit = false;
    try {
      if (carga.origen.tipo === "git") {
        const validacion = validarUrlGit(carga.origen.url);
        if (!validacion.ok) throw new Error(validacion.motivo);
        await git(
          [
            ...(await this.configCredenciales()),
            "clone",
            "--no-recurse-submodules",
            ...(carga.ramaBase ? ["--branch", carga.ramaBase] : []),
            "--",
            carga.origen.url.trim(),
            destino,
          ],
          { cwd: reposDir, corteMs: 10 * 60_000 },
        );
      } else {
        const ruta = await carpetaLocalValida(carga.origen.ruta);
        const raizGit = await git(["rev-parse", "--show-toplevel"], { cwd: ruta, tolerar: true });
        // Sólo se clona si la carpeta **es** la raíz de su repo. Una subcarpeta
        // de un repo más grande se trabaja como copia: la persona señaló esa
        // carpeta, no el repo que la contiene. Lo aprendimos cargando un
        // programa que estaba en `data/` y terminando con el orquestador entero
        // clonado adentro de sí mismo.
        const top = raizGit.ok ? await realpath(raizGit.stdout.trim()).catch(() => raizGit.stdout.trim()) : null;
        if (top && top === ruta) {
          await git(
            [
              "clone",
              "--no-hardlinks",
              "--no-recurse-submodules",
              ...(carga.ramaBase ? ["--branch", carga.ramaBase] : []),
              "--",
              top,
              destino,
            ],
            { cwd: reposDir, corteMs: 10 * 60_000 },
          );
          if (carga.incluirCambiosSinCommitear) {
            const cambios = await git(["diff", "--binary", "HEAD"], { cwd: top, tolerar: true });
            if (cambios.ok && cambios.stdout.trim()) {
              await escribirExcluidos(destino);
              await git(["apply", "--whitespace=nowarn", "-"], { cwd: destino, entrada: cambios.stdout });
              await git(["add", "-A"], { cwd: destino });
              await git(["commit", "-q", "-m", "Cambios sin commitear al cargar el repo"], { cwd: destino });
              avisos.push(
                "Se sumaron tus cambios sin commitear a los archivos rastreados. Los archivos nuevos que no agregaste a git no entran.",
              );
            }
          }
        } else {
          origenSinGit = true;
          if (top) {
            avisos.push(
              `La carpeta está adentro del repo ${top}: se trabaja sobre una copia de esta carpeta sola. Al integrar se copian de vuelta los archivos que cambien.`,
            );
          }
          await copiarSinRegenerables(ruta, destino, avisos);
          await git(["init", "-q", "-b", "main"], { cwd: destino });
          await escribirExcluidos(destino);
          await git(["add", "-A"], { cwd: destino });
          await git(["commit", "-q", "--allow-empty", "-m", `Base: copia de ${ruta}`], { cwd: destino });
          avisos.push(
            "La carpeta no tenía git: se trabaja sobre una copia versionada. Al integrar se copian de vuelta sólo los archivos que cambiaron.",
          );
        }
      }
      await escribirExcluidos(destino);
    } catch (error) {
      await rm(destino, { recursive: true, force: true });
      throw error;
    }

    const ramaBase =
      (await git(["symbolic-ref", "--short", "HEAD"], { cwd: destino, tolerar: true })).stdout.trim() ||
      carga.ramaBase ||
      "main";
    const baseSha = (await git(["rev-parse", "HEAD"], { cwd: destino, tolerar: true })).stdout.trim() || null;
    if (!baseSha) avisos.push("El repo no tiene commits todavía: la primera sesión arranca vacía.");

    const ahora = Date.now();
    const repo: Repositorio = {
      id: ids.repositorio(),
      companyId,
      nombre,
      slug,
      origen: carga.origen.tipo === "local" ? { tipo: "local", ruta: resolve(carga.origen.ruta) } : carga.origen,
      ramaBase,
      baseSha,
      origenSinGit,
      comandos: {
        permitidos: [],
        preparar: null,
        test: null,
        verificar: null,
        sinAislamiento: false,
        unaVez: [],
      },
      servicios: await detectarServicios(destino, carga.origen.tipo === "local" ? resolve(carga.origen.ruta) : null),
      commitsAutomaticos: false,
      pendienteDeConfirmar: false,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.store.saveRepositorio(repo);
    const sugeridos = await detectarComandosDeRepo(destino, repo.servicios);
    if (repo.servicios.length > 0) {
      avisos.push(
        `Servicios detectados: ${repo.servicios.map((s) => `${s.nombre} (${s.carpeta || "raíz"})`).join(", ")}. Se levantan desde la vista Servicios.`,
      );
    }
    this.emitir({ tipo: "repo_cargado", companyId, repoId: repo.id, detalle: nombre, at: ahora });
    return { repo, sugeridos, avisos };
  }

  /**
   * El ayudante de credenciales de la persona (`osxkeychain`, `manager`…).
   *
   * El entorno de `git.ts` no lee la config global —ahí puede haber hooks y
   * filtros que ejecutan programas—, pero sin el ayudante un repo privado por
   * https no se clona. Se lee sólo esa clave, una vez, y se pasa explícita.
   */
  private configCredenciales(): Promise<string[]> {
    this.ayudante ??= new Promise((resolver) => {
      execFile("git", ["config", "--get-all", "credential.helper"], { timeout: 5_000 }, (error, stdout) => {
        if (error) return resolver([]);
        const ayudantes = stdout
          .split("\n")
          .map((linea) => linea.trim())
          .filter((linea) => linea && !linea.startsWith("!"));
        resolver(ayudantes.flatMap((a) => ["-c", `credential.helper=${a}`]));
      });
    });
    return this.ayudante;
  }

  actualizarServicios(repo: Repositorio, servicios: Servicio[]): Repositorio {
    const actualizado: Repositorio = { ...repo, servicios, updatedAt: Date.now() };
    this.store.saveRepositorio(actualizado);
    return actualizado;
  }

  /**
   * Vuelve a detectar los servicios sobre el clon. Lo que la persona ya
   * configuró de un servicio que sigue existiendo (su comando, sus `.env`, sus
   * variables) se conserva: detectar de nuevo no puede deshacer una edición.
   */
  async redetectarServicios(repo: Repositorio): Promise<Repositorio> {
    const origen = repo.origen.tipo === "local" ? repo.origen.ruta : null;
    const detectados = await detectarServicios(this.rutaClon(repo), origen);
    const previos = new Map(repo.servicios.map((s) => [s.id, s]));
    return this.actualizarServicios(
      repo,
      detectados.map((nuevo) => previos.get(nuevo.id) ?? nuevo),
    );
  }

  actualizarComandos(repo: Repositorio, comandos: Partial<ComandosRepositorio>): Repositorio {
    const actualizado: Repositorio = {
      ...repo,
      comandos: { ...repo.comandos, ...comandos },
      pendienteDeConfirmar: false,
      updatedAt: Date.now(),
    };
    this.store.saveRepositorio(actualizado);
    return actualizado;
  }

  /**
   * Cambia el nombre con el que se ve y se nombra el repo.
   *
   * Sólo el nombre: la carpeta sigue en `repos/<slug>` y la rama no cambia. El
   * slug es técnico —nadie lo lee, está adentro de `repos/`— y mudarlo
   * obligaría a reparar cada worktree por un beneficio que nadie ve. El nombre
   * sí importa y por eso no puede repetirse: los agentes eligen el repo con
   * `repo="<nombre>"`, y dos iguales harían que ese argumento dependa del orden.
   */
  renombrar(repo: Repositorio, nombre: string): Repositorio {
    const limpio = nombre.trim().slice(0, 120);
    if (!limpio) throw new Error("El nombre no puede quedar vacío.");
    const repetido = this.store
      .listRepositorios(repo.companyId)
      .find((otro) => otro.id !== repo.id && otro.nombre.toLowerCase() === limpio.toLowerCase());
    if (repetido) throw new Error(`Ya hay un repo llamado "${repetido.nombre}".`);
    if (limpio === repo.nombre) return repo;
    const actualizado: Repositorio = { ...repo, nombre: limpio, updatedAt: Date.now() };
    this.store.saveRepositorio(actualizado);
    return actualizado;
  }

  /**
   * Después de mudar la carpeta del proyecto: git guarda rutas absolutas en los
   * dos lados de un worktree (`.git/worktrees/<x>/gitdir` en el clon y el
   * archivo `.git` del worktree), así que un `mv` los deja apuntando a la
   * carpeta vieja y cualquier `git status` falla. `worktree repair` con las
   * rutas nuevas los vuelve a atar.
   */
  async repararWorktrees(companyId: string): Promise<void> {
    const sesiones = this.store.listSesionesCodigo(companyId).filter((sesion) => sesion.estado === "abierta");
    for (const repo of this.store.listRepositorios(companyId)) {
      const clon = this.rutaClon(repo);
      if (!existsSync(clon)) continue;
      const rutas = sesiones
        .filter((sesion) => sesion.repoId === repo.id)
        .map((sesion) => this.rutaWorktree(sesion))
        .filter((ruta) => existsSync(ruta));
      await git(["worktree", "repair", ...rutas], { cwd: clon, tolerar: true });
    }
  }

  // --- Sesiones ----------------------------------------------------------------

  sesionAbierta(repoId: string, companyId: string): SesionCodigo | null {
    return (
      this.store
        .listSesionesCodigo(companyId)
        .find((sesion) => sesion.repoId === repoId && sesion.estado === "abierta") ?? null
    );
  }

  /** Devuelve la sesión abierta del repo, o abre una. Idempotente. */
  /**
   * ¿La sesión trabaja sobre la rama del proyecto (`dev`) y no sobre una
   * `orq/…` propia? Sí para todo repo que vino de afuera con git: la persona
   * tiene su rama, su historia y su forma de trabajar, y el IDE tiene que estar
   * "parado" donde está ella. Un repo creado por la empresa o una copia sin git
   * siguen con su rama de sesión: no hay una rama de afuera que respetar.
   */
  usaRamaDelProyecto(repo: Repositorio): boolean {
    return !repo.origenSinGit && repo.origen.tipo !== "creado";
  }

  /**
   * El clon suelta la rama base (queda en HEAD desprendido, mismos archivos)
   * para que la sesión pueda abrirla: git no deja una rama abierta en dos
   * carpetas a la vez.
   */
  async soltarRamaDelClon(repo: Repositorio): Promise<void> {
    const clon = this.rutaClon(repo);
    const actual = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: clon, tolerar: true })).stdout.trim();
    if (actual) await git(["checkout", "-q", "--detach"], { cwd: clon, tolerar: true });
  }

  /** La rama local del clon avanza hasta la de la persona, sólo si es un fast-forward. */
  private async adelantarRamaLocal(clon: string, rama: string): Promise<void> {
    const remota = `refs/remotes/origin/${rama}`;
    if (!(await git(["rev-parse", "--verify", "-q", remota], { cwd: clon, tolerar: true })).ok) return;
    const local = await git(["rev-parse", "--verify", "-q", `refs/heads/${rama}`], { cwd: clon, tolerar: true });
    if (!local.ok) {
      await git(["branch", "-q", "--track", rama, `origin/${rama}`], { cwd: clon, tolerar: true });
      return;
    }
    const adelante = await git(["merge-base", "--is-ancestor", `refs/heads/${rama}`, remota], { cwd: clon, tolerar: true });
    if (adelante.ok) await git(["update-ref", `refs/heads/${rama}`, remota], { cwd: clon, tolerar: true });
  }

  /** Ramas abiertas en algún worktree del clon. */
  private async ramasAbiertasEnClon(clon: string): Promise<Set<string>> {
    const salida = (await git(["worktree", "list", "--porcelain"], { cwd: clon, tolerar: true })).stdout;
    return new Set(
      salida
        .split("\n")
        .filter((l) => l.startsWith("branch refs/heads/"))
        .map((l) => l.slice("branch refs/heads/".length)),
    );
  }

  /**
   * Una sesión de antes, en una `orq/…`, pasa a la rama del proyecto si todavía
   * no tiene trabajo propio (ni commits ni cambios): para la persona es la
   * misma sesión, ahora parada donde está su repo. Con trabajo no se toca —se
   * decide desde el panel: cambiar a `dev` y traerlo, o integrarlo como rama—.
   */
  async alinearConLaRamaDelProyecto(sesion: SesionCodigo, repo: Repositorio): Promise<SesionCodigo> {
    if (!this.usaRamaDelProyecto(repo) || !sesion.rama.startsWith("orq/")) return sesion;
    const g = this.gitSesion(sesion, repo);
    const commits = sesion.baseSha
      ? Number((await git(["rev-list", "--count", `${sesion.baseSha}..HEAD`], { ...g, tolerar: true })).stdout.trim() || 0)
      : 1;
    const sucio = (await git(["status", "--porcelain"], { ...g, tolerar: true })).stdout.trim();
    if (commits > 0 || sucio) return sesion;
    const clon = this.rutaClon(repo);
    await this.soltarRamaDelClon(repo);
    await this.adelantarRamaLocal(clon, repo.ramaBase);
    if ((await this.ramasAbiertasEnClon(clon)).has(repo.ramaBase)) return sesion;
    const cambio = await git(["switch", "-q", repo.ramaBase], { ...g, tolerar: true });
    if (!cambio.ok) return sesion;
    await git(["branch", "-q", "-D", sesion.rama], { cwd: clon, tolerar: true });
    const baseSha = (await git(["rev-parse", "HEAD"], g)).stdout.trim();
    const alineada: SesionCodigo = { ...sesion, rama: repo.ramaBase, baseSha, updatedAt: Date.now() };
    this.guardarSesion(alineada);
    this.emitir({ tipo: "sesion_abierta", companyId: repo.companyId, repoId: repo.id, sesionId: sesion.id, detalle: repo.ramaBase, at: Date.now() });
    return alineada;
  }

  async abrirSesion(repo: Repositorio, runId: string | null = null): Promise<SesionCodigo> {
    const abierta = this.sesionAbierta(repo.id, repo.companyId);
    if (abierta && existsSync(this.rutaWorktree(abierta))) return this.alinearConLaRamaDelProyecto(abierta, repo);
    if (abierta) {
      // La fila dice abierta pero el worktree no está: alguien lo borró a mano.
      this.guardarSesion({ ...abierta, estado: "descartada" });
    }

    const clon = this.rutaClon(repo);
    const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sufijo = Math.random().toString(36).slice(2, 6);
    let rama = `orq/${fecha}-${sufijo}`;
    const carpeta = `worktrees/${repo.slug}/${fecha}-${sufijo}`;
    const destino = join(this.directorios.ruta(repo.companyId), carpeta);
    await mkdir(dirname(destino), { recursive: true });

    // La base es lo último de la rama base: si el origen es la carpeta de la
    // persona, eso incluye lo que commiteó desde que cargó el repo. Un repo
    // creado por la empresa no tiene afuera: su base es su propio `main`.
    if (!repo.origenSinGit && repo.origen.tipo !== "creado") {
      await git([...(await this.configCredenciales()), "fetch", "-q", "origin", repo.ramaBase], {
        cwd: clon,
        tolerar: true,
        corteMs: 120_000,
      });
    }
    const remota = await git(["rev-parse", "--verify", "-q", `origin/${repo.ramaBase}`], {
      cwd: clon,
      tolerar: true,
    });
    let base = remota.ok ? `origin/${repo.ramaBase}` : repo.ramaBase;
    const tieneCommits = (await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: clon, tolerar: true })).ok;
    // La sesión se para en la rama del proyecto: el clon la suelta, se pone al
    // día con la de la persona y se abre en el worktree. Si justo está
    // abierta en otro lado, se cae a una rama de sesión, como antes.
    let enLaRamaDelProyecto = false;
    if (tieneCommits && this.usaRamaDelProyecto(repo)) {
      await this.soltarRamaDelClon(repo);
      await this.adelantarRamaLocal(clon, repo.ramaBase);
      const existe = (await git(["rev-parse", "--verify", "-q", `refs/heads/${repo.ramaBase}`], { cwd: clon, tolerar: true })).ok;
      if (existe && !(await this.ramasAbiertasEnClon(clon)).has(repo.ramaBase)) {
        const r = await git(["worktree", "add", "-q", destino, repo.ramaBase], { cwd: clon, tolerar: true });
        if (r.ok) {
          enLaRamaDelProyecto = true;
          rama = repo.ramaBase;
          base = repo.ramaBase;
        }
      }
    }
    if (!enLaRamaDelProyecto) {
      if (tieneCommits) {
        await git(["worktree", "add", "-q", "-b", rama, destino, base], { cwd: clon });
      } else {
        await git(["worktree", "add", "-q", "--orphan", "-b", rama, destino], { cwd: clon });
      }
    }
    const baseSha = tieneCommits
      ? (await git(["rev-parse", base], { cwd: clon })).stdout.trim()
      : "";

    const ahora = Date.now();
    const sesion: SesionCodigo = {
      id: ids.sesionCodigo(),
      companyId: repo.companyId,
      repoId: repo.id,
      rama,
      carpeta,
      baseSha,
      estado: "abierta",
      creadaEnRunId: runId,
      integracion: null,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.guardarSesion(sesion);
    this.emitir({
      tipo: "sesion_abierta",
      companyId: repo.companyId,
      repoId: repo.id,
      sesionId: sesion.id,
      detalle: rama,
      at: ahora,
    });
    return sesion;
  }

  // --- Sincronizar con el repo de la persona -------------------------------------

  private readonly ultimaSincronizacion = new Map<string, number>();

  /**
   * Trae lo nuevo del repo de la persona al clon: sus ramas (`origin/*`), sus
   * tags y —si el origen es una carpeta— también las ramas de **su** remoto
   * (GitHub), como `remoto/*`. Sin esto el clon es una foto del momento de la
   * carga: la persona sigue commiteando en `dev` desde su editor y el IDE le
   * mostraría una historia vieja, o una rama base que ya no es la suya.
   *
   * La rama base del clon (abierta en su propia carpeta) sigue a la del origen
   * sólo por fast-forward. Se limita a una vez cada 45 s salvo que se pida:
   * el panel pregunta el estado cada pocos segundos.
   */
  async sincronizarConOrigen(repo: Repositorio, forzar = false): Promise<{ ok: boolean; detalle: string }> {
    if (repo.origen.tipo === "creado" || repo.origenSinGit) return { ok: true, detalle: "El repo no tiene un origen con git." };
    const ultima = this.ultimaSincronizacion.get(repo.id) ?? 0;
    if (!forzar && Date.now() - ultima < 45_000) return { ok: true, detalle: "Sincronizado hace poco." };
    this.ultimaSincronizacion.set(repo.id, Date.now());
    const clon = this.rutaClon(repo);
    const refspecs = ["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"];
    if (repo.origen.tipo === "local") refspecs.push("+refs/remotes/origin/*:refs/remotes/remoto/*");
    const r = await git(
      [...(repo.origen.tipo === "git" ? await this.configCredenciales() : []), "fetch", "-q", "--prune", "origin", ...refspecs],
      { cwd: clon, tolerar: true, corteMs: 90_000 },
    );
    if (!r.ok) return { ok: false, detalle: `No se pudo traer de ${repo.origen.tipo === "local" ? repo.origen.ruta : "origin"}: ${r.stderr.trim().slice(-300)}` };
    const actual = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: clon, tolerar: true })).stdout.trim();
    const sucio = (await git(["status", "--porcelain", "--untracked-files=no"], { cwd: clon, tolerar: true })).stdout.trim();
    if (actual === repo.ramaBase && !sucio) {
      await git(["merge", "--ff-only", "-q", `origin/${repo.ramaBase}`], { cwd: clon, tolerar: true });
    } else if (!(await this.ramasAbiertasEnClon(clon)).has(repo.ramaBase)) {
      // Nadie la tiene abierta: avanza sola hasta la de la persona.
      await this.adelantarRamaLocal(clon, repo.ramaBase);
      // El clon desprendido es la vista de la base sin sesión: que sea la de hoy.
      if (!actual && !sucio) await git(["checkout", "-q", "--detach", repo.ramaBase], { cwd: clon, tolerar: true });
    }
    return { ok: true, detalle: "Sincronizado con tu repo." };
  }

  // --- Instantáneas: lo que hizo un turno, sin commitear ------------------------

  /**
   * Un commit suelto con el estado del árbol **tal cual está** —lo commiteado,
   * lo modificado y lo nuevo—, sin tocar la rama ni el índice de la sesión.
   *
   * Es lo que permite que un agente no commitee: el turno toma una al empezar
   * y otra al terminar, y lo que cambió es la diferencia. Con eso el chat
   * sigue mostrando "qué cambió este pedido" y lo puede deshacer, mientras los
   * cambios esperan sin commitear a que la persona los prepare, escriba el
   * mensaje y los publique. Se arma con un índice aparte (`GIT_INDEX_FILE`) y
   * se ancla en `refs/orq/instantaneas/…` para que git no la borre.
   */
  async instantanea(sesion: SesionCodigo, repo: Repositorio, etiqueta: string): Promise<string> {
    const g = this.gitSesion(sesion, repo);
    const indice = join(tmpdir(), `orq-indice-${sesion.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    try {
      const cabeza = (await git(["rev-parse", "-q", "--verify", "HEAD"], { ...g, tolerar: true })).stdout.trim();
      if (cabeza) await git(["read-tree", cabeza], { ...g, indice });
      await git(["add", "-A"], { ...g, indice });
      const arbol = (await git(["write-tree"], { ...g, indice })).stdout.trim();
      const sha = (
        await git(["commit-tree", arbol, ...(cabeza ? ["-p", cabeza] : []), "-m", `instantánea: ${etiqueta}`], g)
      ).stdout.trim();
      await git(["update-ref", `refs/orq/instantaneas/${slugTecnico(etiqueta)}-${sha.slice(0, 8)}`, sha], g);
      return sha;
    } finally {
      await rm(indice, { force: true });
    }
  }

  /** Los archivos que cambiaron entre dos instantáneas (o commits). */
  async cambiosEntre(sesion: SesionCodigo, repo: Repositorio, desde: string, hasta: string): Promise<Array<{ estado: string; ruta: string }>> {
    if (!/^[0-9a-f]{7,40}$/.test(desde) || !/^[0-9a-f]{7,40}$/.test(hasta)) throw new Error("Referencia inválida.");
    const salida = await git(["diff-tree", "-r", "--no-renames", "--name-status", desde, hasta], { ...this.gitSesion(sesion, repo), tolerar: true });
    return salida.stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [estado = "", ruta = ""] = linea.split("\t");
        return { estado: estado.charAt(0), ruta };
      })
      .filter((a) => a.ruta);
  }

  /**
   * Deshace en el árbol lo que cambió entre dos instantáneas —el "Deshacer" de
   * un pedido del chat cuando no hubo commit—. Se aplica el diff al revés
   * sobre los archivos (sin índice); si la persona tocó después las mismas
   * líneas, no se aplica nada y se dice qué choca.
   */
  async deshacerEntre(sesion: SesionCodigo, repo: Repositorio, desde: string, hasta: string): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/.test(desde) || !/^[0-9a-f]{7,40}$/.test(hasta)) throw new Error("Referencia inválida.");
    const g = this.gitSesion(sesion, repo);
    const diff = (await git(["diff", "--binary", "--no-color", "--no-ext-diff", desde, hasta], g)).stdout;
    if (!diff.trim()) return;
    const prueba = await git(["apply", "-R", "--check", "-"], { ...g, entrada: diff, tolerar: true });
    if (!prueba.ok) {
      throw new Error(
        `No se pudo deshacer sin pisar cambios hechos después: ${prueba.stderr.trim().split("\n").slice(0, 3).join(" ")}`,
      );
    }
    await git(["apply", "-R", "-"], { ...g, entrada: diff });
    this.avisarCambioDeSesion(sesion, repo, "pedido deshecho");
  }

  /** Ajustes del repo que decide la persona desde la UI. */
  actualizarAjustes(repo: Repositorio, ajustes: { commitsAutomaticos?: boolean }): Repositorio {
    const actualizado: Repositorio = {
      ...repo,
      ...(ajustes.commitsAutomaticos != null ? { commitsAutomaticos: ajustes.commitsAutomaticos } : {}),
      updatedAt: Date.now(),
    };
    this.store.saveRepositorio(actualizado);
    return actualizado;
  }

  // --- Para el control de versiones del IDE (`scm.ts`) ---------------------------

  /** Git sobre el worktree de la sesión, con `--git-dir` explícito. */
  contextoGit(sesion: SesionCodigo, repo: Repositorio): { gitDir: string; workTree: string; cwd: string } {
    return this.gitSesion(sesion, repo);
  }

  /**
   * La sesión pasó a otra rama (la persona la cambió o creó una desde el IDE).
   * Se guarda porque integrar lleva **la rama que está abierta**: si la fila
   * siguiera diciendo `orq/…`, se integraría una rama que ya no tiene el trabajo.
   */
  cambiarRamaDeSesion(sesion: SesionCodigo, rama: string): SesionCodigo {
    const actualizada = { ...sesion, rama };
    this.guardarSesion(actualizada);
    return actualizada;
  }

  /** Avisa por el canal de código que algo cambió en la sesión: la UI se refresca. */
  avisarCambioDeSesion(sesion: SesionCodigo, repo: Repositorio, detalle: string): void {
    this.emitir({ tipo: "checkpoint", companyId: sesion.companyId, repoId: repo.id, sesionId: sesion.id, detalle, at: Date.now() });
  }

  private guardarSesion(sesion: SesionCodigo): void {
    this.store.saveSesionCodigo({ ...sesion, updatedAt: Date.now() });
  }

  /**
   * Commitea todo lo que cambió en el worktree, con el rol como autor.
   *
   * Devuelve el sha, o `null` si no había nada que guardar. Lo llama el cierre
   * de cada turno que escribió: así el trabajo del CLI —que el org no ve pasar—
   * también queda registrado y se puede revertir por turno.
   */
  async checkpoint(
    sesion: SesionCodigo,
    repo: Repositorio,
    autor: { nombre: string; id: string; email?: string },
    mensaje: string,
    opciones: { titulo?: string } = {},
  ): Promise<string | null> {
    const g = this.gitSesion(sesion, repo);
    await git(["add", "-A"], g);
    const hayCambios = await git(["diff", "--cached", "--quiet"], { ...g, tolerar: true });
    if (hayCambios.ok) return null;
    // El título sale de los archivos y no del resumen del agente: la primera
    // línea de un resumen suele ser "No tengo tareas que mover…", y un log
    // lleno de eso no dice qué cambió. El resumen va en el cuerpo. El autor no
    // se repite en el título: ya está en el commit, y la UI lo muestra al lado.
    const tocados = (await git(["diff", "--cached", "--name-only"], g)).stdout.split("\n").filter(Boolean);
    const titulo = (
      opciones.titulo?.trim() ||
      `${tocados.slice(0, 3).join(", ")}${tocados.length > 3 ? ` y ${tocados.length - 3} más` : ""}`
    ).slice(0, 100);
    const email = autor.email ?? `${slugTecnico(autor.id)}@orq.local`;
    await git(
      [
        "commit",
        "-q",
        "--no-verify",
        "-m",
        titulo,
        ...(mensaje.trim() ? ["-m", mensaje.trim().slice(0, 4000)] : []),
        `--author=${autor.nombre.replace(/[<>]/g, "")} <${email.replace(/[<>\s]/g, "")}>`,
      ],
      g,
    );
    const sha = (await git(["rev-parse", "HEAD"], g)).stdout.trim();
    this.emitir({
      tipo: "checkpoint",
      companyId: sesion.companyId,
      repoId: repo.id,
      sesionId: sesion.id,
      detalle: `${sha.slice(0, 8)} ${autor.nombre}: ${titulo}`,
      at: Date.now(),
    });
    return sha;
  }

  // --- IDE: lo que ve y edita una persona ---------------------------------------

  /** ¿Hay algo sin commitear en el worktree? */
  async tieneCambiosPendientes(sesion: SesionCodigo, repo: Repositorio): Promise<boolean> {
    const salida = await git(["status", "--porcelain"], this.gitSesion(sesion, repo));
    return salida.stdout.trim().length > 0;
  }

  /**
   * Los archivos del repo, para el explorador.
   *
   * Con sesión, los del worktree —incluidos los nuevos que todavía no entraron
   * a un checkpoint—; sin sesión, los de la rama base del clon, en sólo
   * lectura. Mirar el código no abre una sesión: abrirla crea una rama, y una
   * persona que sólo quería leer no tiene por qué dejar ramas atrás.
   */
  async listarArchivos(repo: Repositorio, sesion: SesionCodigo | null): Promise<string[]> {
    const salida = sesion
      ? await git(["ls-files", "-z", "-co", "--exclude-standard"], this.gitSesion(sesion, repo))
      : await git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], { cwd: this.rutaClon(repo), tolerar: true });
    return salida.stdout.split("\0").filter(Boolean).sort();
  }

  /**
   * Un archivo para el editor. `ref: "base"` devuelve cómo estaba al abrir la
   * sesión —el lado izquierdo del diff—, y `null` en el contenido si no existía.
   */
  async leerArchivo(
    repo: Repositorio,
    sesion: SesionCodigo | null,
    ruta: string,
    /** `actual`, `base` (la de la sesión) o un sha —con `^` para el padre—. */
    ref: string = "actual",
  ): Promise<
    | { ok: true; contenido: string | null; binario: boolean; bytes: number; hash: string | null }
    | { ok: false; motivo: string }
  > {
    const esSha = /^[0-9a-f]{7,40}\^?$/.test(ref);
    if (!sesion || ref === "base" || esSha) {
      const commit = esSha ? ref : ref === "base" && sesion ? sesion.baseSha : "HEAD";
      if (!commit) return { ok: true, contenido: null, binario: false, bytes: 0, hash: null };
      const cwd = sesion ? this.rutaWorktree(sesion) : this.rutaClon(repo);
      const g = sesion ? this.gitSesion(sesion, repo) : { cwd };
      // Un commit de padre inexistente (el primero del repo) es "no existía".
      if (esSha && !(await git(["rev-parse", "--verify", "-q", `${commit}^{commit}`], { ...g, tolerar: true })).ok) {
        return { ok: true, contenido: null, binario: false, bytes: 0, hash: null };
      }
      const limpia = ruta.replace(/^\.?\/+/, "");
      if (limpia.split("/").includes("..") || limpia.split("/").includes(".git")) {
        return { ok: false, motivo: "Ruta inválida." };
      }
      const existe = await git(["cat-file", "-e", `${commit}:${limpia}`], { ...g, tolerar: true });
      if (!existe.ok) return { ok: true, contenido: null, binario: false, bytes: 0, hash: null };
      const crudo = await git(["show", `${commit}:${limpia}`], { ...g, maxBuffer: 16 * 1024 * 1024 });
      return aContenido(Buffer.from(crudo.stdout, "utf8"));
    }
    const resuelta = await resolverEnWorktree(await realpath(this.rutaWorktree(sesion)), ruta);
    if (!resuelta.ok) return { ok: false, motivo: resuelta.motivo };
    try {
      return aContenido(await readFile(resuelta.absoluta));
    } catch {
      return { ok: false, motivo: `No existe "${resuelta.relativa}".` };
    }
  }

  /**
   * Guarda lo que editó una persona en el worktree.
   *
   * `hashPrevio` es el del contenido que el editor cargó: si el archivo cambió
   * en disco desde entonces —lo editó un agente—, no se pisa. Perder el trabajo
   * de un agente sin que nadie se entere es exactamente lo que el arriendo
   * existe para evitar entre agentes, y vale igual entre agente y persona.
   */
  async escribirArchivo(
    sesion: SesionCodigo,
    repo: Repositorio,
    ruta: string,
    contenido: string,
    /** El hash que cargó el editor; `null` = archivo nuevo; sin pasar = no verificar. */
    hashPrevio?: string | null,
  ): Promise<{ ok: true; hash: string; ruta: string } | { ok: false; motivo: string; conflicto?: boolean }> {
    const resuelta = await resolverEnWorktree(await realpath(this.rutaWorktree(sesion)), ruta);
    if (!resuelta.ok) return { ok: false, motivo: resuelta.motivo };
    if (Buffer.byteLength(contenido, "utf8") > 2 * 1024 * 1024) {
      return { ok: false, motivo: "El archivo supera 2 MB: no se edita desde acá." };
    }
    if (hashPrevio !== undefined) {
      let actual: string | null = null;
      try {
        actual = hashDe(await readFile(resuelta.absoluta));
      } catch {
        actual = null;
      }
      if (actual !== hashPrevio) {
        return {
          ok: false,
          conflicto: true,
          motivo:
            actual === null
              ? `"${resuelta.relativa}" ya no existe: lo borró alguien mientras lo editabas.`
              : `"${resuelta.relativa}" cambió en disco mientras lo editabas (lo tocó un agente). Recargalo y volvé a aplicar tu cambio.`,
        };
      }
    }
    await mkdir(dirname(resuelta.absoluta), { recursive: true });
    const bytes = Buffer.from(contenido, "utf8");
    await writeFile(resuelta.absoluta, bytes);
    return { ok: true, hash: hashDe(bytes), ruta: resuelta.relativa };
  }

  /** ¿Este sha es un checkpoint de la sesión (posterior a su base)? */
  private async esDeLaSesion(sesion: SesionCodigo, repo: Repositorio, sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
    const g = this.gitSesion(sesion, repo);
    const completo = (await git(["rev-parse", "--verify", "-q", `${sha}^{commit}`], { ...g, tolerar: true })).stdout.trim();
    if (!completo || completo === sesion.baseSha) return false;
    if (!sesion.baseSha) return true;
    const dentro = await git(["merge-base", "--is-ancestor", sesion.baseSha, completo], { ...g, tolerar: true });
    const enRama = await git(["merge-base", "--is-ancestor", completo, "HEAD"], { ...g, tolerar: true });
    return dentro.ok && enRama.ok;
  }

  /** Los archivos que tocó un commit de la sesión: lo que hizo un pedido del chat. */
  async archivosDeCommit(
    sesion: SesionCodigo,
    repo: Repositorio,
    sha: string,
  ): Promise<Array<{ estado: string; ruta: string }>> {
    if (!(await this.esDeLaSesion(sesion, repo, sha))) return [];
    const salida = await git(["show", "--name-status", "--no-renames", "--format=", sha], this.gitSesion(sesion, repo));
    return salida.stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [estado = "", ruta = ""] = linea.split("\t");
        return { estado: estado.charAt(0), ruta };
      });
  }

  /**
   * Deshace checkpoints de la sesión con `git revert` —commits nuevos que los
   * anulan, no reescribir la historia: la sesión sigue contando qué se probó y
   * qué se descartó—. Se revierten del más nuevo al más viejo, y si alguno
   * choca con lo que vino después no se deja nada a medias.
   */
  async revertir(
    sesion: SesionCodigo,
    repo: Repositorio,
    shas: string[],
    autor: { nombre: string; email: string },
  ): Promise<{ ok: true; revertidos: number } | { ok: false; motivo: string }> {
    const g = this.gitSesion(sesion, repo);
    for (const sha of shas) {
      if (!(await this.esDeLaSesion(sesion, repo, sha))) {
        return { ok: false, motivo: `${sha.slice(0, 8)} no es un checkpoint de esta sesión.` };
      }
    }
    if (await this.tieneCambiosPendientes(sesion, repo)) {
      await this.checkpoint(sesion, repo, { nombre: autor.nombre, id: "persona", email: autor.email }, "", {
        titulo: "Cambios sin confirmar antes de deshacer",
      });
    }
    // Del más nuevo al más viejo, según el orden real de la rama.
    const orden = (await git(["rev-list", "HEAD"], g)).stdout.split("\n");
    const completos = await Promise.all(
      shas.map(async (sha) => (await git(["rev-parse", sha], g)).stdout.trim()),
    );
    completos.sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
    const antes = (await git(["rev-parse", "HEAD"], g)).stdout.trim();
    const identidad = ["-c", `user.name=${autor.nombre.replace(/[<>]/g, "")}`, "-c", `user.email=${autor.email.replace(/[<>\s]/g, "")}`];
    for (const sha of completos) {
      const r = await git([...identidad, "revert", "--no-edit", sha], { ...g, tolerar: true });
      if (!r.ok) {
        await git(["revert", "--abort"], { ...g, tolerar: true });
        await git(["reset", "--hard", antes], { ...g, tolerar: true });
        return {
          ok: false,
          motivo: `No se pudo deshacer limpio: lo que vino después toca las mismas líneas. No se cambió nada. (${r.stderr.trim().slice(0, 300)})`,
        };
      }
    }
    return { ok: true, revertidos: completos.length };
  }

  /** De dónde se sirve la vista previa: el worktree de la sesión, o la base. */
  raizDeVista(repo: Repositorio): string {
    const sesion = this.sesionAbierta(repo.id, repo.companyId);
    return sesion ? this.rutaWorktree(sesion) : this.rutaClon(repo);
  }

  /**
   * Búsqueda de texto para el IDE: `git grep` literal (no regex: una persona
   * que busca `suma(` no quiere un error de expresión regular), agrupada por
   * archivo y acotada.
   */
  async buscarTexto(
    repo: Repositorio,
    sesion: SesionCodigo | null,
    texto: string,
    opciones: { mayusculas?: boolean; regex?: boolean } = {},
  ): Promise<{ resultados: Array<{ ruta: string; linea: number; texto: string }>; cortado: boolean }> {
    if (!texto.trim()) return { resultados: [], cortado: false };
    const args = [
      "grep", "-n", "-I", "--no-color", "--full-name",
      opciones.regex ? "-E" : "-F",
      ...(opciones.mayusculas ? [] : ["-i"]),
      ...(sesion ? ["--untracked"] : []),
      "-e", texto,
      ...(sesion ? [] : ["HEAD"]),
    ];
    const salida = sesion
      ? await git(args, { ...this.gitSesion(sesion, repo), tolerar: true })
      : await git(args, { cwd: this.rutaClon(repo), tolerar: true });
    const lineas = salida.stdout.split("\n").filter(Boolean);
    const resultados = lineas.slice(0, 500).flatMap((linea) => {
      // Sin sesión git antepone "HEAD:" a cada ruta.
      const limpia = sesion ? linea : linea.replace(/^HEAD:/, "");
      const m = /^(.*?):(\d+):(.*)$/.exec(limpia);
      return m ? [{ ruta: m[1]!, linea: Number(m[2]), texto: m[3]!.slice(0, 300) }] : [];
    });
    return { resultados, cortado: lineas.length > 500 };
  }

  async borrarArchivo(
    sesion: SesionCodigo,
    repo: Repositorio,
    ruta: string,
  ): Promise<{ ok: true } | { ok: false; motivo: string }> {
    const resuelta = await resolverEnWorktree(await realpath(this.rutaWorktree(sesion)), ruta);
    if (!resuelta.ok) return { ok: false, motivo: resuelta.motivo };
    try {
      const info = await stat(resuelta.absoluta);
      if (info.isDirectory()) return { ok: false, motivo: "Es una carpeta." };
    } catch {
      return { ok: false, motivo: `No existe "${resuelta.relativa}".` };
    }
    await rm(resuelta.absoluta);
    return { ok: true };
  }

  /**
   * Quién es la persona, para firmar sus commits: la identidad de git de la
   * máquina. El entorno de `git.ts` no lee la config global —ahí puede haber
   * hooks—, así que se leen sólo estas dos claves, una vez.
   */
  private identidad: Promise<{ nombre: string; email: string }> | null = null;
  identidadDePersona(): Promise<{ nombre: string; email: string }> {
    const leer = (clave: string) =>
      new Promise<string>((resolver) => {
        execFile("git", ["config", "--get", clave], { timeout: 5_000 }, (error, stdout) =>
          resolver(error ? "" : stdout.trim()),
        );
      });
    this.identidad ??= Promise.all([leer("user.name"), leer("user.email")]).then(([nombre, email]) => ({
      nombre: nombre || "Persona",
      email: email || "persona@orq.local",
    }));
    return this.identidad;
  }

  async estado(sesion: SesionCodigo, repo: Repositorio): Promise<EstadoDeSesion> {
    const g = this.gitSesion(sesion, repo);
    const archivos = new Map<string, string>();
    if (sesion.baseSha) {
      const committeados = await git(["diff", "--name-status", "--no-renames", sesion.baseSha, "HEAD"], {
        ...g,
        tolerar: true,
      });
      for (const linea of committeados.stdout.split("\n")) {
        const [estado, ruta] = linea.split("\t");
        if (estado && ruta) archivos.set(ruta, estado);
      }
    }
    const pendientes = await git(["status", "--porcelain=v1", "-uall", "--no-renames"], g);
    for (const linea of pendientes.stdout.split("\n")) {
      if (linea.length < 4) continue;
      const estado = linea.slice(0, 2).trim() || "M";
      archivos.set(linea.slice(3), estado === "??" ? "A" : estado.charAt(0));
    }
    const commits = sesion.baseSha
      ? Number((await git(["rev-list", "--count", `${sesion.baseSha}..HEAD`], { ...g, tolerar: true })).stdout.trim() || 0)
      : Number((await git(["rev-list", "--count", "HEAD"], { ...g, tolerar: true })).stdout.trim() || 0);
    const lista = [...archivos].map(([ruta, estado]) => ({ estado, ruta })).sort((a, b) => a.ruta.localeCompare(b.ruta));
    return { archivos: lista, sensibles: lista.map((a) => a.ruta).filter(esArchivoDeEjecucion), commits };
  }

  /** Diff contra la base, incluido lo no commiteado. Con `ruta`, sólo ese archivo. */
  async diff(sesion: SesionCodigo, repo: Repositorio, ruta?: string): Promise<string> {
    const g = this.gitSesion(sesion, repo);
    // Los archivos nuevos sin commitear no aparecen en `git diff`: se marcan
    // con intención de agregar, que no toca el contenido del índice.
    await git(["add", "-A", "--intent-to-add"], { ...g, tolerar: true });
    const args = ["diff", "--no-color", "--no-ext-diff", sesion.baseSha || "--root"];
    if (!sesion.baseSha) args.splice(3, 1, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    if (ruta) args.push("--", ruta);
    return (await git(args, { ...g, tolerar: true })).stdout;
  }

  async log(sesion: SesionCodigo, repo: Repositorio) {
    const g = this.gitSesion(sesion, repo);
    const rango = sesion.baseSha ? `${sesion.baseSha}..HEAD` : "HEAD";
    const salida = await git(["log", "--format=%H%x1f%an%x1f%at%x1f%s", rango], { ...g, tolerar: true });
    return salida.stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [sha = "", autor = "", at = "0", mensaje = ""] = linea.split("\x1f");
        return { sha, autor, at: Number(at) * 1000, mensaje };
      });
  }

  /** Los commits de la sesión como una serie de patches (`git am` los aplica). */
  async patch(sesion: SesionCodigo, repo: Repositorio): Promise<string> {
    const g = this.gitSesion(sesion, repo);
    const rango = sesion.baseSha ? `${sesion.baseSha}..HEAD` : "--root";
    return (await git(["format-patch", "--stdout", "--no-color", rango], { ...g, tolerar: true })).stdout;
  }

  // --- Cierre -----------------------------------------------------------------

  /**
   * Integra la sesión al origen. Es lo único que escribe en la carpeta de la
   * persona, y lo aprieta ella.
   *
   * 1. La rama absorbe la base **dentro del worktree**. Un conflicto se resuelve
   *    ahí —se lo pide a un agente—, nunca en la carpeta de la persona.
   * 2. Origen con git: se crea la rama `orq/…` en su repo y, si tiene la rama
   *    base abierta y la carpeta limpia, se avanza con fast-forward. Si no, la
   *    rama queda creada para que la mezcle cuando quiera.
   * 3. Origen sin git: se copian de vuelta los archivos tocados, y no se pisa
   *    ninguno que la persona haya cambiado desde la base.
   * 4. Origen por URL: no hay push —pediría credenciales—; la rama queda en el
   *    clon gestionado y se dice cómo subirla.
   */
  async integrar(
    sesion: SesionCodigo,
    repo: Repositorio,
    opciones: {
      /** Además, subir la rama al remoto de la persona (`git push origin <rama>`). */
      subir?: boolean;
    } = {},
  ): Promise<
    | { ok: true; modo: "fast-forward" | "rama" | "copia"; detalle: string; sigueAbierta?: boolean }
    | { ok: false; motivo: string; conflictos?: string[] }
  > {
    if (sesion.estado !== "abierta") return { ok: false, motivo: "La sesión ya está cerrada." };
    const g = this.gitSesion(sesion, repo);
    const pendientes = await git(["status", "--porcelain"], g);
    if (pendientes.stdout.trim()) {
      // Sin commits automáticos, lo que no está commiteado es de la persona
      // decidirlo: publicar no se lo commitea por ella con un mensaje genérico.
      if (!repo.commitsAutomaticos) {
        return {
          ok: false,
          motivo: "Tenés cambios sin commitear. Preparalos y hacé commit (podés generar el mensaje con ✨), o descartalos, y después publicá.",
        };
      }
      await this.checkpoint(sesion, repo, { nombre: "Orquestador", id: "orquestador" }, "Cambios pendientes al integrar");
    }

    const clon = this.rutaClon(repo);
    if (!repo.origenSinGit && repo.origen.tipo !== "creado") {
      await git([...(await this.configCredenciales()), "fetch", "-q", "origin", repo.ramaBase], {
        cwd: clon,
        tolerar: true,
        corteMs: 120_000,
      });
      const remota = await git(["rev-parse", "--verify", "-q", `origin/${repo.ramaBase}`], { cwd: clon, tolerar: true });
      if (remota.ok) {
        const mezcla = await git(["merge", "--no-edit", "-q", `origin/${repo.ramaBase}`], { ...g, tolerar: true });
        if (!mezcla.ok) {
          const conflictos = (await git(["diff", "--name-only", "--diff-filter=U"], { ...g, tolerar: true })).stdout
            .split("\n")
            .filter(Boolean);
          await git(["merge", "--abort"], { ...g, tolerar: true });
          return {
            ok: false,
            conflictos,
            motivo:
              `La rama base cambió y choca con el trabajo de la sesión en ${conflictos.length} archivo(s). ` +
              `Pedile a un agente que traiga la base (${repo.ramaBase}) y resuelva los conflictos; después integrá de nuevo.`,
          };
        }
      }
    }

    let resultado: { modo: "fast-forward" | "rama" | "copia"; detalle: string };
    if (repo.origen.tipo === "creado") {
      // Su `main` sólo avanza integrando sesiones, así que siempre es un
      // fast-forward: no hay un afuera que haya cambiado en el medio.
      const avance = await git(["merge", "--ff-only", "-q", sesion.rama], { cwd: clon, tolerar: true });
      if (!avance.ok) {
        return { ok: false, motivo: `No se pudo avanzar ${repo.ramaBase}: ${avance.stderr.trim().slice(0, 300)}` };
      }
      resultado = {
        modo: "fast-forward",
        detalle: `${repo.ramaBase} de ${repo.nombre} avanzó hasta la sesión. Para llevártelo, descargá el patch o copiá ${clon}.`,
      };
    } else if (repo.origen.tipo === "git") {
      resultado = {
        modo: "rama",
        detalle:
          `La rama ${sesion.rama} quedó en el clon gestionado. Para subirla: ` +
          `git -C "${clon}" push origin ${sesion.rama}  — o descargá el patch.`,
      };
    } else if (repo.origenSinGit) {
      const copia = await this.copiarDeVuelta(sesion, repo);
      if (!copia.ok) return copia;
      resultado = { modo: "copia", detalle: copia.detalle };
    } else {
      const local = await this.integrarEnRepoLocal(sesion, repo);
      if ("ok" in local) return local;
      resultado = local;
    }

    if (opciones.subir) {
      const subida = await this.subirAlRemoto(sesion, repo);
      if (!subida.ok) return { ok: false, motivo: `${resultado.detalle} Pero no se pudo subir: ${subida.detalle}` };
      resultado = { ...resultado, detalle: `${resultado.detalle} ${subida.detalle}` };
    }

    // En la rama del proyecto publicar no cierra nada: la persona sigue
    // trabajando sobre `dev`, con los mismos servicios levantados. La base
    // pasa a ser lo publicado, así "contra la base" vuelve a empezar de cero.
    if (this.usaRamaDelProyecto(repo) && !sesion.rama.startsWith("orq/")) {
      const cabeza = (await git(["rev-parse", "HEAD"], g)).stdout.trim();
      this.guardarSesion({ ...sesion, baseSha: cabeza, updatedAt: Date.now() });
      this.emitir({
        tipo: "sesion_integrada",
        companyId: sesion.companyId,
        repoId: repo.id,
        sesionId: sesion.id,
        detalle: resultado.detalle,
        at: Date.now(),
      });
      return { ok: true, ...resultado, sigueAbierta: true };
    }

    await git(["worktree", "remove", "--force", this.rutaWorktree(sesion)], { cwd: clon, tolerar: true });
    this.guardarSesion({
      ...sesion,
      estado: "integrada",
      integracion: { ...resultado, at: Date.now() },
    });
    this.emitir({
      tipo: "sesion_integrada",
      companyId: sesion.companyId,
      repoId: repo.id,
      sesionId: sesion.id,
      detalle: resultado.detalle,
      at: Date.now(),
    });
    return { ok: true, ...resultado };
  }

  private async integrarEnRepoLocal(
    sesion: SesionCodigo,
    repo: Repositorio,
  ): Promise<{ modo: "fast-forward" | "rama"; detalle: string } | { ok: false; motivo: string }> {
    if (repo.origen.tipo !== "local") throw new Error("Origen inesperado.");
    const destino = repo.origen.ruta;
    const clon = this.rutaClon(repo);
    // La sesión puede estar en una rama con nombre propio (`main`, `dev`, una
    // feature que la persona abrió desde el IDE). Esa rama existe en su repo
    // con su propia historia, y se trata distinto: sólo avanza, nunca se pisa.
    if (!sesion.rama.startsWith("orq/")) return this.integrarRamaPropia(sesion, repo, destino, clon);
    // `+` porque la rama es nuestra: reintegrar la misma sesión la actualiza.
    await git(["fetch", "-q", "--no-tags", clon, `+${sesion.rama}:${sesion.rama}`], { cwd: destino });

    const actual = (await git(["symbolic-ref", "--short", "HEAD"], { cwd: destino, tolerar: true })).stdout.trim();
    const sucio = (await git(["status", "--porcelain", "--untracked-files=no"], { cwd: destino })).stdout.trim();
    if (actual !== repo.ramaBase || sucio) {
      return {
        modo: "rama",
        detalle:
          `Se creó la rama ${sesion.rama} en ${destino}. No se mezcló sola porque ` +
          (actual !== repo.ramaBase
            ? `tenés abierta ${actual || "otra cosa"} y no ${repo.ramaBase}.`
            : "tu carpeta tiene cambios sin commitear.") +
          ` Mezclala cuando quieras: git merge ${sesion.rama}`,
      };
    }
    const avance = await git(["merge", "--ff-only", "-q", sesion.rama], { cwd: destino, tolerar: true });
    if (!avance.ok) {
      return {
        modo: "rama",
        detalle:
          `Se creó la rama ${sesion.rama}, pero ${repo.ramaBase} avanzó en tu carpeta y no se puede ` +
          `adelantar sin mezclar. Mezclala a mano: git merge ${sesion.rama}`,
      };
    }
    return { modo: "fast-forward", detalle: `${repo.ramaBase} avanzó hasta la sesión en ${destino}.` };
  }

  /**
   * Una rama que la persona reconoce como suya. Con `+rama:rama` —lo que se
   * usa para las `orq/*`, que son nuestras— una sesión abierta en `main` le
   * habría reescrito su `main`. Acá: si la tiene abierta, fast-forward sobre su
   * carpeta limpia; si no, `rama:rama` sin `+`, que git sólo acepta si avanza.
   * Cualquier otra cosa no se integra y se explica.
   */
  private async integrarRamaPropia(
    sesion: SesionCodigo,
    repo: Repositorio,
    destino: string,
    clon: string,
  ): Promise<{ modo: "fast-forward" | "rama"; detalle: string } | { ok: false; motivo: string }> {
    const rama = sesion.rama;
    const actual = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: destino, tolerar: true })).stdout.trim();
    if (actual === rama) {
      const sucio = (await git(["status", "--porcelain", "--untracked-files=no"], { cwd: destino })).stdout.trim();
      if (sucio) {
        return { ok: false, motivo: `Tenés ${rama} abierta en ${destino} con cambios sin commitear: no se integra encima. Commitealos o guardalos y volvé a integrar.` };
      }
      await git(["fetch", "-q", "--no-tags", clon, rama], { cwd: destino });
      const avance = await git(["merge", "--ff-only", "-q", "FETCH_HEAD"], { cwd: destino, tolerar: true });
      if (!avance.ok) {
        return {
          ok: false,
          motivo: `${rama} avanzó en tu carpeta por otro lado y no se puede adelantar sin mezclar. Sincronizá, traé los cambios a la sesión y volvé a integrar.`,
        };
      }
      return { modo: "fast-forward", detalle: `${rama} avanzó hasta la sesión en ${destino}.` };
    }
    const existia = (await git(["rev-parse", "--verify", "-q", `refs/heads/${rama}`], { cwd: destino, tolerar: true })).ok;
    const r = await git(["fetch", "-q", "--no-tags", clon, `${rama}:${rama}`], { cwd: destino, tolerar: true });
    if (!r.ok) {
      return {
        ok: false,
        motivo: `${rama} ya existe en tu repo y avanzó por otro lado: no se pisó. Sincronizá, traé sus cambios a la sesión y volvé a integrar.`,
      };
    }
    return { modo: "rama", detalle: existia ? `${rama} avanzó en ${destino}.` : `Se creó la rama ${rama} en ${destino}.` };
  }

  /**
   * Sube la rama al remoto de la persona. Con origen local se empuja **desde su
   * repo** a su `origin` (su GitHub), con su ayudante de credenciales o su
   * agente SSH; con origen git, desde el clon. Sin hooks —la config segura los
   * apaga—, y sin forzar nunca: un push que no es fast-forward se rechaza.
   */
  private async subirAlRemoto(sesion: SesionCodigo, repo: Repositorio): Promise<{ ok: boolean; detalle: string }> {
    const cwd = repo.origen.tipo === "local" ? repo.origen.ruta : this.rutaClon(repo);
    const tieneRemoto = (await git(["remote", "get-url", "origin"], { cwd, tolerar: true })).stdout.trim();
    if (!tieneRemoto) return { ok: false, detalle: "tu repo no tiene un remoto origin." };
    const r = await git([...(await this.configCredenciales()), "push", "origin", `${sesion.rama}:${sesion.rama}`], {
      cwd,
      tolerar: true,
      corteMs: 120_000,
    });
    if (!r.ok) return { ok: false, detalle: r.stderr.trim().split("\n").filter((l) => !l.startsWith("hint:")).slice(-3).join(" ") };
    return { ok: true, detalle: `Se subió ${sesion.rama} a ${tieneRemoto}.` };
  }

  /** Origen sin git: vuelve a la carpeta lo que cambió, sin pisar lo que cambió la persona. */
  private async copiarDeVuelta(
    sesion: SesionCodigo,
    repo: Repositorio,
  ): Promise<{ ok: true; detalle: string } | { ok: false; motivo: string; conflictos: string[] }> {
    if (repo.origen.tipo !== "local") throw new Error("Origen inesperado.");
    const destino = repo.origen.ruta;
    const g = this.gitSesion(sesion, repo);
    const cambios = (await git(["diff", "--name-status", "--no-renames", sesion.baseSha, "HEAD"], g)).stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [estado = "", ruta = ""] = linea.split("\t");
        return { estado, ruta };
      });

    const conflictos: string[] = [];
    for (const { ruta } of cambios) {
      const local = join(destino, ruta);
      const enBase = await git(["rev-parse", "-q", "--verify", `${sesion.baseSha}:${ruta}`], { ...g, tolerar: true });
      const existeLocal = existsSync(local);
      if (!enBase.ok) {
        if (existeLocal) conflictos.push(ruta); // nuevo acá y nuevo allá
        continue;
      }
      if (!existeLocal) {
        conflictos.push(ruta); // lo borró la persona
        continue;
      }
      const hashLocal = (await git(["hash-object", "--no-filters", "--", local], { cwd: destino })).stdout.trim();
      if (hashLocal !== enBase.stdout.trim()) conflictos.push(ruta);
    }
    if (conflictos.length > 0) {
      return {
        ok: false,
        conflictos,
        motivo:
          `Cambiaste ${conflictos.length} archivo(s) en tu carpeta desde que se cargó el repo, y la ` +
          `sesión también los tocó. No se copió nada: descargá el patch y mezclalo a mano.`,
      };
    }

    for (const { estado, ruta } of cambios) {
      const local = resolve(destino, ruta);
      if (!local.startsWith(resolve(destino) + sep)) continue;
      if (estado.startsWith("D")) {
        await rm(local, { force: true });
        continue;
      }
      const contenido = await git(["show", `HEAD:${ruta}`], { ...g, maxBuffer: 64 * 1024 * 1024 });
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, contenido.stdout);
    }
    return { ok: true, detalle: `Se copiaron ${cambios.length} archivo(s) a ${destino}.` };
  }

  async descartar(sesion: SesionCodigo, repo: Repositorio): Promise<void> {
    const clon = this.rutaClon(repo);
    await git(["worktree", "remove", "--force", this.rutaWorktree(sesion)], { cwd: clon, tolerar: true });
    await rm(this.rutaWorktree(sesion), { recursive: true, force: true });
    await git(["worktree", "prune"], { cwd: clon, tolerar: true });
    if (sesion.rama.startsWith("orq/")) {
      await git(["branch", "-D", sesion.rama], { cwd: clon, tolerar: true });
    } else if ((await git(["rev-parse", "--verify", "-q", `refs/remotes/origin/${sesion.rama}`], { cwd: clon, tolerar: true })).ok) {
      // La rama del proyecto no se borra: vuelve a estar como en el repo de la
      // persona, que es lo que significa descartar el trabajo de la sesión.
      await git(["branch", "-f", sesion.rama, `origin/${sesion.rama}`], { cwd: clon, tolerar: true });
    }
    this.guardarSesion({ ...sesion, estado: "descartada" });
    this.emitir({
      tipo: "sesion_descartada",
      companyId: sesion.companyId,
      repoId: repo.id,
      sesionId: sesion.id,
      detalle: sesion.rama,
      at: Date.now(),
    });
  }

  /** Borra el repo del proyecto: clon, worktrees y filas. El origen no se toca. */
  /**
   * Saca el repo del proyecto. Si tiene una sesión con trabajo **sin integrar**,
   * antes deja un respaldo en la salida (`respaldos/`): un `git bundle` con la
   * rama entera y el patch legible.
   *
   * Lo pagamos: un simulador entero —tres etapas, 36 tests, seis checkpoints—
   * vivía sólo en la rama de la sesión; se sacó el repo del proyecto antes de
   * integrarlo y el clon se fue con todo. La carpeta de la persona estaba
   * intacta, como se prometía, y justo por eso no tenía nada.
   */
  async eliminar(repo: Repositorio): Promise<{ respaldo: string | null }> {
    let respaldo: string | null = null;
    const abierta = this.sesionAbierta(repo.id, repo.companyId);
    if (abierta && existsSync(this.rutaClon(repo))) {
      try {
        const g = this.gitSesion(abierta, repo);
        if (await this.tieneCambiosPendientes(abierta, repo)) {
          await this.checkpoint(abierta, repo, { nombre: "Orquestador", id: "orquestador" }, "", {
            titulo: "Cambios sin confirmar al sacar el repo del proyecto",
          });
        }
        const commits = abierta.baseSha
          ? Number((await git(["rev-list", "--count", `${abierta.baseSha}..HEAD`], { ...g, tolerar: true })).stdout.trim() || 0)
          : 1;
        if (commits > 0) {
          const dir = join(this.directorios.sub(repo.companyId, "salida", true), "respaldos");
          await mkdir(dir, { recursive: true });
          const base = join(dir, `${repo.slug}-${abierta.rama.replace(/\//g, "-")}`);
          // Con la historia entera y no sólo lo de la sesión: un bundle
          // "delgado" necesita el repo de origen para abrirse, y un respaldo
          // existe justo para cuando ese repo ya no está.
          await git(["bundle", "create", `${base}.bundle`, abierta.rama], {
            cwd: this.rutaClon(repo),
            tolerar: true,
          });
          await writeFile(`${base}.patch`, await this.patch(abierta, repo));
          respaldo = `respaldos/${basename(base)}.bundle`;
        }
      } catch {
        respaldo = null;
      }
    }
    await rm(this.rutaClon(repo), { recursive: true, force: true });
    await rm(join(this.directorios.sub(repo.companyId, "worktrees"), repo.slug), { recursive: true, force: true });
    this.store.deleteRepositorio(repo.id);
    this.emitir({
      tipo: "repo_eliminado",
      companyId: repo.companyId,
      repoId: repo.id,
      detalle: respaldo ? `${repo.nombre} (respaldo en ${respaldo})` : repo.nombre,
      at: Date.now(),
    });
    return { respaldo };
  }

  /**
   * Un repo vacío para un programa nuevo que construye la empresa. Nace con
   * README, `.gitignore` y los comandos de verificación de Node ya permitidos
   * —corren en el sandbox como todos—: sin eso, lo primero que hacía el equipo
   * era pedir permiso para correr los tests de un repo que acababa de crear.
   */
  async crearVacio(companyId: string, nombre: string, descripcion: string): Promise<Repositorio> {
    const existentes = this.store.listRepositorios(companyId);
    if (existentes.length >= MAX_REPOS_POR_PROYECTO) {
      throw new Error(`El proyecto ya tiene ${existentes.length} repos. Sacá alguno antes de crear otro.`);
    }
    const limpio = nombre.trim().slice(0, 120);
    const repetido = existentes.find((r) => r.nombre.toLowerCase() === limpio.toLowerCase());
    if (repetido) throw new Error(`Ya hay un repo "${repetido.nombre}": trabajá sobre ése con repo="${repetido.nombre}".`);
    let slug = slugTecnico(limpio, "repo");
    for (let n = 2; existentes.some((r) => r.slug === slug); n++) slug = `${slugTecnico(limpio, "repo")}-${n}`;
    const destino = join(this.directorios.sub(companyId, "repos", true), slug);
    if (existsSync(destino)) throw new Error(`Ya existe ${destino}.`);
    await mkdir(destino, { recursive: true });
    try {
      await git(["init", "-q", "-b", "main"], { cwd: destino });
      await writeFile(join(destino, "README.md"), `# ${limpio}\n\n${descripcion.trim() || "Programa creado por el equipo."}\n`);
      await writeFile(join(destino, ".gitignore"), "node_modules/\n.DS_Store\ndist/\n");
      await escribirExcluidos(destino);
      await git(["add", "-A"], { cwd: destino });
      await git(["commit", "-q", "-m", `Base: ${limpio}`], { cwd: destino });
    } catch (error) {
      await rm(destino, { recursive: true, force: true });
      throw error;
    }
    const ahora = Date.now();
    const repo: Repositorio = {
      id: ids.repositorio(),
      companyId,
      nombre: limpio,
      slug,
      origen: { tipo: "creado", descripcion: descripcion.trim().slice(0, 500) },
      ramaBase: "main",
      baseSha: (await git(["rev-parse", "HEAD"], { cwd: destino })).stdout.trim(),
      origenSinGit: false,
      comandos: {
        permitidos: [["npm", "test"], ["node", "--test"], ["node", "--check"]],
        preparar: null,
        test: ["npm", "test"],
        verificar: null,
        sinAislamiento: false,
        unaVez: [],
      },
      servicios: [],
      commitsAutomaticos: false,
      pendienteDeConfirmar: false,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.store.saveRepositorio(repo);
    this.emitir({ tipo: "repo_cargado", companyId, repoId: repo.id, detalle: limpio, at: ahora });
    return repo;
  }

  /** Al arrancar: git olvida los worktrees cuya carpeta ya no existe. */
  async podar(companyIds: string[]): Promise<void> {
    for (const companyId of companyIds) {
      for (const repo of this.store.listRepositorios(companyId)) {
        if (existsSync(this.rutaClon(repo))) {
          await git(["worktree", "prune"], { cwd: this.rutaClon(repo), tolerar: true });
        }
      }
    }
  }
}

// --- Auxiliares -------------------------------------------------------------

function nombreDeOrigen(origen: OrigenRepositorio): string {
  if (origen.tipo === "creado") return "repo";
  const crudo = origen.tipo === "local" ? origen.ruta : origen.url;
  return basename(crudo.replace(/[/\\]+$/, "")).replace(/\.git$/, "") || "repo";
}

async function carpetaLocalValida(ruta: string): Promise<string> {
  const absoluta = resolve(ruta.replace(/^~(?=$|\/)/, process.env["HOME"] ?? "~"));
  let real: string;
  try {
    real = await realpath(absoluta);
  } catch {
    throw new Error(`No existe la carpeta ${absoluta}.`);
  }
  if (!(await stat(real)).isDirectory()) throw new Error(`${absoluta} no es una carpeta.`);
  return real;
}

async function escribirExcluidos(clon: string): Promise<void> {
  const archivo = join(clon, ".git", "info", "exclude");
  await mkdir(dirname(archivo), { recursive: true });
  let actual = "";
  try {
    actual = await readFile(archivo, "utf8");
  } catch {
    actual = "";
  }
  if (actual.includes(EXCLUIDOS[0]!)) return;
  await writeFile(archivo, `${actual.trimEnd()}\n\n${EXCLUIDOS.join("\n")}\n`, "utf8");
}

async function copiarSinRegenerables(origen: string, destino: string, avisos: string[]): Promise<void> {
  const grandes: string[] = [];
  await cp(origen, destino, {
    recursive: true,
    dereference: false,
    filter: async (fuente) => {
      const rel = relative(origen, fuente);
      if (rel === "") return true;
      const partes = rel.split(sep);
      if (partes.some((parte) => NO_SE_COPIA.has(parte))) return false;
      try {
        const info = await stat(fuente);
        if (info.isFile() && info.size > MAX_ARCHIVO_COPIADO) {
          grandes.push(rel);
          return false;
        }
      } catch {
        return false;
      }
      return true;
    },
  });
  if (grandes.length > 0) {
    avisos.push(
      `No se copiaron ${grandes.length} archivo(s) de más de 5 MB (${grandes.slice(0, 5).join(", ")}${
        grandes.length > 5 ? "…" : ""
      }).`,
    );
  }
}

/**
 * Qué comandos parece tener el repo. Son **sugerencias**: nada de esto queda
 * permitido hasta que una persona lo confirme.
 */
export async function detectarComandos(dir: string): Promise<Partial<ComandosRepositorio>> {
  const hay = (nombre: string) => existsSync(join(dir, nombre));
  const sugeridos: { permitidos: Argv[]; preparar?: Argv; test?: Argv; verificar?: Argv } = { permitidos: [] };

  if (hay("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      scripts = {};
    }
    const gestor = hay("pnpm-lock.yaml") ? "pnpm" : hay("yarn.lock") ? "yarn" : "npm";
    sugeridos.preparar =
      gestor === "npm"
        ? hay("package-lock.json")
          ? ["npm", "ci"]
          : ["npm", "install"]
        : gestor === "pnpm"
          ? ["pnpm", "install", "--frozen-lockfile"]
          : ["yarn", "install", "--frozen-lockfile"];
    const correr = (script: string): Argv => (gestor === "npm" ? ["npm", "run", script] : [gestor, script]);
    if (scripts["test"]) {
      sugeridos.test = gestor === "npm" ? ["npm", "test"] : [gestor, "test"];
      sugeridos.permitidos.push(sugeridos.test);
    }
    for (const script of ["typecheck", "lint", "build"]) {
      if (scripts[script]) {
        sugeridos.permitidos.push(correr(script));
        sugeridos.verificar ??= correr(script);
      }
    }
  } else if (hay("pyproject.toml") || hay("requirements.txt") || hay("setup.py")) {
    sugeridos.test = ["pytest", "-q"];
    sugeridos.permitidos.push(["pytest"]);
    if (hay("requirements.txt")) sugeridos.preparar = ["pip", "install", "-r", "requirements.txt"];
  } else if (hay("go.mod")) {
    sugeridos.test = ["go", "test", "./..."];
    sugeridos.verificar = ["go", "vet", "./..."];
    sugeridos.permitidos.push(["go", "test"], ["go", "vet"], ["go", "build"]);
  } else if (hay("Cargo.toml")) {
    sugeridos.test = ["cargo", "test"];
    sugeridos.verificar = ["cargo", "check"];
    sugeridos.permitidos.push(["cargo", "test"], ["cargo", "check"], ["cargo", "build"]);
  }
  return sugeridos;
}

/**
 * Los comandos sugeridos de un monorepo: los de la raíz más los de cada
 * servicio. Un argv permitido vale en cualquier carpeta (`npm test` es
 * `npm test` en `backend/` y en `frontend/`), así que alcanza con la unión; lo
 * que cambia por servicio es **dónde** se corre, y eso lo dice `carpeta`.
 */
export async function detectarComandosDeRepo(dir: string, servicios: Servicio[]): Promise<Partial<ComandosRepositorio>> {
  const raiz = await detectarComandos(dir);
  const permitidos = [...(raiz.permitidos ?? [])];
  const clave = (argv: Argv) => argv.join("\u0000");
  const vistos = new Set(permitidos.map(clave));
  let test = raiz.test ?? null;
  let verificar = raiz.verificar ?? null;
  for (const servicio of servicios) {
    if (!servicio.carpeta || servicio.tipo === "docs") continue;
    const propios = await detectarComandos(join(dir, servicio.carpeta));
    for (const argv of propios.permitidos ?? []) {
      if (!vistos.has(clave(argv))) {
        vistos.add(clave(argv));
        permitidos.push(argv);
      }
    }
    test ??= propios.test ?? null;
    verificar ??= propios.verificar ?? null;
  }
  return {
    ...raiz,
    permitidos,
    ...(test ? { test } : {}),
    ...(verificar ? { verificar } : {}),
  };
}

export { ErrorGit };

/** Para listados: las entradas de primer nivel del worktree, sin lo oculto. */
export async function carpetasDePrimerNivel(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return [];
  }
}

const TOPE_EDITABLE = 2 * 1024 * 1024;
/** Más repos que esto en un proyecto no es un equipo trabajando, es dispersión. */
const MAX_REPOS_POR_PROYECTO = 12;

export function hashDe(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/** Lo que el editor puede mostrar: texto hasta 2 MB; lo binario o enorme, sólo su tamaño. */
function aContenido(bytes: Buffer): {
  ok: true;
  contenido: string | null;
  binario: boolean;
  bytes: number;
  hash: string;
} {
  const binario = bytes.subarray(0, 8_000).includes(0) || bytes.length > TOPE_EDITABLE;
  return {
    ok: true,
    contenido: binario ? null : bytes.toString("utf8"),
    binario,
    bytes: bytes.length,
    hash: hashDe(bytes),
  };
}
