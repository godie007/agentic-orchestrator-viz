import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { argvATexto, slugTecnico, type Repositorio, type Role, type SesionCodigo } from "@orq/shared";
import type { EspacioDeTurno } from "@orq/engine";
import {
  HERRAMIENTAS_QUE_ESCRIBEN_CODIGO,
  ejecutarComando,
  hayAislamiento,
  type CodigoStorage,
  type EspacioDeCodigo,
  type ResultadoComando,
  type ServicioParaAgente,
  type ToolContext,
} from "@orq/tools";
import type { Store } from "./db.js";
import type { Directorios } from "./directorios.js";
import { git } from "./git.js";
import { carpetasDePrimerNivel, type RepoStore } from "./repos.js";
import type { ServiciosVivos } from "./servicios.js";

/**
 * El lado servidor de las herramientas de código: dónde vive cada repo, quién
 * puede escribir en este turno y cómo se corre un comando.
 */

/** Las herramientas de código, por nombre. Otorgar alguna es "este rol programa". */
export const HERRAMIENTAS_DE_CODIGO = new Set([
  "crear_repositorio",
  "instalar_dependencia",
  "listar_repositorios",
  "mapa_del_codigo",
  "buscar_codigo",
  "buscar_archivos",
  "leer_codigo",
  "editar_codigo",
  "escribir_codigo",
  "aplicar_parche",
  "estado_git",
  "revertir_codigo",
  "ejecutar_comando",
  "solicitar_comando",
  "servicios",
  "probar_servicio",
]);

/** Pasado esto, un arriendo se considera abandonado: un turno no dura tanto. */
const ARRIENDO_MAXIMO_MS = 45 * 60_000;

/**
 * Quién escribe en cada repo, ahora.
 *
 * Uno por repo y por turno. Vive en memoria a propósito: un arriendo es de un
 * turno vivo, y un reinicio del servidor mata los turnos —no hay nada que
 * recordar—. El vencimiento cubre el caso de un turno que murió sin pasar por
 * su `finally`, que no debería ocurrir pero no puede dejar un repo bloqueado
 * para siempre.
 */
export class ArriendosDeCodigo {
  private readonly titulares = new Map<string, { runId: string; roleId: string; nombre: string; desde: number }>();

  tomar(repoId: string, runId: string, roleId: string, nombre: string): boolean {
    const actual = this.titulares.get(repoId);
    const vencido = actual && Date.now() - actual.desde > ARRIENDO_MAXIMO_MS;
    if (actual && !vencido && !(actual.runId === runId && actual.roleId === roleId)) return false;
    this.titulares.set(repoId, { runId, roleId, nombre, desde: Date.now() });
    return true;
  }

  tiene(repoId: string, runId: string, roleId: string): boolean {
    const actual = this.titulares.get(repoId);
    return actual != null && actual.runId === runId && actual.roleId === roleId;
  }

  titular(repoId: string): string | null {
    return this.titulares.get(repoId)?.nombre ?? null;
  }

  soltar(repoId: string, runId: string, roleId: string): void {
    if (this.tiene(repoId, runId, roleId)) this.titulares.delete(repoId);
  }
}

export interface DepsCodigo {
  store: Store;
  repos: RepoStore;
  directorios: Directorios;
  arriendos: ArriendosDeCodigo;
  /** Los servicios levantados para la vista previa: los agentes los ven y los prueban, no los arrancan. */
  servicios: ServiciosVivos;
  companyId: string;
  /** Para anunciar checkpoints en la traza de la corrida. */
  emitirCheckpoint?: (
    runId: string,
    evento: { roleId: string; repoId: string; rama: string; sha: string; mensaje: string; archivos: number; antes?: string; commit?: boolean },
  ) => void;
}

/**
 * El último resultado de cada comando por repo, con la huella del árbol sobre
 * el que corrió. Medido en una corrida de cuatro agentes: 24 `npm test`, casi
 * todos sobre el mismo código —el tech lead, QA y el CTO verificando lo mismo
 * uno detrás del otro—. Con una suite de minutos, eso es media hora de reloj
 * que no aporta nada: el mismo árbol da el mismo resultado.
 */
const ultimosResultados = new Map<string, { huella: string; resultado: ResultadoComando; at: number }>();
const VIGENCIA_RESULTADO_MS = 30 * 60_000;

/**
 * Qué hay en el árbol ahora: HEAD más todo lo que cambió encima, incluidos los
 * archivos nuevos (por eso el `--intent-to-add`: sin él, `git diff` no ve un
 * archivo que un agente acaba de crear, y editarlo no cambiaría la huella).
 */
async function huellaDelArbol(
  correrGit: (args: string[]) => Promise<{ stdout: string }>,
): Promise<string> {
  await correrGit(["add", "-A", "--intent-to-add"]);
  const cabeza = (await correrGit(["rev-parse", "HEAD"])).stdout.trim();
  const cambios = (await correrGit(["diff", "--binary", "--no-color", "HEAD"])).stdout;
  return createHash("sha1").update(cabeza).update("\0").update(cambios).digest("hex");
}

/** Un comando a la vez por repo: dos `npm test` comparten puertos y `dist/`. */
const colas = new Map<string, Promise<unknown>>();
function enFila<T>(clave: string, trabajo: () => Promise<T>): Promise<T> {
  const previa = colas.get(clave) ?? Promise.resolve();
  const siguiente = previa.catch(() => {}).then(trabajo);
  colas.set(clave, siguiente);
  return siguiente;
}

function elegirRepo(repos: Repositorio[], pedido: string | undefined): Repositorio | { error: string } {
  if (repos.length === 0) return { error: "El proyecto no tiene repos cargados. Los carga una persona desde la pestaña Código." };
  if (!pedido) {
    if (repos.length === 1) return repos[0]!;
    return { error: `Hay ${repos.length} repos: indicá cuál con 'repo' (${repos.map((r) => r.nombre).join(", ")}).` };
  }
  const clave = pedido.trim().toLowerCase();
  const encontrado = repos.find(
    (r) => r.id === pedido || r.nombre.toLowerCase() === clave || r.slug === slugTecnico(pedido),
  );
  return encontrado ?? { error: `No hay un repo "${pedido}". Están: ${repos.map((r) => r.nombre).join(", ")}.` };
}

/** Los servicios de un repo como los ve un agente. */
export function serviciosParaAgente(deps: Pick<DepsCodigo, "servicios">, repo: Repositorio): ServicioParaAgente[] {
  return repo.servicios.map((s) => {
    const vista = deps.servicios.vista(repo.id, s.id);
    return {
      id: s.id,
      nombre: s.nombre,
      tipo: s.tipo,
      carpeta: s.carpeta,
      estado: vista.estado,
      url: vista.url,
      detalle: vista.detalle,
    };
  });
}

export function crearCodigoStorage(deps: DepsCodigo): CodigoStorage {
  const { store, repos, directorios, arriendos, companyId } = deps;
  const repoDeEmpresa = (repoId: string): Repositorio | null => {
    const repo = store.getRepositorio(repoId);
    return repo && repo.companyId === companyId ? repo : null;
  };

  const buscarSesion = (repoId: string): { repo: Repositorio; sesion: SesionCodigo } | null => {
    const repo = store.getRepositorio(repoId);
    const sesion = repo ? repos.sesionAbierta(repo.id, companyId) : null;
    return repo && sesion ? { repo, sesion } : null;
  };

  const aEspacio = async (repo: Repositorio, sesion: SesionCodigo): Promise<EspacioDeCodigo> => ({
    repoId: repo.id,
    nombre: repo.nombre,
    dir: await realpath(repos.rutaWorktree(sesion)),
    rama: sesion.rama,
    baseSha: sesion.baseSha,
    ramaBase: repo.ramaBase,
    comandos: repo.comandos,
    pendienteDeConfirmar: repo.pendienteDeConfirmar,
  });

  return {
    async listar() {
      return Promise.all(
        store.listRepositorios(companyId).map(async (repo) => {
          const sesion = repos.sesionAbierta(repo.id, companyId);
          let commits: number | null = null;
          if (sesion) {
            try {
              commits = (await repos.log(sesion, repo)).length;
            } catch {
              commits = null;
            }
          }
          return {
            id: repo.id,
            nombre: repo.nombre,
            ramaBase: repo.ramaBase,
            comandos: repo.comandos,
            pendienteDeConfirmar: repo.pendienteDeConfirmar,
            sesion: sesion ? { rama: sesion.rama, commits } : null,
            servicios: serviciosParaAgente(deps, repo),
          };
        }),
      );
    },

    async espacio(pedido, ctx: ToolContext) {
      const elegido = elegirRepo(store.listRepositorios(companyId), pedido);
      if ("error" in elegido) return { ok: false, motivo: elegido.error };
      try {
        const sesion = await repos.abrirSesion(elegido, ctx.runId);
        return { ok: true, espacio: await aEspacio(elegido, sesion) };
      } catch (error) {
        return { ok: false, motivo: `No se pudo abrir la sesión de ${elegido.nombre}: ${error instanceof Error ? error.message : String(error)}` };
      }
    },

    puedeEscribir(repoId, ctx) {
      if (arriendos.tiene(repoId, ctx.runId, ctx.actor.id)) return { ok: true };
      const titular = arriendos.titular(repoId);
      return {
        ok: false,
        motivo: titular
          ? `En este turno escribe ${titular} y vos estás en sólo lectura: dos agentes editando el mismo árbol se pisan. Leé, revisá y dejale lo que encontraste por mensaje; en el ciclo siguiente te toca.`
          : "Este turno no tiene el arriendo de escritura del repo. Si tu rol tiene que editar, pedí que te otorguen editar_codigo.",
      };
    },

    async git(espacio, args, opciones = {}) {
      const encontrada = buscarSesion(espacio.repoId);
      if (!encontrada) return { ok: false, codigo: 1, stdout: "", stderr: "La sesión del repo ya no está abierta." };
      return git(args, {
        cwd: espacio.dir,
        gitDir: repos.gitDirDe(encontrada.sesion, encontrada.repo),
        workTree: espacio.dir,
        tolerar: true,
        ...(opciones.entrada != null ? { entrada: opciones.entrada } : {}),
      });
    },

    async ejecutar(espacio, argv, opciones) {
      const encontrada = buscarSesion(espacio.repoId);
      if (!encontrada) {
        return { codigo: null, salida: "", duracionMs: 0, cortadoPorTiempo: false, aislamiento: "sin-aislamiento", log: null, error: "La sesión del repo ya no está abierta." };
      }
      const { repo } = encontrada;
      const conSandbox = !repo.comandos.sinAislamiento;
      if (conSandbox && !hayAislamiento()) {
        return {
          codigo: null,
          salida: "",
          duracionMs: 0,
          cortadoPorTiempo: false,
          aislamiento: "sin-aislamiento",
          log: null,
          error:
            "En esta máquina no hay sandbox-exec, y correr sin aislamiento lo tiene que habilitar una persona para este repo (pestaña Código). Avisale con send_message.",
        };
      }
      const tmp = directorios.sub(companyId, "tmp", true);
      const clon = repos.rutaClon(repo);
      const gitDelEspacio = (args: string[]) =>
        git(args, {
          cwd: espacio.dir,
          gitDir: repos.gitDirDe(encontrada.sesion, repo),
          workTree: espacio.dir,
          tolerar: true,
        });
      const cwd = opciones.carpeta ? join(espacio.dir, opciones.carpeta) : espacio.dir;
      const clave = `${repo.id}\u0000${opciones.carpeta ?? ""}\u0000${argv.join("\u0000")}`;
      const log = join(tmp, "logs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugTecnico(argv.slice(0, 2).join("-"))}.log`);
      return enFila(repo.id, async () => {
        // Dentro de la fila: la huella se toma cuando ya no corre nada más
        // sobre el árbol, y el resultado reutilizado es el de este árbol.
        const huella = await huellaDelArbol(gitDelEspacio).catch(() => null);
        const previo = ultimosResultados.get(clave);
        if (
          !opciones.repetir &&
          huella &&
          previo &&
          previo.huella === huella &&
          Date.now() - previo.at < VIGENCIA_RESULTADO_MS
        ) {
          return { ...previo.resultado, reutilizadoHaceMs: Date.now() - previo.at };
        }
        const resultado = await ejecutarComando({
          argv,
          cwd,
          tmpDir: join(tmp, "run"),
          logPath: log,
          corteMs: opciones.corteMs,
          ...(opciones.signal ? { signal: opciones.signal } : {}),
          aislamiento: conSandbox
            ? {
                tipo: "sandbox",
                escribibles: [espacio.dir, tmp],
                // El .git del clon —y el archivo `.git` del worktree, que apunta
                // a él— quedan afuera: un test que escribe un hook ahí convierte
                // el próximo checkpoint en código corriendo fuera del sandbox.
                noEscribibles: [join(clon, ".git"), join(espacio.dir, ".git")],
              }
            : { tipo: "ninguno" },
        });
        // Sólo se recuerda lo que terminó: un corte por tiempo o un error al
        // lanzar no son "el resultado de este árbol".
        if (huella && !resultado.error && !resultado.cortadoPorTiempo) {
          ultimosResultados.set(clave, { huella, resultado, at: Date.now() });
        }
        return resultado;
      });
    },

    async crear(nombre, descripcion, ctx) {
      // Crear un programa nuevo es una decisión de quien coordina: un ejecutor
      // que crea repos por su cuenta termina con el trabajo repartido en tres.
      if (ctx.actor.authority === "executor") {
        return {
          ok: false,
          motivo: "Crear un repo lo decide quien coordina el trabajo. Pedíselo a tu responsable con send_message.",
        };
      }
      try {
        const repo = await repos.crearVacio(companyId, nombre, descripcion);
        return { ok: true, repo: { id: repo.id, nombre: repo.nombre } };
      } catch (error) {
        return { ok: false, motivo: error instanceof Error ? error.message : String(error) };
      }
    },

    async servicios(repoId) {
      const repo = repoDeEmpresa(repoId);
      return repo ? serviciosParaAgente(deps, repo) : [];
    },

    async logsDeServicio(repoId, servicioId, lineas) {
      const repo = repoDeEmpresa(repoId);
      const servicio = repo?.servicios.find((s) => s.id === servicioId);
      if (!repo || !servicio) {
        return { ok: false, motivo: `No hay un servicio "${servicioId}". Están: ${repo?.servicios.map((s) => s.id).join(", ") || "ninguno"}.` };
      }
      const texto = deps.servicios.ultimas(repo.id, servicio.id, lineas);
      if (texto == null) return { ok: false, motivo: `${servicio.nombre} no se levantó todavía: no tiene salida. Lo levanta una persona desde la pestaña Código.` };
      const vista = deps.servicios.vista(repo.id, servicio.id);
      return { ok: true, texto: `${servicio.nombre}: ${vista.estado}${vista.url ? ` en ${vista.url}` : ""}${vista.detalle ? ` — ${vista.detalle}` : ""}\n\n${texto}` };
    },

    async probarServicio(repoId, servicioId, pedido) {
      const repo = repoDeEmpresa(repoId);
      if (!repo?.servicios.some((s) => s.id === servicioId)) {
        return { ok: false, motivo: `No hay un servicio "${servicioId}". Están: ${repo?.servicios.map((s) => s.id).join(", ") || "ninguno"}.` };
      }
      try {
        return { ok: true, respuesta: await deps.servicios.probar(repoId, servicioId, pedido) };
      } catch (error) {
        return { ok: false, motivo: error instanceof Error ? error.message : String(error) };
      }
    },

    async consumirUnaVez(repoId, argv) {
      const repo = store.getRepositorio(repoId);
      if (!repo) return;
      const clave = argv.join("\u0000");
      const restantes = repo.comandos.unaVez.filter((exacto) => exacto.join("\u0000") !== clave);
      if (restantes.length !== repo.comandos.unaVez.length) {
        repos.actualizarComandos(repo, { unaVez: restantes });
      }
    },
  };
}

/**
 * Abre el espacio de código de un turno, si el rol trabaja sobre código.
 *
 * "Trabaja sobre código" = tiene otorgada alguna herramienta de código. Con
 * alguna que escribe, pide el arriendo; si lo tiene otro, el turno va en sólo
 * lectura y el resumen lo dice —así no intenta editar para chocar contra la
 * negativa—.
 */
export async function abrirTurnoDeCodigo(
  deps: DepsCodigo,
  role: Role,
  runId: string,
  opciones: {
    /**
     * El repo sobre el que trabaja el turno: su worktree es el directorio del
     * CLI. En una corrida enfocada es el que eligió la persona; si no, el
     * primero que se cargó.
     */
    repoPrincipalId?: string;
  } = {},
): Promise<EspacioDeTurno | null> {
  const { store, repos, arriendos, companyId } = deps;
  const lista = store.listRepositorios(companyId).sort((a, b) => a.createdAt - b.createdAt);

  const otorgadas = new Set(
    store
      .listTools(companyId)
      .filter((tool) => role.toolIds.includes(tool.id))
      .map((tool) => tool.name),
  );
  if (![...otorgadas].some((nombre) => HERRAMIENTAS_DE_CODIGO.has(nombre))) return null;

  // Sin repos, el turno igual se entera de dónde va el código. Lo medimos: un
  // equipo entero, sin esta línea, escribió un simulador en la salida archivo
  // por archivo, y llamó a listar_repositorios 36 veces esperando que apareciera.
  if (lista.length === 0) {
    const puedeCrear = otorgadas.has("crear_repositorio") && role.authority !== "executor";
    return {
      dir: null,
      escritura: false,
      resumen: [
        "## Código del proyecto",
        "Todavía no hay ningún repo.",
        puedeCrear
          ? "Si el encargo pide construir software, lo primero es crear el repo con crear_repositorio(nombre) y escribir ahí con escribir_codigo repo=<nombre>. El código NO va a la salida (write_output_file): ahí no se puede testear, integrar ni ver correr."
          : "Si el encargo pide construir software, pedile a quien coordina que cree el repo con crear_repositorio. No escribas código en la salida (write_output_file).",
      ].join("\n"),
      async cerrar() {},
    };
  }
  const escribe = [...otorgadas].some((nombre) => HERRAMIENTAS_QUE_ESCRIBEN_CODIGO.has(nombre));

  const principal = lista.find((repo) => repo.id === opciones.repoPrincipalId) ?? lista[0]!;
  const sesion = await repos.abrirSesion(principal, runId);
  const dir = await realpath(repos.rutaWorktree(sesion));

  const conArriendo = new Set<string>();
  if (escribe) {
    for (const repo of lista) {
      if (arriendos.tomar(repo.id, runId, role.id, role.name)) conArriendo.add(repo.id);
    }
  }
  // Lo que quedó sin commitear antes de este turno lo editó una persona desde
  // el IDE (los turnos de agente cierran siempre con checkpoint). Se commitea
  // a su nombre **antes** de que el agente toque nada: si no, el checkpoint del
  // turno se llevaba su trabajo firmado por el agente.
  // Sin commits automáticos no se commitea nada de nadie: lo de la persona y
  // lo del agente quedan juntos sin commitear, y ella decide. Lo que hizo el
  // turno se sigue pudiendo ver y deshacer por las instantáneas.
  const instantaneasAntes = new Map<string, string>();
  for (const repoId of conArriendo) {
    const repo = store.getRepositorio(repoId);
    const abierta = repo ? repos.sesionAbierta(repoId, companyId) : null;
    if (repo && abierta && !repo.commitsAutomaticos) {
      instantaneasAntes.set(repoId, await repos.instantanea(abierta, repo, `${runId}-antes`));
    }
  }
  for (const repoId of conArriendo) {
    const repo = store.getRepositorio(repoId);
    const abierta = repo ? repos.sesionAbierta(repoId, companyId) : null;
    if (repo?.commitsAutomaticos && abierta && (await repos.tieneCambiosPendientes(abierta, repo))) {
      const persona = await repos.identidadDePersona();
      await repos.checkpoint(
        abierta,
        repo,
        { nombre: persona.nombre, id: "persona", email: persona.email },
        `Cambios hechos desde el IDE, commiteados antes del turno de ${role.name}.`,
      );
    }
  }
  const escritura = conArriendo.has(principal.id);

  const bloques: string[] = ["## Código del proyecto"];
  for (const repo of lista) {
    const abierta = repo.id === principal.id ? sesion : repos.sesionAbierta(repo.id, companyId);
    const comandos = repo.comandos;
    const carpetas = repo.id === principal.id ? (await carpetasDePrimerNivel(dir)).slice(0, 25) : [];
    bloques.push(
      [
        `**${repo.nombre}**${lista.length > 1 ? ` (repo="${repo.nombre}")` : ""} — ${
          abierta ? `sesión en la rama ${abierta.rama}` : "sesión nueva al primer uso"
        }, base ${repo.ramaBase}.`,
        `Tests: ${comandos.test ? `\`${argvATexto(comandos.test)}\`` : "sin definir"} · Verificar: ${
          comandos.verificar ? `\`${argvATexto(comandos.verificar)}\`` : "sin definir"
        } · Permitidos: ${comandos.permitidos.length ? comandos.permitidos.map((c) => `\`${argvATexto(c)}\``).join(", ") : "ninguno (pedilos con solicitar_comando)"}.`,
        ...(carpetas.length ? [`Raíz: ${carpetas.join("  ")}`] : []),
        ...lineasDeServicios(deps, repo),
        escribe
          ? conArriendo.has(repo.id)
            ? "Escritura: **tenés el arriendo en este turno.**"
            : `Escritura: **sólo lectura este turno** — escribe ${arriendos.titular(repo.id) ?? "otro rol"}. Revisá, medí y dejale lo que encontraste; editás en el ciclo siguiente.`
          : "Escritura: tu rol no edita código; leé, corré lo permitido y reportá.",
      ].join("\n"),
    );
  }
  bloques.push(...(await bloqueDeBaseDeDatos(deps, role, dir)));
  bloques.push(
    [
      "Cómo se trabaja acá:",
      "- Orientate con mapa_del_codigo y buscar_codigo antes de leer archivos enteros; leé con leer_codigo por ventanas.",
      "- Editá con editar_codigo (reemplazo exacto y único) y verificá corriendo los tests con ejecutar_comando. Un exit distinto de 0 es un resultado: leelo y corregí.",
      "- No declares algo terminado sin haber corrido los tests o la verificación y leído su salida. Contá en tu resumen qué corriste y qué dio.",
      "- ¿Falta una librería? Pedila con instalar_dependencia (la aprueba una persona y se instala sola). No la bajes con curl ni la copies a mano: no hay red para eso.",
      lista.some((r) => r.commitsAutomaticos)
        ? "- Al cerrar el turno se hace solo un checkpoint (un commit con tu nombre). Integrar a la rama de la persona lo decide ella."
        : "- Tus cambios quedan SIN commitear: la persona los revisa, los prepara, escribe el mensaje y hace el commit y la publicación. No intentes commitear ni publicar vos. En tu resumen contá qué archivos cambiaste y por qué, que es lo que ella va a leer para decidir.",
    ].join("\n"),
  );

  return {
    dir,
    escritura,
    resumen: bloques.join("\n\n"),
    async cerrar(resumenDelTurno) {
      try {
        for (const repoId of conArriendo) {
          const repo = store.getRepositorio(repoId);
          const abierta = repo ? repos.sesionAbierta(repoId, companyId) : null;
          if (!repo || !abierta) continue;
          const mensaje = (resumenDelTurno?.trim() || `Turno de ${role.name}`).slice(0, 4000);
          const antes = instantaneasAntes.get(repoId);
          if (!repo.commitsAutomaticos && antes) {
            // Sin commit: la instantánea del final. Si el árbol no cambió, no
            // hay nada que anunciar.
            const despues = await repos.instantanea(abierta, repo, `${runId}-despues`);
            const cambios = await repos.cambiosEntre(abierta, repo, antes, despues);
            if (cambios.length && deps.emitirCheckpoint) {
              deps.emitirCheckpoint(runId, {
                roleId: role.id,
                repoId,
                rama: abierta.rama,
                sha: despues,
                antes,
                commit: false,
                mensaje: mensaje.replace(/\s+/g, " ").slice(0, 200),
                archivos: cambios.length,
              });
            }
            continue;
          }
          const sha = await repos.checkpoint(abierta, repo, { nombre: role.name, id: role.id }, mensaje);
          if (sha && deps.emitirCheckpoint) {
            const tocados = await git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
              cwd: repos.rutaClon(repo),
              tolerar: true,
            });
            deps.emitirCheckpoint(runId, {
              roleId: role.id,
              repoId,
              rama: abierta.rama,
              sha,
              mensaje: mensaje.replace(/\s+/g, " ").slice(0, 200),
              archivos: tocados.stdout.split("\n").filter(Boolean).length,
            });
          }
        }
      } finally {
        for (const repoId of conArriendo) arriendos.soltar(repoId, runId, role.id);
      }
    },
  };
}

/**
 * Los servicios en el prompt: qué parte del monorepo es qué, dónde está la
 * documentación y qué está levantado. Es lo primero que una persona le diría a
 * alguien nuevo en el equipo, y sin eso un agente trata `backend/` y
 * `frontend/` como carpetas cualquiera y corre `npm test` en la raíz.
 */
function lineasDeServicios(deps: DepsCodigo, repo: Repositorio): string[] {
  if (repo.servicios.length === 0) return [];
  const lineas = serviciosParaAgente(deps, repo).map((s) => {
    const donde = `\`${s.carpeta || "."}/\``;
    if (s.tipo === "docs") return `- ${s.nombre} ${donde}: documentación (notas de Obsidian, enlaces [[…]]). Leé la nota que corresponda antes de cambiar una regla de negocio.`;
    const tipo = { web: "frontend web", api: "API", movil: "app móvil", otro: "servicio" }[s.tipo];
    const estado = s.estado === "listo" && s.url ? `levantado en ${s.url} — se recarga solo con cada edición` : s.estado === "fallo" ? "falló al arrancar (mirá servicios accion=logs)" : "no levantado";
    return `- ${s.nombre} ${donde}: ${tipo}, ${estado}.`;
  });
  return [
    "Es un monorepo. Cada parte tiene su package.json: corré sus tests con ejecutar_comando carpeta=\"<carpeta>\" y pedí sus dependencias con instalar_dependencia carpeta=\"<carpeta>\".",
    ...lineas,
    "Con un servicio levantado, después de editar mirá sus logs (servicios accion=logs) para ver si compiló, y probá la API con probar_servicio.",
  ];
}

/** Dónde guarda las migraciones un repo, por convención. La primera que exista. */
const CARPETAS_DE_MIGRACIONES = ["supabase/migrations", "backend/migrations", "db/migrations", "migrations", "backend/supabase/migrations", "prisma/migrations"];

/**
 * Si el rol tiene herramientas de un MCP de base de datos (Supabase, Postgres),
 * cómo se trabaja con él. Un cambio de esquema tiene dos mitades que no pueden
 * separarse —el archivo versionado en el repo y su aplicación en la base— y
 * sin decirlo un agente hace una sola: aplica SQL en vivo que nadie puede
 * reproducir, o escribe el archivo y nunca lo aplica.
 */
async function bloqueDeBaseDeDatos(deps: DepsCodigo, role: Role, dir: string): Promise<string[]> {
  const herramientas = deps.store.listTools(deps.companyId).filter((t) => role.toolIds.includes(t.id) && t.mcpServerId);
  const servidores = deps.store
    .listMcpServers(deps.companyId)
    .filter((s) => herramientas.some((t) => t.mcpServerId === s.id))
    .filter((s) => /supabase|postgres|database|base de datos|\bdb\b|sql/i.test(`${s.name} ${s.description}`));
  if (!servidores.length) return [];
  const carpeta = CARPETAS_DE_MIGRACIONES.find((c) => existsSync(join(dir, c)));
  const conAprobacion = herramientas.filter((t) => servidores.some((s) => s.id === t.mcpServerId) && t.requiresApproval).map((t) => t.name.split("__").at(-1));
  return [
    [
      "## Base de datos",
      ...servidores.map((s) => `- MCP \`${s.name}\`${s.description ? `: ${s.description}` : ""} (herramientas \`mcp__${s.name}__…\`).`),
      "- Antes de cambiar el esquema, mirá cómo está: list_tables (con los esquemas) y list_migrations. No asumas columnas.",
      `- Un cambio de esquema es una migración **versionada en el repo y aplicada en la base, las dos cosas**: escribí el SQL como archivo${
        carpeta ? ` en \`${carpeta}/\` siguiendo el estilo de las que ya hay` : " (buscá dónde guarda las migraciones el repo)"
      }, idempotente (IF NOT EXISTS), y aplicá **ese mismo SQL** con apply_migration.`,
      conAprobacion.length
        ? `- ${conAprobacion.join(", ")} piden aprobación de una persona: llamala una vez con el SQL completo y terminá el turno. Cuando la aprueben se ejecuta sola, con esos argumentos, y te llega el resultado a la bandeja: no la vuelvas a llamar.`
        : "",
      "- Nunca borres datos, tablas ni columnas si el pedido no lo dice explícitamente. Una migración que borra se describe en tu resumen, en mayúsculas.",
      "- Después de migrar: get_advisors (security) para ver que no quedó una tabla sin RLS, y si el código usa tipos generados, generate_typescript_types.",
    ]
      .filter(Boolean)
      .join("\n"),
  ];
}

/** El espacio de un repo para lo que hace una persona desde el IDE (la terminal). */
export async function espacioDePersona(deps: DepsCodigo, repo: Repositorio): Promise<EspacioDeCodigo> {
  const sesion = await deps.repos.abrirSesion(repo, null);
  return {
    repoId: repo.id,
    nombre: repo.nombre,
    dir: await realpath(deps.repos.rutaWorktree(sesion)),
    rama: sesion.rama,
    baseSha: sesion.baseSha,
    ramaBase: repo.ramaBase,
    comandos: repo.comandos,
    pendienteDeConfirmar: repo.pendienteDeConfirmar,
  };
}
