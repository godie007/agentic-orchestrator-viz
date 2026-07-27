import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/**
 * `fetch` que verifica el certificado contra una CA declarada.
 *
 * Los servidores MCP que corren en la máquina —el de Obsidian, por ejemplo—
 * sirven HTTPS con un certificado propio. El `fetch` global lo rechaza, y la
 * salida fácil sería apagar la verificación con `rejectUnauthorized: false` o
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`. Eso no se hace acá: lo primero debilita esa
 * conexión y lo segundo **todas** las del proceso, incluidas las llamadas al
 * proveedor LLM.
 *
 * En su lugar se agrega esa CA a las de confianza para esta conexión y nada
 * más. La verificación sigue existiendo: un certificado que no sea el de ese
 * servidor se rechaza igual.
 *
 * Se implementa sobre `node:https` porque el `fetch` global de Node no acepta
 * opciones de TLS por llamada.
 */
export function fetchConCa(caPath: string): typeof fetch {
  // Se lee una vez: si el archivo no existe, que falle acá y no en cada pedido.
  const ca = readFileSync(caPath);

  return async function fetchVerificado(input, init) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (value, key) => {
        headers[key] = value;
      },
    );

    const body =
      init?.body == null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : Buffer.from(init.body as ArrayBuffer);

    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          ca,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(key, v));
            else if (value != null) responseHeaders.set(key, value);
          }

          // El cuerpo se pasa como stream, no acumulado: el transporte MCP
          // usa SSE y necesita leer los eventos a medida que llegan.
          const status = res.statusCode ?? 502;
          resolve(
            new Response(status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream), {
              status,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );

      req.on("error", reject);
      if (init?.signal) {
        init.signal.addEventListener("abort", () => req.destroy(new Error("abortado")), { once: true });
      }
      if (body != null) req.write(body);
      req.end();
    });
  } as typeof fetch;
}
