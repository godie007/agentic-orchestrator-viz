/**
 * Comandos como argv: tokenizar, validar la allowlist y decidir si algo está
 * permitido.
 *
 * Es código puro y vive en `@orq/shared` porque lo usan dos lados que no pueden
 * discrepar: el servidor, cuando una persona edita la allowlist, y la
 * herramienta `ejecutar_comando`, cuando un agente pide correr algo. Con dos
 * copias, lo que la UI aceptaba como permitido la herramienta lo rechazaba —o
 * peor, al revés—.
 *
 * **La allowlist no es una frontera de seguridad.** Permitir `npm test` es
 * permitir los scripts de `package.json` y los tests, que un agente puede
 * editar. Lo que contiene de verdad es el sandbox; la allowlist evita que un
 * agente corra *cualquier* cosa por accidente, y hace visible qué se corre.
 */

/**
 * Metacaracteres de shell. El comando se lanza **sin shell**, así que no
 * harían nada —`;` sería un argumento literal—, pero un agente que los escribe
 * cree que sí, y el rechazo le explica por qué su `npm test && npm run lint`
 * no es lo que piensa. Dos llamadas separadas sí lo son.
 */
const METACARACTERES = /[;&|<>`$\\\n\r]|\$\(|\*|\?/;

export type Tokenizado = { ok: true; argv: string[] } | { ok: false; motivo: string };

/**
 * Parte un comando en argv respetando comillas simples y dobles. No expande
 * nada: ni variables, ni `~`, ni globs.
 */
export function tokenizar(comando: string): Tokenizado {
  const texto = comando.trim();
  if (!texto) return { ok: false, motivo: "El comando está vacío." };

  const argv: string[] = [];
  let actual = "";
  let comilla: '"' | "'" | null = null;
  let hayToken = false;
  for (const caracter of texto) {
    if (comilla) {
      if (caracter === comilla) comilla = null;
      else actual += caracter;
      continue;
    }
    if (caracter === '"' || caracter === "'") {
      comilla = caracter;
      hayToken = true;
      continue;
    }
    if (/\s/.test(caracter)) {
      if (hayToken) argv.push(actual);
      actual = "";
      hayToken = false;
      continue;
    }
    if (METACARACTERES.test(caracter)) {
      return {
        ok: false,
        motivo:
          `"${caracter}" es sintaxis de shell y acá no hay shell: el comando se corre tal cual, ` +
          `como una lista de argumentos. Para encadenar, hacé llamadas separadas; para ` +
          `redirigir, no hace falta —la salida ya vuelve en el resultado—.`,
      };
    }
    actual += caracter;
    hayToken = true;
  }
  if (comilla) return { ok: false, motivo: "Hay una comilla sin cerrar." };
  if (hayToken) argv.push(actual);
  if (argv.length === 0) return { ok: false, motivo: "El comando está vacío." };
  return { ok: true, argv };
}

export function argvATexto(argv: readonly string[]): string {
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}

/**
 * Ejecutables que, solos, lo permiten todo: `node` corre cualquier archivo,
 * `npx` baja y corre cualquier paquete, `sh -c` es un shell. Como entrada de la
 * allowlist necesitan un argumento más que diga *qué* corren.
 */
const EJECUTABLES_ABIERTOS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "env", "sudo", "doas", "xargs", "eval", "exec",
  "node", "deno", "bun", "python", "python3", "ruby", "perl", "php", "osascript",
  "npx", "pnpx", "bunx", "uvx", "pipx",
  "curl", "wget", "ssh", "scp", "rsync", "nc",
  "rm", "mv", "chmod", "chown", "dd",
]);

/** Gestores de paquetes: `npm` solo no dice nada; `npm run` sin script, tampoco. */
const GESTORES = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Subcomandos de git que escriben fuera del worktree o hablan con la red. */
const GIT_PROHIBIDOS = new Set(["push", "remote", "config", "credential", "submodule", "filter-branch", "gc", "worktree"]);

export type Validacion = { ok: true } | { ok: false; motivo: string };

/** ¿Sirve este prefijo como entrada de la allowlist? */
export function validarPrefijoPermitido(argv: readonly string[]): Validacion {
  const [ejecutable, primero, segundo] = argv;
  if (!ejecutable) return { ok: false, motivo: "Vacío." };
  if (ejecutable.includes("/")) {
    return { ok: false, motivo: "Usá el nombre del ejecutable, no una ruta: la ruta la resuelve el PATH." };
  }
  if (EJECUTABLES_ABIERTOS.has(ejecutable)) {
    if (["sh", "bash", "zsh", "fish", "dash", "env", "sudo", "doas", "xargs", "eval", "exec", "curl", "wget", "ssh", "scp", "rsync", "nc", "rm", "mv", "chmod", "chown", "dd", "osascript"].includes(ejecutable)) {
      return { ok: false, motivo: `"${ejecutable}" no se puede permitir: es un shell o toca cosas fuera del proyecto.` };
    }
    if (argv.length < 2 || primero === "-c" || primero === "-e" || primero === "--eval") {
      return {
        ok: false,
        motivo: `"${ejecutable}" solo corre cualquier cosa. Permitilo con lo que corre: "${ejecutable} <script o paquete>".`,
      };
    }
  }
  if (GESTORES.has(ejecutable)) {
    if (!primero) return { ok: false, motivo: `"${ejecutable}" solo no dice qué corre. Ej.: "${ejecutable} test".` };
    if ((primero === "run" || primero === "exec" || primero === "dlx" || primero === "x") && !segundo) {
      return { ok: false, motivo: `"${ejecutable} ${primero}" sin script corre cualquiera. Nombrá el script.` };
    }
    if (["publish", "login", "adduser", "token", "config", "set", "unpublish", "owner", "access"].includes(primero)) {
      return { ok: false, motivo: `"${ejecutable} ${primero}" publica o toca credenciales: no se permite.` };
    }
  }
  if (ejecutable === "git") {
    if (!primero) return { ok: false, motivo: `"git" solo lo permite todo. Nombrá el subcomando.` };
    if (GIT_PROHIBIDOS.has(primero)) {
      return { ok: false, motivo: `"git ${primero}" no se permite: la integración la hace una persona desde la UI.` };
    }
  }
  return { ok: true };
}

/** ¿`argv` empieza con `prefijo`, token por token? `npm test` no habilita `npm testx`. */
export function empiezaCon(argv: readonly string[], prefijo: readonly string[]): boolean {
  if (prefijo.length === 0 || prefijo.length > argv.length) return false;
  return prefijo.every((token, i) => argv[i] === token);
}

export type Decision =
  | { permitido: true; motivo: "allowlist" | "una-vez" | "lectura-git" }
  | { permitido: false; motivo: string };

/** Lo que cualquier rol puede leer de git sin pedir permiso. */
const GIT_LECTURA = new Set(["status", "diff", "log", "show", "blame", "ls-files", "grep", "rev-parse", "shortlog", "describe"]);

/**
 * ¿Se puede correr este argv? Primero lo que nunca se permite —ni aunque esté
 * en la lista—, después la allowlist, después los permisos de una vez.
 */
export function decidirComando(
  argv: readonly string[],
  comandos: { permitidos: readonly (readonly string[])[]; unaVez: readonly (readonly string[])[] },
): Decision {
  const [ejecutable, primero] = argv;
  if (!ejecutable) return { permitido: false, motivo: "El comando está vacío." };
  if (ejecutable === "git" && primero && GIT_PROHIBIDOS.has(primero)) {
    return { permitido: false, motivo: `"git ${primero}" no se corre desde un agente: integrar lo hace una persona.` };
  }
  if (ejecutable === "git" && primero && GIT_LECTURA.has(primero)) {
    // Leer no puede ser la puerta para escribir o ejecutar: `--output` escribe
    // un archivo donde diga, y un diff o textconv externo corre un programa.
    const peligroso = argv.find((arg) =>
      /^--(output|ext-diff|textconv|exec|upload-pack|git-dir|work-tree|config-env)/.test(arg),
    );
    if (peligroso) {
      return { permitido: false, motivo: `"${peligroso}" escribe o ejecuta: no va en una lectura de git.` };
    }
    return { permitido: true, motivo: "lectura-git" };
  }
  if (comandos.permitidos.some((prefijo) => empiezaCon(argv, prefijo))) {
    return { permitido: true, motivo: "allowlist" };
  }
  if (comandos.unaVez.some((exacto) => exacto.length === argv.length && empiezaCon(argv, exacto))) {
    return { permitido: true, motivo: "una-vez" };
  }
  return {
    permitido: false,
    motivo:
      `"${argvATexto(argv)}" no está entre los comandos permitidos de este repo. ` +
      `Pedilo con solicitar_comando —una persona decide si queda permitido siempre o sólo esta vez— ` +
      `y mientras tanto seguí con lo que sí podés hacer.`,
  };
}
