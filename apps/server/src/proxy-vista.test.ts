import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { RUTA_SELECTOR, inyectarSelector, levantarProxyDeVista, type ProxyDeVista } from "./proxy-vista.js";

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
    expect(html).toContain(`<script src="${RUTA_SELECTOR}" defer></script></head>`);
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
