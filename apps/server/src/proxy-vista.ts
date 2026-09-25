import { createServer, request as pedirHttp, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";

/**
 * Un proxy delante de cada frontend levantado, para poder **señalar** en la
 * vista previa.
 *
 * El iframe de la vista previa es otro origen (`127.0.0.1:43xx`) y el IDE no
 * puede tocar su DOM: sin algo corriendo adentro de la página no hay forma de
 * saber qué elemento tocó la persona. Este proxy reenvía todo tal cual —las
 * respuestas, y los websockets de la recarga en caliente de Vite y de Metro— y
 * a las páginas HTML les agrega un `<script>` chico, el selector
 * (`SELECTOR_JS`), que duerme hasta que el IDE lo despierta por `postMessage`.
 *
 * Es un puerto propio y no un prefijo del servidor del orquestador (`/vista/…`)
 * a propósito: Vite y Metro piden `/@vite/client`, `/src/…`, `/node_modules/…`
 * con rutas absolutas y abren su websocket en la raíz, y debajo de un prefijo
 * nada de eso existe.
 */

export const RUTA_SELECTOR = "/__orq__/selector.js";

export interface ProxyDeVista {
  cerrar(): void;
}

export function levantarProxyDeVista(opciones: { puerto: number; destino: number }): Promise<ProxyDeVista> {
  const { puerto, destino } = opciones;

  const servidor: Server = createServer((req, res) => {
    if (req.url === RUTA_SELECTOR) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(SELECTOR_JS);
      return;
    }
    const cabeceras: IncomingHttpHeaders = { ...req.headers };
    // Una página comprimida no se puede tocar sin descomprimirla: se pide sin
    // comprimir sólo lo que puede ser HTML. El resto viaja como vino.
    //
    // Y sin pedidos condicionales: si el programa contesta 304, el navegador
    // usa la página que tenía guardada —la de antes del selector, o la de
    // cuando ese puerto lo atendía el programa directo— y el selector no está.
    if ((req.headers.accept ?? "").includes("text/html")) {
      delete cabeceras["accept-encoding"];
      delete cabeceras["if-none-match"];
      delete cabeceras["if-modified-since"];
    }

    const salida = pedirHttp(
      { host: "127.0.0.1", port: destino, method: req.method, path: req.url, headers: cabeceras },
      (respuesta) => {
        const tipo = String(respuesta.headers["content-type"] ?? "");
        if (!tipo.includes("text/html") || respuesta.headers["content-encoding"]) {
          res.writeHead(respuesta.statusCode ?? 502, respuesta.headers);
          respuesta.pipe(res);
          return;
        }
        const trozos: Buffer[] = [];
        respuesta.on("data", (t: Buffer) => trozos.push(t));
        respuesta.on("end", () => {
          const html = inyectarSelector(Buffer.concat(trozos).toString("utf8"));
          // Con el cuerpo reescrito, las cabeceras de transporte del original
          // mienten: `chunked` junto con `content-length` es una respuesta
          // inválida y el navegador la descarta entera.
          const { "content-length": _largo, "transfer-encoding": _transferencia, etag: _etag, ...resto } = respuesta.headers;
          res.writeHead(respuesta.statusCode ?? 200, { ...resto, "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
          res.end(html);
        });
      },
    );
    salida.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("El servicio todavía no responde. Esperá a que termine de arrancar y recargá.");
    });
    req.pipe(salida);
  });

  // Los websockets (recarga en caliente) se reenvían crudos: se reescribe la
  // primera línea y las cabeceras tal como llegaron, y después se une un
  // socket con el otro.
  servidor.on("upgrade", (req, socket, cabeza) => {
    const arriba = connect(destino, "127.0.0.1", () => {
      const lineas = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lineas.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      arriba.write(`${lineas.join("\r\n")}\r\n\r\n`);
      if (cabeza.length) arriba.write(cabeza);
      socket.pipe(arriba).pipe(socket);
    });
    arriba.on("error", () => socket.destroy());
    socket.on("error", () => arriba.destroy());
  });

  return new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(puerto, "127.0.0.1", () => {
      servidor.off("error", rechazar);
      resolver({
        cerrar: () => {
          servidor.close();
          servidor.closeAllConnections();
        },
      });
    });
  });
}

/** Antes de `</head>` si lo hay; si no, al principio. Nunca dos veces. */
export function inyectarSelector(html: string): string {
  if (html.includes(RUTA_SELECTOR)) return html;
  const etiqueta = `<script src="${RUTA_SELECTOR}" defer></script>`;
  const cierre = html.search(/<\/head>/i);
  return cierre >= 0 ? `${html.slice(0, cierre)}${etiqueta}${html.slice(cierre)}` : `${etiqueta}${html}`;
}

/**
 * El selector que corre adentro de la página. Va como `String.raw` para que
 * ninguna barra se pierda en el camino, y **sin backticks ni `${`** adentro:
 * cerrarían el template (la trampa ya documentada en CLAUDE.md). Los
 * comentarios sobre su comportamiento van acá afuera:
 *
 * - Sólo se activa dentro de un iframe y cuando el IDE se lo pide; responde
 *   únicamente al origen que lo activó.
 * - Mientras está activo se come los clics (en captura): elegir un botón no lo
 *   aprieta.
 * - Del elemento manda lo que sirve para encontrarlo en el código: la ruta de
 *   la app, la cadena de componentes de React (leída de la fibra que React
 *   cuelga del nodo en desarrollo), el archivo fuente si React lo expone
 *   (`_debugSource`, hasta React 18), el texto, atributos y el HTML recortado.
 * - Esc cancela.
 */
const SELECTOR_JS = String.raw`(function () {
  if (window.__orqSelector || window.parent === window) return;
  window.__orqSelector = true;
  var activo = false, origen = null, caja = null, rotulo = null, actual = null;
  var Z = "2147483647";

  function estilo(el, css) { for (var k in css) el.style[k] = css[k]; }
  function crear() {
    caja = document.createElement("div");
    estilo(caja, { position: "fixed", pointerEvents: "none", zIndex: Z, border: "2px solid #3b82f6", background: "rgba(59,130,246,0.12)", borderRadius: "3px", display: "none", boxSizing: "border-box" });
    rotulo = document.createElement("div");
    estilo(rotulo, { position: "fixed", pointerEvents: "none", zIndex: Z, background: "#1d4ed8", color: "#fff", font: "11px/1.4 ui-monospace, monospace", padding: "2px 6px", borderRadius: "3px", display: "none", whiteSpace: "nowrap" });
    document.documentElement.appendChild(caja);
    document.documentElement.appendChild(rotulo);
  }

  function fibra(el) {
    for (var k in el) if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return el[k];
    return null;
  }
  function componentes(el) {
    var nombres = [], fuentes = [], f = fibra(el), vueltas = 0;
    while (f && vueltas < 80 && nombres.length < 8) {
      vueltas++;
      var t = f.type;
      var nombre = t && typeof t !== "string" ? (t.displayName || t.name || (t.render && (t.render.displayName || t.render.name))) : null;
      if (nombre && /^[A-Z]/.test(nombre) && nombres.indexOf(nombre) < 0) nombres.push(nombre);
      var s = f._debugSource;
      if (s && s.fileName && fuentes.length < 4) fuentes.push(s.fileName + ":" + s.lineNumber);
      f = f.return;
    }
    return { nombres: nombres, fuentes: fuentes };
  }
  function selectorDe(el) {
    var partes = [];
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      var p = n.tagName.toLowerCase();
      if (n.id) { partes.unshift(p + "#" + n.id); break; }
      var clases = (typeof n.className === "string" ? n.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (clases.length) p += "." + clases.join(".");
      var padre = n.parentElement;
      if (padre) {
        var iguales = Array.prototype.filter.call(padre.children, function (c) { return c.tagName === n.tagName; });
        if (iguales.length > 1) p += ":nth-of-type(" + (iguales.indexOf(n) + 1) + ")";
      }
      partes.unshift(p);
    }
    return partes.join(" > ");
  }
  function describir(el) {
    var r = el.getBoundingClientRect(), c = componentes(el), atributos = {};
    ["id", "class", "role", "aria-label", "data-testid", "name", "placeholder", "href", "type", "title", "alt"].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (v) atributos[a] = String(v).slice(0, 200);
    });
    return {
      etiqueta: el.tagName.toLowerCase(),
      selector: selectorDe(el),
      texto: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
      html: (el.outerHTML || "").slice(0, 2500),
      componentes: c.nombres,
      fuentes: c.fuentes,
      atributos: atributos,
      ruta: location.pathname + location.search + location.hash,
      titulo: document.title,
      tamano: Math.round(r.width) + "x" + Math.round(r.height)
    };
  }
  function enviar(m) { if (origen) window.parent.postMessage(m, origen); }
  function mover(e) {
    if (!activo) return;
    var el = e.target;
    if (!el || el === caja || el === rotulo || el.nodeType !== 1) return;
    actual = el;
    var r = el.getBoundingClientRect();
    estilo(caja, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    var c = componentes(el).nombres[0];
    rotulo.textContent = el.tagName.toLowerCase() + (c ? " · " + c : "") + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    estilo(rotulo, { display: "block", left: Math.max(0, r.left) + "px", top: (r.top > 22 ? r.top - 22 : r.bottom + 4) + "px" });
  }
  function comer(e) { if (!activo) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  function clic(e) {
    if (!activo) return;
    comer(e);
    enviar({ tipo: "orq-elemento", elemento: describir(actual || e.target) });
    desactivar();
  }
  function tecla(e) {
    if (activo && e.key === "Escape") { comer(e); desactivar(); enviar({ tipo: "orq-seleccion-cancelada" }); }
  }
  function activar() {
    if (!caja) crear();
    activo = true;
    document.documentElement.style.cursor = "crosshair";
  }
  function desactivar() {
    activo = false;
    actual = null;
    if (caja) { caja.style.display = "none"; rotulo.style.display = "none"; }
    document.documentElement.style.cursor = "";
  }
  document.addEventListener("mousemove", mover, true);
  document.addEventListener("click", clic, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "dblclick", "submit"].forEach(function (t) { document.addEventListener(t, comer, true); });
  document.addEventListener("keydown", tecla, true);
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.tipo !== "orq-seleccionar") return;
    origen = e.origin;
    if (d.activo) activar(); else desactivar();
  });
  window.parent.postMessage({ tipo: "orq-selector-listo" }, "*");
})();`;
