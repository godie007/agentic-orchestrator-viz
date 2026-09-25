import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { runInNewContext } from "node:vm";
import type { AddressInfo } from "node:net";
import { RUTA_SELECTOR, SELECTOR_JS, inyectarSelector, levantarProxyDeVista, type ProxyDeVista } from "./proxy-vista.js";

/**
 * El proxy de la vista previa: lo que importa es que no rompa nada de lo que
 * pasa por él —Vite pide cientos de módulos y abre un websocket para la
 * recarga— y que el selector llegue sólo a las páginas.
 */

let destino: Server;
let proxy: ProxyDeVista | null = null;

afterEach(() => {
  proxy?.cerrar();
  proxy = null;
  destino?.close();
});

async function arrancar(): Promise<number> {
  destino = createServer((req, res) => {
    if (req.url === "/" && req.headers["if-none-match"]) {
      res.writeHead(304);
      res.end();
    } else if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head><title>App</title></head><body>hola</body></html>");
    } else {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export const x = 1; // </head>");
    }
  });
  destino.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`eco:${d.toString()}`));
  });
  await new Promise<void>((r) => destino.listen(0, "127.0.0.1", r));
  const interno = (destino.address() as AddressInfo).port;
  const publico = interno + 1;
  proxy = await levantarProxyDeVista({ puerto: publico, destino: interno });
  return publico;
}

describe("proxy de vista previa", () => {
  it("inyecta el selector en el HTML y deja pasar el resto intacto", async () => {
    const puerto = await arrancar();
    const html = await (await fetch(`http://127.0.0.1:${puerto}/`, { headers: { accept: "text/html" } })).text();
    // Al principio del <head>: la sonda envuelve console y fetch antes que la app.
    expect(html).toContain(`<head><script src="${RUTA_SELECTOR}"></script><title>`);
    // Con la página vieja en caché, el navegador pregunta si cambió: el proxy
    // no deja que el programa conteste 304, o volvería la página sin selector.
    const condicional = await fetch(`http://127.0.0.1:${puerto}/`, { headers: { accept: "text/html", "if-none-match": '"abc"' } });
    expect(condicional.status).toBe(200);
    expect(await condicional.text()).toContain(RUTA_SELECTOR);
    const modulo = await (await fetch(`http://127.0.0.1:${puerto}/src/main.ts`)).text();
    expect(modulo).toBe("export const x = 1; // </head>");
    const selector = await fetch(`http://127.0.0.1:${puerto}${RUTA_SELECTOR}`);
    expect(selector.headers.get("content-type")).toContain("javascript");
    // Las barras del String.raw sobrevivieron: la regex de espacios sigue siendo \s.
    expect(await selector.text()).toContain("split(/\\s+/)");
  });

  it("reenvía los websockets de la recarga en caliente", async () => {
    const puerto = await arrancar();
    const respuesta = await new Promise<string>((resolver, rechazar) => {
      const socket = connect(puerto, "127.0.0.1", () => {
        socket.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      });
      let recibido = "";
      socket.on("data", (d) => {
        recibido += d.toString();
        if (recibido.includes("101") && !recibido.includes("eco:")) socket.write("ping");
        if (recibido.includes("eco:ping")) {
          socket.destroy();
          resolver(recibido);
        }
      });
      socket.on("error", rechazar);
    });
    expect(respuesta).toContain("101 Switching Protocols");
    expect(respuesta).toContain("eco:ping");
  });

  it("con el programa caído contesta 502 con una explicación, no se cuelga", async () => {
    const puerto = await arrancar();
    destino.close();
    destino.closeAllConnections();
    const r = await fetch(`http://127.0.0.1:${puerto}/otra`);
    expect(r.status).toBe(502);
  });
});

describe("inyectarSelector", () => {
  it("una sola vez, y sin </head> va al principio", () => {
    const una = inyectarSelector("<html><HEAD></HEAD></html>");
    expect(inyectarSelector(una)).toBe(una);
    expect(inyectarSelector("<div>x</div>").startsWith("<script")).toBe(true);
  });
});

/**
 * La sonda corre adentro de la app de otro: se ejecuta en una VM con un
 * `window` mínimo para fijar lo que promete — envolver sin romper, y no
 * soltarle nada a nadie hasta que el IDE salude desde su origen.
 */
describe("sonda del inspector", () => {
  function montar() {
    const enviados: Array<{ m: Record<string, unknown>; destino: string }> = [];
    const oyentes: Record<string, Array<(e: unknown) => void>> = {};
    const padre = { postMessage: (m: Record<string, unknown>, destino: string) => enviados.push({ m, destino }) };
    const logs: unknown[][] = [];
    class XHR {
      status = 0;
      responseType = "";
      responseText = "";
      private fin: (() => void) | null = null;
      open() {}
      send() {
        this.status = 401;
        this.responseText = '{"error":"AUTH_TOKEN_MISSING"}';
        queueMicrotask(() => this.fin?.());
      }
      addEventListener(_t: string, f: () => void) {
        this.fin = f;
      }
      getResponseHeader() {
        return "application/json";
      }
    }
    class FormDataFalso {
      constructor(private readonly campos: Array<[string, unknown]>) {}
      forEach(f: (v: unknown, k: string) => void) {
        for (const [k, v] of this.campos) f(v, k);
      }
    }
    const window: Record<string, unknown> = {
      parent: padre,
      addEventListener: (t: string, f: (e: unknown) => void) => ((oyentes[t] ??= []).push(f)),
      fetch: async () => ({ status: 500, headers: { get: () => "text/plain" }, clone: () => ({ text: async () => "boom" }) }),
    };
    const documento = { addEventListener: () => {}, documentElement: { style: {} } };
    const consola = { log: (...a: unknown[]) => logs.push(a), info() {}, warn() {}, error: (...a: unknown[]) => logs.push(a), debug() {} };
    const XMLHttpRequest = XHR as unknown as { prototype: Record<string, unknown> };
    runInNewContext(SELECTOR_JS, {
      window,
      document: documento,
      console: consola,
      location: { pathname: "/fotos", search: "", hash: "" },
      XMLHttpRequest,
      FormData: FormDataFalso,
      Blob: class {},
    });
    const saludar = (origen: string) => oyentes.message?.forEach((f) => f({ data: { tipo: "orq-inspector" }, source: padre, origin: origen }));
    return { window, consola, logs, enviados, saludar, XHR, FormDataFalso };
  }

  it("no suelta nada hasta el saludo, y después sólo al origen que saludó", async () => {
    const { consola, logs, enviados, saludar } = montar();
    consola.error("falló algo", { codigo: 7 });
    expect(logs).toEqual([["falló algo", { codigo: 7 }]]); // la consola original sigue andando
    expect(enviados.map((e) => e.m.tipo)).toEqual(["orq-selector-listo"]);
    expect(enviados[0]!.destino).toBe("*");
    saludar("http://localhost:5173");
    const consolaEnviada = enviados.find((e) => e.m.tipo === "orq-consola")!;
    expect(consolaEnviada.destino).toBe("http://localhost:5173");
    expect(consolaEnviada.m).toMatchObject({ nivel: "error", texto: 'falló algo {"codigo":7}', ruta: "/fotos" });
  });

  it("registra un XHR fallido con su respuesta y los archivos del multipart", async () => {
    const { enviados, saludar, XHR, FormDataFalso } = montar();
    saludar("http://localhost:5173");
    const x = new XHR() as unknown as { open(m: string, u: string): void; send(b: unknown): void };
    x.open("post", "http://127.0.0.1:4300/api/photos/upload");
    x.send(new FormDataFalso([["foto", { name: "tablero.jpg", size: 2048, type: "image/jpeg" }], ["nota", "hola"]]));
    await new Promise((r) => setTimeout(r, 0));
    const red = enviados.filter((e) => e.m.tipo === "orq-red").map((e) => e.m);
    expect(red[0]).toMatchObject({ fase: "inicio", metodo: "POST", cuerpo: "multipart — foto: tablero.jpg (2048 B, image/jpeg)" });
    expect(red[1]).toMatchObject({ fase: "fin", estado: 401, respuesta: '{"error":"AUTH_TOKEN_MISSING"}' });
  });

  it("registra un fetch con error y le devuelve la respuesta intacta a la app", async () => {
    const { window, enviados, saludar } = montar();
    saludar("http://localhost:5173");
    const r = await (window.fetch as (u: string) => Promise<{ status: number }>)("/api/x");
    expect(r.status).toBe(500);
    await new Promise((res) => setTimeout(res, 0));
    const fin = enviados.find((e) => e.m.tipo === "orq-red" && e.m.fase === "fin")!.m;
    expect(fin).toMatchObject({ estado: 500, respuesta: "boom" });
  });

  it("no lleva backticks ni interpolaciones que cierren el template", () => {
    expect(SELECTOR_JS).not.toContain("`");
    expect(SELECTOR_JS).not.toContain("${");
  });
});
