/**
 * La configuración de MCP que usa todo el mundo → la de esta empresa.
 *
 * El formato `{ "mcpServers": { "browsermcp": { "command": "npx", … } } }` es el
 * que publican los servidores en su README y el que ya tenés pegado en Claude, en
 * Cursor y en el resto. Pedirle a alguien que lo traduzca a mano campo por campo
 * es la razón por la que MCP terminaba sin usarse: la capacidad estaba entera y
 * el único camino para llegar a ella era un `curl`.
 *
 * ## Los secretos no se importan
 *
 * El formato del ecosistema mete el valor del secreto adentro del JSON
 * (`"env": { "GITHUB_TOKEN": "ghp_1234…" }`). Acá se guarda **la referencia**: el
 * nombre de la variable de `.env` donde vive el valor, nunca el valor. Eso es lo
 * que hace que una empresa exportada a JSON no lleve credenciales adentro.
 *
 * Así que al importar, un valor que parece un nombre de variable (`GITHUB_TOKEN`,
 * `${GITHUB_TOKEN}`) entra como referencia, y **un valor que parece un secreto se
 * descarta con un aviso**. Descartarlo en silencio sería peor que no importar: el
 * servidor arrancaría sin credencial y el error aparecería mucho después, lejos
 * de su causa.
 */

import type { McpTransport } from "./schema.js";

export interface ServidorImportado {
  name: string;
  description: string;
  transport: McpTransport;
}

export interface ResultadoImportacion {
  servidores: ServidorImportado[];
  /** Lo que no se pudo importar o se importó distinto, en castellano. */
  avisos: string[];
}

/** `${VAR}` y `$VAR` son la forma habitual de referenciar una variable. */
const REFERENCIA = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/** Un nombre de variable a secas: `GITHUB_TOKEN`. */
const NOMBRE_DE_VARIABLE = /^[A-Z][A-Z0-9_]*$/;

/**
 * El nombre de variable al que apunta un valor, o `null` si parece un secreto.
 *
 * La distinción no puede ser perfecta y no hace falta que lo sea: ante la duda
 * gana no guardar. Un falso negativo cuesta escribir el nombre a mano; un falso
 * positivo escribe una credencial en la base.
 */
export function referenciaDe(valor: string): string | null {
  const limpio = valor.trim();
  const interpolada = REFERENCIA.exec(limpio);
  if (interpolada) return interpolada[1]!;
  return NOMBRE_DE_VARIABLE.test(limpio) ? limpio : null;
}

/** Nombre válido para un servidor: es el segmento de `mcp__<servidor>__<tool>`. */
export function normalizarNombre(crudo: string): string {
  return crudo
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

interface EntradaCruda {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  url?: unknown;
  headers?: unknown;
  type?: unknown;
  description?: unknown;
  disabled?: unknown;
}

/** Pasa un `Record<string, unknown>` a referencias, avisando lo que descarta. */
function referencias(
  crudo: unknown,
  donde: string,
  servidor: string,
  avisos: string[],
): Record<string, string> {
  if (!crudo || typeof crudo !== "object") return {};
  const salida: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(crudo as Record<string, unknown>)) {
    if (typeof valor !== "string") continue;
    const referencia = referenciaDe(valor);
    if (referencia) {
      salida[clave] = referencia;
      continue;
    }
    avisos.push(
      `En "${servidor}", ${donde} "${clave}" traía un valor literal y no se guardó: los ` +
        `secretos se guardan por referencia. Poné el valor en el .env del servidor con ` +
        `algún nombre y acá dejá ese nombre.`,
    );
  }
  return salida;
}

const comoLista = (crudo: unknown): string[] =>
  Array.isArray(crudo) ? crudo.filter((x): x is string => typeof x === "string") : [];

/**
 * Interpreta el JSON pegado. Nunca tira: lo que no entiende vuelve como aviso.
 *
 * Acepta el bloque completo (`{ "mcpServers": { … } }`) y también el mapa a
 * secas, porque la mitad de los README publican una cosa y la mitad la otra.
 */
export function parsearConfigMcp(texto: string): ResultadoImportacion {
  const avisos: string[] = [];
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch (error) {
    return {
      servidores: [],
      avisos: [`No es JSON válido: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!crudo || typeof crudo !== "object" || Array.isArray(crudo)) {
    return { servidores: [], avisos: ["Se esperaba un objeto con los servidores adentro."] };
  }

  const raiz = crudo as Record<string, unknown>;
  const mapa = (
    raiz.mcpServers && typeof raiz.mcpServers === "object" ? raiz.mcpServers : raiz
  ) as Record<string, unknown>;

  const servidores: ServidorImportado[] = [];
  for (const [nombreCrudo, entradaCruda] of Object.entries(mapa)) {
    if (!entradaCruda || typeof entradaCruda !== "object") continue;
    const entrada = entradaCruda as EntradaCruda;
    const name = normalizarNombre(nombreCrudo);
    if (!name) {
      avisos.push(`El nombre "${nombreCrudo}" no deja ningún carácter válido; se saltea.`);
      continue;
    }
    if (name !== nombreCrudo.trim()) {
      avisos.push(`"${nombreCrudo}" se guardó como "${name}": el nombre es parte del id de cada herramienta.`);
    }

    const description = typeof entrada.description === "string" ? entrada.description : "";

    if (typeof entrada.url === "string") {
      servidores.push({
        name,
        description,
        transport: {
          type: "http",
          url: entrada.url,
          headerRefs: referencias(entrada.headers, "el encabezado", name, avisos),
          caPath: null,
        },
      });
      continue;
    }

    if (typeof entrada.command === "string" && entrada.command.trim()) {
      servidores.push({
        name,
        description,
        transport: {
          type: "stdio",
          command: entrada.command.trim(),
          args: comoLista(entrada.args),
          envRefs: referencias(entrada.env, "la variable", name, avisos),
          cwd: typeof entrada.cwd === "string" && entrada.cwd ? entrada.cwd : null,
        },
      });
      continue;
    }

    avisos.push(`"${nombreCrudo}" no tiene ni "command" ni "url": no se sabe cómo conectarlo.`);
  }

  if (servidores.length === 0 && avisos.length === 0) {
    avisos.push("No se encontró ningún servidor en lo que pegaste.");
  }
  return { servidores, avisos };
}
