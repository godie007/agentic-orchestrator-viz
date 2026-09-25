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

/**
 * **Al principio** del `<head>` y sin `defer`: la sonda del inspector tiene que
 * envolver `console`, `fetch` y `XMLHttpRequest` antes de que corra un solo
 * script de la app, o se pierde justo lo que falla al arrancar. Nunca dos veces.
 */
export function inyectarSelector(html: string): string {
  if (html.includes(RUTA_SELECTOR)) return html;
  const etiqueta = `<script src="${RUTA_SELECTOR}"></script>`;
  const apertura = /<head[^>]*>/i.exec(html);
  if (apertura) {
    const fin = apertura.index + apertura[0].length;
    return `${html.slice(0, fin)}${etiqueta}${html.slice(fin)}`;
  }
  return `${etiqueta}${html}`;
}

/**
 * Lo que corre adentro de la página: la **sonda del inspector** y el
 * **selector de elementos**. Va como `String.raw` para que ninguna barra se
 * pierda, y **sin backticks ni `${`** adentro: cerrarían el template (la
 * trampa ya documentada en CLAUDE.md). Los comentarios sobre su
 * comportamiento van acá afuera:
 *
 * - Sólo hace algo dentro de un iframe. Nada sale hacia el IDE hasta que el IDE
 *   saluda (`orq-inspector`) desde su origen: lo que registró antes espera en
 *   una cola acotada, y a partir de ahí sólo le habla a ese origen. El único
 *   mensaje a `*` es el aviso de "estoy lista", sin datos.
 * - Consola: `log/info/warn/error/debug`, excepciones sin capturar y promesas
 *   rechazadas, con su stack; un recurso que no carga (script, imagen) también.
 * - Red: `fetch` y `XMLHttpRequest` (axios usa el segundo). De lo que falla
 *   (4xx, 5xx, sin respuesta) se guarda el cuerpo de la respuesta —ahí está el
 *   mensaje del backend—; de lo que se envía, sólo la descripción de un
 *   `multipart` (nombre, tamaño y tipo de cada archivo), que es lo que hace
 *   falta para diagnosticar una subida. Nunca cabeceras: ahí va el token.
 * - Selector: el de siempre (ver el IDE): duerme hasta que lo activan, se come
 *   los clics mientras está activo, Esc cancela.
 */
export const SELECTOR_JS = String.raw`(function () {
  if (window.__orqSonda || window.parent === window) return;
  window.__orqSonda = true;
  var origen = null, cola = [], MAX_COLA = 500, seq = 0;
  function enviar(m) {
    if (origen) { try { window.parent.postMessage(m, origen); } catch (e) {} return; }
    cola.push(m);
    if (cola.length > MAX_COLA) cola.shift();
  }
  function aTexto(v) {
    try {
      if (v instanceof Error) return v.stack || (v.name + ": " + v.message);
      if (typeof v === "string") return v;
      if (v && typeof v === "object") { var s = JSON.stringify(v); return s && s.length > 2000 ? s.slice(0, 2000) + "…" : String(s); }
      return String(v);
    } catch (e) { return String(v); }
  }
  function ruta() { return location.pathname + location.search; }

  ["log", "info", "warn", "error", "debug"].forEach(function (nivel) {
    var original = console[nivel];
    if (typeof original !== "function") return;
    console[nivel] = function () {
      try {
        var partes = Array.prototype.map.call(arguments, aTexto);
        enviar({ tipo: "orq-consola", nivel: nivel, texto: partes.join(" ").slice(0, 6000), at: Date.now(), ruta: ruta() });
      } catch (e) {}
      return original.apply(this, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      enviar({ tipo: "orq-consola", nivel: "error", texto: "No se pudo cargar " + t.tagName.toLowerCase() + ": " + (t.src || t.href || ""), at: Date.now(), ruta: ruta() });
      return;
    }
    var texto = (e.error && e.error.stack) || (e.message + " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")");
    enviar({ tipo: "orq-consola", nivel: "error", texto: texto, at: Date.now(), ruta: ruta(), excepcion: true });
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    enviar({ tipo: "orq-consola", nivel: "error", texto: "Promesa rechazada sin manejar: " + aTexto(e.reason), at: Date.now(), ruta: ruta(), excepcion: true });
  });

  function describirCuerpo(b) {
    try {
      if (!b) return null;
      if (typeof FormData !== "undefined" && b instanceof FormData) {
        var archivos = [];
        b.forEach(function (v, k) {
          if (v && typeof v === "object" && "name" in v && "size" in v) archivos.push(k + ": " + v.name + " (" + v.size + " B, " + (v.type || "sin tipo") + ")");
        });
        return "multipart" + (archivos.length ? " — " + archivos.join(", ") : "");
      }
      if (typeof Blob !== "undefined" && b instanceof Blob) return "blob (" + b.size + " B, " + (b.type || "sin tipo") + ")";
      if (typeof b === "string") return "texto (" + b.length + " caracteres)";
    } catch (e) {}
    return null;
  }
  var fetchOriginal = window.fetch;
  if (typeof fetchOriginal === "function") {
    window.fetch = function (entrada, init) {
      var id = ++seq, inicio = Date.now();
      var url = typeof entrada === "string" ? entrada : (entrada && entrada.url) || String(entrada);
      var metodo = String((init && init.method) || (entrada && entrada.method) || "GET").toUpperCase();
      enviar({ tipo: "orq-red", id: id, fase: "inicio", metodo: metodo, url: url, cuerpo: describirCuerpo(init && init.body), at: inicio, ruta: ruta() });
      return fetchOriginal.apply(this, arguments).then(function (r) {
        var fin = { tipo: "orq-red", id: id, fase: "fin", estado: r.status, ms: Date.now() - inicio, tipoContenido: r.headers.get("content-type") };
        if (r.status >= 400) {
          r.clone().text().then(function (t) { fin.respuesta = t.slice(0, 4000); enviar(fin); }, function () { enviar(fin); });
        } else {
          enviar(fin);
        }
        return r;
      }, function (err) {
        enviar({ tipo: "orq-red", id: id, fase: "fin", estado: 0, ms: Date.now() - inicio, error: aTexto(err) });
        throw err;
      });
    };
  }
  var abrirXhr = XMLHttpRequest.prototype.open, enviarXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__orq = { metodo: String(metodo).toUpperCase(), url: String(url) };
    return abrirXhr.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (cuerpo) {
    var x = this, info = x.__orq || { metodo: "GET", url: "?" }, id = ++seq, inicio = Date.now();
    enviar({ tipo: "orq-red", id: id, fase: "inicio", metodo: info.metodo, url: info.url, cuerpo: describirCuerpo(cuerpo), at: inicio, ruta: ruta() });
    x.addEventListener("loadend", function () {
      var fin = { tipo: "orq-red", id: id, fase: "fin", estado: x.status, ms: Date.now() - inicio, tipoContenido: x.getResponseHeader ? x.getResponseHeader("content-type") : null };
      if (x.status === 0) fin.error = "Sin respuesta: red caída, CORS rechazado o pedido cancelado.";
      if (x.status >= 400) {
        try {
          var t = x.responseType === "" || x.responseType === "text" ? x.responseText : x.responseType === "json" ? JSON.stringify(x.response) : "";
          fin.respuesta = String(t || "").slice(0, 4000);
        } catch (e) {}
      }
      enviar(fin);
    });
    return enviarXhr.apply(this, arguments);
  };

  var activo = false, caja = null, rotulo = null, actual = null;
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
    if (!d || e.source !== window.parent) return;
    if (d.tipo === "orq-inspector" || d.tipo === "orq-seleccionar") {
      if (origen !== e.origin) {
        origen = e.origin;
        var pendientes = cola;
        cola = [];
        pendientes.forEach(enviar);
      }
    }
    if (d.tipo === "orq-seleccionar") { if (d.activo) activar(); else desactivar(); }
  });
  window.parent.postMessage({ tipo: "orq-selector-listo" }, "*");
})();`;
