import { slugTecnico } from "./nombres.js";
import type { Servicio, TipoServicio } from "./schema.js";

/**
 * Qué se levanta dentro de un repo, y cómo se conectan las partes.
 *
 * Es código puro —sin disco ni procesos— porque las dos decisiones que importan
 * se equivocan en silencio y hay que poder fijarlas con tests:
 *
 * - **Qué es cada carpeta.** Un `package.json` con Vite es un frontend, uno con
 *   Express es una API, uno con Expo es una app móvil que se puede ver en web.
 *   Clasificar mal no rompe nada visible: levanta un programa con el comando
 *   equivocado y la vista previa queda en blanco.
 * - **A quién le habla cada una.** El `.env` del frontend de la persona dice
 *   `VITE_API_URL=http://localhost:3001/api` porque en su máquina el backend
 *   corre en el 3001. En la vista previa el backend corre en otro puerto —el
 *   3001 lo tiene ella, con su versión—, y sin reescribir esa URL el frontend
 *   de la sesión le hablaría al backend *de la persona*, no al que cambiaron
 *   los agentes. Es la peor falla posible de una vista previa: se ve bien y
 *   muestra otra cosa.
 */

export interface PaqueteNode {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Lo que se sabe de una carpeta candidata, ya leído del disco. */
export interface CarpetaCandidata {
  /** Relativa a la raíz del repo; `""` es la raíz. */
  carpeta: string;
  paquete: PaqueteNode | null;
  /** Cuántos `.md` tiene (hasta dos niveles). */
  notas: number;
  /** Tiene una carpeta `.obsidian` adentro. */
  obsidian: boolean;
  /** Puerto fijado en la config de Vite (`server.port`), si lo hay. */
  puertoVite?: number | null;
  /** `PORT` del `.env` de la persona. */
  puertoEnv?: number | null;
  /** El default de `process.env.PORT || 3001` en el código, si se encontró. */
  puertoCodigo?: number | null;
  /** Ruta de salud encontrada en el código (`/health`). */
  salud?: string | null;
  /** Los `.env` de la persona que existen para esta carpeta, absolutos. */
  archivosEntorno?: string[];
}

const SERVIDORES = ["express", "fastify", "koa", "@nestjs/core", "hono", "@hapi/hapi", "restify", "@adonisjs/core"];
const CARPETA_DE_DOCS = /(obsidian|^docs?$|wiki|documentaci|manual)/i;

function tiene(paquete: PaqueteNode, dependencia: string): boolean {
  return Boolean(paquete.dependencies?.[dependencia] ?? paquete.devDependencies?.[dependencia]);
}

function nombreLegible(carpeta: string, tipo: TipoServicio): string {
  const base = carpeta.split("/").at(-1) ?? "";
  if (!base) return tipo === "api" ? "API" : "App";
  const limpio = base.replace(/[-_]+/g, " ").trim();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

function servicio(candidata: CarpetaCandidata, tipo: TipoServicio, resto: Partial<Servicio>): Servicio {
  return {
    id: slugTecnico(candidata.carpeta || (tipo === "api" ? "api" : "app"), "app"),
    nombre: nombreLegible(candidata.carpeta, tipo),
    carpeta: candidata.carpeta,
    tipo,
    arrancar: null,
    variablePuerto: null,
    puertoOriginal: null,
    salud: null,
    inicio: "/",
    archivosEntorno: candidata.archivosEntorno ?? [],
    entorno: {},
    ...resto,
  };
}

/**
 * Qué servicio es una carpeta, o `null` si no es algo que se levante ni se lea.
 *
 * El orden importa: Expo trae `react-dom` y a veces Vite; una app móvil que se
 * clasifica como web se levanta con el comando del otro y no arranca.
 */
export function clasificarServicio(candidata: CarpetaCandidata): Servicio | null {
  const paquete = candidata.paquete;
  if (paquete) {
    const scripts = paquete.scripts ?? {};
    if (tiene(paquete, "expo")) {
      // Expo en web: el mismo Metro sirve la app para el navegador. `--web`
      // es lo que la habilita (sin eso no se arma el bundle web).
      const arrancar = scripts["web"]
        ? ["npm", "run", "web", "--", "--port", "{puerto}"]
        : ["npx", "expo", "start", "--web", "--port", "{puerto}"];
      return servicio(candidata, "movil", { arrancar, puertoOriginal: 8081 });
    }
    if (tiene(paquete, "next") && scripts["dev"]) {
      return servicio(candidata, "web", {
        arrancar: ["npm", "run", "dev", "--", "-p", "{puerto}", "-H", "127.0.0.1"],
        puertoOriginal: 3000,
      });
    }
    if (tiene(paquete, "vite") && scripts["dev"]) {
      // Los argumentos van al final del script: `npm run dev -- --port N`
      // con `"dev": "node prepara.mjs && vite"` termina en `vite --port N`.
      // `--host 127.0.0.1` porque la config de la persona puede decir `::`,
      // que escucha en todas las interfaces: una vista previa no se publica
      // en la red de la oficina.
      return servicio(candidata, "web", {
        arrancar: ["npm", "run", "dev", "--", "--port", "{puerto}", "--strictPort", "--host", "127.0.0.1"],
        puertoOriginal: candidata.puertoVite ?? 5173,
      });
    }
    const script = scripts["dev"] ? "dev" : scripts["start"] ? "start" : null;
    if (SERVIDORES.some((nombre) => tiene(paquete, nombre)) && script) {
      return servicio(candidata, "api", {
        arrancar: ["npm", "run", script],
        variablePuerto: "PORT",
        puertoOriginal: candidata.puertoEnv ?? candidata.puertoCodigo ?? null,
        salud: candidata.salud ?? null,
        inicio: candidata.salud ?? "/",
      });
    }
    if (script && candidata.carpeta !== "") {
      return servicio(candidata, "otro", {
        arrancar: ["npm", "run", script],
        variablePuerto: "PORT",
        puertoOriginal: candidata.puertoEnv ?? null,
      });
    }
  }
  const base = candidata.carpeta.split("/").at(-1) ?? "";
  if (candidata.notas > 0 && (candidata.obsidian || CARPETA_DE_DOCS.test(base))) {
    // "Inspia obsidian" no le dice nada a nadie; "Documentación (Obsidian)" sí.
    return servicio(candidata, "docs", /obsidian/i.test(base) ? { nombre: "Documentación (Obsidian)" } : {});
  }
  return null;
}

/** Ids únicos dentro del repo: dos carpetas `app` en distintos niveles no pueden llamarse igual. */
export function conIdsUnicos(servicios: Servicio[]): Servicio[] {
  const vistos = new Set<string>();
  return servicios.map((s) => {
    let id = s.id;
    for (let n = 2; vistos.has(id); n++) id = `${s.id}-${n}`;
    vistos.add(id);
    return id === s.id ? s : { ...s, id };
  });
}

/** El argv con el puerto puesto. */
export function argvDeArranque(servicio: Servicio, puerto: number): string[] {
  return (servicio.arrancar ?? []).map((token) => token.replaceAll("{puerto}", String(puerto)));
}

/**
 * Un `.env` a un mapa. Lo mismo que entiende `dotenv`: comentarios, `export`,
 * comillas simples y dobles (con `\n` en las dobles), y `#` como comentario
 * sólo después de un espacio en un valor sin comillas.
 */
export function parsearDotenv(texto: string): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const cruda of texto.split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea || linea.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(linea);
    if (!m) continue;
    const clave = m[1]!;
    let valor = m[2] ?? "";
    const comilla = valor.charAt(0);
    if ((comilla === '"' || comilla === "'" || comilla === "`") && valor.lastIndexOf(comilla) > 0) {
      valor = valor.slice(1, valor.lastIndexOf(comilla));
      if (comilla === '"') valor = valor.replace(/\\n/g, "\n");
    } else {
      valor = valor.replace(/\s+#.*$/, "").trim();
    }
    salida[clave] = valor;
  }
  return salida;
}

const URL_LOCAL = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?(\/.*)?$/i;
const URL_EXTERNA = /^(https?|wss?):\/\/[^\s,]+$/i;
/** Claves cuyo valor no se muestra nunca, aunque sea una URL (puede llevar credenciales). */
const CLAVE_SECRETA = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DSN|PRIVATE)/i;

/**
 * Qué variables hablan de **la propia app** (su API, su frontend), y no de un
 * servicio de afuera. Un backend tiene decenas de URLs externas legítimas —
 * Supabase, el storage, los webhooks— y avisar de todas es tapar la que
 * importa: la app móvil que en la vista previa le pega a la API de producción.
 */
const URL_DE_LA_APP = /(^|_)(API|BACKEND|SERVER|FRONTEND|APP|WEB|BASE|PUBLIC_API)(_BASE)?_?(URL|URI|ORIGIN|ORIGINS|HOST)S?$/i;

export interface Redireccion {
  clave: string;
  antes: string;
  despues: string;
}

/**
 * Reescribe las URLs a `localhost:<puerto>` que apuntan a otro servicio del
 * repo, para que la vista previa hable con la vista previa.
 *
 * `destinos` va del puerto original (el de la máquina de la persona) a la URL
 * del servicio levantado acá. Un valor puede ser una lista separada por comas
 * —los orígenes de CORS suelen serlo—, y se reescribe elemento por elemento:
 * `FRONTEND_URL=http://localhost:5173,https://staging…` conserva el de staging.
 *
 * Devuelve además las URLs que apuntan **afuera** (a staging, a producción):
 * no se tocan —puede ser justo lo que la persona quiere—, pero se avisan,
 * porque una app móvil que en la vista previa le pega a la API de producción es
 * algo que hay que saber antes de apretar un botón.
 */
export function redirigirUrlsLocales(
  variables: Record<string, string>,
  destinos: ReadonlyMap<number, string>,
): { variables: Record<string, string>; redirecciones: Redireccion[]; externas: Array<{ clave: string; valor: string }> } {
  const salida: Record<string, string> = {};
  const redirecciones: Redireccion[] = [];
  const externas: Array<{ clave: string; valor: string }> = [];
  for (const [clave, valor] of Object.entries(variables)) {
    let cambio = false;
    const partes = valor.split(",").map((parte) => {
      const limpio = parte.trim();
      const m = URL_LOCAL.exec(limpio);
      if (!m) return parte;
      const puerto = Number(m[3] ?? (m[1]!.toLowerCase() === "https" ? 443 : 80));
      const destino = destinos.get(puerto);
      if (!destino) return parte;
      cambio = true;
      return `${destino.replace(/\/$/, "")}${m[4] ?? ""}`;
    });
    const nuevo = partes.join(",");
    salida[clave] = nuevo;
    if (cambio) redirecciones.push({ clave, antes: valor, despues: nuevo });
    else if (
      URL_DE_LA_APP.test(clave) &&
      !CLAVE_SECRETA.test(clave) &&
      valor.split(",").some((parte) => URL_EXTERNA.test(parte.trim()) && !URL_LOCAL.test(parte.trim()))
    ) {
      externas.push({ clave, valor });
    }
  }
  return { variables: salida, redirecciones, externas };
}

/** `{url:backend}` → la URL del servicio `backend`. Lo que no existe queda como está, a la vista. */
export function expandirUrls(valor: string, urls: ReadonlyMap<string, string>): string {
  return valor.replace(/\{url:([a-z0-9._-]+)\}/gi, (entero, id: string) => urls.get(id) ?? entero);
}

/** ¿Una variable parece un secreto? Para no mostrar su valor en la UI ni en los logs. */
export function esClaveSecreta(clave: string): boolean {
  return CLAVE_SECRETA.test(clave) || /(AUTH|COOKIE|SESSION)/i.test(clave);
}
