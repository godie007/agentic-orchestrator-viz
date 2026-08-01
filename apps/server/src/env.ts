import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raíz del monorepo. Las rutas relativas de `.env` se anclan acá y no al
 * directorio actual, para que la base sea la misma tanto si arrancás desde la
 * raíz (`npm run dev`) como desde el workspace (`npm run dev -w @orq/server`).
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Resuelve una ruta de configuración contra la raíz del monorepo. */
export function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

/**
 * Configuración leída del entorno, validada una vez al arrancar para que un
 * valor mal puesto falle acá y no en medio de una corrida.
 */
export interface Env {
  port: number;
  databaseUrl: string;
  /** Dónde se guardan los Word y PDF que producen las habilidades. */
  exportsDir: string;
  /**
   * Carpeta con las pistas de música de fondo de los videos.
   *
   * Las pistas las dejás vos: tienen licencia, y bajar un mp3 de internet para
   * meterlo en el video de una empresa es un problema que el orquestador no
   * puede ver. Si la carpeta no existe, los videos salen sin música.
   */
  musicaDir: string;
  defaultBudgetUsd: number;
  defaultMaxTicks: number;
  agentConcurrency: number;
  /**
   * Webhook de n8n que despacha el correo. Sin esto la empresa no manda mails y
   * la herramienta lo dice con esas palabras, en vez de fallar sin explicación.
   */
  emailWebhookUrl: string | null;
  /** A dónde apuntan los enlaces que viajan en los avisos. */
  appUrl: string;
  /**
   * Base pública de la API, para los enlaces de descarga de los avisos.
   *
   * Apunta al servidor local: el enlace se abre desde la misma máquina o red
   * donde corre el orquestador, no desde cualquier lado.
   */
  apiUrl: string;
  /** Cada cuánto se revisa si a alguna misión le toca correr. */
  misionTickMs: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: numeric(source.PORT, 3001, "PORT"),
    databaseUrl: fromRoot(source.DATABASE_URL?.trim() || "./data/orquestador.db"),
    exportsDir: fromRoot(source.EXPORTS_DIR?.trim() || "./data/exports"),
    musicaDir: fromRoot(source.MUSICA_DIR?.trim() || "./data/musica"),
    defaultBudgetUsd: numeric(source.DEFAULT_RUN_BUDGET_USD, 1, "DEFAULT_RUN_BUDGET_USD"),
    defaultMaxTicks: numeric(source.DEFAULT_MAX_TICKS, 50, "DEFAULT_MAX_TICKS"),
    agentConcurrency: numeric(source.AGENT_CONCURRENCY, 4, "AGENT_CONCURRENCY"),
    emailWebhookUrl: source.N8N_EMAIL_WEBHOOK_URL?.trim() || null,
    appUrl: source.APP_URL?.trim() || "http://localhost:5173",
    apiUrl:
      source.API_URL?.trim() ||
      `http://localhost:${numeric(source.PORT, 3001, "PORT")}`,
    misionTickMs: numeric(source.MISION_TICK_MS, 30_000, "MISION_TICK_MS"),
  };
}

function numeric(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}="${raw}" no es un número positivo válido.`);
  }
  return value;
}

/**
 * Los secretos de los servidores MCP se guardan por referencia: la config
 * almacena el *nombre* de la variable, y el valor se resuelve acá. Así una
 * empresa exportada a JSON no lleva credenciales adentro.
 */
export function resolveSecret(envVarName: string): string | undefined {
  return process.env[envVarName];
}
