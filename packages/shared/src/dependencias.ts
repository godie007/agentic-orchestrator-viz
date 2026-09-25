/**
 * Instalar dependencias: qué se acepta y con qué comando.
 *
 * Un agente no puede bajar nada de la red por su cuenta —`curl` no entra en
 * ninguna allowlist—, y eso dejó un simulador 3D sin dibujar: el código
 * importaba Three.js y nadie podía traerlo. Instalar pasa por una persona
 * (`instalar_dependencia` abre una solicitud y aprobarla instala), y acá están
 * las dos reglas que hacen seguro aprobar con un click:
 *
 * - **Sólo paquetes del registro, por nombre** (`three`, `three@0.160.0`,
 *   `@scope/pkg@^1`). Nada de URLs, `git:`, `file:` ni rutas: un "paquete" que
 *   es una URL es código de cualquier lado, y la persona que aprueba ve un
 *   nombre y cree que sabe qué está instalando.
 * - **Sin scripts de instalación** (`--ignore-scripts`). Un `postinstall` es
 *   código arbitrario corriendo al instalar; la gran mayoría de las librerías
 *   no lo necesita, y la que sí lo necesita se nota cuando falla.
 *
 * Es código puro y vive en `@orq/shared` porque lo usan la herramienta del
 * agente (valida al pedir) y el servidor (valida otra vez al aprobar: lo que
 * llega a la base no se da por bueno).
 */

export type GestorDePaquetes = "npm" | "pnpm" | "yarn";

/** Nombre de npm, con scope opcional. Sin mayúsculas: el registro no las acepta. */
const NOMBRE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Versión, rango o etiqueta: `1.2.3`, `^1.2`, `~0.160.0`, `latest`, `>=2 <3`. */
const VERSION = /^[\w.\-~^<>=*| ]{1,60}$/;

export const MAX_PAQUETES_POR_PEDIDO = 10;

export function validarPaquete(spec: string): { ok: true } | { ok: false; motivo: string } {
  const limpio = spec.trim();
  if (!limpio) return { ok: false, motivo: "Paquete vacío." };
  if (/[:\\]|^\.|^\/|\s{2,}/.test(limpio) || limpio.includes("//")) {
    return {
      ok: false,
      motivo: `"${limpio}" no es un paquete del registro: no se instalan URLs, git, file: ni rutas. Pedilo por nombre, ej. "three@0.160.0".`,
    };
  }
  // El `@` de la versión es el último que no está al principio (el primero
  // puede ser el de un scope: `@scope/pkg@1.0`).
  const arroba = limpio.lastIndexOf("@");
  const nombre = arroba > 0 ? limpio.slice(0, arroba) : limpio;
  const version = arroba > 0 ? limpio.slice(arroba + 1) : null;
  if (!NOMBRE.test(nombre) || nombre.length > 214) {
    return { ok: false, motivo: `"${nombre}" no es un nombre de paquete válido de npm.` };
  }
  if (version !== null && !VERSION.test(version)) {
    return { ok: false, motivo: `"${version}" no es una versión válida.` };
  }
  return { ok: true };
}

/** El comando que instala, ya sin scripts. Una lista de argumentos, sin shell. */
export function argvDeInstalacion(
  gestor: GestorDePaquetes,
  paquetes: readonly string[],
  opciones: { dev?: boolean } = {},
): string[] {
  const dev = opciones.dev === true;
  switch (gestor) {
    case "npm":
      return ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", dev ? "--save-dev" : "--save", ...paquetes];
    case "pnpm":
      return ["pnpm", "add", "--ignore-scripts", ...(dev ? ["-D"] : []), ...paquetes];
    case "yarn":
      return ["yarn", "add", "--ignore-scripts", ...(dev ? ["--dev"] : []), ...paquetes];
  }
}

/** Qué gestor usa el repo, por su lockfile. Sin lockfile, npm. */
export function gestorPorArchivos(archivos: readonly string[]): GestorDePaquetes {
  if (archivos.includes("pnpm-lock.yaml")) return "pnpm";
  if (archivos.includes("yarn.lock")) return "yarn";
  return "npm";
}
