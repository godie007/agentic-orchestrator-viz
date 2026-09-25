import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Bot,
  Boxes,
  ChevronRight,
  Eye,
  Files,
  GitBranch,
  PanelBottom,
  Search,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import type { Argv } from "@orq/shared";
import { api, type CompanyBundle } from "../api.js";
import { ConfirmDialog, useToast } from "../ui/index.js";
import { Explorador, IconoDeArchivo } from "./codigo/Explorador.js";
import { DiffDeArchivo, EditorDeArchivo } from "./codigo/Editor.js";
import { ControlDeCodigo } from "./codigo/ControlDeCodigo.js";
import { Buscar } from "./codigo/Buscar.js";
import { Terminal } from "./codigo/Terminal.js";
import { Repositorio } from "./codigo/Repositorio.js";
import { ChatDeIA, type Adjunto } from "./codigo/Chat.js";
import { VistaPrevia } from "./codigo/VistaPrevia.js";
import { ICONO_SERVICIO, Servicios, useServicios } from "./codigo/Servicios.js";
import { VistaDeServicio } from "./codigo/VistaDeServicio.js";
import { Salida } from "./codigo/SalidaDeServicio.js";
import { IndiceDeNotas, Nota } from "./codigo/Nota.js";
import type { ElementoSeleccionado } from "./codigo/elemento.js";
import type { FallaDeVista } from "./codigo/sonda.js";
import { etiquetaDeLenguaje, lenguajeDe } from "./codigo/monaco.js";

/**
 * El código del proyecto como un IDE: explorador con **una carpeta raíz por
 * repo**, editor con pestañas, control de código fuente, búsqueda, terminal,
 * vista previa y un chat de IA para pedir mejoras con contexto.
 *
 * Es el mismo worktree en el que trabajan los agentes, así que el IDE es
 * también la forma de **mirarlos trabajar**: el árbol marca lo que tocaron, el
 * archivo abierto se actualiza cuando lo editan, la vista previa se recarga con
 * cada checkpoint, y la barra de estado dice quién tiene el arriendo de
 * escritura. Mientras un agente escribe, el editor queda en sólo lectura —dos
 * escritores sobre el mismo árbol se pisan, sean agentes o personas—.
 */

type VistaLateral = "explorador" | "buscar" | "scm" | "servicios" | "repositorio";

interface Pestana {
  id: string;
  repoId: string;
  /**
   * `servicio`: un servicio levantado (la ruta es su id). `docs`: una carpeta
   * de notas (la ruta es la carpeta, `nota` la que se está leyendo). `nota`:
   * un `.md` renderizado, como la vista previa de markdown de VS Code.
   */
  tipo: "archivo" | "diff" | "vista" | "servicio" | "docs" | "nota";
  ruta: string;
  nota?: string;
  nuevo?: boolean;
  /** Para el diff de un pedido del chat: entre qué commits. */
  desde?: string;
  hasta?: string;
}

const idDe = (repoId: string, tipo: Pestana["tipo"], ruta: string, extra = "") => `${repoId}:${tipo}:${ruta}${extra}`;
const claveEdicion = (repoId: string, ruta: string) => `${repoId}\u0000${ruta}`;

function leerNumero(clave: string, porDefecto: number): number {
  try {
    const guardado = Number(localStorage.getItem(clave));
    return Number.isFinite(guardado) && guardado > 0 ? guardado : porDefecto;
  } catch {
    return porDefecto;
  }
}
function guardarNumero(clave: string, valor: number): void {
  try {
    localStorage.setItem(clave, String(Math.round(valor)));
  } catch {
    // sin almacenamiento: el tamaño vuelve al default la próxima vez
  }
}

function arrastrar(eje: "x" | "y", inicio: number, alMover: (delta: number) => void, alSoltar: () => void) {
  const mover = (e: PointerEvent) => alMover((eje === "x" ? e.clientX : e.clientY) - inicio);
  const soltar = () => {
    window.removeEventListener("pointermove", mover);
    window.removeEventListener("pointerup", soltar);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    alSoltar();
  };
  document.body.style.cursor = eje === "x" ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", mover);
  window.addEventListener("pointerup", soltar);
}

export function Codigo({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const avisar = useToast();

  const repos = useQuery({ queryKey: ["repos", companyId], queryFn: () => api.repos(companyId) });
  const lista = repos.data ?? [];
  const sinRepos = repos.isSuccess && lista.length === 0;

  const [vista, setVista] = useState<VistaLateral | null>("explorador");
  /** En la vista Repositorio: qué repo se configura, o `null` para cargar uno nuevo. */
  const [configurando, setConfigurando] = useState<string | null>(null);
  const [anchoLateral, setAnchoLateral] = useState(() => leerNumero("orq-ide-lateral", 280));
  const [altoPanel, setAltoPanel] = useState(() => leerNumero("orq-ide-panel", 220));
  const [anchoChat, setAnchoChat] = useState(() => leerNumero("orq-ide-chat", 380));
  const [panelAbierto, setPanelAbierto] = useState(false);
  /** Qué muestra el panel de abajo: la terminal, o la salida de un servicio. */
  const [panelDe, setPanelDe] = useState<string>("terminal");
  const [chatAbierto, setChatAbierto] = useState(false);

  const [pestanas, setPestanas] = useState<Pestana[]>([]);
  const [activa, setActiva] = useState<string | null>(null);
  const [ediciones, setEdiciones] = useState<Record<string, string>>({});
  const [irA, setIrA] = useState<{ id: string; linea: number; n: number } | null>(null);
  const [cursor, setCursor] = useState<{ linea: number; columna: number } | null>(null);
  const [cerrando, setCerrando] = useState<Pestana | null>(null);
  const [borrando, setBorrando] = useState<{ repoId: string; ruta: string } | null>(null);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [guardados, setGuardados] = useState(0);

  const pestanaActiva = pestanas.find((p) => p.id === activa) ?? null;
  // El repo "activo" es el de la pestaña que tenés abierta, o el último que
  // tocaste en el explorador: sobre ése operan el control de código, la
  // búsqueda, la terminal y el chat.
  const [repoElegido, setRepoElegido] = useState<string | null>(null);
  const idRepo = pestanaActiva?.repoId ?? (lista.some((r) => r.repo.id === repoElegido) ? repoElegido : lista[0]?.repo.id ?? null);
  const item = lista.find((r) => r.repo.id === idRepo) ?? null;

  // Lo que pasa fuera de una corrida (integrar, un checkpoint) llega por SSE.
  useEffect(() => {
    const source = new EventSource(`/api/companies/${companyId}/codigo/stream`);
    source.addEventListener("codigo", () => {
      void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["arbol"] });
      void queryClient.invalidateQueries({ queryKey: ["sesion"] });
      void queryClient.invalidateQueries({ queryKey: ["servicios"] });
      void queryClient.invalidateQueries({ queryKey: ["scm"] });
    });
    return () => source.close();
  }, [companyId, queryClient]);

  const arbol = useQuery({
    queryKey: ["arbol", idRepo],
    queryFn: () => api.arbolDeRepo(idRepo!),
    enabled: idRepo != null,
    refetchInterval: 3_000,
  });
  const cambios = useMemo(
    () => new Map((arbol.data?.cambios ?? []).map((c) => [c.ruta, c.estado] as const)),
    [arbol.data],
  );
  const escritor = arbol.data?.escritor ?? null;
  const servicios = useServicios(idRepo);
  const listaServicios = servicios.data?.servicios ?? [];

  const abrir = useCallback(
    (repoId: string, ruta: string, opciones: { tipo?: Pestana["tipo"]; linea?: number; nuevo?: boolean; desde?: string; hasta?: string } = {}) => {
      const tipo = opciones.tipo ?? "archivo";
      const id = idDe(repoId, tipo, ruta, opciones.hasta ? `@${opciones.hasta}` : "");
      setPestanas((previas) =>
        previas.some((p) => p.id === id)
          ? previas
          : [
              ...previas,
              {
                id,
                repoId,
                tipo,
                ruta,
                ...(opciones.nuevo ? { nuevo: true } : {}),
                ...(opciones.desde ? { desde: opciones.desde } : {}),
                ...(opciones.hasta ? { hasta: opciones.hasta } : {}),
              },
            ],
      );
      setActiva(id);
      setRepoElegido(repoId);
      if (opciones.linea) setIrA({ id, linea: opciones.linea, n: Date.now() });
    },
    [],
  );

  const cerrar = (pestana: Pestana, forzar = false) => {
    const clave = claveEdicion(pestana.repoId, pestana.ruta);
    if (!forzar && pestana.tipo === "archivo" && ediciones[clave] !== undefined) {
      setCerrando(pestana);
      return;
    }
    if (pestana.tipo === "archivo") setEdiciones(({ [clave]: _descartada, ...resto }) => resto);
    const indice = pestanas.findIndex((p) => p.id === pestana.id);
    const restantes = pestanas.filter((p) => p.id !== pestana.id);
    setPestanas(restantes);
    if (activa === pestana.id) setActiva(restantes[Math.min(indice, restantes.length - 1)]?.id ?? null);
  };

  const alEditar = useCallback((repoId: string, ruta: string, valor: string | undefined) => {
    const clave = claveEdicion(repoId, ruta);
    setEdiciones((previas) => {
      if (valor === undefined) {
        const { [clave]: _sacada, ...resto } = previas;
        return resto;
      }
      return { ...previas, [clave]: valor };
    });
  }, []);

  const alGuardar = useCallback(
    (repoId: string, ruta: string) => {
      alEditar(repoId, ruta, undefined);
      setGuardados((n) => n + 1);
      setPestanas((previas) => previas.map((p) => (p.repoId === repoId && p.ruta === ruta && p.nuevo ? { ...p, nuevo: false } : p)));
    },
    [alEditar],
  );

  const agregarAlChat = useCallback(
    (repoId: string, sel: { ruta: string; desde: number; hasta: number; texto: string } | { ruta: string }) => {
      setRepoElegido(repoId);
      setAdjuntos((previos) => {
        const nuevo: Adjunto = "texto" in sel ? { tipo: "seleccion", ...sel } : { tipo: "archivo", ruta: sel.ruta };
        const clave = JSON.stringify(nuevo);
        return previos.some((a) => JSON.stringify(a) === clave) ? previos : [...previos, nuevo];
      });
      setChatAbierto(true);
    },
    [],
  );

  /** Un elemento señalado en la vista previa de un frontend: al chat, como en Cursor. */
  const agregarElemento = useCallback(
    (servicio: { id: string; nombre: string; carpeta: string }, elemento: ElementoSeleccionado) => {
      const repoId = pestanas.find((p) => p.id === activa)?.repoId;
      if (repoId) setRepoElegido(repoId);
      setAdjuntos((previos) => [
        ...previos.filter((a) => !(a.tipo === "elemento" && a.servicioId === servicio.id && a.elemento.selector === elemento.selector)),
        { tipo: "elemento", ruta: servicio.carpeta, servicioId: servicio.id, servicioNombre: servicio.nombre, elemento },
      ]);
      setChatAbierto(true);
    },
    [activa, pestanas],
  );

  /** Una falla del inspector de la vista previa: al chat, con su stack o su respuesta. */
  const agregarFalla = useCallback(
    (servicio: { id: string; nombre: string; carpeta: string }, falla: FallaDeVista) => {
      const repoId = pestanas.find((p) => p.id === activa)?.repoId;
      if (repoId) setRepoElegido(repoId);
      setAdjuntos((previos) =>
        previos.some((a) => a.tipo === "falla" && a.servicioId === servicio.id && a.falla.titulo === falla.titulo)
          ? previos
          : [...previos, { tipo: "falla", ruta: servicio.carpeta, servicioId: servicio.id, servicioNombre: servicio.nombre, falla }],
      );
      setChatAbierto(true);
    },
    [activa, pestanas],
  );

  const abrirVistaPrevia = useCallback(
    (repoId: string, ruta?: string) => {
      const entrada = ruta ?? "index.html";
      // Una sola pestaña de vista previa por repo: cambiar de página la reusa.
      const existente = pestanas.find((p) => p.repoId === repoId && p.tipo === "vista");
      if (existente) {
        setPestanas((previas) => previas.map((p) => (p.id === existente.id ? { ...p, ruta: entrada } : p)));
        setActiva(existente.id);
        return;
      }
      abrir(repoId, entrada, { tipo: "vista" });
    },
    [abrir, pestanas],
  );

  const abrirServicio = useCallback((repoId: string, servicioId: string) => abrir(repoId, servicioId, { tipo: "servicio" }), [abrir]);

  /** La documentación: una pestaña por carpeta de notas, que abre en su nota de inicio. */
  const abrirDocs = useCallback(
    (repoId: string, carpeta: string, nota?: string) => {
      const archivos = (queryClient.getQueryData(["arbol", repoId]) as { archivos?: string[] } | undefined)?.archivos ?? [];
      const prefijo = carpeta ? `${carpeta}/` : "";
      const notas = archivos.filter((a) => a.startsWith(prefijo) && a.toLowerCase().endsWith(".md"));
      const inicio =
        nota ??
        notas.find((a) => /(^|\/)(00[\s-]|inicio|index|readme|home)[^/]*\.md$/i.test(a.slice(prefijo.length)) && !a.slice(prefijo.length).includes("/")) ??
        notas.sort()[0];
      const id = idDe(repoId, "docs", carpeta);
      setPestanas((previas) =>
        previas.some((p) => p.id === id)
          ? previas.map((p) => (p.id === id && nota ? { ...p, nota } : p))
          : [...previas, { id, repoId, tipo: "docs", ruta: carpeta, ...(inicio ? { nota: inicio } : {}) }],
      );
      setActiva(id);
      setRepoElegido(repoId);
    },
    [queryClient],
  );

  // Atajos de VS Code y Cursor.
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const tecla = e.key.toLowerCase();
      const enEditor = (e.target as HTMLElement | null)?.closest?.(".monaco-editor") != null;
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setPanelAbierto((a) => !a);
      } else if (mod && !e.shiftKey && tecla === "b") {
        e.preventDefault();
        setVista((v) => (v ? null : "explorador"));
      } else if (mod && e.shiftKey && tecla === "f") {
        e.preventDefault();
        setVista("buscar");
      } else if (mod && e.shiftKey && tecla === "e") {
        e.preventDefault();
        setVista("explorador");
      } else if (mod && e.shiftKey && tecla === "g") {
        e.preventDefault();
        setVista("scm");
      } else if (mod && !e.shiftKey && tecla === "l" && !enEditor) {
        // En el editor, ⌘L lo maneja Monaco (manda la selección al chat).
        e.preventDefault();
        setChatAbierto((a) => !a);
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, []);

  const anchoRef = useRef(anchoLateral);
  anchoRef.current = anchoLateral;
  const altoRef = useRef(altoPanel);
  altoRef.current = altoPanel;
  const chatRef = useRef(anchoChat);
  chatRef.current = anchoChat;

  const sugeridos: Argv[] = useMemo(() => {
    const c = item?.repo.comandos;
    if (!c) return [];
    const todos = [c.test, c.verificar, ...c.permitidos].filter((x): x is Argv => x != null);
    const vistos = new Set<string>();
    return todos.filter((argv) => {
      const clave = argv.join(" ");
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
  }, [item]);

  const ACTIVIDADES: Array<{ id: VistaLateral; icono: typeof Files; titulo: string; contador?: number }> = [
    { id: "explorador", icono: Files, titulo: "Explorador (⌘⇧E)" },
    { id: "buscar", icono: Search, titulo: "Buscar (⌘⇧F)" },
    { id: "scm", icono: GitBranch, titulo: "Control de código fuente (⌘⇧G)", contador: arbol.data?.cambios.length },
    {
      id: "servicios",
      icono: Boxes,
      titulo: "Servicios: levantar el backend, el frontend y la app para verlos andando",
      contador: listaServicios.filter((x) => x.vivo.estado === "listo").length || undefined,
    },
    { id: "repositorio", icono: Settings2, titulo: "Repositorios: cargar código y comandos" },
  ];

  /** En Buscar, SCM y Repositorio, con varios repos, cuál. */
  const selectorDeRepo =
    lista.length > 1 ? (
      <div className="px-2 pt-2">
        <select
          value={idRepo ?? ""}
          onChange={(e) => setRepoElegido(e.target.value)}
          className="h-6 w-full rounded border border-line bg-canvas px-1 text-[12px] text-ink"
        >
          {lista.map((r) => (
            <option key={r.repo.id} value={r.repo.id}>
              {r.repo.nombre}
            </option>
          ))}
        </select>
      </div>
    ) : null;

  const repoConfigurado = lista.find((r) => r.repo.id === configurando) ?? null;

  return (
    // `grid-cols-[minmax(0,1fr)]`: sin columna explícita la grilla crea una
    // `auto` que crece con el contenido, y al abrir el chat la página entera
    // se corría de costado (Monaco mide 16M px de ancho interno).
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_22px] overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 min-w-0">
        {/* Barra de actividad */}
        <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2">
          {ACTIVIDADES.map((a) => (
            <button
              key={a.id}
              type="button"
              title={a.titulo}
              onClick={() => {
                if (a.id === "repositorio") setConfigurando(idRepo);
                setVista((v) => (v === a.id ? null : a.id));
              }}
              className={`relative flex size-10 items-center justify-center border-l-2 transition-colors ${
                vista === a.id ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink"
              }`}
            >
              <a.icono className="size-5" aria-hidden />
              {a.contador ? (
                <span className="absolute right-1 bottom-1 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] leading-4 font-semibold text-white">
                  {a.contador}
                </span>
              ) : null}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            title="Chat de IA (⌘L)"
            onClick={() => setChatAbierto((a) => !a)}
            className={`flex size-10 items-center justify-center ${chatAbierto ? "text-accent" : "text-ink-faint hover:text-ink"}`}
          >
            <Sparkles className="size-5" aria-hidden />
          </button>
          <button
            type="button"
            title="Terminal (⌃`)"
            onClick={() => setPanelAbierto((a) => !a)}
            className={`flex size-10 items-center justify-center ${panelAbierto ? "text-ink" : "text-ink-faint hover:text-ink"}`}
          >
            <SquareTerminal className="size-5" aria-hidden />
          </button>
        </nav>

        {/* Barra lateral: las vistas quedan montadas y se ocultan, como en
            VS Code; si se desmontaran, ir a Buscar y volver cerraría todas las
            carpetas del explorador y borraría la búsqueda. */}
        {(vista || sinRepos) && (
          <>
            <aside className="flex min-h-0 shrink-0 flex-col border-r border-line bg-surface" style={{ width: anchoLateral }}>
              <div className={sinRepos || vista === "repositorio" ? "contents" : "hidden"}>
                {lista.length > 1 && configurando && (
                  <div className="px-2 pt-2">
                    <select
                      value={configurando}
                      onChange={(e) => setConfigurando(e.target.value)}
                      className="h-6 w-full rounded border border-line bg-canvas px-1 text-[12px] text-ink"
                    >
                      {lista.map((r) => (
                        <option key={r.repo.id} value={r.repo.id}>
                          {r.repo.nombre}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <Repositorio
                  companyId={companyId}
                  item={repoConfigurado}
                  onCargado={(id) => {
                    setRepoElegido(id);
                    setConfigurando(null);
                    setVista("explorador");
                  }}
                />
              </div>
              {!sinRepos && (
                <>
                  <div className={vista === "explorador" ? "contents" : "hidden"}>
                    <Explorador
                      repos={lista}
                      activo={pestanaActiva ? { repoId: pestanaActiva.repoId, ruta: pestanaActiva.ruta } : null}
                      onAgregar={() => {
                        setConfigurando(null);
                        setVista("repositorio");
                      }}
                      onAbrir={(repoId, ruta) => abrir(repoId, ruta)}
                      onNuevo={(repoId, ruta) => abrir(repoId, ruta, { nuevo: true })}
                      onBorrar={(repoId, ruta) => setBorrando({ repoId, ruta })}
                      onVistaPrevia={(repoId, ruta) => abrirVistaPrevia(repoId, ruta)}
                      onConfigurar={(repoId) => {
                        setConfigurando(repoId);
                        setVista("repositorio");
                      }}
                      onQuitar={(repoId) => setQuitando(repoId)}
                      onElegir={(repoId) => setRepoElegido(repoId)}
                      onRenombrar={async (repoId, nombre) => {
                        await api.renombrarRepo(repoId, nombre);
                        await queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
                      }}
                    />
                  </div>
                  {idRepo && (
                    <>
                      <div className={vista === "buscar" ? "contents" : "hidden"}>
                        {selectorDeRepo}
                        <Buscar key={idRepo} repoId={idRepo} onAbrir={(ruta, linea) => abrir(idRepo, ruta, { linea })} />
                      </div>
                      <div className={vista === "servicios" ? "contents" : "hidden"}>
                        {selectorDeRepo}
                        <Servicios
                          repoId={idRepo}
                          onVistaPrevia={(servicioId) => abrirServicio(idRepo, servicioId)}
                          onLogs={(servicioId) => {
                            setPanelDe(servicioId);
                            setPanelAbierto(true);
                          }}
                          onAbrirDocs={(carpeta) => abrirDocs(idRepo, carpeta)}
                        />
                      </div>
                      <div className={vista === "scm" ? "contents" : "hidden"}>
                        {selectorDeRepo}
                        <ControlDeCodigo
                          repoId={idRepo}
                          arbol={arbol.data}
                          origen={item?.repo.origen.tipo ?? "local"}
                          onAbrirDiff={(ruta) => abrir(idRepo, ruta, { tipo: "diff" })}
                          onAbrirDiffEntre={(ruta, desde, hasta) => abrir(idRepo, ruta, { tipo: "diff", desde, hasta })}
                        />
                      </div>
                    </>
                  )}
                </>
              )}
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(e) => {
                const base = anchoRef.current;
                arrastrar("x", e.clientX, (d) => setAnchoLateral(Math.max(180, Math.min(640, base + d))), () =>
                  guardarNumero("orq-ide-lateral", anchoRef.current),
                );
              }}
              className="-ml-[3px] w-[5px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40"
            />
          </>
        )}

        {/* Área del editor + panel */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 border-b border-line bg-surface">
            <div className="flex min-w-0 flex-1 overflow-x-auto">
              {pestanas.map((p) => {
                const nombre = p.ruta.split("/").at(-1) ?? p.ruta;
                const sucia = p.tipo === "archivo" && ediciones[claveEdicion(p.repoId, p.ruta)] !== undefined;
                const marca = p.repoId === idRepo ? cambios.get(p.ruta) : undefined;
                const repoNombre = lista.length > 1 ? lista.find((r) => r.repo.id === p.repoId)?.repo.nombre : null;
                return (
                  <div
                    key={p.id}
                    role="tab"
                    aria-selected={activa === p.id}
                    onClick={() => setActiva(p.id)}
                    onAuxClick={(e) => e.button === 1 && cerrar(p)}
                    title={`${repoNombre ? `${repoNombre}/` : ""}${p.ruta}`}
                    className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-[13px] ${
                      activa === p.id
                        ? "border-t-2 border-t-accent bg-canvas text-ink"
                        : "border-t-2 border-t-transparent text-ink-dim hover:bg-surface-2"
                    }`}
                  >
                    <IconoDePestana pestana={p} nombre={nombre} tipoServicio={listaServicios.find((x) => x.id === p.ruta)?.tipo} />
                    <span className={`${p.tipo !== "archivo" ? "italic" : ""} ${marca === "A" ? "text-ok" : marca ? "text-warn" : ""}`}>
                      {p.tipo === "vista"
                        ? `Vista previa · ${nombre}`
                        : p.tipo === "servicio"
                          ? `▶ ${listaServicios.find((x) => x.id === p.ruta)?.nombre ?? p.ruta}`
                          : p.tipo === "docs"
                            ? (p.nota?.split("/").at(-1)?.replace(/\.md$/i, "") ?? (nombre || "Documentación"))
                            : p.tipo === "nota"
                              ? `Vista · ${nombre}`
                              : nombre}
                      {p.tipo === "diff" && <span className="ml-1 text-ink-faint">({p.hasta ? "pedido" : "cambios"})</span>}
                      {repoNombre && <span className="ml-1 text-[10px] text-ink-faint">· {repoNombre}</span>}
                    </span>
                    <button
                      type="button"
                      title={sucia ? "Sin guardar — cerrar" : "Cerrar"}
                      onClick={(e) => {
                        e.stopPropagation();
                        cerrar(p);
                      }}
                      className="relative flex size-4 items-center justify-center rounded hover:bg-surface-2"
                    >
                      {sucia ? (
                        <>
                          <span className="size-2 rounded-full bg-ink group-hover:hidden" aria-hidden />
                          <X className="hidden size-3.5 group-hover:block" aria-hidden />
                        </>
                      ) : (
                        <X className={`size-3.5 ${activa === p.id ? "" : "invisible group-hover:visible"}`} aria-hidden />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {idRepo && (
              <div className="flex shrink-0 items-center gap-0.5 border-l border-line px-1.5">
                <button
                  type="button"
                  title="Vista previa del proyecto (index.html)"
                  onClick={() => abrirVistaPrevia(idRepo, pestanaActiva && /\.html?$/i.test(pestanaActiva.ruta) ? pestanaActiva.ruta : undefined)}
                  className="rounded p-1.5 text-ink-dim hover:bg-surface-2 hover:text-ink"
                >
                  <Eye className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  title="Chat de IA (⌘L)"
                  onClick={() => setChatAbierto((a) => !a)}
                  className={`rounded p-1.5 hover:bg-surface-2 ${chatAbierto ? "text-accent" : "text-ink-dim hover:text-ink"}`}
                >
                  <Sparkles className="size-4" aria-hidden />
                </button>
              </div>
            )}
          </div>
          {pestanaActiva && (pestanaActiva.tipo === "archivo" || pestanaActiva.tipo === "diff") && (
            <div className="flex h-6 shrink-0 items-center gap-0.5 bg-canvas px-3 text-[12px] text-ink-faint">
              {lista.length > 1 && (
                <span className="flex items-center gap-0.5">
                  {lista.find((r) => r.repo.id === pestanaActiva.repoId)?.repo.nombre}
                  <ChevronRight className="size-3" aria-hidden />
                </span>
              )}
              {pestanaActiva.ruta.split("/").map((parte, i, partes) => (
                <span key={i} className="flex items-center gap-0.5">
                  {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                  <span className={i === partes.length - 1 ? "text-ink-dim" : ""}>{parte}</span>
                </span>
              ))}
              <span className="flex-1" />
              {pestanaActiva.tipo === "archivo" && /\.md$/i.test(pestanaActiva.ruta) && (
                <button
                  type="button"
                  title="Ver la nota renderizada, con sus [[enlaces]] (como en Obsidian)"
                  onClick={() => abrir(pestanaActiva.repoId, pestanaActiva.ruta, { tipo: "nota" })}
                  className="flex items-center gap-1 rounded px-1.5 hover:bg-surface-2 hover:text-ink"
                >
                  <BookOpen className="size-3" aria-hidden /> Vista de lectura
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1">
            {!idRepo ? (
              <Bienvenida sinRepos={sinRepos} />
            ) : pestanaActiva ? (
              pestanaActiva.tipo === "servicio" ? (
                <VistaDeServicio
                  key={pestanaActiva.id}
                  repoId={pestanaActiva.repoId}
                  servicioId={pestanaActiva.ruta}
                  onElemento={agregarElemento}
                  onFalla={agregarFalla}
                />
              ) : pestanaActiva.tipo === "docs" ? (
                <Documentacion
                  key={pestanaActiva.id}
                  repoId={pestanaActiva.repoId}
                  carpeta={pestanaActiva.ruta}
                  nota={pestanaActiva.nota ?? null}
                  onNota={(nota) => abrirDocs(pestanaActiva.repoId, pestanaActiva.ruta, nota)}
                  onEditar={(ruta) => abrir(pestanaActiva.repoId, ruta)}
                />
              ) : pestanaActiva.tipo === "nota" ? (
                <NotaSuelta
                  key={pestanaActiva.id}
                  repoId={pestanaActiva.repoId}
                  ruta={pestanaActiva.ruta}
                  onAbrir={(ruta) => abrir(pestanaActiva.repoId, ruta, { tipo: "nota" })}
                />
              ) : pestanaActiva.tipo === "vista" ? (
                <VistaConVersion
                  key={pestanaActiva.id}
                  repoId={pestanaActiva.repoId}
                  ruta={pestanaActiva.ruta}
                  guardados={guardados}
                  onCambiarRuta={(ruta) => abrirVistaPrevia(pestanaActiva.repoId, ruta)}
                />
              ) : pestanaActiva.tipo === "diff" ? (
                <DiffDeArchivo
                  key={pestanaActiva.id}
                  repoId={pestanaActiva.repoId}
                  ruta={pestanaActiva.ruta}
                  edicion={ediciones[claveEdicion(pestanaActiva.repoId, pestanaActiva.ruta)]}
                  desde={pestanaActiva.desde}
                  hasta={pestanaActiva.hasta}
                />
              ) : (
                <EditorConArbol
                  key={pestanaActiva.id}
                  pestana={pestanaActiva}
                  edicion={ediciones[claveEdicion(pestanaActiva.repoId, pestanaActiva.ruta)]}
                  irALinea={irA && irA.id === pestanaActiva.id ? { linea: irA.linea, n: irA.n } : null}
                  onEditar={alEditar}
                  onGuardado={alGuardar}
                  onCursor={(linea, columna) => setCursor({ linea, columna })}
                  onAgregarAlChat={agregarAlChat}
                />
              )
            ) : (
              <Bienvenida sinRepos={false} escritor={escritor} corridaViva={arbol.data?.corridaViva ?? false} />
            )}
          </div>

          {panelAbierto && idRepo && (
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={(e) => {
                  const base = altoRef.current;
                  arrastrar("y", e.clientY, (d) => setAltoPanel(Math.max(100, Math.min(700, base - d))), () =>
                    guardarNumero("orq-ide-panel", altoRef.current),
                  );
                }}
                className="h-[5px] shrink-0 cursor-row-resize border-t border-line transition-colors hover:bg-accent/40"
              />
              <div className="flex shrink-0 flex-col" style={{ height: altoPanel }}>
                <div className="flex h-8 shrink-0 items-center gap-4 px-3 text-[11px] font-semibold tracking-wide uppercase">
                  <button
                    type="button"
                    onClick={() => setPanelDe("terminal")}
                    className={`border-b pb-0.5 ${panelDe === "terminal" ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink"}`}
                  >
                    Terminal
                  </button>
                  {listaServicios.some((x) => x.tipo !== "docs") && (
                    <span className={`flex items-center gap-1.5 border-b pb-0.5 ${panelDe !== "terminal" ? "border-accent text-ink" : "border-transparent text-ink-faint"}`}>
                      <button type="button" onClick={() => setPanelDe(listaServicios.find((x) => x.tipo !== "docs")?.id ?? "terminal")} className="uppercase hover:text-ink">
                        Salida
                      </button>
                      {panelDe !== "terminal" && (
                        <select
                          value={panelDe}
                          onChange={(e) => setPanelDe(e.target.value)}
                          className="h-5 rounded border border-line bg-canvas px-1 text-[11px] font-normal tracking-normal text-ink normal-case"
                        >
                          {listaServicios
                            .filter((x) => x.tipo !== "docs")
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.nombre}
                              </option>
                            ))}
                        </select>
                      )}
                    </span>
                  )}
                  {lista.length > 1 && <span className="font-normal tracking-normal text-ink-faint normal-case">{item?.repo.nombre}</span>}
                  <span className="flex-1" />
                  <button type="button" title="Cerrar el panel (⌃`)" onClick={() => setPanelAbierto(false)} className="text-ink-faint hover:text-ink">
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  {panelDe === "terminal" || !listaServicios.some((x) => x.id === panelDe) ? (
                    <Terminal
                      key={idRepo}
                      repoId={idRepo}
                      sugeridos={sugeridos}
                      carpetas={[...new Set(listaServicios.filter((x) => x.carpeta && x.tipo !== "docs").map((x) => x.carpeta))]}
                    />
                  ) : (
                    <Salida key={`${idRepo}:${panelDe}`} repoId={idRepo} servicioId={panelDe} />
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Chat de IA, a la derecha como en Cursor */}
        {chatAbierto && item && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(e) => {
                const base = chatRef.current;
                arrastrar("x", e.clientX, (d) => setAnchoChat(Math.max(300, Math.min(720, base - d))), () =>
                  guardarNumero("orq-ide-chat", chatRef.current),
                );
              }}
              className="w-[5px] shrink-0 cursor-col-resize border-l border-line transition-colors hover:bg-accent/40"
            />
            <aside className="min-h-0 shrink-0" style={{ width: anchoChat }}>
              <ChatDeIA
                company={company}
                repo={item}
                archivos={arbol.data?.archivos ?? []}
                archivoActivo={pestanaActiva?.repoId === item.repo.id && pestanaActiva.tipo === "archivo" ? pestanaActiva.ruta : null}
                adjuntos={adjuntos}
                onAdjuntos={setAdjuntos}
                onAbrirDiff={(ruta, desde, hasta) => abrir(item.repo.id, ruta, { tipo: "diff", desde, hasta })}
                onAbrirArchivo={(ruta, linea) => abrir(item.repo.id, ruta, linea ? { linea } : {})}
                onCerrar={() => setChatAbierto(false)}
              />
            </aside>
          </>
        )}
      </div>

      {/* Barra de estado */}
      <footer
        className={`flex items-center gap-3 px-2 text-[11px] text-white ${
          // Colores fijos, no el acento del tema: en oscuro el acento es claro
          // y el texto blanco encima no se leía.
          escritor ? "bg-[oklch(0.5_0.16_300)]" : arbol.data?.sesion ? "bg-[oklch(0.5_0.15_250)]" : "bg-[oklch(0.42_0.02_260)]"
        }`}
      >
        {item && lista.length > 1 && <span className="font-medium">{item.repo.nombre}</span>}
        {arbol.data?.sesion ? (
          <span className="flex items-center gap-1" title="Rama de la sesión de trabajo">
            <GitBranch className="size-3" aria-hidden /> {arbol.data.sesion.rama}
          </span>
        ) : item ? (
          <span className="flex items-center gap-1" title="Sin sesión: la rama base, en sólo lectura">
            <GitBranch className="size-3" aria-hidden /> {item.repo.ramaBase} (base)
          </span>
        ) : null}
        {arbol.data && arbol.data.cambios.length > 0 && <span>{arbol.data.cambios.length} cambio(s)</span>}
        {arbol.data && arbol.data.commits > 0 && <span>{arbol.data.commits} checkpoint(s)</span>}
        {escritor ? (
          <span className="flex items-center gap-1 font-medium">
            <Bot className="size-3 animate-pulse" aria-hidden /> {escritor} está escribiendo
          </span>
        ) : arbol.data?.corridaViva ? (
          <span className="flex items-center gap-1">
            <Bot className="size-3" aria-hidden /> corrida en curso
          </span>
        ) : null}
        {listaServicios.some((x) => x.vivo.estado === "listo") && (
          <button
            type="button"
            title="Servicios levantados"
            onClick={() => setVista("servicios")}
            className="flex items-center gap-1 hover:opacity-80"
          >
            <Boxes className="size-3" aria-hidden />
            {listaServicios
              .filter((x) => x.vivo.estado === "listo")
              .map((x) => `${x.nombre} :${x.vivo.puerto}`)
              .join(" · ")}
          </button>
        )}
        <span className="flex-1" />
        {pestanaActiva && cursor && pestanaActiva.tipo === "archivo" && (
          <span>
            Lín. {cursor.linea}, col. {cursor.columna}
          </span>
        )}
        {pestanaActiva && (pestanaActiva.tipo === "archivo" || pestanaActiva.tipo === "diff") && (
          <span>{etiquetaDeLenguaje(lenguajeDe(pestanaActiva.ruta))}</span>
        )}
        <button type="button" title="Chat de IA (⌘L)" onClick={() => setChatAbierto((a) => !a)} className="flex items-center gap-1 hover:opacity-80">
          <Sparkles className="size-3" aria-hidden />
        </button>
        <button type="button" title="Terminal (⌃`)" onClick={() => setPanelAbierto((a) => !a)} className="flex items-center gap-1 hover:opacity-80">
          <PanelBottom className="size-3" aria-hidden />
        </button>
      </footer>

      <ConfirmDialog
        abierto={cerrando != null}
        titulo={`¿Cerrar ${cerrando?.ruta.split("/").at(-1) ?? ""} sin guardar?`}
        detalle="Tenés cambios sin guardar en este archivo. Si lo cerrás, se pierden."
        confirmar="Cerrar sin guardar"
        onConfirmar={() => {
          if (cerrando) cerrar(cerrando, true);
          setCerrando(null);
        }}
        onCancelar={() => setCerrando(null)}
      />
      <ConfirmDialog
        abierto={borrando != null}
        titulo={`¿Borrar ${borrando?.ruta ?? ""}?`}
        detalle="Se borra del worktree de la sesión. Si estaba en la base, el borrado queda como un cambio que podés no integrar."
        confirmar="Borrar"
        onConfirmar={() => {
          const objetivo = borrando;
          setBorrando(null);
          if (!objetivo) return;
          api
            .borrarArchivo(objetivo.repoId, objetivo.ruta)
            .then(() => {
              const pestana = pestanas.find((p) => p.repoId === objetivo.repoId && p.ruta === objetivo.ruta && p.tipo === "archivo");
              if (pestana) cerrar(pestana, true);
              void queryClient.invalidateQueries({ queryKey: ["arbol", objetivo.repoId] });
              avisar(`Se borró ${objetivo.ruta}.`, "ok");
            })
            .catch((e: Error) => avisar(e.message, "error"));
        }}
        onCancelar={() => setBorrando(null)}
      />
      <ConfirmDialog
        abierto={quitando != null}
        titulo={`¿Sacar ${lista.find((r) => r.repo.id === quitando)?.repo.nombre ?? "el repo"} del proyecto?`}
        detalle="Se borran la copia de trabajo, las sesiones y sus ramas dentro del orquestador. Tu carpeta o repo original no se toca. Si la sesión tiene trabajo sin integrar, antes queda un respaldo (bundle de git y patch) en Salida → respaldos."
        confirmar="Sacar del proyecto"
        onConfirmar={() => {
          const repoId = quitando;
          setQuitando(null);
          if (!repoId) return;
          api
            .eliminarRepo(repoId)
            .then(({ respaldo }) => {
              setPestanas((previas) => previas.filter((p) => p.repoId !== repoId));
              if (pestanaActiva?.repoId === repoId) setActiva(null);
              void queryClient.invalidateQueries({ queryKey: ["repos", companyId] });
              avisar(
                respaldo
                  ? `Se sacó el repo. El trabajo sin integrar quedó respaldado en Salida → ${respaldo} (y su .patch).`
                  : "Se sacó el repo del proyecto. Tu carpeta original sigue igual.",
                "ok",
              );
            })
            .catch((e: Error) => avisar(e.message, "error"));
        }}
        onCancelar={() => setQuitando(null)}
      />
    </div>
  );
}

function IconoDePestana({
  pestana,
  nombre,
  tipoServicio,
}: {
  pestana: Pestana;
  nombre: string;
  tipoServicio: keyof typeof ICONO_SERVICIO | undefined;
}) {
  if (pestana.tipo === "vista") return <Eye className="size-4 text-accent" aria-hidden />;
  if (pestana.tipo === "docs" || pestana.tipo === "nota") return <BookOpen className="size-4 text-accent" aria-hidden />;
  if (pestana.tipo === "servicio") {
    const Icono = ICONO_SERVICIO[tipoServicio ?? "otro"];
    return <Icono className="size-4 text-accent" aria-hidden />;
  }
  return <IconoDeArchivo nombre={nombre} />;
}

/** La documentación: el índice de notas a la izquierda, la nota a la derecha. */
function Documentacion({
  repoId,
  carpeta,
  nota,
  onNota,
  onEditar,
}: {
  repoId: string;
  carpeta: string;
  nota: string | null;
  onNota: (ruta: string) => void;
  onEditar: (ruta: string) => void;
}) {
  const arbol = useQuery({ queryKey: ["arbol", repoId], queryFn: () => api.arbolDeRepo(repoId) });
  const archivos = arbol.data?.archivos ?? [];
  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)]">
      <IndiceDeNotas carpeta={carpeta} archivos={archivos} activa={nota} onAbrir={onNota} />
      <div className="flex min-h-0 flex-col">
        {nota && (
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px] text-ink-faint">
            <span className="min-w-0 flex-1 truncate">{nota}</span>
            <button type="button" onClick={() => onEditar(nota)} className="rounded px-1.5 hover:bg-surface-2 hover:text-ink">
              Editar
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {nota ? (
            <Nota key={nota} repoId={repoId} ruta={nota} archivos={archivos} onAbrir={onNota} />
          ) : (
            <div className="p-6 text-[13px] text-ink-faint">{arbol.isLoading ? "Cargando…" : "No hay notas en esta carpeta."}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function NotaSuelta({ repoId, ruta, onAbrir }: { repoId: string; ruta: string; onAbrir: (ruta: string) => void }) {
  const arbol = useQuery({ queryKey: ["arbol", repoId], queryFn: () => api.arbolDeRepo(repoId) });
  return <Nota repoId={repoId} ruta={ruta} archivos={arbol.data?.archivos ?? []} onAbrir={onAbrir} />;
}

/** El editor de una pestaña, con el estado de escritura de su propio repo. */
function EditorConArbol({
  pestana,
  edicion,
  irALinea,
  onEditar,
  onGuardado,
  onCursor,
  onAgregarAlChat,
}: {
  pestana: Pestana;
  edicion: string | undefined;
  irALinea: { linea: number; n: number } | null;
  onEditar: (repoId: string, ruta: string, valor: string | undefined) => void;
  onGuardado: (repoId: string, ruta: string) => void;
  onCursor: (linea: number, columna: number) => void;
  onAgregarAlChat: (repoId: string, sel: { ruta: string; desde: number; hasta: number; texto: string } | { ruta: string }) => void;
}) {
  const arbol = useQuery({ queryKey: ["arbol", pestana.repoId], queryFn: () => api.arbolDeRepo(pestana.repoId), refetchInterval: 3_000 });
  const escritor = arbol.data?.escritor ?? null;
  return (
    <EditorDeArchivo
      repoId={pestana.repoId}
      ruta={pestana.ruta}
      nuevo={pestana.nuevo ?? false}
      edicion={edicion}
      soloLectura={escritor != null}
      motivoSoloLectura={escritor ? `${escritor} está escribiendo en su turno: el archivo se actualiza solo y vas a poder editar cuando termine.` : null}
      irALinea={irALinea}
      onEditar={(ruta, valor) => onEditar(pestana.repoId, ruta, valor)}
      onGuardado={(ruta) => onGuardado(pestana.repoId, ruta)}
      onCursor={onCursor}
      onAgregarAlChat={(sel) => onAgregarAlChat(pestana.repoId, sel)}
    />
  );
}

/** La vista previa se recarga con cada guardado y con cada checkpoint de su repo. */
function VistaConVersion({
  repoId,
  ruta,
  guardados,
  onCambiarRuta,
}: {
  repoId: string;
  ruta: string;
  guardados: number;
  onCambiarRuta: (ruta: string) => void;
}) {
  const arbol = useQuery({ queryKey: ["arbol", repoId], queryFn: () => api.arbolDeRepo(repoId), refetchInterval: 3_000 });
  const version = `${guardados}-${arbol.data?.commits ?? 0}-${arbol.data?.sesion?.id ?? "base"}`;
  return <VistaPrevia repoId={repoId} ruta={ruta} version={version} onCambiarRuta={onCambiarRuta} />;
}

function Bienvenida({ sinRepos, escritor, corridaViva }: { sinRepos: boolean; escritor?: string | null; corridaViva?: boolean }) {
  const atajos: Array<[string, string]> = [
    ["Chat de IA · selección al chat", "⌘L"],
    ["Explorador", "⌘⇧E"],
    ["Buscar en el repo", "⌘⇧F"],
    ["Control de código fuente", "⌘⇧G"],
    ["Terminal", "⌃`"],
    ["Guardar", "⌘S"],
    ["Mostrar u ocultar la barra lateral", "⌘B"],
  ];
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-5 text-center">
        <div className="text-[15px] font-medium text-ink">
          {sinRepos ? "Cargá una carpeta de código para empezar" : "Abrí un archivo del explorador"}
        </div>
        <p className="text-[13px] leading-relaxed text-ink-dim">
          {sinRepos
            ? "Los agentes trabajan sobre una copia propia, en una rama; tu carpeta no se toca hasta que integres."
            : escritor
              ? `${escritor} está escribiendo ahora. Lo que toque aparece marcado en el explorador.`
              : corridaViva
                ? "Hay una corrida en curso: los cambios de los agentes aparecen marcados en el explorador."
                : "Pedile una mejora al agente desde el chat (⌘L), mirá el resultado en la vista previa y quedate con lo que sirva."}
        </p>
        {!sinRepos && (
          <dl className="mx-auto grid w-80 grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[12px]">
            {atajos.map(([que, tecla]) => (
              <div key={que} className="contents">
                <dt className="text-left text-ink-dim">{que}</dt>
                <dd className="text-right font-mono text-ink-faint">{tecla}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

export default Codigo;
