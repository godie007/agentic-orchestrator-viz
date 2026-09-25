import { execFile } from "node:child_process";

/**
 * Git, endurecido. Toda llamada del servidor a git pasa por acá.
 *
 * El servidor corre git sobre carpetas donde un agente escribe, y ese agente
 * corre `npm test` —código que él mismo puede editar—. Así que git no puede
 * confiar en nada que viva adentro del worktree:
 *
 * - **Sin hooks, sin fsmonitor, sin firma.** Un test que escribe
 *   `.git/hooks/pre-commit` convertiría el próximo checkpoint del servidor en
 *   ejecución de código fuera del sandbox. `core.hooksPath=/dev/null` lo apaga
 *   de raíz; `core.fsmonitor=false` hace lo mismo con el otro gancho que git
 *   ejecuta solo.
 * - **Identidad fija.** Sin `user.name` configurado en la máquina, `git commit`
 *   falla; con el de la persona, los checkpoints de un agente saldrían firmados
 *   por ella. El autor real de cada checkpoint va aparte, con `--author`.
 * - **Nunca pregunta.** `GIT_TERMINAL_PROMPT=0` y SSH en modo batch: un clon
 *   que pide contraseña deja el proceso esperando para siempre, que es la misma
 *   falla que un proveedor que no contesta — cuelga todo lo que viene detrás.
 * - **Con corte por tiempo**, como toda llamada que sale de una herramienta.
 *
 * Sin shell, siempre con argv: la ruta y la rama las elige, en última
 * instancia, un modelo.
 */

const CONFIG_SEGURA = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "user.name=Orquestador",
  "-c", "user.email=orq@localhost",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.file.allow=always",
  "-c", "advice.detachedHead=false",
  "-c", "init.defaultBranch=main",
  "-c", "core.autocrlf=false",
];

export interface ResultadoGit {
  ok: boolean;
  codigo: number;
  stdout: string;
  stderr: string;
}

export class ErrorGit extends Error {
  constructor(
    readonly args: string[],
    readonly resultado: ResultadoGit,
  ) {
    super(
      `git ${args.filter((a) => !a.startsWith("core.") && a !== "-c").slice(0, 4).join(" ")} ` +
        `falló (${resultado.codigo}): ${(resultado.stderr || resultado.stdout).trim().slice(0, 600)}`,
    );
  }
}

export interface OpcionesGit {
  /** Directorio desde el que se corre. Con `gitDir` explícito no hay descubrimiento. */
  cwd?: string;
  /** `--git-dir` explícito: nunca se descubre el repo desde el worktree. */
  gitDir?: string;
  workTree?: string;
  corteMs?: number;
  /** No tira si el código es distinto de 0: devuelve el resultado. */
  tolerar?: boolean;
  entrada?: string;
  maxBuffer?: number;
}

export function entornoGit(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: base["HOME"] ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    GIT_CONFIG_NOSYSTEM: "1",
    // Sin esto git lee `~/.gitconfig` y ahí puede haber un `core.hooksPath`
    // global o un filtro que ejecuta un programa: la config segura tiene que
    // ser toda la config.
    GIT_CONFIG_GLOBAL: "/dev/null",
    // `git status` refresca el índice y para eso toma `index.lock` "si
    // puede". El IDE lo pide cada tres segundos sobre el worktree, y más de
    // una vez coincidió con el checkpoint de un turno: el commit fallaba con
    // "index.lock: File exists" y el cambio del agente quedaba sin commitear
    // —y el turno siguiente lo firmaba como de la persona—. Las lecturas no
    // necesitan ese lock.
    GIT_OPTIONAL_LOCKS: "0",
    ...(base["SSH_AUTH_SOCK"] ? { SSH_AUTH_SOCK: base["SSH_AUTH_SOCK"] } : {}),
  };
}

/** Un lock del índice o de una ref que tiene otro git en este momento. */
const LOCK_OCUPADO = /Unable to create '.*\.lock': File exists/;

/**
 * Git con reintento cuando otro proceso tiene el lock: dos escrituras sobre el
 * mismo repo (el checkpoint de un turno y un guardado del IDE, un `add` de la
 * huella de un comando) se cruzan en milisegundos, y el lock se suelta solo.
 * Pocos intentos y cortos: un lock que no se suelta es un git colgado, y eso
 * sí tiene que verse como error.
 */
export async function git(args: string[], opciones: OpcionesGit = {}): Promise<ResultadoGit> {
  for (let intento = 0; ; intento++) {
    const resultado = await gitUnaVez(args, { ...opciones, tolerar: true });
    if (resultado.ok || intento >= 8 || !LOCK_OCUPADO.test(resultado.stderr)) {
      if (!resultado.ok && !opciones.tolerar) throw new ErrorGit(args, resultado);
      return resultado;
    }
    await new Promise((r) => setTimeout(r, 120 + intento * 80));
  }
}

function gitUnaVez(args: string[], opciones: OpcionesGit = {}): Promise<ResultadoGit> {
  const completos = [
    ...CONFIG_SEGURA,
    ...(opciones.gitDir ? [`--git-dir=${opciones.gitDir}`] : []),
    ...(opciones.workTree ? [`--work-tree=${opciones.workTree}`] : []),
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const hijo = execFile(
      "git",
      completos,
      {
        // Con `--work-tree` y sin cwd, varios comandos (grep --untracked,
        // ls-files -o) trabajan sobre el cwd del servidor: la raíz del
        // orquestador. El default es el propio worktree.
        cwd: opciones.cwd ?? opciones.workTree,
        env: entornoGit(),
        timeout: opciones.corteMs ?? 60_000,
        killSignal: "SIGKILL",
        maxBuffer: opciones.maxBuffer ?? 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const codigo =
          error == null ? 0 : typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : 1;
        const resultado: ResultadoGit = { ok: codigo === 0, codigo, stdout, stderr };
        if ((error as { killed?: boolean } | null)?.killed) {
          resultado.stderr = `Se cortó por tiempo (${Math.round((opciones.corteMs ?? 60_000) / 1000)} s). ${stderr}`;
        }
        if (!resultado.ok && !opciones.tolerar) reject(new ErrorGit(args, resultado));
        else resolve(resultado);
      },
    );
    if (opciones.entrada != null) {
      hijo.stdin?.end(opciones.entrada);
    }
  });
}

/**
 * Una URL de git que se puede clonar sin sorpresas.
 *
 * Rechaza credenciales embebidas —`https://usuario:token@…`— por la misma regla
 * que los secretos de MCP: la URL se guarda en la base y viaja en el blueprint,
 * y una credencial ahí adentro se exporta con la empresa. También rechaza lo
 * que no es un transporte de red (`ext::`, `file://`, una ruta suelta): para
 * una carpeta de esta máquina está el origen local, que no pasa por acá.
 */
export function validarUrlGit(url: string): { ok: true } | { ok: false; motivo: string } {
  const limpia = url.trim();
  if (limpia.startsWith("-")) return { ok: false, motivo: "Una URL no puede empezar con un guion." };
  if (/^[a-z]+::/i.test(limpia)) {
    return { ok: false, motivo: "Transporte no permitido: sólo https, ssh o git@host:repo." };
  }
  const scp = /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(limpia);
  let parseada: URL | null = null;
  try {
    parseada = new URL(limpia);
  } catch {
    parseada = null;
  }
  if (!scp && !parseada) return { ok: false, motivo: "No parece una URL de git." };
  if (parseada) {
    if (!["https:", "http:", "ssh:", "git:"].includes(parseada.protocol)) {
      return { ok: false, motivo: `Protocolo no permitido: ${parseada.protocol}` };
    }
    if (parseada.password || (parseada.username && parseada.protocol.startsWith("http"))) {
      return {
        ok: false,
        motivo:
          "La URL trae credenciales adentro. No se guardan: una URL viaja en la base y en el " +
          "blueprint exportado. Configurá el acceso con el helper de credenciales de git o una " +
          "clave SSH, y pegá la URL sin usuario ni token.",
      };
    }
  }
  return { ok: true };
}
