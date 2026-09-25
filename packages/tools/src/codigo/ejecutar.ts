import { spawn } from "node:child_process";
import { createWriteStream, existsSync, realpathSync, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ResultadoComando } from "./tipos.js";

/**
 * Correr un comando que eligió un agente, en la máquina de una persona.
 *
 * La allowlist decide *qué* se corre; esto decide *cómo*, y es donde está la
 * contención de verdad, porque permitir `npm test` es permitir los tests que el
 * agente acaba de escribir:
 *
 * - **Sin shell**, argv tal cual. Un `;` es un argumento, no un segundo comando.
 * - **`sandbox-exec`** (macOS): se escribe sólo en el worktree, en el tmp del
 *   proyecto y en los cachés de paquetes; nada en el `.git` del clon; y no se
 *   leen `~/.ssh`, `~/.aws` ni las credenciales de `gh`. Donde no hay sandbox,
 *   el repo tiene que tener `sinAislamiento` prendido por una persona.
 * - **Entorno limpio**: sin API keys ni tokens. El servidor tiene cargadas las
 *   credenciales de todos los proveedores y un test no tiene por qué verlas.
 * - **`CI=1`**: sin eso vitest y jest arrancan en modo watch y el comando no
 *   termina nunca —la falla de "un proveedor que no contesta", en chico—.
 * - **Grupo de procesos entero** al cortar: `npm test` lanza node, que lanza
 *   workers; matar sólo al primero deja a los nietos corriendo.
 * - **Salida acotada**: cabeza corta y cola larga, porque el error de un test
 *   se imprime al final. El log completo queda en disco.
 */

const CABEZA = 2_000;
const COLA = 10_000;

/** Lo que no puede llegar a un comando: credenciales y configuración del orquestador. */
const SECRETO = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const DEL_ORQUESTADOR = /^(ORQ_|ANTHROPIC|OPENAI|OPENROUTER|NVIDIA|GEMINI|GOOGLE_|AWS_|AZURE_|N8N_|DATABASE_URL|CLAUDE_CODE)/i;

export function entornoDeComando(base: NodeJS.ProcessEnv, tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [clave, valor] of Object.entries(base)) {
    if (valor == null) continue;
    if (SECRETO.test(clave) || DEL_ORQUESTADOR.test(clave)) continue;
    env[clave] = valor;
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    // Que npm no pregunte nada: una pregunta deja el proceso esperando.
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
}

/**
 * El entorno de un servicio levantado para la vista previa (`npm run dev`).
 *
 * Parte del mismo saneo que un comando —las credenciales del orquestador no
 * le llegan a nadie— con tres diferencias. **Sin `CI=1`**: en Expo apaga la
 * recarga ("Metro is running in CI mode, reloads are disabled"), y una vista
 * previa que no se entera de lo que editó un agente muestra lo de antes.
 * **`BROWSER=none`**: `expo start --web` abre una pestaña por su cuenta en el
 * Chrome de la persona cada vez que arranca. Y encima van las variables del
 * `.env` **del propio servicio** (`propias`): ésas sí son suyas —el backend
 * necesita su clave de Supabase para arrancar—, y las pone quien lo arranca.
 */
export function entornoDeServicio(
  base: NodeJS.ProcessEnv,
  tmpDir: string,
  propias: Record<string, string>,
): NodeJS.ProcessEnv {
  const { CI: _ci, ...resto } = entornoDeComando(base, tmpDir);
  return {
    ...resto,
    BROWSER: "none",
    EXPO_NO_TELEMETRY: "1",
    EXPO_NO_REDIRECT_PAGE: "1",
    ...propias,
  };
}

export function hayAislamiento(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

function real(ruta: string): string {
  try {
    return realpathSync(ruta);
  } catch {
    return ruta;
  }
}

const esc = (ruta: string) => JSON.stringify(ruta);

/**
 * El perfil de `sandbox-exec`. En SBPL **gana la última regla que aplica**, por
 * eso los permisos van primero y las negaciones puntuales al final.
 */
export function perfilSandbox(opciones: {
  escribibles: string[];
  noEscribibles: string[];
  hogar?: string;
}): string {
  const hogar = real(opciones.hogar ?? homedir());
  const cachés = [
    ".npm", ".cache", ".yarn", ".expo", ".pnpm-store", "Library/pnpm", "Library/Caches", ".bun",
    ".cargo/registry", ".cargo/git", "go/pkg/mod", ".gradle", ".m2/repository", ".nuget/packages",
  ].map((rel) => join(hogar, rel));
  // El temporal del usuario (el de `os.tmpdir()`, no todo `/var/folders`):
  // compiladores y cachés de herramientas escriben ahí aunque TMPDIR diga otra
  // cosa, y negarlo hace fallar builds por motivos que nadie entiende.
  const escribir = [...opciones.escribibles.map(real), ...cachés, "/private/tmp", real(tmpdir())];
  const secretos = [".ssh", ".aws", ".config/gh", ".gnupg", ".docker", ".kube", ".config/gcloud", ".azure"].map(
    (rel) => join(hogar, rel),
  );
  const archivosSecretos = [".netrc", ".npmrc", ".pypirc", ".git-credentials"].map((rel) => join(hogar, rel));
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${escribir.map((r) => `(subpath ${esc(r)})`).join(" ")})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))',
    `(deny file-write* ${opciones.noEscribibles.map(real).map((r) => `(subpath ${esc(r)})`).join(" ")})`,
    `(deny file-read* ${secretos.map((r) => `(subpath ${esc(r)})`).join(" ")} ${archivosSecretos
      .map((r) => `(literal ${esc(r)})`)
      .join(" ")})`,
  ].join("\n");
}

export interface OpcionesEjecucion {
  argv: string[];
  cwd: string;
  tmpDir: string;
  /** Dónde guardar la salida entera. */
  logPath?: string;
  corteMs: number;
  signal?: AbortSignal;
  aislamiento: { tipo: "sandbox"; escribibles: string[]; noEscribibles: string[] } | { tipo: "ninguno" };
  entornoBase?: NodeJS.ProcessEnv;
}

export async function ejecutarComando(opciones: OpcionesEjecucion): Promise<ResultadoComando> {
  const inicio = Date.now();
  await mkdir(opciones.tmpDir, { recursive: true });
  let log: WriteStream | null = null;
  if (opciones.logPath) {
    await mkdir(dirname(opciones.logPath), { recursive: true });
    log = createWriteStream(opciones.logPath);
  }

  const [ejecutable, ...resto] = opciones.argv;
  if (!ejecutable) {
    return { codigo: null, salida: "", duracionMs: 0, cortadoPorTiempo: false, aislamiento: "sin-aislamiento", log: null, error: "Comando vacío." };
  }
  const conSandbox = opciones.aislamiento.tipo === "sandbox";
  const comando = conSandbox ? "/usr/bin/sandbox-exec" : ejecutable;
  const args = conSandbox
    ? ["-p", perfilSandbox(opciones.aislamiento as { escribibles: string[]; noEscribibles: string[] }), ejecutable, ...resto]
    : resto;

  let cabeza = "";
  let cola = "";
  let total = 0;
  const acumular = (trozo: Buffer) => {
    const texto = trozo.toString("utf8");
    log?.write(trozo);
    total += texto.length;
    if (cabeza.length < CABEZA) {
      const falta = CABEZA - cabeza.length;
      cabeza += texto.slice(0, falta);
      if (texto.length > falta) cola = (cola + texto.slice(falta)).slice(-COLA);
    } else {
      cola = (cola + texto).slice(-COLA);
    }
  };

  return new Promise<ResultadoComando>((resolver) => {
    let terminado = false;
    let cortado = false;
    const hijo = spawn(comando, args, {
      cwd: opciones.cwd,
      env: entornoDeComando(opciones.entornoBase ?? process.env, opciones.tmpDir),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const matar = (senal: NodeJS.Signals) => {
      if (hijo.pid == null) return;
      try {
        process.kill(-hijo.pid, senal); // el grupo entero, nietos incluidos
      } catch {
        try {
          hijo.kill(senal);
        } catch {
          // ya terminó
        }
      }
    };
    const cortar = () => {
      cortado = true;
      matar("SIGTERM");
      setTimeout(() => matar("SIGKILL"), 3_000).unref();
    };
    const reloj = setTimeout(cortar, opciones.corteMs);
    reloj.unref();
    const alAbortar = () => cortar();
    opciones.signal?.addEventListener("abort", alAbortar, { once: true });

    hijo.stdout?.on("data", acumular);
    hijo.stderr?.on("data", acumular);

    const cerrar = (codigo: number | null, error?: string) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      opciones.signal?.removeEventListener("abort", alAbortar);
      // Aunque el líder haya salido, pueden quedar hijos colgados del grupo.
      matar("SIGKILL");
      log?.end();
      const omitido = total - cabeza.length - cola.length;
      const salida =
        omitido > 0
          ? `${cabeza}\n\n[… ${omitido} caracteres omitidos: el log completo está en disco …]\n\n${cola}`
          : cabeza + cola;
      resolver({
        codigo: cortado ? null : codigo,
        salida,
        duracionMs: Date.now() - inicio,
        cortadoPorTiempo: cortado,
        aislamiento: conSandbox ? "sandbox" : "sin-aislamiento",
        log: opciones.logPath ?? null,
        ...(error ? { error } : {}),
      });
    };
    hijo.on("error", (error) => {
      const noExiste = (error as NodeJS.ErrnoException).code === "ENOENT";
      cerrar(null, noExiste ? `No se encontró "${ejecutable}" en el PATH.` : error.message);
    });
    hijo.on("close", (codigo) => cerrar(codigo));
  });
}
