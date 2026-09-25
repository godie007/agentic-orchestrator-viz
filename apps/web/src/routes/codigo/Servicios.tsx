import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  AppWindow,
  BookOpen,
  Box,
  CornerDownRight,
  ExternalLink,
  Eye,
  Loader2,
  Package,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server,
  Settings2,
  Smartphone,
  Square,
} from "lucide-react";
import { argvATexto, tokenizar, type Servicio, type TipoServicio } from "@orq/shared";
import { api, type EstadoDeServicio, type ServicioConEstado } from "../../api.js";
import { useToast } from "../../ui/index.js";
import { Vista } from "./ControlDeCodigo.js";

/**
 * Los servicios del repo: backend, frontend, app móvil, documentación.
 *
 * Es la respuesta a "¿cómo veo esto andando?" en un monorepo. Cada servicio
 * se levanta sobre la sesión —lo que cambiaron los agentes— en un puerto
 * propio, y se recarga solo con cada edición. El orden de "levantar todo" no
 * es cosmético: primero las API, después lo que les habla, porque las URLs a
 * `localhost` de los `.env` se redirigen a los servicios **que ya están
 * levantados** — un frontend que arranca antes que su backend le seguiría
 * hablando al de la persona.
 */

export const ICONO_SERVICIO: Record<TipoServicio, typeof Server> = {
  api: Server,
  web: AppWindow,
  movil: Smartphone,
  docs: BookOpen,
  otro: Box,
};

const ETIQUETA: Record<TipoServicio, string> = {
  api: "API",
  web: "Web",
  movil: "Móvil",
  docs: "Docs",
  otro: "Servicio",
};

const ORDEN: Record<TipoServicio, number> = { api: 0, otro: 1, web: 2, movil: 3, docs: 4 };

export const COLOR_ESTADO: Record<EstadoDeServicio, string> = {
  detenido: "bg-ink-faint/50",
  preparando: "bg-warn animate-pulse",
  arrancando: "bg-warn animate-pulse",
  listo: "bg-ok",
  fallo: "bg-danger",
};

const TEXTO_ESTADO: Record<EstadoDeServicio, string> = {
  detenido: "detenido",
  preparando: "instalando dependencias…",
  arrancando: "arrancando…",
  listo: "levantado",
  fallo: "falló",
};

export function useServicios(repoId: string | null) {
  return useQuery({
    queryKey: ["servicios", repoId],
    queryFn: () => api.servicios(repoId!),
    enabled: repoId != null,
    // Mientras algo cambia de estado se mira seguido; quieto, casi nada (los
    // cambios igual llegan por el stream de código).
    refetchInterval: (q) =>
      q.state.data?.servicios.some((s) => s.vivo.estado === "preparando" || s.vivo.estado === "arrancando") ? 1_000 : 10_000,
  });
}

async function esperarEstado(repoId: string, servicioId: string, hasta: (e: EstadoDeServicio) => boolean): Promise<EstadoDeServicio> {
  for (let i = 0; i < 600; i++) {
    const { servicios } = await api.servicios(repoId);
    const estado = servicios.find((s) => s.id === servicioId)?.vivo.estado ?? "detenido";
    if (hasta(estado)) return estado;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return "fallo";
}

export function Servicios({
  repoId,
  onVistaPrevia,
  onLogs,
  onAbrirDocs,
}: {
  repoId: string;
  onVistaPrevia: (servicioId: string) => void;
  onLogs: (servicioId: string) => void;
  onAbrirDocs: (carpeta: string) => void;
}) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const consulta = useServicios(repoId);
  const servicios = [...(consulta.data?.servicios ?? [])].sort((a, b) => ORDEN[a.tipo] - ORDEN[b.tipo]);
  const [configurando, setConfigurando] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);
  const refrescar = () => void queryClient.invalidateQueries({ queryKey: ["servicios", repoId] });

  const accion = useMutation({
    mutationFn: async ({ tipo, id }: { tipo: "preparar" | "arrancar" | "detener" | "reiniciar"; id: string }) => {
      if (tipo === "preparar") await api.prepararServicio(repoId, id);
      else if (tipo === "arrancar") await api.arrancarServicio(repoId, id);
      else if (tipo === "detener") await api.detenerServicio(repoId, id);
      else {
        await api.detenerServicio(repoId, id);
        await esperarEstado(repoId, id, (e) => e !== "arrancando" && e !== "listo");
        await api.arrancarServicio(repoId, id);
      }
    },
    onSettled: refrescar,
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const detectar = useMutation({
    mutationFn: () => api.detectarServicios(repoId),
    onSuccess: (repo) => {
      refrescar();
      avisar(`${repo.servicios.length} servicio(s) detectados.`, "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  /** Prepara lo que falte y levanta en orden: API primero, después lo que les habla. */
  const levantarTodo = useMutation({
    mutationFn: async () => {
      const aLevantar = servicios.filter((s) => s.arrancar && s.vivo.estado !== "listo");
      for (const s of aLevantar) {
        if (s.preparado === false || s.preparado === null) {
          setProgreso(`Preparando ${s.nombre}…`);
          await api.prepararServicio(repoId, s.id);
          const fin = await esperarEstado(repoId, s.id, (e) => e !== "preparando");
          if (fin === "fallo") throw new Error(`No se pudo preparar ${s.nombre}: mirá su salida.`);
        }
        setProgreso(`Levantando ${s.nombre}…`);
        await api.arrancarServicio(repoId, s.id);
        const fin = await esperarEstado(repoId, s.id, (e) => e === "listo" || e === "fallo" || e === "detenido");
        if (fin !== "listo") throw new Error(`${s.nombre} no arrancó: mirá su salida.`);
        refrescar();
      }
    },
    onSettled: () => {
      setProgreso(null);
      refrescar();
    },
    onSuccess: () => avisar("Servicios levantados.", "ok"),
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const hayVivos = servicios.some((s) => s.vivo.estado === "listo" || s.vivo.estado === "arrancando");

  return (
    <Vista titulo="Servicios">
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          type="button"
          disabled={levantarTodo.isPending || servicios.every((s) => !s.arrancar)}
          onClick={() => levantarTodo.mutate()}
          className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded bg-accent px-2 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {levantarTodo.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {progreso ?? "Levantar todo"}
        </button>
        {hayVivos && (
          <button
            type="button"
            title="Detener todos"
            onClick={() => {
              for (const s of servicios) if (s.vivo.estado === "listo" || s.vivo.estado === "arrancando") accion.mutate({ tipo: "detener", id: s.id });
            }}
            className="flex size-7 items-center justify-center rounded border border-line text-ink-dim hover:border-danger hover:text-danger"
          >
            <Square className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          title="Volver a detectar los servicios del repo (conserva lo que configuraste)"
          disabled={detectar.isPending}
          onClick={() => detectar.mutate()}
          className="flex size-7 items-center justify-center rounded border border-line text-ink-dim hover:text-ink disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${detectar.isPending ? "animate-spin" : ""}`} aria-hidden />
        </button>
      </div>

      {consulta.isSuccess && servicios.length === 0 && (
        <p className="px-3 text-[12px] leading-relaxed text-ink-faint">
          No se detectó nada para levantar: un servicio es una carpeta con un <code>package.json</code> que tiene{" "}
          <code>dev</code> o <code>start</code> (Vite, Express, Expo, Next…), o una carpeta de notas.
        </p>
      )}

      <ul className="space-y-1 px-1.5 pb-4">
        {servicios.map((s) => (
          <FilaDeServicio
            key={s.id}
            s={s}
            api={servicios.find((x) => x.tipo === "api" && x.id !== s.id) ?? null}
            ocupado={accion.isPending || levantarTodo.isPending}
            configurando={configurando === s.id}
            onConfigurar={() => setConfigurando(configurando === s.id ? null : s.id)}
            onAccion={(tipo) => accion.mutate({ tipo, id: s.id })}
            onVistaPrevia={() => (s.tipo === "docs" ? onAbrirDocs(s.carpeta) : onVistaPrevia(s.id))}
            onLogs={() => onLogs(s.id)}
            onGuardar={async (servicio) => {
              await api.guardarServicio(repoId, servicio);
              refrescar();
              setConfigurando(null);
              avisar(`Se guardó ${servicio.nombre}. Si está levantado, reinicialo para usar la configuración nueva.`, "ok");
            }}
          />
        ))}
      </ul>
    </Vista>
  );
}

/** La configuración guardable de un servicio: los `.env` vuelven a ser rutas. */
function comoServicio(s: ServicioConEstado): Servicio {
  const { vivo: _vivo, preparado: _preparado, archivosEntorno, ...resto } = s;
  return { ...resto, archivosEntorno: archivosEntorno.map((a) => a.ruta) };
}

function FilaDeServicio({
  s,
  api: servicioApi,
  ocupado,
  configurando,
  onConfigurar,
  onAccion,
  onVistaPrevia,
  onLogs,
  onGuardar,
}: {
  s: ServicioConEstado;
  /** La API del repo, si hay: a ella se puede redirigir una URL que apunta afuera. */
  api: ServicioConEstado | null;
  ocupado: boolean;
  configurando: boolean;
  onConfigurar: () => void;
  onAccion: (tipo: "preparar" | "arrancar" | "detener" | "reiniciar") => void;
  onVistaPrevia: () => void;
  onLogs: () => void;
  onGuardar: (servicio: Servicio) => Promise<void>;
}) {
  const Icono = ICONO_SERVICIO[s.tipo];
  const estado = s.vivo.estado;
  const corre = estado === "listo" || estado === "arrancando";
  const boton = "flex size-6 items-center justify-center rounded text-ink-dim hover:bg-surface-2 hover:text-ink disabled:opacity-40";

  return (
    <li className="group rounded border border-transparent px-1.5 py-1.5 hover:border-line hover:bg-canvas/50">
      <div className="flex items-center gap-2">
        <span className="relative shrink-0">
          <Icono className="size-4 text-ink-dim" aria-hidden />
          {s.tipo !== "docs" && (
            <span className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface ${COLOR_ESTADO[estado]}`} aria-hidden />
          )}
        </span>
        <button type="button" onClick={onVistaPrevia} className="min-w-0 flex-1 text-left" title={s.tipo === "docs" ? "Abrir la documentación" : "Abrir la vista previa"}>
          <span className="block truncate text-[13px] font-medium text-ink">{s.nombre}</span>
          <span className="block truncate text-[11px] text-ink-faint">
            {ETIQUETA[s.tipo]} · {s.carpeta || "raíz"}
            {s.tipo !== "docs" && ` · ${TEXTO_ESTADO[estado]}`}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
          {s.tipo === "docs" ? (
            <button type="button" title="Leer la documentación" onClick={onVistaPrevia} className={boton}>
              <BookOpen className="size-3.5" aria-hidden />
            </button>
          ) : (
            <>
              {s.preparado === false && !corre && (
                <button type="button" title="Instalar dependencias en la sesión" disabled={ocupado || estado === "preparando"} onClick={() => onAccion("preparar")} className={boton}>
                  <Package className="size-3.5" aria-hidden />
                </button>
              )}
              {corre ? (
                <>
                  <button type="button" title="Reiniciar" disabled={ocupado} onClick={() => onAccion("reiniciar")} className={boton}>
                    <RotateCw className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" title="Detener" disabled={ocupado} onClick={() => onAccion("detener")} className={`${boton} hover:text-danger`}>
                    <Square className="size-3.5" aria-hidden />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  title={s.preparado === false ? "Primero instalá las dependencias" : "Levantar"}
                  disabled={ocupado || !s.arrancar || estado === "preparando" || s.preparado === false}
                  onClick={() => onAccion("arrancar")}
                  className={`${boton} text-ok`}
                >
                  <Play className="size-3.5" aria-hidden />
                </button>
              )}
              <button type="button" title="Vista previa" disabled={estado !== "listo"} onClick={onVistaPrevia} className={boton}>
                <Eye className="size-3.5" aria-hidden />
              </button>
              <button type="button" title="Salida (logs)" onClick={onLogs} className={boton}>
                <ScrollText className="size-3.5" aria-hidden />
              </button>
            </>
          )}
          <button type="button" title="Configurar" onClick={onConfigurar} className={`${boton} ${configurando ? "text-accent" : ""}`}>
            <Settings2 className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>

      {s.vivo.url && estado === "listo" && (
        <a
          href={s.vivo.url + (s.inicio === "/" ? "" : s.inicio)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 ml-6 flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
        >
          {s.vivo.url}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
      {estado === "fallo" && s.vivo.detalle && (
        <button type="button" onClick={onLogs} className="mt-1 ml-6 block text-left text-[11px] leading-snug text-danger hover:underline">
          {s.vivo.detalle}
        </button>
      )}
      {s.preparado === false && estado === "detenido" && (
        <p className="mt-1 ml-6 text-[11px] leading-snug text-ink-faint">Sin dependencias en la sesión: instalalas (📦) antes de levantarlo.</p>
      )}
      {corre && s.vivo.redirecciones.length > 0 && (
        <ul className="mt-1 ml-6 space-y-0.5 text-[10px] leading-snug text-ink-faint">
          {s.vivo.redirecciones.map((r) => (
            <li key={r.clave} className="flex items-start gap-1" title={`${r.antes} → ${r.despues}`}>
              <CornerDownRight className="mt-px size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                <b className="font-medium">{r.clave}</b> → {r.despues}
              </span>
            </li>
          ))}
        </ul>
      )}
      {corre && s.vivo.externas.length > 0 && (
        <ul className="mt-1 ml-6 space-y-0.5 text-[10px] leading-snug text-warn">
          {s.vivo.externas.map((x) => (
            <li key={x.clave} className="flex items-start gap-1" title="Esta variable apunta a un servidor de afuera, no a la vista previa.">
              <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
              <span className="min-w-0 break-all">
                <b className="font-medium">{x.clave}</b> apunta afuera: {x.valor}
                {servicioApi && (
                  <button
                    type="button"
                    title={`Guardar ${x.clave}={url:${servicioApi.id}}… y reiniciar para que use la API de la vista previa`}
                    onClick={() => {
                      // Se conserva la ruta: `https://x.co/api` → `{url:backend}/api`.
                      let ruta = "";
                      try {
                        ruta = new URL(x.valor.split(",")[0]!.trim()).pathname.replace(/\/$/, "");
                      } catch {
                        ruta = "";
                      }
                      void onGuardar({ ...comoServicio(s), entorno: { ...s.entorno, [x.clave]: `{url:${servicioApi.id}}${ruta}` } }).then(() =>
                        onAccion("reiniciar"),
                      );
                    }}
                    className="ml-1 font-medium text-accent underline decoration-accent/40 hover:decoration-accent"
                  >
                    usar {servicioApi.nombre} de la vista previa
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {configurando && <FormularioDeServicio s={s} onGuardar={onGuardar} />}
    </li>
  );
}

/** La configuración de un servicio. Los `.env` se nombran; sus valores no pasan por acá. */
function FormularioDeServicio({ s, onGuardar }: { s: ServicioConEstado; onGuardar: (servicio: Servicio) => Promise<void> }) {
  const [nombre, setNombre] = useState(s.nombre);
  const [arrancar, setArrancar] = useState(s.arrancar ? argvATexto(s.arrancar) : "");
  const [variablePuerto, setVariablePuerto] = useState(s.variablePuerto ?? "");
  const [puertoOriginal, setPuertoOriginal] = useState(s.puertoOriginal ? String(s.puertoOriginal) : "");
  const [salud, setSalud] = useState(s.salud ?? "");
  const [inicio, setInicio] = useState(s.inicio);
  const [archivos, setArchivos] = useState(s.archivosEntorno.map((a) => a.ruta).join("\n"));
  const [entorno, setEntorno] = useState(
    Object.entries(s.entorno)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const campo = "h-6 w-full rounded border border-line bg-canvas px-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent";
  const etiqueta = "mb-0.5 block text-[10px] font-medium tracking-wide text-ink-faint uppercase";

  const guardar = async () => {
    setError(null);
    let argv: string[] | null = null;
    if (arrancar.trim()) {
      const t = tokenizar(arrancar);
      if (!t.ok) return setError(t.motivo);
      argv = t.argv;
    }
    const variables: Record<string, string> = {};
    for (const linea of entorno.split("\n")) {
      const limpia = linea.trim();
      if (!limpia || limpia.startsWith("#")) continue;
      const i = limpia.indexOf("=");
      if (i < 1) return setError(`"${limpia}" no es CLAVE=valor.`);
      variables[limpia.slice(0, i).trim()] = limpia.slice(i + 1).trim();
    }
    setGuardando(true);
    try {
      await onGuardar({
        id: s.id,
        nombre: nombre.trim() || s.nombre,
        carpeta: s.carpeta,
        tipo: s.tipo,
        arrancar: argv,
        variablePuerto: variablePuerto.trim() || null,
        puertoOriginal: puertoOriginal.trim() ? Number(puertoOriginal) : null,
        salud: salud.trim() || null,
        inicio: inicio.trim() || "/",
        archivosEntorno: archivos
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
        entorno: variables,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="mt-2 ml-6 space-y-2 rounded border border-line bg-canvas p-2">
      <label className="block">
        <span className={etiqueta}>Nombre</span>
        <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={campo} />
      </label>
      {s.tipo !== "docs" && (
        <>
          <label className="block">
            <span className={etiqueta}>Comando de arranque · {"{puerto}"} = el asignado</span>
            <input value={arrancar} onChange={(e) => setArrancar(e.target.value)} placeholder="npm run dev -- --port {puerto}" className={campo} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className={etiqueta}>Variable del puerto</span>
              <input value={variablePuerto} onChange={(e) => setVariablePuerto(e.target.value)} placeholder="PORT" className={campo} />
            </label>
            <label className="block" title="El puerto que usa en tu máquina. Las URLs a localhost:<este> de los otros servicios se redirigen a éste.">
              <span className={etiqueta}>Puerto en tu máquina</span>
              <input value={puertoOriginal} onChange={(e) => setPuertoOriginal(e.target.value.replace(/\D/g, ""))} placeholder="3001" className={campo} />
            </label>
            <label className="block">
              <span className={etiqueta}>Ruta de salud</span>
              <input value={salud} onChange={(e) => setSalud(e.target.value)} placeholder="/health" className={campo} />
            </label>
            <label className="block">
              <span className={etiqueta}>Abre en</span>
              <input value={inicio} onChange={(e) => setInicio(e.target.value)} placeholder="/" className={campo} />
            </label>
          </div>
          <label className="block">
            <span className={etiqueta}>Archivos .env (ruta absoluta, uno por renglón)</span>
            <textarea value={archivos} onChange={(e) => setArchivos(e.target.value)} rows={2} className={`${campo} h-auto py-1`} />
            {s.archivosEntorno.length > 0 && (
              <span className="mt-0.5 block text-[10px] text-ink-faint">
                {s.archivosEntorno.map((a) => `${a.ruta.split("/").at(-1)}: ${a.existe ? `${a.variables} variables` : "no existe"}`).join(" · ")}
                . Se leen al arrancar; los valores no se guardan ni se copian al repo.
              </span>
            )}
          </label>
          <label className="block">
            <span className={etiqueta}>Variables extra (sin secretos) · {"{url:backend}"} = URL de otro servicio</span>
            <textarea value={entorno} onChange={(e) => setEntorno(e.target.value)} rows={2} placeholder="EXPO_PUBLIC_API_URL={url:backend}/api" className={`${campo} h-auto py-1`} />
          </label>
        </>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <button
        type="button"
        disabled={guardando}
        onClick={() => void guardar()}
        className="h-6 rounded bg-accent px-3 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {guardando ? "Guardando…" : "Guardar"}
      </button>
    </div>
  );
}
