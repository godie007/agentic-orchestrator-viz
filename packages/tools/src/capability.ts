import { fail, ok, preview, type RegisteredTool } from "./types.js";

/**
 * Herramientas de capacidad: lo que un agente puede hacer fuera de la empresa.
 *
 * `web_search` se implementa con la búsqueda nativa del proveedor cuando
 * existe. En OpenRouter eso es el plugin `web`, que el motor activa poniendo
 * `webSearch` en el `ChatRequest` — no hay una llamada de herramienta separada.
 * Por eso acá está declarada pero su ejecución la resuelve el motor: es un
 * caso especial documentado, no una omisión.
 */

export const WEB_SEARCH_TOOL_NAME = "web_search";

const webSearch: RegisteredTool = {
  name: WEB_SEARCH_TOOL_NAME,
  origin: "capability",
  readOnly: true,
  requiresApproval: false,
  description:
    "Busca información actual en internet. Usala cuando la respuesta dependa " +
    "de datos que cambian —precios, noticias, competencia, normativa vigente— " +
    "en vez de responder de memoria.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Qué buscar, en lenguaje natural" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(args) {
    // El motor intercepta esta herramienta antes de llegar acá cuando el
    // proveedor tiene búsqueda nativa. Si llegó, es que ninguno la soporta.
    return fail(
      `La búsqueda web no está disponible para este agente. El proveedor de su modelo ` +
        `no la soporta de forma nativa. Consultá "${String(args.query ?? "")}" con otro rol ` +
        `cuyo modelo sí la tenga, o usá fetch_url si conocés la fuente.`,
    );
  },
};

const fetchUrl: RegisteredTool = {
  name: "fetch_url",
  origin: "capability",
  readOnly: true,
  requiresApproval: false,
  description:
    "Descarga el contenido de una URL concreta y lo devuelve como texto. " +
    "Usala cuando ya sabés la fuente exacta que querés leer.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL completa, incluyendo https://" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const raw = String(args.url ?? "").trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail(`"${raw}" no es una URL válida. Incluí el esquema, ej: https://ejemplo.com`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail(`Solo se permiten URLs http y https, no "${url.protocol}".`);
    }

    // Un agente no debería poder escanear la red interna del host. Sin esto,
    // una URL apuntando a localhost o a metadatos de la nube sería un vector
    // de exfiltración desde el prompt.
    if (isPrivateHost(url.hostname)) {
      return fail(
        `No se permite acceder a direcciones internas ("${url.hostname}"). ` +
          `Usá una URL pública.`,
      );
    }

    const timeout = AbortSignal.timeout(20_000);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, timeout])
      : timeout;

    try {
      const response = await fetch(url, {
        signal,
        redirect: "follow",
        headers: { "User-Agent": "OrquestadorAgentico/0.1 (+agente de empresa simulada)" },
      });
      if (!response.ok) {
        return fail(`La página devolvió HTTP ${response.status} ${response.statusText}.`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/|json|xml/i.test(contentType)) {
        return fail(`El contenido es "${contentType}", que no es texto legible.`);
      }

      const body = await response.text();
      const text = /html/i.test(contentType) ? htmlToText(body) : body;
      const clipped = text.slice(0, 40_000);
      const note =
        text.length > clipped.length
          ? `\n\n[recortado: ${text.length} caracteres en total]`
          : "";
      return ok(`Contenido de ${url.href}:\n\n${clipped}${note}`, preview(text, 200));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`No se pudo descargar ${url.href}: ${message}`);
    }
  },
};

/** Bloquea loopback, rangos privados RFC1918, link-local y `.internal`. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "[::1]") return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 127 || // loopback
    a === 10 || // privada
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) || // privada
    (a === 192 && b === 168) || // privada
    (a === 169 && b === 254) // link-local (metadatos de nube)
  );
}

/** Extracción de texto suficiente para que un modelo lea una página. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const capabilityTools: RegisteredTool[] = [webSearch, fetchUrl];
