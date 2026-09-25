import { rm } from "node:fs/promises";
import type { Repositorio, SesionCodigo } from "@orq/shared";
import { resolverEnWorktree } from "@orq/tools";
import { git, type ResultadoGit } from "./git.js";
import type { RepoStore } from "./repos.js";

/**
 * El control de versiones del IDE, como el panel de Git de Cursor/VS Code:
 * preparar y quitar archivos, commit (con amend), stash, ramas y fusión.
 *
 * Todo pasa **sobre el worktree de la sesión**, nunca sobre la carpeta de la
 * persona —eso sigue siendo sólo integrar—. Dos reglas que no son de gusto:
 *
 * - **Mientras un agente tiene el arriendo, nada de esto escribe** (lo
 *   verifica quien llama): un `stash` a mitad de su turno le saca los archivos
 *   que está editando, y un cambio de rama le cambia el árbol debajo.
 * - **Cambiar de rama mueve la sesión**: integrar lleva la rama que está
 *   abierta. Una rama que ya está abierta en otro lado (la base, en el clon) no
 *   se puede abrir acá —git no deja dos worktrees en la misma rama— y se ofrece
 *   crear una desde ella.
 */

export interface ArchivoScm {
  ruta: string;
  /** Letra de git: M, A, D, R, U (conflicto), ? (nuevo sin seguimiento). */
  estado: string;
}

export interface EstadoScm {
  rama: string | null;
  cabeza: string | null;
  /** Commits de la rama por delante de la base de la sesión. */
  adelante: number;
  preparados: ArchivoScm[];
  cambios: ArchivoScm[];
  conflictos: string[];
  stashes: Array<{ ref: string; mensaje: string; at: number }>;
  ramas: Array<{
    nombre: string;
    sha: string;
    at: number;
    asunto: string;
    actual: boolean;
    /** Abierta en otro worktree (la base en el clon, otra sesión): no se puede abrir acá. */
    ocupada: boolean;
  }>;
  /** El último commit es de la sesión (se puede modificar con amend sin tocar la base). */
  puedeModificarUltimo: boolean;
  /**
   * La rama base **en el repo de la persona** (`origin/dev`): cuánto lleva la
   * sesión sin integrar y cuánto avanzó ella desde entonces.
   */
  base: { rama: string; ref: string | null; adelante: number; atras: number };
  /**
   * Las ramas del repo de la persona (`origin/*`) y las de su remoto
   * (`remoto/*`, su GitHub). Cambiar a una crea la local que la sigue.
   */
  ramasDelRepo: Array<{ nombre: string; ref: string; grupo: "repo" | "remoto"; sha: string; at: number; asunto: string; local: boolean }>;
}

export interface CommitDelHistorial {
  sha: string;
  corto: string;
  autor: string;
  at: number;
  asunto: string;
  /** Ramas y tags que apuntan acá (`dev`, `origin/main`, `tag: v1`). */
  refs: string[];
  /** Más de un padre: una fusión. */
  fusion: boolean;
  /** Todavía no está en la rama base de la persona: es trabajo de la sesión sin integrar. */
  sinIntegrar: boolean;
}

type Contexto = { gitDir: string; workTree: string; cwd: string };

export class ControlDeVersiones {
  constructor(private readonly repos: RepoStore) {}

  private g(sesion: SesionCodigo, repo: Repositorio): Contexto {
    return this.repos.contextoGit(sesion, repo);
  }

  // --- Estado -------------------------------------------------------------------

  async estado(sesion: SesionCodigo, repo: Repositorio): Promise<EstadoScm> {
    const g = this.g(sesion, repo);
    const rama = (await git(["symbolic-ref", "--short", "-q", "HEAD"], { ...g, tolerar: true })).stdout.trim() || null;
    const cabeza = (await git(["rev-parse", "-q", "--verify", "HEAD"], { ...g, tolerar: true })).stdout.trim() || null;

    // `-z` y sin renombres: una ruta con espacios o comillas llega entera, y
    // un renombre se ve como borrado + nuevo, que es lo que se prepara.
    const salida = (await git(["status", "--porcelain=v1", "-z", "-uall", "--no-renames"], g)).stdout;
    const preparados: ArchivoScm[] = [];
    const cambios: ArchivoScm[] = [];
    const conflictos: string[] = [];
    for (const entrada of salida.split("\0")) {
      if (entrada.length < 4) continue;
      const x = entrada.charAt(0);
      const y = entrada.charAt(1);
      const ruta = entrada.slice(3);
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
        conflictos.push(ruta);
        continue;
      }
      // `?` sin seguimiento, y `" A"`: un nuevo marcado con `--intent-to-add`
      // (lo hacen el diff de la sesión y la huella de los comandos para verlo).
      // Para la persona los dos son lo mismo: un archivo nuevo sin preparar.
      if ((x === "?" && y === "?") || (x === " " && y === "A")) {
        cambios.push({ ruta, estado: "?" });
        continue;
      }
      if (x !== " ") preparados.push({ ruta, estado: x });
      if (y !== " ") cambios.push({ ruta, estado: y });
    }

    const stashes = (await git(["stash", "list", "--format=%gd%x1f%gs%x1f%ct"], { ...g, tolerar: true })).stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [ref = "", mensaje = "", at = "0"] = linea.split("\x1f");
        return { ref, mensaje: mensaje.replace(/^(On|WIP on) [^:]+: /, ""), at: Number(at) * 1000 };
      });

    const ocupadas = await this.ramasAbiertas(sesion, repo);
    const ramas = (
      await git(
        ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(subject)", "refs/heads"],
        { ...g, tolerar: true },
      )
    ).stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [nombre = "", sha = "", at = "0", asunto = ""] = linea.split("\x1f");
        return { nombre, sha, at: Number(at) * 1000, asunto, actual: nombre === rama, ocupada: nombre !== rama && ocupadas.has(nombre) };
      });

    const adelante = sesion.baseSha && cabeza
      ? Number((await git(["rev-list", "--count", `${sesion.baseSha}..HEAD`], { ...g, tolerar: true })).stdout.trim() || 0)
      : 0;

    const refBase = await this.refDeLaBase(repo, g);
    let base = { rama: repo.ramaBase, ref: refBase, adelante: 0, atras: 0 };
    if (refBase && cabeza) {
      const [izq = "0", der = "0"] = (await git(["rev-list", "--left-right", "--count", `HEAD...${refBase}`], { ...g, tolerar: true })).stdout
        .trim()
        .split(/\s+/);
      base = { ...base, adelante: Number(izq) || 0, atras: Number(der) || 0 };
    }

    const locales = new Set(ramas.map((r) => r.nombre));
    const ramasDelRepo = (
      await git(
        ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(subject)", "refs/remotes/origin", "refs/remotes/remoto"],
        { ...g, tolerar: true },
      )
    ).stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [ref = "", sha = "", at = "0", asunto = ""] = linea.split("\x1f");
        const grupo: "repo" | "remoto" = ref.startsWith("remoto/") ? "remoto" : "repo";
        const nombre = ref.replace(/^(origin|remoto)\//, "");
        return { nombre, ref, grupo, sha, at: Number(at) * 1000, asunto, local: locales.has(nombre) };
      })
      .filter((r) => r.nombre !== "HEAD" && r.ref !== "origin" && r.ref !== "remoto");

    return {
      rama,
      cabeza,
      adelante,
      preparados,
      cambios,
      conflictos,
      stashes,
      ramas,
      puedeModificarUltimo: adelante > 0,
      base,
      ramasDelRepo,
    };
  }

  /** `origin/<base>` si existe (repo con origen); si no, la base local. */
  private async refDeLaBase(repo: Repositorio, g: Contexto): Promise<string | null> {
    for (const ref of [`origin/${repo.ramaBase}`, repo.ramaBase]) {
      if ((await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { ...g, tolerar: true })).ok) return ref;
    }
    return null;
  }

  // --- Historial --------------------------------------------------------------------

  /**
   * La historia de la rama abierta **entera**, no sólo la de la sesión: en un
   * repo con años de trabajo, como el de INSPIA sobre `dev`, "qué hay acá" se
   * contesta mirando esa historia. Paginada, con las ramas y tags que apuntan a
   * cada commit, y marcando lo que la persona todavía no tiene en su base.
   */
  async historial(
    sesion: SesionCodigo,
    repo: Repositorio,
    opciones: { desde?: number; cantidad?: number; rama?: string } = {},
  ): Promise<{ commits: CommitDelHistorial[]; hayMas: boolean }> {
    const g = this.g(sesion, repo);
    const cantidad = Math.max(10, Math.min(200, opciones.cantidad ?? 60));
    const desde = Math.max(0, opciones.desde ?? 0);
    const cual = opciones.rama?.trim() ? await this.validarNombreDeRama(opciones.rama, g) : "HEAD";
    const salida = (
      await git(
        ["log", `--skip=${desde}`, `-n${cantidad + 1}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1f%P", cual, "--"],
        { ...g, tolerar: true },
      )
    ).stdout;
    const refBase = await this.refDeLaBase(repo, g);
    const sinIntegrar = new Set(
      refBase
        ? (await git(["rev-list", "--max-count=2000", `${refBase}..${cual}`], { ...g, tolerar: true })).stdout.split("\n").filter(Boolean)
        : [],
    );
    const lineas = salida.split("\n").filter(Boolean);
    const commits = lineas.slice(0, cantidad).map((linea) => {
      const [sha = "", corto = "", autor = "", at = "0", asunto = "", deco = "", padres = ""] = linea.split("\x1f");
      const refs = deco
        .split(",")
        .map((r) => r.trim().replace(/^HEAD -> /, ""))
        .filter((r) => r && r !== "HEAD" && !/\/HEAD$/.test(r));
      return { sha, corto, autor, at: Number(at) * 1000, asunto, refs, fusion: padres.trim().split(" ").length > 1, sinIntegrar: sinIntegrar.has(sha) };
    });
    return { commits, hayMas: lineas.length > cantidad };
  }

  /** Los archivos que tocó cualquier commit (contra su primer padre, así una fusión se lee como "lo que trajo"). */
  async archivosDeCommit(sesion: SesionCodigo, repo: Repositorio, sha: string): Promise<{ archivos: ArchivoScm[]; padre: string | null }> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Commit inválido.");
    const g = this.g(sesion, repo);
    const padre = (await git(["rev-parse", "-q", "--verify", `${sha}^1`], { ...g, tolerar: true })).stdout.trim() || null;
    const salida = await git(
      ["diff-tree", "-r", "--no-commit-id", "--name-status", "--no-renames", "--root", ...(padre ? [padre, sha] : [sha])],
      { ...g, tolerar: true },
    );
    const archivos = salida.stdout
      .split("\n")
      .filter(Boolean)
      .map((linea) => {
        const [estado = "", ruta = ""] = linea.split("\t");
        return { estado: estado.charAt(0), ruta };
      })
      .filter((a) => a.ruta);
    return { archivos, padre };
  }

  /** Ramas abiertas en algún worktree del clon (incluido el propio clon, con la base). */
  private async ramasAbiertas(sesion: SesionCodigo, repo: Repositorio): Promise<Set<string>> {
    const salida = (await git(["worktree", "list", "--porcelain"], { ...this.g(sesion, repo), tolerar: true })).stdout;
    const abiertas = new Set<string>();
    for (const linea of salida.split("\n")) {
      if (linea.startsWith("branch refs/heads/")) abiertas.add(linea.slice("branch refs/heads/".length));
    }
    return abiertas;
  }

  // --- Preparar / quitar / descartar ------------------------------------------------

  /** Valida rutas contra el worktree: vienen del navegador. */
  private async rutas(sesion: SesionCodigo, repo: Repositorio, rutas: string[]): Promise<string[]> {
    const dir = this.g(sesion, repo).workTree;
    const validas: string[] = [];
    for (const ruta of rutas) {
      const r = await resolverEnWorktree(dir, ruta);
      if (!r.ok) throw new Error(r.motivo);
      validas.push(r.relativa);
    }
    return validas;
  }

  async preparar(sesion: SesionCodigo, repo: Repositorio, rutas: string[] | "todo"): Promise<void> {
    const g = this.g(sesion, repo);
    if (rutas === "todo") await git(["add", "-A"], g);
    else if (rutas.length) await git(["add", "-A", "--", ...(await this.rutas(sesion, repo, rutas))], g);
  }

  async quitar(sesion: SesionCodigo, repo: Repositorio, rutas: string[] | "todo"): Promise<void> {
    const g = this.g(sesion, repo);
    const lista = rutas === "todo" ? ["."] : await this.rutas(sesion, repo, rutas);
    if (!lista.length) return;
    const hayCabeza = (await git(["rev-parse", "-q", "--verify", "HEAD"], { ...g, tolerar: true })).ok;
    // Sin ningún commit no hay HEAD al que volver: se saca del índice a secas.
    if (hayCabeza) await git(["restore", "--staged", "--", ...lista], g);
    else await git(["rm", "-r", "-q", "--cached", "--", ...lista], g);
  }

  /**
   * Descarta cambios: los rastreados vuelven a como están en el último commit,
   * los nuevos se borran. Es la operación destructiva del panel, y la UI la
   * confirma antes.
   */
  async descartar(sesion: SesionCodigo, repo: Repositorio, rutas: string[] | "todo"): Promise<void> {
    const g = this.g(sesion, repo);
    const estado = await this.estado(sesion, repo);
    const pedidas = rutas === "todo" ? null : new Set(await this.rutas(sesion, repo, rutas));
    const elegidas = (a: ArchivoScm) => pedidas == null || pedidas.has(a.ruta);
    const nuevos = estado.cambios.filter((a) => a.estado === "?" && elegidas(a)).map((a) => a.ruta);
    const rastreados = [...new Set([...estado.cambios, ...estado.preparados].filter((a) => a.estado !== "?" && elegidas(a)).map((a) => a.ruta))];
    // Un archivo agregado al índice que no existe en HEAD no se puede
    // "restaurar": se saca del índice y se borra como un nuevo.
    const enCabeza: string[] = [];
    for (const ruta of rastreados) {
      const existe = await git(["cat-file", "-e", `HEAD:${ruta}`], { ...g, tolerar: true });
      if (existe.ok) enCabeza.push(ruta);
      else {
        await git(["rm", "-q", "--cached", "--force", "--", ruta], { ...g, tolerar: true });
        nuevos.push(ruta);
      }
    }
    if (enCabeza.length) await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...enCabeza], g);
    for (const ruta of nuevos) {
      const r = await resolverEnWorktree(g.workTree, ruta);
      if (r.ok) await rm(r.absoluta, { force: true, recursive: true });
    }
    this.repos.avisarCambioDeSesion(sesion, repo, "cambios descartados");
  }

  // --- Commit -----------------------------------------------------------------------

  /**
   * Commit con la identidad de git de la persona. Sin nada preparado se
   * commitea todo, como el "smart commit" de VS Code: es lo que la persona
   * quiere cuando aprieta el botón sin haber preparado nada.
   */
  async commit(
    sesion: SesionCodigo,
    repo: Repositorio,
    opciones: { mensaje: string; todo?: boolean; amend?: boolean },
  ): Promise<{ sha: string }> {
    const g = this.g(sesion, repo);
    const mensaje = opciones.mensaje.trim();
    if (!mensaje && !opciones.amend) throw new Error("Escribí un mensaje para el commit (o generalo).");
    const estado = await this.estado(sesion, repo);
    if (estado.conflictos.length) throw new Error(`Hay conflictos sin resolver en ${estado.conflictos.join(", ")}.`);
    if (opciones.amend && !estado.puedeModificarUltimo) {
      throw new Error("El último commit es de la base, no de la sesión: modificarlo reescribiría una historia que no es de acá.");
    }
    if (opciones.todo || (estado.preparados.length === 0 && !opciones.amend)) await git(["add", "-A"], g);
    const hayAlgo = !(await git(["diff", "--cached", "--quiet"], { ...g, tolerar: true })).ok;
    if (!hayAlgo && !opciones.amend) throw new Error("No hay cambios para commitear.");

    const persona = await this.repos.identidadDePersona();
    const identidad = ["-c", `user.name=${persona.nombre.replace(/[<>]/g, "")}`, "-c", `user.email=${persona.email.replace(/[<>\s]/g, "")}`];
    const args = [...identidad, "commit", "-q", "--no-verify"];
    if (opciones.amend) args.push("--amend");
    if (mensaje) {
      // Primer renglón título, el resto cuerpo: lo mismo que `git commit -m`.
      const [titulo = "", ...cuerpo] = mensaje.split("\n");
      args.push("-m", titulo.slice(0, 200));
      if (cuerpo.join("\n").trim()) args.push("-m", cuerpo.join("\n").trim().slice(0, 8_000));
    } else {
      args.push("--no-edit");
    }
    await git(args, g);
    const sha = (await git(["rev-parse", "HEAD"], g)).stdout.trim();
    this.repos.avisarCambioDeSesion(sesion, repo, `${sha.slice(0, 8)} ${persona.nombre}`);
    return { sha };
  }

  /** El diff que describe el commit que se está por hacer: lo preparado, o todo si no hay nada preparado. */
  async diffParaMensaje(sesion: SesionCodigo, repo: Repositorio): Promise<{ diff: string; archivos: string[] }> {
    const g = this.g(sesion, repo);
    const estado = await this.estado(sesion, repo);
    if (estado.preparados.length) {
      return {
        diff: (await git(["diff", "--cached", "--no-color", "--no-ext-diff"], g)).stdout,
        archivos: estado.preparados.map((a) => a.ruta),
      };
    }
    // Los nuevos no aparecen en `git diff` sin intención de agregar.
    await git(["add", "-A", "--intent-to-add"], { ...g, tolerar: true });
    return {
      diff: (await git(["diff", "HEAD", "--no-color", "--no-ext-diff"], { ...g, tolerar: true })).stdout,
      archivos: estado.cambios.map((a) => a.ruta),
    };
  }

  // --- Stash ----------------------------------------------------------------------

  async guardarStash(sesion: SesionCodigo, repo: Repositorio, opciones: { mensaje?: string; incluirNuevos?: boolean; soloPreparados?: boolean }): Promise<void> {
    await this.soltarIntencionDeAgregar(sesion, repo);
    const args = ["stash", "push"];
    if (opciones.incluirNuevos !== false && !opciones.soloPreparados) args.push("--include-untracked");
    if (opciones.soloPreparados) args.push("--staged");
    if (opciones.mensaje?.trim()) args.push("-m", opciones.mensaje.trim().slice(0, 200));
    const r = await git(args, { ...this.g(sesion, repo), tolerar: true });
    if (!r.ok) throw new Error(r.stderr.trim() || "No se pudo guardar el stash.");
    if (/No local changes to save/i.test(r.stdout + r.stderr)) throw new Error("No hay cambios para guardar.");
    this.repos.avisarCambioDeSesion(sesion, repo, "stash guardado");
  }

  /**
   * Devuelve a "nuevo sin seguimiento" lo marcado con `--intent-to-add`.
   *
   * El diff de la sesión, el mensaje generado y la huella de los comandos
   * marcan así los archivos nuevos para que `git diff` los vea, y `git stash`
   * no sabe guardar esas entradas: falla con "not uptodate. Cannot save the
   * current worktree state". Sacarlas del índice no toca el archivo.
   */
  private async soltarIntencionDeAgregar(sesion: SesionCodigo, repo: Repositorio): Promise<void> {
    const g = this.g(sesion, repo);
    const salida = (await git(["status", "--porcelain=v1", "-z", "-uno", "--no-renames"], g)).stdout;
    const marcados = salida
      .split("\0")
      .filter((e) => e.length > 3 && e.charAt(0) === " " && e.charAt(1) === "A")
      .map((e) => e.slice(3));
    if (marcados.length) await git(["rm", "-q", "--cached", "--", ...marcados], g);
  }

  async usarStash(sesion: SesionCodigo, repo: Repositorio, ref: string, accion: "aplicar" | "sacar" | "borrar"): Promise<void> {
    if (!/^stash@\{\d{1,4}\}$/.test(ref)) throw new Error(`"${ref}" no es un stash.`);
    const comando = accion === "aplicar" ? "apply" : accion === "sacar" ? "pop" : "drop";
    const r = await git(["stash", comando, ...(accion === "borrar" ? [] : ["--index"]), ref], { ...this.g(sesion, repo), tolerar: true });
    if (!r.ok) {
      // `--index` falla si lo preparado no se puede reconstruir: se reintenta
      // sin él, que igual trae los cambios (sin separar lo preparado).
      const reintento = accion === "borrar" ? r : await git(["stash", comando, ref], { ...this.g(sesion, repo), tolerar: true });
      if (!reintento.ok) throw new Error(explicarGit(reintento, "No se pudo aplicar el stash"));
    }
    this.repos.avisarCambioDeSesion(sesion, repo, `stash: ${accion}`);
  }

  // --- Ramas ------------------------------------------------------------------------

  private async validarNombreDeRama(nombre: string, g: Contexto): Promise<string> {
    const limpio = nombre.trim();
    if (!limpio || limpio.startsWith("-")) throw new Error("Nombre de rama inválido.");
    const r = await git(["check-ref-format", "--branch", limpio], { ...g, tolerar: true });
    if (!r.ok) throw new Error(`"${limpio}" no es un nombre de rama válido para git (sin espacios, sin "..", sin "~^:?*[").`);
    return limpio;
  }

  /** Crea una rama y la abre en la sesión, llevándose los cambios sin commitear. */
  async crearRama(sesion: SesionCodigo, repo: Repositorio, nombre: string, desde?: string): Promise<SesionCodigo> {
    const g = this.g(sesion, repo);
    const rama = await this.validarNombreDeRama(nombre, g);
    await this.soltarIntencionDeAgregar(sesion, repo);
    const args = ["switch", "-c", rama];
    if (desde?.trim()) args.push(await this.validarNombreDeRama(desde, g));
    const r = await git(args, { ...g, tolerar: true });
    if (!r.ok) throw new Error(explicarGit(r, `No se pudo crear ${rama}`));
    this.repos.avisarCambioDeSesion(sesion, repo, `rama ${rama}`);
    return this.repos.cambiarRamaDeSesion(sesion, rama);
  }

  async cambiarRama(sesion: SesionCodigo, repo: Repositorio, nombre: string): Promise<SesionCodigo> {
    const g = this.g(sesion, repo);
    const rama = await this.validarNombreDeRama(nombre.replace(/^(origin|remoto)\//, ""), g);
    if ((await this.ramasAbiertas(sesion, repo)).has(rama) && rama !== sesion.rama) {
      throw new Error(
        rama === repo.ramaBase
          ? `${rama} es la rama base y está abierta en el clon. La sesión ya trabaja sobre ${rama}: lo que commitees acá entra a tu ${rama} al integrar. Para arrancar de cero sobre tu último ${rama}, creá una rama desde origin/${rama}.`
          : `${rama} está abierta en otra sesión y git no deja abrirla dos veces. Creá una rama desde ella.`,
      );
    }
    await this.soltarIntencionDeAgregar(sesion, repo);
    // Si sólo existe en el repo de la persona (o en su GitHub), se crea la
    // local que la sigue. Explícito y no el "adivinar" de `git switch`: con la
    // misma rama en `origin/` y en `remoto/`, git se niega a elegir.
    const local = (await git(["rev-parse", "--verify", "-q", `refs/heads/${rama}`], { ...g, tolerar: true })).ok;
    let argsSwitch = ["switch", rama];
    if (!local) {
      const origen = [`origin/${rama}`, `remoto/${rama}`];
      let ref: string | null = null;
      for (const candidato of origen) {
        if ((await git(["rev-parse", "--verify", "-q", `refs/remotes/${candidato}`], { ...g, tolerar: true })).ok) {
          ref = candidato;
          break;
        }
      }
      if (ref) argsSwitch = ["switch", "--track", "-c", rama, ref];
    }
    const r = await git(argsSwitch, { ...g, tolerar: true });
    if (!r.ok) throw new Error(explicarGit(r, `No se pudo cambiar a ${rama}`));
    this.repos.avisarCambioDeSesion(sesion, repo, `rama ${rama}`);
    return this.repos.cambiarRamaDeSesion(sesion, rama);
  }

  async borrarRama(sesion: SesionCodigo, repo: Repositorio, nombre: string): Promise<void> {
    const g = this.g(sesion, repo);
    const rama = await this.validarNombreDeRama(nombre, g);
    if (rama === sesion.rama) throw new Error("Es la rama abierta: cambiá a otra antes de borrarla.");
    if (rama === repo.ramaBase) throw new Error("Es la rama base del repo: no se borra desde acá.");
    if ((await this.ramasAbiertas(sesion, repo)).has(rama)) throw new Error(`${rama} está abierta en otra sesión.`);
    const r = await git(["branch", "-D", rama], { ...g, tolerar: true });
    if (!r.ok) throw new Error(explicarGit(r, `No se pudo borrar ${rama}`));
    this.repos.avisarCambioDeSesion(sesion, repo, `rama ${rama} borrada`);
  }

  /**
   * Trae otra rama a la abierta. Un conflicto **no se deja a medias**: se
   * aborta y se nombran los archivos. Un árbol con marcas de conflicto que
   * nadie está mirando es donde el próximo checkpoint de un agente las
   * commitea como si fueran código.
   */
  async fusionar(sesion: SesionCodigo, repo: Repositorio, nombre: string): Promise<{ ok: true; detalle: string } | { ok: false; conflictos: string[]; motivo: string }> {
    const g = this.g(sesion, repo);
    const rama = await this.validarNombreDeRama(nombre, g);
    const estado = await this.estado(sesion, repo);
    if (estado.preparados.length || estado.cambios.length) {
      return { ok: false, conflictos: [], motivo: "Hay cambios sin commitear: commitealos o guardalos en un stash antes de fusionar." };
    }
    const persona = await this.repos.identidadDePersona();
    const r = await git(
      ["-c", `user.name=${persona.nombre.replace(/[<>]/g, "")}`, "-c", `user.email=${persona.email.replace(/[<>\s]/g, "")}`, "merge", "--no-edit", rama],
      { ...g, tolerar: true },
    );
    if (!r.ok) {
      const conflictos = (await git(["diff", "--name-only", "--diff-filter=U"], { ...g, tolerar: true })).stdout.split("\n").filter(Boolean);
      await git(["merge", "--abort"], { ...g, tolerar: true });
      return {
        ok: false,
        conflictos,
        motivo: conflictos.length
          ? `${rama} choca con ${estado.rama ?? "la rama abierta"} en ${conflictos.length} archivo(s): ${conflictos.join(", ")}. No se fusionó nada; pedile a un agente que lo resuelva.`
          : explicarGit(r, `No se pudo fusionar ${rama}`),
      };
    }
    this.repos.avisarCambioDeSesion(sesion, repo, `fusión de ${rama}`);
    return { ok: true, detalle: /Already up to date/i.test(r.stdout) ? `${estado.rama} ya tenía todo lo de ${rama}.` : `${rama} se fusionó en ${estado.rama}.` };
  }
}

/** El error de git en una línea legible: lo último que dijo, sin las pistas en inglés. */
function explicarGit(r: ResultadoGit, prefijo: string): string {
  const util = (r.stderr || r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("hint:"))
    .slice(-3)
    .join(" ");
  if (/would be overwritten/i.test(util)) {
    return `${prefijo}: tenés cambios sin commitear que se pisarían. Commitealos o guardalos en un stash primero.`;
  }
  return `${prefijo}: ${util || `git terminó con código ${r.codigo}`}`;
}
