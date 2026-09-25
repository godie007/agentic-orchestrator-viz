import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type RepoConSesion } from "../../api.js";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FilePlus2,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListCollapse,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";

/**
 * El explorador de archivos, como el de VS Code con un workspace de varias
 * carpetas: **cada repo del proyecto es una raíz propia**, con sus acciones
 * (archivo nuevo, actualizar, configurar, sacarlo del proyecto) y su propio
 * árbol. Carpetas primero, colapsables, con el estado git de cada archivo a la
 * derecha (M cambiado, A nuevo) y el nombre teñido del mismo color, así se ve
 * de un vistazo qué tocó la sesión.
 */

interface NodoArchivo {
  tipo: "archivo";
  nombre: string;
  ruta: string;
}
interface NodoCarpeta {
  tipo: "carpeta";
  nombre: string;
  ruta: string;
  hijos: Array<NodoCarpeta | NodoArchivo>;
}

export function construirArbol(rutas: string[]): NodoCarpeta {
  const raiz: NodoCarpeta = { tipo: "carpeta", nombre: "", ruta: "", hijos: [] };
  for (const ruta of rutas) {
    const partes = ruta.split("/");
    let actual = raiz;
    partes.forEach((parte, i) => {
      const rutaParcial = partes.slice(0, i + 1).join("/");
      if (i === partes.length - 1) {
        actual.hijos.push({ tipo: "archivo", nombre: parte, ruta: rutaParcial });
        return;
      }
      let carpeta = actual.hijos.find((h): h is NodoCarpeta => h.tipo === "carpeta" && h.nombre === parte);
      if (!carpeta) {
        carpeta = { tipo: "carpeta", nombre: parte, ruta: rutaParcial, hijos: [] };
        actual.hijos.push(carpeta);
      }
      actual = carpeta;
    });
  }
  const ordenar = (nodo: NodoCarpeta) => {
    nodo.hijos.sort((a, b) =>
      a.tipo === b.tipo ? a.nombre.localeCompare(b.nombre) : a.tipo === "carpeta" ? -1 : 1,
    );
    for (const hijo of nodo.hijos) if (hijo.tipo === "carpeta") ordenar(hijo);
  };
  ordenar(raiz);
  return raiz;
}

const COLOR_POR_EXTENSION: Record<string, string> = {
  js: "text-yellow-500", mjs: "text-yellow-500", cjs: "text-yellow-500", jsx: "text-sky-400",
  ts: "text-blue-500", tsx: "text-sky-400", json: "text-amber-500", md: "text-sky-500",
  html: "text-orange-500", css: "text-purple-400", scss: "text-pink-400", py: "text-emerald-500",
  go: "text-cyan-500", rs: "text-orange-600", glsl: "text-lime-500", sh: "text-green-500",
  yml: "text-rose-400", yaml: "text-rose-400",
};

export function IconoDeArchivo({ nombre, className = "" }: { nombre: string; className?: string }) {
  const ext = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase() : "";
  const Icono = ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)
    ? FileImage
    : ext === "json"
      ? FileJson
      : ["md", "txt"].includes(ext)
        ? FileText
        : COLOR_POR_EXTENSION[ext]
          ? FileCode2
          : FileIcon;
  return <Icono className={`size-4 shrink-0 ${COLOR_POR_EXTENSION[ext] ?? "text-ink-faint"} ${className}`} aria-hidden />;
}

const MARCA_ESTADO: Record<string, { letra: string; color: string }> = {
  A: { letra: "A", color: "text-ok" },
  M: { letra: "M", color: "text-warn" },
  D: { letra: "D", color: "text-danger" },
  R: { letra: "R", color: "text-accent" },
};

export function marcaDeEstado(estado: string | undefined) {
  if (!estado) return null;
  return MARCA_ESTADO[estado.charAt(0)] ?? { letra: estado.charAt(0), color: "text-ink-dim" };
}

export interface AccionesDelExplorador {
  onAbrir: (repoId: string, ruta: string) => void;
  onNuevo: (repoId: string, ruta: string) => void;
  onBorrar: (repoId: string, ruta: string) => void;
  onVistaPrevia: (repoId: string, ruta: string) => void;
  onConfigurar: (repoId: string) => void;
  onQuitar: (repoId: string) => void;
  onElegir: (repoId: string) => void;
  /** Rechaza con el motivo (nombre repetido): el campo queda abierto mostrándolo. */
  onRenombrar: (repoId: string, nombre: string) => Promise<unknown>;
}

export function Explorador({
  repos,
  activo,
  onAgregar,
  ...acciones
}: {
  repos: RepoConSesion[];
  activo: { repoId: string; ruta: string } | null;
  onAgregar: () => void;
} & AccionesDelExplorador) {
  const [filtro, setFiltro] = useState("");
  // Colapsar todo vuelve a montar las raíces: es lo que hace el botón de VS Code.
  const [generacion, setGeneracion] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 px-3 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
        <span className="min-w-0 flex-1 truncate">Explorador</span>
        <button type="button" title="Agregar una carpeta de código al proyecto" onClick={onAgregar} className="rounded p-1 hover:bg-surface-2 hover:text-ink">
          <FolderPlus className="size-3.5" aria-hidden />
        </button>
        <button type="button" title="Colapsar todo" onClick={() => setGeneracion((g) => g + 1)} className="rounded p-1 hover:bg-surface-2 hover:text-ink">
          <ListCollapse className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="px-2 pb-2">
        <input
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder="Filtrar archivos"
          className="h-6 w-full rounded border border-line bg-canvas px-2 text-[12px] text-ink outline-none focus:border-accent"
        />
      </div>
      <div role="tree" className="min-h-0 flex-1 overflow-auto pb-4">
        {repos.map((item, i) => (
          <RaizDeRepo
            key={`${item.repo.id}-${generacion}`}
            item={item}
            abiertaAlInicio={generacion === 0 && (i === 0 || repos.length <= 3)}
            filtro={filtro}
            activo={activo?.repoId === item.repo.id ? activo.ruta : null}
            {...acciones}
          />
        ))}
        {repos.length === 0 && (
          <button type="button" onClick={onAgregar} className="mx-3 mt-2 w-[calc(100%-1.5rem)] rounded border border-dashed border-line px-3 py-4 text-[12px] text-ink-faint hover:border-accent hover:text-ink">
            Agregar una carpeta de código
          </button>
        )}
      </div>
    </div>
  );
}

function RaizDeRepo({
  item,
  abiertaAlInicio,
  filtro,
  activo,
  onAbrir,
  onNuevo,
  onBorrar,
  onVistaPrevia,
  onConfigurar,
  onQuitar,
  onElegir,
  onRenombrar,
}: {
  item: RepoConSesion;
  abiertaAlInicio: boolean;
  filtro: string;
  activo: string | null;
} & AccionesDelExplorador) {
  const repoId = item.repo.id;
  const [abierta, setAbierta] = useState(abiertaAlInicio);
  const [creando, setCreando] = useState<string | null>(null);
  const [renombre, setRenombre] = useState<{ texto: string; error: string | null } | null>(null);
  const arbol = useQuery({
    queryKey: ["arbol", repoId],
    queryFn: () => api.arbolDeRepo(repoId),
    enabled: abierta || filtro.trim() !== "",
    refetchInterval: 3_000,
  });
  const cambios = useMemo(
    () => new Map((arbol.data?.cambios ?? []).map((c) => [c.ruta, c.estado] as const)),
    [arbol.data],
  );
  const soloLectura = arbol.data?.escritor != null;
  const Chevron = abierta ? ChevronDown : ChevronRight;
  const accion = "rounded p-0.5 text-ink-faint hover:bg-surface-2 hover:text-ink";

  return (
    <div role="group" className="mb-0.5">
      <div
        role="treeitem"
        aria-expanded={abierta}
        onClick={() => {
          setAbierta(!abierta);
          onElegir(repoId);
        }}
        className="group flex h-[26px] cursor-pointer items-center gap-1 pr-2 pl-1 text-[12px] font-semibold tracking-wide text-ink uppercase hover:bg-surface-2"
        title={item.repo.origen.tipo === "local" ? item.repo.origen.ruta : item.repo.origen.tipo === "git" ? item.repo.origen.url : "Creado por la empresa"}
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden />
        {renombre ? (
          <form
            className="flex min-w-0 flex-1 flex-col"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const nombre = renombre.texto.trim();
              if (!nombre || nombre === item.repo.nombre) return setRenombre(null);
              onRenombrar(repoId, nombre).then(
                () => setRenombre(null),
                (fallo: unknown) =>
                  setRenombre({ texto: renombre.texto, error: fallo instanceof Error ? fallo.message : String(fallo) }),
              );
            }}
          >
            <input
              autoFocus
              value={renombre.texto}
              aria-label="Nuevo nombre del repo"
              maxLength={120}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenombre({ texto: e.target.value, error: null })}
              onKeyDown={(e) => e.key === "Escape" && setRenombre(null)}
              // Salir sin haber cambiado nada cierra; con un cambio a medio
              // escribir se queda, para no tirar lo tipeado por un click de más.
              onBlur={() => renombre.texto.trim() === item.repo.nombre && setRenombre(null)}
              className="h-5 min-w-0 rounded border border-accent bg-canvas px-1 text-[12px] font-normal tracking-normal text-ink normal-case outline-none"
            />
            {renombre.error && (
              <span className="text-[10px] font-normal tracking-normal text-danger normal-case">{renombre.error}</span>
            )}
          </form>
        ) : (
          <span
            className="min-w-0 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenombre({ texto: item.repo.nombre, error: null });
            }}
          >
            {item.repo.nombre}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-surface-2 px-1 text-[10px] font-normal tracking-normal text-ink-faint normal-case">
          <GitBranch className="size-2.5" aria-hidden />
          {item.sesion ? item.sesion.rama.replace(/^orq\//, "") : "base"}
        </span>
        {cambios.size > 0 && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-hidden />}
        <span className="flex-1" />
        <span className="hidden items-center gap-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()}>
          {!soloLectura && (
            <button type="button" title="Archivo nuevo" onClick={() => { setAbierta(true); setCreando(""); }} className={accion}>
              <FilePlus2 className="size-3.5" aria-hidden />
            </button>
          )}
          <button type="button" title="Actualizar" onClick={() => void arbol.refetch()} className={accion}>
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
          <button type="button" title="Renombrar (doble click en el nombre)" onClick={() => setRenombre({ texto: item.repo.nombre, error: null })} className={accion}>
            <Pencil className="size-3.5" aria-hidden />
          </button>
          <button type="button" title="Configurar: comandos y origen" onClick={() => onConfigurar(repoId)} className={accion}>
            <Settings2 className="size-3.5" aria-hidden />
          </button>
          <button type="button" title="Sacar este repo del proyecto" onClick={() => onQuitar(repoId)} className={`${accion} hover:text-danger`}>
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      {creando !== null && (
        <form
          className="py-1 pr-2 pl-6"
          onSubmit={(e) => {
            e.preventDefault();
            const ruta = creando.trim().replace(/^\/+/, "");
            if (ruta) onNuevo(repoId, ruta);
            setCreando(null);
          }}
        >
          <input
            autoFocus
            value={creando}
            onChange={(e) => setCreando(e.target.value)}
            onBlur={() => setCreando(null)}
            onKeyDown={(e) => e.key === "Escape" && setCreando(null)}
            placeholder="ruta/del/archivo.js — Enter"
            className="h-6 w-full rounded border border-accent bg-canvas px-2 font-mono text-[12px] text-ink outline-none"
          />
        </form>
      )}
      {(abierta || filtro.trim()) &&
        (arbol.data ? (
          <ArbolDeArchivos
            archivos={arbol.data.archivos}
            cambios={cambios}
            activo={activo}
            soloLectura={soloLectura}
            filtro={filtro}
            onAbrir={(ruta) => onAbrir(repoId, ruta)}
            onBorrar={(ruta) => onBorrar(repoId, ruta)}
            onVistaPrevia={(ruta) => onVistaPrevia(repoId, ruta)}
          />
        ) : (
          <p className="py-1 pl-7 text-[12px] text-ink-faint">{arbol.isError ? "No se pudo leer el árbol." : "Cargando…"}</p>
        ))}
    </div>
  );
}

function ArbolDeArchivos({
  archivos,
  cambios,
  activo,
  soloLectura,
  filtro,
  onAbrir,
  onBorrar,
  onVistaPrevia,
}: {
  archivos: string[];
  cambios: Map<string, string>;
  activo: string | null;
  soloLectura: boolean;
  filtro: string;
  onAbrir: (ruta: string) => void;
  onBorrar: (ruta: string) => void;
  onVistaPrevia: (ruta: string) => void;
}) {
  const arbol = useMemo(() => construirArbol(archivos), [archivos]);
  const [abiertas, setAbiertas] = useState<Set<string>>(() => new Set());

  // Una carpeta con cambios adentro también se marca: si no, un cambio en
  // `src/render/shader.js` queda escondido detrás de dos carpetas cerradas.
  const carpetasConCambios = useMemo(() => {
    const conjunto = new Set<string>();
    for (const ruta of cambios.keys()) {
      const partes = ruta.split("/");
      for (let i = 1; i < partes.length; i++) conjunto.add(partes.slice(0, i).join("/"));
    }
    return conjunto;
  }, [cambios]);

  const filtrados = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    return f ? archivos.filter((ruta) => ruta.toLowerCase().includes(f)) : null;
  }, [archivos, filtro]);

  const alternar = (ruta: string) =>
    setAbiertas((previas) => {
      const nuevas = new Set(previas);
      if (nuevas.has(ruta)) nuevas.delete(ruta);
      else nuevas.add(ruta);
      return nuevas;
    });

  const filaArchivo = (ruta: string, nombre: string, profundidad: number, conRuta = false) => {
    const marca = marcaDeEstado(cambios.get(ruta));
    const esPagina = /\.html?$/i.test(nombre);
    return (
      <div
        key={ruta}
        role="treeitem"
        aria-selected={activo === ruta}
        onClick={() => onAbrir(ruta)}
        className={`group flex h-[22px] cursor-pointer items-center gap-1.5 pr-2 text-[13px] ${
          activo === ruta ? "bg-accent/20 text-ink" : "text-ink-dim hover:bg-surface-2"
        }`}
        style={{ paddingLeft: 8 + (profundidad + 1) * 12 + 14 }}
        title={ruta}
      >
        <IconoDeArchivo nombre={nombre} />
        <span className={`min-w-0 flex-1 truncate ${marca ? marca.color : ""}`}>
          {nombre}
          {conRuta && <span className="ml-1.5 text-[11px] text-ink-faint">{ruta.slice(0, -nombre.length - 1)}</span>}
        </span>
        {esPagina && (
          <button
            type="button"
            title={`Vista previa de ${ruta}`}
            onClick={(e) => {
              e.stopPropagation();
              onVistaPrevia(ruta);
            }}
            className="hidden rounded p-0.5 text-ink-faint hover:bg-surface-2 hover:text-accent group-hover:block"
          >
            <Eye className="size-3" aria-hidden />
          </button>
        )}
        {!soloLectura && (
          <button
            type="button"
            title={`Borrar ${ruta}`}
            onClick={(e) => {
              e.stopPropagation();
              onBorrar(ruta);
            }}
            className="hidden rounded p-0.5 text-ink-faint hover:bg-danger/15 hover:text-danger group-hover:block"
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        )}
        {marca && <span className={`w-3 text-center text-[11px] font-semibold ${marca.color}`}>{marca.letra}</span>}
      </div>
    );
  };

  const render = (nodo: NodoCarpeta, profundidad: number): React.ReactNode =>
    nodo.hijos.map((hijo) => {
      if (hijo.tipo === "archivo") return filaArchivo(hijo.ruta, hijo.nombre, profundidad);
      const abierta = abiertas.has(hijo.ruta);
      const Chevron = abierta ? ChevronDown : ChevronRight;
      const Carpeta = abierta ? FolderOpen : Folder;
      return (
        <div key={hijo.ruta} role="group">
          <div
            role="treeitem"
            aria-expanded={abierta}
            onClick={() => alternar(hijo.ruta)}
            className="flex h-[22px] cursor-pointer items-center gap-1 pr-2 text-[13px] text-ink-dim hover:bg-surface-2"
            style={{ paddingLeft: 8 + (profundidad + 1) * 12 }}
          >
            <Chevron className="size-3.5 shrink-0" aria-hidden />
            <Carpeta className="size-4 shrink-0 text-sky-500/80" aria-hidden />
            <span className={`min-w-0 flex-1 truncate ${carpetasConCambios.has(hijo.ruta) ? "text-warn" : ""}`}>
              {hijo.nombre}
            </span>
            {carpetasConCambios.has(hijo.ruta) && <span className="size-1.5 rounded-full bg-warn" aria-hidden />}
          </div>
          {abierta && render(hijo, profundidad + 1)}
        </div>
      );
    });

  if (filtrados) {
    return filtrados.length === 0 ? null : <>{filtrados.slice(0, 200).map((ruta) => filaArchivo(ruta, ruta.split("/").at(-1) ?? ruta, 0, true))}</>;
  }
  return <>{render(arbol, 0)}</>;
}
