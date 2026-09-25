import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bug, ExternalLink, Loader2, Monitor, MousePointerClick, Play, RotateCw, Send, Smartphone, Tablet } from "lucide-react";
import { api, type RespuestaDeServicio, type ServicioConEstado } from "../../api.js";
import { COLOR_ESTADO, ICONO_SERVICIO, useServicios } from "./Servicios.js";
import { Salida } from "./SalidaDeServicio.js";
import { esElemento, type ElementoSeleccionado } from "./elemento.js";
import { aplicarRed, consolaDesdeMensaje, esError, type FallaDeVista, type Registro } from "./sonda.js";
import { Inspector } from "./Inspector.js";

/**
 * La pestaña de un servicio levantado: el frontend o la app móvil en un
 * navegador embebido, o una consola para pegarle a la API.
 *
 * El iframe apunta **directo** al puerto del servicio (`127.0.0.1:43xx`), no a
 * un proxy del orquestador: Vite y Metro piden `/@vite/client`, `/src/…` y
 * abren un websocket para la recarga, todo con rutas absolutas, y debajo de un
 * prefijo se rompe. Como es otro origen, lo que corre adentro no puede tocar la
 * app ni leer la API del orquestador (su CORS no lo admite); `allow-same-origin`
 * sólo le deja usar su propio almacenamiento, que es donde una app guarda la
 * sesión de su login.
 */

/** Lo que se conserva del inspector: una app que loguea en bucle no puede comerse la memoria. */
const TOPE_REGISTROS = 1_000;

type Dispositivo = "escritorio" | "tablet" | "movil";
const ANCHOS: Record<Dispositivo, number | null> = { escritorio: null, tablet: 820, movil: 390 };

export function VistaDeServicio({
  repoId,
  servicioId,
  onElemento,
  onFalla,
}: {
  repoId: string;
  servicioId: string;
  /** La persona señaló un elemento de la app: va al chat como contexto. */
  onElemento?: (servicio: ServicioConEstado, elemento: ElementoSeleccionado) => void;
  /** Un error de consola o un pedido fallido del inspector: al chat. */
  onFalla?: (servicio: ServicioConEstado, falla: FallaDeVista) => void;
}) {
  const consulta = useServicios(repoId);
  const s = consulta.data?.servicios.find((x) => x.id === servicioId) ?? null;
  if (!s) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ink-faint">{consulta.isLoading ? "Cargando…" : "El servicio ya no existe."}</div>;
  }
  if (s.vivo.estado !== "listo" || !s.vivo.url) return <NoLevantado repoId={repoId} s={s} />;
  return s.tipo === "api" ? (
    <ConsolaDeApi repoId={repoId} s={s} url={s.vivo.url} />
  ) : (
    <Navegador
      s={s}
      url={s.vivo.url}
      {...(onElemento ? { onElemento: (e: ElementoSeleccionado) => onElemento(s, e) } : {})}
      {...(onFalla ? { onFalla: (f: FallaDeVista) => onFalla(s, f) } : {})}
    />
  );
}

function NoLevantado({ repoId, s }: { repoId: string; s: ServicioConEstado }) {
  const queryClient = useQueryClient();
  const arrancar = useMutation({
    mutationFn: async () => {
      if (s.preparado === false) await api.prepararServicio(repoId, s.id);
      else await api.arrancarServicio(repoId, s.id);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["servicios", repoId] }),
  });
  const Icono = ICONO_SERVICIO[s.tipo];
  const trabajando = s.vivo.estado === "arrancando" || s.vivo.estado === "preparando";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col items-center gap-3 px-6 pt-10 pb-6 text-center">
        <Icono className="size-10 text-ink-faint" aria-hidden />
        <h2 className="text-[15px] font-semibold text-ink">{s.nombre}</h2>
        <p className="max-w-md text-[12px] leading-relaxed text-ink-faint">
          {trabajando
            ? s.vivo.estado === "preparando"
              ? "Instalando dependencias en la sesión…"
              : "Arrancando: la vista aparece sola cuando responda."
            : s.vivo.estado === "fallo"
              ? s.vivo.detalle ?? "No arrancó."
              : s.preparado === false
                ? "Faltan las dependencias en la sesión. Se copian de tu carpeta si el lockfile es el mismo (instantáneo), o se instalan."
                : "Está detenido. Se levanta sobre la sesión de los agentes, en un puerto propio, y se recarga solo con cada edición."}
        </p>
        {trabajando ? (
          <Loader2 className="size-5 animate-spin text-accent" aria-hidden />
        ) : (
          <button
            type="button"
            disabled={arrancar.isPending || !s.arrancar}
            onClick={() => arrancar.mutate()}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Play className="size-3.5" aria-hidden />
            {s.preparado === false ? "Instalar dependencias" : s.vivo.estado === "fallo" ? "Volver a intentar" : "Levantar"}
          </button>
        )}
        {arrancar.error && <p className="text-[12px] text-danger">{(arrancar.error as Error).message}</p>}
      </div>
      <div className="min-h-0 flex-1 border-t border-line">
        <Salida repoId={repoId} servicioId={s.id} />
      </div>
    </div>
  );
}

function Navegador({
  s,
  url,
  onElemento,
  onFalla,
}: {
  s: ServicioConEstado;
  url: string;
  onElemento?: (elemento: ElementoSeleccionado) => void;
  onFalla?: (falla: FallaDeVista) => void;
}) {
  const [dispositivo, setDispositivo] = useState<Dispositivo>(s.tipo === "movil" ? "movil" : "escritorio");
  const marco = useRef<HTMLIFrameElement>(null);
  const origen = new URL(url).origin;
  const [seleccionando, setSeleccionando] = useState(false);
  /** El selector lo inyecta el proxy de la vista previa; si no respondió, la página no es HTML servido por él. */
  const [selectorListo, setSelectorListo] = useState(false);
  const seleccionandoRef = useRef(false);
  seleccionandoRef.current = seleccionando;
  /** Consola y red de la página, como DevTools. Cada carga de página empieza de cero. */
  const [registros, setRegistros] = useState<Registro[]>([]);
  const [inspectorAbierto, setInspectorAbierto] = useState(false);
  const idConsola = useRef(0);
  const errores = registros.filter(esError).length;

  const avisarAlSelector = (activo: boolean) =>
    marco.current?.contentWindow?.postMessage({ tipo: "orq-seleccionar", activo }, origen);

  // El selector corre adentro de la página (otro origen): se habla por
  // mensajes, y sólo se le cree al origen del servicio.
  useEffect(() => {
    const alRecibir = (e: MessageEvent) => {
      if (e.origin !== origen || e.source !== marco.current?.contentWindow) return;
      const dato = e.data as { tipo?: string; elemento?: unknown } | null;
      if (dato?.tipo === "orq-consola") {
        const r = consolaDesdeMensaje(dato as Record<string, unknown>, ++idConsola.current);
        if (r) setRegistros((previos) => [...previos, r].slice(-TOPE_REGISTROS));
      } else if (dato?.tipo === "orq-red") {
        setRegistros((previos) => aplicarRed(previos, dato as Record<string, unknown>).slice(-TOPE_REGISTROS));
      } else if (dato?.tipo === "orq-selector-listo") {
        setSelectorListo(true);
        // Página nueva: lo registrado es de la anterior. El saludo le fija a
        // la sonda a quién hablarle, y recién ahí suelta lo que juntó al cargar.
        setRegistros([]);
        marco.current?.contentWindow?.postMessage({ tipo: "orq-inspector" }, origen);
        // Una recarga (la de Vite al editar) vuelve a montar el selector
        // apagado: si se estaba señalando, se vuelve a encender.
        if (seleccionandoRef.current) avisarAlSelector(true);
      } else if (dato?.tipo === "orq-elemento" && esElemento(dato.elemento)) {
        setSeleccionando(false);
        onElemento?.(dato.elemento);
      } else if (dato?.tipo === "orq-seleccion-cancelada") {
        setSeleccionando(false);
      }
    };
    window.addEventListener("message", alRecibir);
    return () => window.removeEventListener("message", alRecibir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origen, onElemento]);

  const alternarSeleccion = () => {
    const activo = !seleccionando;
    setSeleccionando(activo);
    avisarAlSelector(activo);
    if (activo) marco.current?.focus();
  };
  const [ruta, setRuta] = useState(s.inicio || "/");
  const [direccion, setDireccion] = useState(s.inicio || "/");
  const [recargas, setRecargas] = useState(0);
  // Un reinicio cambia `desde`: el iframe se vuelve a cargar solo.
  const clave = `${url}${ruta}#${recargas}#${s.vivo.desde ?? 0}`;
  const ancho = ANCHOS[dispositivo];
  const boton = (activo: boolean) =>
    `rounded p-1 hover:bg-surface-2 ${activo ? "text-accent" : "text-ink-dim hover:text-ink"}`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2">
        <button type="button" title="Recargar" onClick={() => setRecargas((n) => n + 1)} className={boton(false)}>
          <RotateCw className="size-3.5" aria-hidden />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center rounded border border-line bg-canvas px-2"
          onSubmit={(e) => {
            e.preventDefault();
            const limpia = direccion.trim() || "/";
            setRuta(limpia.startsWith("/") ? limpia : `/${limpia}`);
            setRecargas((n) => n + 1);
          }}
        >
          <span className={`mr-1.5 size-2 shrink-0 rounded-full ${COLOR_ESTADO[s.vivo.estado]}`} aria-hidden />
          <span className="shrink-0 font-mono text-[12px] text-ink-faint">{url}</span>
          <input
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            aria-label="Ruta"
            className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none"
          />
        </form>
        {onElemento && (
          <button
            type="button"
            title={
              selectorListo
                ? "Señalar un elemento de la app para pedirle un cambio al chat (Esc cancela)"
                : "El selector todavía no cargó: recargá la vista si no aparece"
            }
            onClick={alternarSeleccion}
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-[12px] ${
              seleccionando ? "bg-accent text-white" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <MousePointerClick className="size-3.5" aria-hidden />
            <span className="hidden lg:inline">{seleccionando ? "Elegí un elemento…" : "Seleccionar"}</span>
          </button>
        )}
        <button
          type="button"
          title="Inspector: la consola y los pedidos de red de la app, para ver qué falla"
          onClick={() => setInspectorAbierto((v) => !v)}
          className={`relative flex items-center gap-1 rounded px-1.5 py-1 text-[12px] ${
            inspectorAbierto ? "bg-surface-2 text-ink" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
          }`}
        >
          <Bug className="size-3.5" aria-hidden />
          <span className="hidden lg:inline">Inspector</span>
          {errores > 0 && (
            <span className="rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{errores > 99 ? "99+" : errores}</span>
          )}
        </button>
        <span className="flex items-center gap-0.5 border-l border-line pl-1.5">
          <button type="button" title="Escritorio" onClick={() => setDispositivo("escritorio")} className={boton(dispositivo === "escritorio")}>
            <Monitor className="size-3.5" aria-hidden />
          </button>
          <button type="button" title="Tablet (820 px)" onClick={() => setDispositivo("tablet")} className={boton(dispositivo === "tablet")}>
            <Tablet className="size-3.5" aria-hidden />
          </button>
          <button type="button" title="Teléfono (390 px)" onClick={() => setDispositivo("movil")} className={boton(dispositivo === "movil")}>
            <Smartphone className="size-3.5" aria-hidden />
          </button>
        </span>
        <a href={url + ruta} target="_blank" rel="noopener noreferrer" title="Abrir en una pestaña del navegador" className={boton(false)}>
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      {seleccionando && (
        <div className="flex shrink-0 items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 py-1 text-[12px] text-ink">
          <MousePointerClick className="size-3.5 text-accent" aria-hidden />
          Hacé clic en la parte de la app que querés cambiar: va al chat con su componente y sus archivos.
          <span className="flex-1" />
          <button type="button" onClick={alternarSeleccion} className="text-ink-faint hover:text-ink">
            Cancelar (Esc)
          </button>
        </div>
      )}
      <div className={`flex min-h-0 flex-1 justify-center overflow-auto ${ancho ? "bg-surface-2 p-4" : ""}`}>
        <iframe
          ref={marco}
          key={clave}
          src={url + ruta}
          title={`Vista previa de ${s.nombre}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          style={ancho ? { width: ancho, maxWidth: "100%" } : undefined}
          className={`min-h-0 border-0 bg-white ${ancho ? `h-full shrink-0 rounded-[18px] shadow-xl ring-8 ring-ink/80` : "h-full w-full"}`}
        />
      </div>
      {inspectorAbierto && (
        <Inspector
          registros={registros}
          sondaActiva={selectorListo}
          onLimpiar={() => setRegistros([])}
          onCerrar={() => setInspectorAbierto(false)}
          {...(onFalla ? { onFalla } : {})}
        />
      )}
    </div>
  );
}

interface Pedido {
  id: number;
  metodo: string;
  ruta: string;
  respuesta: RespuestaDeServicio | null;
  error: string | null;
}

function ConsolaDeApi({ repoId, s, url }: { repoId: string; s: ServicioConEstado; url: string }) {
  const [metodo, setMetodo] = useState("GET");
  const [ruta, setRuta] = useState(s.salud ?? "/");
  const [cabeceras, setCabeceras] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [historial, setHistorial] = useState<Pedido[]>([]);
  const [elegido, setElegido] = useState<number | null>(null);

  const enviar = useMutation({
    mutationFn: async () => {
      const id = Date.now();
      const extra: Record<string, string> = {};
      for (const linea of cabeceras.split("\n")) {
        const i = linea.indexOf(":");
        if (i > 0) extra[linea.slice(0, i).trim()] = linea.slice(i + 1).trim();
      }
      setHistorial((h) => [{ id, metodo, ruta, respuesta: null, error: null }, ...h].slice(0, 30));
      setElegido(id);
      try {
        const respuesta = await api.probarServicio(repoId, s.id, {
          metodo,
          ruta: ruta.startsWith("/") ? ruta : `/${ruta}`,
          ...(cuerpo.trim() && metodo !== "GET" ? { cuerpo } : {}),
          ...(Object.keys(extra).length ? { cabeceras: extra } : {}),
        });
        setHistorial((h) => h.map((p) => (p.id === id ? { ...p, respuesta } : p)));
      } catch (e) {
        setHistorial((h) => h.map((p) => (p.id === id ? { ...p, error: (e as Error).message } : p)));
      }
    },
  });

  // La primera vez, un pedido a la salud: es lo que la persona quiere ver. El
  // ref evita el segundo que dispara el doble montaje de StrictMode.
  const inicial = useRef(false);
  useEffect(() => {
    if (inicial.current) return;
    inicial.current = true;
    enviar.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actual = historial.find((p) => p.id === elegido) ?? historial[0] ?? null;
  const colorEstado = (n: number) => (n < 300 ? "text-ok" : n < 400 ? "text-accent" : n < 500 ? "text-warn" : "text-danger");

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] bg-canvas">
      <form
        className="space-y-2 border-b border-line bg-surface p-2"
        onSubmit={(e) => {
          e.preventDefault();
          enviar.mutate();
        }}
      >
        <div className="flex items-center gap-1.5">
          <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="h-7 rounded border border-line bg-canvas px-1 font-mono text-[12px] font-semibold text-ink">
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <div className="flex min-w-0 flex-1 items-center rounded border border-line bg-canvas px-2">
            <span className="shrink-0 font-mono text-[12px] text-ink-faint">{url}</span>
            <input value={ruta} onChange={(e) => setRuta(e.target.value)} aria-label="Ruta" className="h-7 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none" />
          </div>
          <button type="submit" disabled={enviar.isPending} className="flex h-7 items-center gap-1.5 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {enviar.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            Enviar
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <textarea
            value={cabeceras}
            onChange={(e) => setCabeceras(e.target.value)}
            rows={2}
            placeholder={"Cabeceras, una por renglón\nAuthorization: Bearer …"}
            className="rounded border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          <textarea
            value={cuerpo}
            onChange={(e) => setCuerpo(e.target.value)}
            rows={2}
            disabled={metodo === "GET" || metodo === "HEAD"}
            placeholder={metodo === "GET" ? "(GET no lleva cuerpo)" : '{"nombre": "…"}'}
            className="rounded border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent disabled:opacity-50"
          />
        </div>
      </form>
      <div className="grid min-h-0 grid-cols-[180px_minmax(0,1fr)]">
        <ul className="min-h-0 overflow-auto border-r border-line py-1 text-[11px]">
          {historial.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setElegido(p.id)}
                className={`flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono hover:bg-surface-2 ${actual?.id === p.id ? "bg-surface-2" : ""}`}
              >
                <span className="w-9 shrink-0 font-semibold text-ink-dim">{p.metodo}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{p.ruta}</span>
                {p.respuesta ? (
                  <span className={colorEstado(p.respuesta.estado)}>{p.respuesta.estado}</span>
                ) : p.error ? (
                  <span className="text-danger">✕</span>
                ) : (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-h-0 overflow-auto p-3">
          {actual?.error && <p className="text-[12px] text-danger">{actual.error}</p>}
          {actual?.respuesta && (
            <>
              <div className="mb-2 flex items-center gap-3 text-[12px]">
                <span className={`font-mono font-semibold ${colorEstado(actual.respuesta.estado)}`}>HTTP {actual.respuesta.estado}</span>
                <span className="text-ink-faint">{actual.respuesta.ms} ms</span>
                <span className="text-ink-faint">{actual.respuesta.cabeceras["content-type"] ?? ""}</span>
              </div>
              <details className="mb-2 text-[11px] text-ink-dim">
                <summary className="cursor-pointer text-ink-faint">Cabeceras ({Object.keys(actual.respuesta.cabeceras).length})</summary>
                <pre className="mt-1 font-mono whitespace-pre-wrap">
                  {Object.entries(actual.respuesta.cabeceras)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                </pre>
              </details>
              <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">{actual.respuesta.cuerpo || "(sin cuerpo)"}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
