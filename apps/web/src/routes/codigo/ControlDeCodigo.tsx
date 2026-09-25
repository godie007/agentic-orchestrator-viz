import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  Tag,
  Minus,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { api, type ArbolDeRepo, type CommitDelHistorial, type EstadoScm } from "../../api.js";
import { ConfirmDialog, relativeTime, useToast } from "../../ui/index.js";
import { IconoDeArchivo, marcaDeEstado } from "./Explorador.js";

/**
 * El control de código fuente, como el panel de Git de Cursor: preparar y
 * quitar archivos, commit con un mensaje que puede escribir la IA, stash,
 * ramas y fusión — todo sobre la sesión, nunca sobre tu carpeta.
 *
 * Integrar y descartar la sesión siguen viviendo acá y sólo acá: un agente no
 * puede hacer ninguna de las dos. Mientras un agente está en su turno, nada de
 * esto escribe (el servidor lo rechaza y los botones lo dicen).
 */

type Confirmacion =
  | { tipo: "integrar" }
  | { tipo: "descartar-sesion" }
  | { tipo: "descartar"; rutas: string[] | "todo"; titulo: string }
  | { tipo: "borrar-rama"; nombre: string }
  | { tipo: "borrar-stash"; ref: string };

export function ControlDeCodigo({
  repoId,
  arbol,
  origen,
  onAbrirDiff,
  onAbrirDiffEntre,
}: {
  repoId: string;
  arbol: ArbolDeRepo | undefined;
  origen: "local" | "git" | "creado";
  onAbrirDiff: (ruta: string) => void;
  /** El diff de un archivo entre dos commits: lo que cambió un commit de la historia. */
  onAbrirDiffEntre: (ruta: string, desde: string, hasta: string) => void;
}) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const [mensaje, setMensaje] = useState("");
  const [amend, setAmend] = useState(false);
  const [confirmar, setConfirmar] = useState<Confirmacion | null>(null);

  const scm = useQuery({ queryKey: ["scm", repoId], queryFn: () => api.scm(repoId), refetchInterval: 3_000 });
  const sesion = scm.data?.sesion ?? arbol?.sesion ?? null;
  const estado = scm.data?.estado ?? null;
  const escritor = scm.data?.escritor ?? arbol?.escritor ?? null;
  const bloqueado = escritor != null;

  const refrescar = () => {
    for (const clave of ["scm", "scm-historial", "arbol", "sesion", "repos", "archivo"]) void queryClient.invalidateQueries({ queryKey: [clave] });
  };

  /** Toda operación git del panel pasa por acá: mismo manejo de errores y de refresco. */
  const operar = useMutation({
    mutationFn: ({ op, cuerpo }: { op: string; cuerpo?: Record<string, unknown>; exito?: string }) =>
      api.scmOperar<Record<string, unknown>>(sesion!.id, op, cuerpo ?? {}),
    onSuccess: (r, { exito }) => {
      if (r && r["ok"] === false && typeof r["motivo"] === "string") avisar(r["motivo"], "error");
      else if (exito) avisar(typeof r?.["detalle"] === "string" ? (r["detalle"] as string) : exito, "ok");
      refrescar();
    },
    onError: (e: Error) => {
      avisar(e.message, "error");
      refrescar();
    },
  });

  const sincronizar = useMutation({
    mutationFn: () => api.scmSincronizar(sesion!.id),
    onSuccess: (r) => {
      avisar(r.detalle, "ok");
      refrescar();
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const generar = useMutation({
    mutationFn: () => api.scmOperar<{ mensaje: string }>(sesion!.id, "mensaje"),
    onSuccess: (r) => setMensaje(r.mensaje),
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const commit = useMutation({
    mutationFn: () => api.scmOperar<{ sha: string }>(sesion!.id, "commit", { mensaje, amend }),
    onSuccess: (r) => {
      setMensaje("");
      setAmend(false);
      avisar(`${amend ? "Commit modificado" : "Commit"} ${r.sha.slice(0, 8)}.`, "ok");
      refrescar();
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const integrar = useMutation({
    mutationFn: () => api.integrarSesion(sesion!.id),
    onSuccess: (r) => {
      setConfirmar(null);
      if (r.ok) avisar(r.detalle, "ok");
      refrescar();
    },
    onError: (e: Error) => {
      setConfirmar(null);
      avisar(e.message, "error");
    },
  });
  const descartarSesion = useMutation({
    mutationFn: () => api.descartarSesion(sesion!.id),
    onSuccess: () => {
      setConfirmar(null);
      avisar("Sesión descartada.", "ok");
      refrescar();
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  if (!sesion) {
    return (
      <Vista titulo="Control de código fuente">
        <p className="px-4 text-[12px] leading-relaxed text-ink-faint">
          No hay una sesión abierta: estás viendo la rama base en sólo lectura. La sesión se abre sola cuando un agente
          empieza a trabajar o cuando guardás un archivo.
        </p>
      </Vista>
    );
  }

  const sensibles = new Set(arbol?.sensibles ?? []);
  const contraBase = arbol?.cambios ?? [];
  const preparados = estado?.preparados ?? [];
  const cambios = estado?.cambios ?? [];
  const hayAlgo = preparados.length + cambios.length > 0;
  const ocupado = operar.isPending || commit.isPending;
  const textoBoton = amend
    ? "Modificar el último commit"
    : preparados.length
      ? `Commit (${preparados.length} preparado${preparados.length === 1 ? "" : "s"})`
      : hayAlgo
        ? "Commit de todo"
        : "Commit";

  return (
    <Vista
      titulo="Control de código fuente"
      acciones={
        <>
          <MenuStash
            deshabilitado={bloqueado || !hayAlgo}
            hayPreparados={preparados.length > 0}
            onGuardar={(opciones) => operar.mutate({ op: "stash", cuerpo: opciones, exito: "Cambios guardados en un stash." })}
          />
          <button
            type="button"
            title={origen === "creado" ? "Actualizar" : "Sincronizar: traer lo nuevo de tu repo (ramas, commits, tags)"}
            onClick={() => (origen === "creado" ? refrescar() : sincronizar.mutate())}
            className={ICONO}
          >
            <RefreshCw className={`size-3.5 ${scm.isFetching || sincronizar.isPending ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </>
      }
    >
      <div className="space-y-2 px-3 pb-3">
        <SelectorDeRama
          estado={estado}
          bloqueado={bloqueado}
          onCambiar={(nombre) => operar.mutate({ op: "ramas/cambiar", cuerpo: { nombre }, exito: `Ahora estás en ${nombre}.` })}
          onCrear={(nombre, desde) =>
            operar.mutate({ op: "ramas/crear", cuerpo: { nombre, ...(desde ? { desde } : {}) }, exito: `Rama ${nombre} creada y abierta.` })
          }
          onFusionar={(nombre) => operar.mutate({ op: "ramas/fusionar", cuerpo: { nombre }, exito: `Se fusionó ${nombre}.` })}
          onBorrar={(nombre) => setConfirmar({ tipo: "borrar-rama", nombre })}
        />

        {estado?.base.ref && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-faint" title={`Comparado con ${estado.base.ref}: la rama ${estado.base.rama} de ${origen === "creado" ? "este repo" : "tu repo"}`}>
            <span className="min-w-0 truncate">
              Base: <span className="font-mono text-ink-dim">{estado.base.rama}</span> {origen === "creado" ? "" : "de tu repo"}
            </span>
            {estado.base.adelante > 0 && <span className="shrink-0 rounded bg-accent/15 px-1 text-accent">↑{estado.base.adelante} sin integrar</span>}
            {estado.base.atras > 0 && <span className="shrink-0 rounded bg-warn/15 px-1 text-warn">↓{estado.base.atras} nuevos</span>}
            <span className="flex-1" />
            {estado.base.atras > 0 && (
              <button
                type="button"
                disabled={bloqueado || operar.isPending}
                title={`Traer a la sesión los ${estado.base.atras} commit(s) nuevos de ${estado.base.ref}`}
                onClick={() => operar.mutate({ op: "ramas/fusionar", cuerpo: { nombre: estado.base.ref }, exito: `Se trajeron los cambios de ${estado.base.rama}.` })}
                className="flex shrink-0 items-center gap-0.5 rounded px-1 text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                <ArrowDownToLine className="size-3" aria-hidden /> Traer
              </button>
            )}
          </div>
        )}

        {bloqueado && (
          <p className="rounded border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-ink-dim">
            {escritor} está escribiendo en su turno: el control de versiones espera a que termine.
          </p>
        )}

        <div className="relative rounded border border-line bg-canvas focus-within:border-accent">
          <textarea
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !bloqueado && (hayAlgo || amend)) commit.mutate();
            }}
            rows={mensaje.includes("\n") ? 5 : 2}
            placeholder={hayAlgo ? "Mensaje (⌘Enter para hacer commit)" : "Nada para commitear"}
            className="block w-full resize-y bg-transparent py-1 pr-8 pl-2 text-[12px] text-ink outline-none"
          />
          <button
            type="button"
            title="Generar el mensaje con IA a partir de los cambios (sigue el estilo de los commits del repo)"
            disabled={!hayAlgo || generar.isPending}
            onClick={() => generar.mutate()}
            className="absolute top-1 right-1 rounded p-1 text-accent hover:bg-accent/10 disabled:text-ink-faint disabled:opacity-50"
          >
            {generar.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
          </button>
        </div>
        <button
          type="button"
          disabled={bloqueado || ocupado || (!hayAlgo && !amend) || (!mensaje.trim() && !amend)}
          onClick={() => commit.mutate()}
          title={!mensaje.trim() && !amend ? "Escribí un mensaje o generalo con ✨" : "Commit firmado con tu identidad de git"}
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded bg-accent text-[12px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          {commit.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />} {textoBoton}
        </button>
        {estado?.puedeModificarUltimo && (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-faint" title="Suma lo preparado al último commit de la sesión y, si escribiste un mensaje, lo reemplaza">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} className="accent-[var(--color-accent)]" />
            Modificar el último commit (amend)
          </label>
        )}
      </div>

      {sensibles.size > 0 && (
        <p className="mx-3 mb-2 flex items-start gap-1.5 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Cambia archivos que deciden qué se ejecuta: {[...sensibles].join(", ")}. Miralos antes de integrar.
        </p>
      )}

      {(estado?.conflictos.length ?? 0) > 0 && (
        <Seccion titulo="Conflictos" contador={estado!.conflictos.length}>
          {estado!.conflictos.map((ruta) => (
            <FilaDeArchivo key={ruta} ruta={ruta} estado="U" onAbrir={() => onAbrirDiff(ruta)} />
          ))}
        </Seccion>
      )}

      {preparados.length > 0 && (
        <Seccion
          titulo="Cambios preparados"
          contador={preparados.length}
          acciones={
            <button type="button" title="Quitar todo" disabled={bloqueado} onClick={() => operar.mutate({ op: "quitar", cuerpo: { rutas: "todo" } })} className={ICONO}>
              <Minus className="size-3.5" aria-hidden />
            </button>
          }
        >
          {preparados.map((a) => (
            <FilaDeArchivo
              key={`p:${a.ruta}`}
              ruta={a.ruta}
              estado={a.estado}
              sensible={sensibles.has(a.ruta)}
              onAbrir={() => onAbrirDiff(a.ruta)}
              acciones={
                <button type="button" title="Quitar de los preparados" disabled={bloqueado} onClick={() => operar.mutate({ op: "quitar", cuerpo: { rutas: [a.ruta] } })} className={ICONO}>
                  <Minus className="size-3.5" aria-hidden />
                </button>
              }
            />
          ))}
        </Seccion>
      )}

      <Seccion
        titulo="Cambios"
        contador={cambios.length}
        acciones={
          cambios.length > 0 ? (
            <>
              <button
                type="button"
                title="Descartar todos los cambios"
                disabled={bloqueado}
                onClick={() => setConfirmar({ tipo: "descartar", rutas: "todo", titulo: "todos los cambios" })}
                className={ICONO}
              >
                <Undo2 className="size-3.5" aria-hidden />
              </button>
              <button type="button" title="Preparar todo" disabled={bloqueado} onClick={() => operar.mutate({ op: "preparar", cuerpo: { rutas: "todo" } })} className={ICONO}>
                <Plus className="size-3.5" aria-hidden />
              </button>
            </>
          ) : null
        }
      >
        {cambios.length === 0 ? (
          <p className="px-4 py-1 text-[12px] text-ink-faint">{preparados.length ? "Todo lo que cambió está preparado." : "Sin cambios sin commitear."}</p>
        ) : (
          cambios.map((a) => (
            <FilaDeArchivo
              key={`c:${a.ruta}`}
              ruta={a.ruta}
              estado={a.estado}
              sensible={sensibles.has(a.ruta)}
              onAbrir={() => onAbrirDiff(a.ruta)}
              acciones={
                <>
                  <button
                    type="button"
                    title={a.estado === "?" ? "Borrar el archivo nuevo" : "Descartar los cambios"}
                    disabled={bloqueado}
                    onClick={() => setConfirmar({ tipo: "descartar", rutas: [a.ruta], titulo: a.ruta })}
                    className={ICONO}
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" title="Preparar" disabled={bloqueado} onClick={() => operar.mutate({ op: "preparar", cuerpo: { rutas: [a.ruta] } })} className={ICONO}>
                    <Plus className="size-3.5" aria-hidden />
                  </button>
                </>
              }
            />
          ))
        )}
      </Seccion>

      {(estado?.stashes.length ?? 0) > 0 && (
        <Seccion titulo="Stashes" contador={estado!.stashes.length}>
          {estado!.stashes.map((s) => (
            <div key={s.ref} className="group flex items-center gap-1.5 py-0.5 pr-2 pl-5 text-[12px] hover:bg-surface-2" title={s.ref}>
              <Archive className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink">{s.mensaje || s.ref}</span>
              <span className="shrink-0 text-[10px] text-ink-faint group-hover:hidden">{relativeTime(s.at)}</span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                <button type="button" title="Aplicar (lo deja guardado)" disabled={bloqueado} onClick={() => operar.mutate({ op: "stash/usar", cuerpo: { ref: s.ref, accion: "aplicar" }, exito: "Stash aplicado." })} className={ICONO}>
                  <Check className="size-3.5" aria-hidden />
                </button>
                <button type="button" title="Sacar (aplicar y borrarlo)" disabled={bloqueado} onClick={() => operar.mutate({ op: "stash/usar", cuerpo: { ref: s.ref, accion: "sacar" }, exito: "Stash recuperado." })} className={ICONO}>
                  <ArchiveRestore className="size-3.5" aria-hidden />
                </button>
                <button type="button" title="Borrar el stash" disabled={bloqueado} onClick={() => setConfirmar({ tipo: "borrar-stash", ref: s.ref })} className={`${ICONO} hover:text-danger`}>
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </span>
            </div>
          ))}
        </Seccion>
      )}

      <Seccion titulo="Contra la base" contador={contraBase.length} cerrada>
        {contraBase.length === 0 ? (
          <p className="px-4 py-1 text-[12px] text-ink-faint">La sesión todavía no cambió nada.</p>
        ) : (
          contraBase.map((cambio) => (
            <FilaDeArchivo key={`b:${cambio.ruta}`} ruta={cambio.ruta} estado={cambio.estado} sensible={sensibles.has(cambio.ruta)} onAbrir={() => onAbrirDiff(cambio.ruta)} />
          ))
        )}
      </Seccion>

      <Seccion titulo={`Historial${estado?.rama ? ` · ${estado.rama}` : ""}`} contador={estado?.base.adelante ?? 0}>
        <HistorialDeRama sesionId={sesion.id} cabeza={estado?.cabeza ?? null} onAbrirDiffEntre={onAbrirDiffEntre} />
      </Seccion>

      <div className="mt-auto space-y-1.5 border-t border-line p-3">
        <button
          type="button"
          disabled={contraBase.length === 0 || bloqueado}
          onClick={() => setConfirmar({ tipo: "integrar" })}
          className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-accent/50 bg-accent/10 text-[12px] font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          <GitMerge className="size-3.5" aria-hidden /> Integrar {estado?.rama ?? sesion.rama} a {origen === "git" ? "la rama" : origen === "creado" ? "su main" : "tu repo"}
        </button>
        <div className="flex gap-1.5">
          <a
            href={api.patchUrl(sesion.id)}
            download
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-line text-[12px] text-ink-dim hover:bg-surface-2"
          >
            <Download className="size-3.5" aria-hidden /> Patch
          </a>
          <button
            type="button"
            disabled={bloqueado}
            onClick={() => setConfirmar({ tipo: "descartar-sesion" })}
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-line text-[12px] text-ink-dim hover:border-danger/50 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          >
            <Trash2 className="size-3.5" aria-hidden /> Descartar sesión
          </button>
        </div>
      </div>

      <ConfirmDialog
        abierto={confirmar?.tipo === "integrar"}
        titulo="Integrar la sesión"
        detalle={
          origen === "git"
            ? "La rama queda en la copia de trabajo lista para subir; te dice el comando. También podés descargar el patch."
            : "Se crea la rama en tu repo y, si tenés la rama base abierta y sin cambios pendientes, avanza con fast-forward. Si no, la rama queda para que la mezcles vos."
        }
        confirmar="Integrar"
        pendiente={integrar.isPending}
        onConfirmar={() => integrar.mutate()}
        onCancelar={() => setConfirmar(null)}
      />
      <ConfirmDialog
        abierto={confirmar?.tipo === "descartar-sesion"}
        titulo="Descartar la sesión"
        detalle="Se borran el worktree y la rama con todos sus checkpoints. No hay vuelta atrás. Tu repo original no se toca."
        confirmar="Descartar"
        pendiente={descartarSesion.isPending}
        onConfirmar={() => descartarSesion.mutate()}
        onCancelar={() => setConfirmar(null)}
      />
      <ConfirmDialog
        abierto={confirmar?.tipo === "descartar"}
        titulo={`¿Descartar ${confirmar?.tipo === "descartar" ? confirmar.titulo : ""}?`}
        detalle="Lo modificado vuelve a como está en el último commit y los archivos nuevos se borran. No hay papelera: si puede servirte, guardalo antes en un stash."
        confirmar="Descartar"
        onConfirmar={() => {
          if (confirmar?.tipo === "descartar") operar.mutate({ op: "descartar", cuerpo: { rutas: confirmar.rutas }, exito: "Cambios descartados." });
          setConfirmar(null);
        }}
        onCancelar={() => setConfirmar(null)}
      />
      <ConfirmDialog
        abierto={confirmar?.tipo === "borrar-rama"}
        titulo={`¿Borrar la rama ${confirmar?.tipo === "borrar-rama" ? confirmar.nombre : ""}?`}
        detalle="Los commits que sólo estén en esa rama dejan de verse. Tu repo original no se toca."
        confirmar="Borrar rama"
        onConfirmar={() => {
          if (confirmar?.tipo === "borrar-rama") operar.mutate({ op: "ramas/borrar", cuerpo: { nombre: confirmar.nombre }, exito: `Rama ${confirmar.nombre} borrada.` });
          setConfirmar(null);
        }}
        onCancelar={() => setConfirmar(null)}
      />
      <ConfirmDialog
        abierto={confirmar?.tipo === "borrar-stash"}
        titulo="¿Borrar el stash?"
        detalle="Lo que tenía guardado se pierde."
        confirmar="Borrar"
        onConfirmar={() => {
          if (confirmar?.tipo === "borrar-stash") operar.mutate({ op: "stash/usar", cuerpo: { ref: confirmar.ref, accion: "borrar" }, exito: "Stash borrado." });
          setConfirmar(null);
        }}
        onCancelar={() => setConfirmar(null)}
      />
    </Vista>
  );
}

const ICONO = "flex size-5 items-center justify-center rounded text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30";

function FilaDeArchivo({
  ruta,
  estado,
  sensible = false,
  onAbrir,
  acciones,
}: {
  ruta: string;
  estado: string;
  sensible?: boolean;
  onAbrir: () => void;
  acciones?: React.ReactNode;
}) {
  const nombre = ruta.split("/").at(-1) ?? ruta;
  const carpeta = ruta.slice(0, -nombre.length - 1);
  const marca = estado === "?" ? { letra: "U", color: "text-ok" } : marcaDeEstado(estado);
  return (
    <div className="group flex h-[22px] items-center gap-1.5 pr-2 pl-5 text-[13px] hover:bg-surface-2">
      <button type="button" onClick={onAbrir} title={`Ver los cambios de ${ruta}`} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <IconoDeArchivo nombre={nombre} />
        <span className={`truncate ${sensible ? "text-danger" : estado === "D" ? "text-ink-faint line-through" : "text-ink"}`}>{nombre}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{carpeta}</span>
      </button>
      {acciones && <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{acciones}</span>}
      {marca && <span className={`w-3 shrink-0 text-center text-[11px] font-semibold ${marca.color}`}>{marca.letra}</span>}
    </div>
  );
}

/** La rama abierta, y el menú para cambiar, crear, fusionar o borrar — como el selector de ramas de VS Code. */
function SelectorDeRama({
  estado,
  bloqueado,
  onCambiar,
  onCrear,
  onFusionar,
  onBorrar,
}: {
  estado: EstadoScm | null;
  bloqueado: boolean;
  onCambiar: (nombre: string) => void;
  onCrear: (nombre: string, desde?: string) => void;
  onFusionar: (nombre: string) => void;
  onBorrar: (nombre: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [filtro, setFiltro] = useState("");
  /** Crear la rama nueva desde otra que no es la abierta (la base, por ejemplo). */
  const [desde, setDesde] = useState<string | null>(null);
  const entrada = useRef<HTMLInputElement>(null);
  const contenedor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!abierto) return;
    const cerrar = (e: MouseEvent) => {
      if (!contenedor.current?.contains(e.target as Node)) setAbierto(false);
    };
    window.addEventListener("mousedown", cerrar);
    return () => window.removeEventListener("mousedown", cerrar);
  }, [abierto]);

  const ramas = estado?.ramas ?? [];
  const f = filtro.trim();
  const visibles = useMemo(() => ramas.filter((r) => r.nombre.toLowerCase().includes(f.toLowerCase())), [ramas, f]);
  // Las del repo de la persona que no están ya como locales, y las de su GitHub.
  const delRepo = useMemo(
    () => (estado?.ramasDelRepo ?? []).filter((r) => !r.local && r.ref.toLowerCase().includes(f.toLowerCase())),
    [estado, f],
  );
  const existe = ramas.some((r) => r.nombre === f);
  const actual = estado?.rama ?? "(sin rama)";
  const elegir = (accion: () => void) => {
    accion();
    setAbierto(false);
    setFiltro("");
    setDesde(null);
  };
  const origen = desde ?? actual;

  return (
    <div ref={contenedor} className="relative">
      <button
        type="button"
        disabled={bloqueado}
        onClick={() => setAbierto(!abierto)}
        title="Cambiar de rama, crear una o fusionar"
        className="flex h-7 w-full items-center gap-1.5 rounded border border-line bg-canvas px-2 text-[12px] text-ink hover:border-accent/50 disabled:opacity-50"
      >
        <GitBranch className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left font-mono">{actual}</span>
        {(estado?.adelante ?? 0) > 0 && (
          <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-ink-faint" title="Commits por delante de la base">
            ↑{estado!.adelante}
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      </button>
      {abierto && (
        <div className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border border-line bg-surface shadow-xl">
          {desde && (
            <div className="flex items-center gap-1 border-b border-line bg-accent/10 px-2 py-1 text-[11px] text-ink-dim">
              <GitBranchPlus className="size-3 text-accent" aria-hidden /> Rama nueva desde <b className="font-mono">{desde}</b>
              <span className="flex-1" />
              <button type="button" onClick={() => setDesde(null)} className="text-ink-faint hover:text-ink">
                cancelar
              </button>
            </div>
          )}
          <input
            ref={entrada}
            autoFocus
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAbierto(false);
              if (e.key === "Enter" && f) {
                if (existe && !desde) elegir(() => onCambiar(f));
                else if (!existe) elegir(() => onCrear(f, desde ?? undefined));
              }
            }}
            placeholder={desde ? "Nombre de la rama nueva…" : "Buscar o crear una rama…"}
            className="h-8 w-full border-b border-line bg-canvas px-2 font-mono text-[12px] text-ink outline-none"
          />
          <div className="max-h-72 overflow-auto py-1">
            {f && !existe && (
              <button
                type="button"
                onClick={() => elegir(() => onCrear(f, desde ?? undefined))}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-accent hover:bg-surface-2"
              >
                <GitBranchPlus className="size-3.5" aria-hidden /> Crear la rama <b className="font-mono">{f}</b> desde {origen}
              </button>
            )}
            {visibles.map((r) => (
              <div key={r.nombre} className="group flex items-center gap-1.5 px-2 py-1 hover:bg-surface-2" title={r.asunto}>
                <button
                  type="button"
                  disabled={r.actual || r.ocupada}
                  onClick={() => elegir(() => onCambiar(r.nombre))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:cursor-default"
                >
                  {r.actual ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden /> : <GitBranch className="size-3.5 shrink-0 text-ink-faint" aria-hidden />}
                  <span className={`min-w-0 truncate font-mono text-[12px] ${r.ocupada ? "text-ink-faint" : "text-ink"}`}>{r.nombre}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
                    {r.ocupada ? "abierta en el clon" : `${r.sha} · ${relativeTime(r.at)}`}
                  </span>
                </button>
                {!r.actual && (
                  <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      title={`Crear una rama nueva desde ${r.nombre}`}
                      onClick={() => {
                        setDesde(r.nombre);
                        setFiltro("");
                        entrada.current?.focus();
                      }}
                      className={ICONO}
                    >
                      <GitBranchPlus className="size-3.5" aria-hidden />
                    </button>
                    <button type="button" title={`Fusionar ${r.nombre} en ${actual}`} onClick={() => elegir(() => onFusionar(r.nombre))} className={ICONO}>
                      <GitMerge className="size-3.5" aria-hidden />
                    </button>
                    {!r.ocupada && (
                      <button type="button" title={`Borrar ${r.nombre}`} onClick={() => elegir(() => onBorrar(r.nombre))} className={`${ICONO} hover:text-danger`}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
            {visibles.length === 0 && !f && <p className="px-2 py-1 text-[12px] text-ink-faint">No hay ramas.</p>}
            {(["repo", "remoto"] as const).map((grupo) => {
              const lista = delRepo.filter((r) => r.grupo === grupo);
              if (!lista.length) return null;
              return (
                <div key={grupo}>
                  <div className="mt-1 border-t border-line px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                    {grupo === "repo" ? "Ramas de tu repo" : "En el remoto de tu repo (GitHub)"}
                  </div>
                  {lista.map((r) => (
                    <div key={r.ref} className="group flex items-center gap-1.5 px-2 py-1 hover:bg-surface-2" title={r.asunto}>
                      <button
                        type="button"
                        onClick={() => elegir(() => onCambiar(r.ref))}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        title={r.nombre === estado?.base.rama ? `${r.nombre} es la base: la sesión ya trabaja sobre ella` : `Abrir ${r.nombre} (se crea la local que la sigue)`}
                      >
                        <GitBranch className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                        <span className="min-w-0 truncate font-mono text-[12px] text-ink">{r.nombre}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
                          {r.nombre === estado?.base.rama ? "base de la sesión" : `${r.sha} · ${relativeTime(r.at)}`}
                        </span>
                      </button>
                      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                        <button
                          type="button"
                          title={`Crear una rama nueva desde ${r.ref}`}
                          onClick={() => {
                            setDesde(r.ref);
                            setFiltro("");
                            entrada.current?.focus();
                          }}
                          className={ICONO}
                        >
                          <GitBranchPlus className="size-3.5" aria-hidden />
                        </button>
                        <button type="button" title={`Fusionar ${r.ref} en ${actual}`} onClick={() => elegir(() => onFusionar(r.ref))} className={ICONO}>
                          <GitMerge className="size-3.5" aria-hidden />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * La historia de la rama abierta, entera y paginada: en INSPIA son cientos de
 * commits de `dev` antes del primero de la sesión. Cada commit muestra las
 * ramas y tags que apuntan a él, y los que todavía no están en tu repo se
 * marcan. Se abre para ver sus archivos, y cada archivo abre su diff.
 */
function HistorialDeRama({
  sesionId,
  cabeza,
  onAbrirDiffEntre,
}: {
  sesionId: string;
  cabeza: string | null;
  onAbrirDiffEntre: (ruta: string, desde: string, hasta: string) => void;
}) {
  const [paginas, setPaginas] = useState(1);
  const POR_PAGINA = 50;
  const historial = useQuery({
    queryKey: ["scm-historial", sesionId, cabeza, paginas],
    queryFn: () => api.scmHistorial(sesionId, 0, POR_PAGINA * paginas),
    placeholderData: (previo) => previo,
  });
  const [abierto, setAbierto] = useState<string | null>(null);
  const commits = historial.data?.commits ?? [];

  if (historial.isLoading) return <p className="px-4 py-1 text-[12px] text-ink-faint">Cargando la historia…</p>;
  return (
    <div>
      {commits.map((c, i) => (
        <FilaDeCommit
          key={c.sha}
          commit={c}
          ultimo={i === commits.length - 1}
          abierto={abierto === c.sha}
          sesionId={sesionId}
          onAlternar={() => setAbierto(abierto === c.sha ? null : c.sha)}
          onAbrirDiffEntre={onAbrirDiffEntre}
        />
      ))}
      {historial.data?.hayMas && (
        <button
          type="button"
          onClick={() => setPaginas((p) => p + 1)}
          disabled={historial.isFetching}
          className="mx-5 my-1 text-[11px] text-accent hover:underline disabled:opacity-50"
        >
          {historial.isFetching ? "Cargando…" : "Cargar más commits"}
        </button>
      )}
    </div>
  );
}

function FilaDeCommit({
  commit: c,
  ultimo,
  abierto,
  sesionId,
  onAlternar,
  onAbrirDiffEntre,
}: {
  commit: CommitDelHistorial;
  ultimo: boolean;
  abierto: boolean;
  sesionId: string;
  onAlternar: () => void;
  onAbrirDiffEntre: (ruta: string, desde: string, hasta: string) => void;
}) {
  const archivos = useQuery({
    queryKey: ["scm-commit", sesionId, c.sha],
    queryFn: () => api.scmCommit(sesionId, c.sha),
    enabled: abierto,
  });
  return (
    <div>
      <button type="button" onClick={onAlternar} className="group flex w-full items-stretch gap-1.5 pr-2 pl-4 text-left hover:bg-surface-2" title={`${c.sha}\n${c.asunto}`}>
        {/* La línea del grafo: un punto por commit, lleno si todavía no está en tu repo. */}
        <span className="relative flex w-3 shrink-0 justify-center">
          <span className={`absolute top-0 w-px bg-line ${ultimo ? "h-3" : "h-full"}`} aria-hidden />
          <span
            className={`relative mt-[7px] size-2 rounded-full border ${c.sinIntegrar ? "border-accent bg-accent" : c.fusion ? "border-ink-faint bg-surface" : "border-ink-faint bg-ink-faint"}`}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1 py-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {c.refs.map((r) => (
              <RefDeCommit key={r} nombre={r} />
            ))}
            <span className={`min-w-0 truncate text-[12px] ${c.sinIntegrar ? "text-ink" : "text-ink-dim"}`}>{c.asunto}</span>
          </span>
          <span className="block truncate text-[11px] text-ink-faint">
            {c.autor} · {relativeTime(c.at)} · <span className="font-mono">{c.corto}</span>
            {c.sinIntegrar && <span className="text-accent"> · sin integrar</span>}
          </span>
        </span>
      </button>
      {abierto && (
        <div className="pb-1">
          {archivos.isLoading && <p className="py-0.5 pl-10 text-[11px] text-ink-faint">…</p>}
          {(archivos.data?.archivos ?? []).map((a) => (
            <FilaDeArchivo
              key={a.ruta}
              ruta={a.ruta}
              estado={a.estado}
              onAbrir={() => onAbrirDiffEntre(a.ruta, archivos.data?.padre ?? `${c.sha}^`, c.sha)}
            />
          ))}
          {archivos.data && archivos.data.archivos.length === 0 && <p className="py-0.5 pl-10 text-[11px] text-ink-faint">Sin cambios de archivos.</p>}
        </div>
      )}
    </div>
  );
}

function RefDeCommit({ nombre }: { nombre: string }) {
  const tag = nombre.startsWith("tag: ");
  const remota = /^(origin|remoto)\//.test(nombre);
  const texto = tag ? nombre.slice(5) : nombre;
  return (
    <span
      className={`inline-flex max-w-[10rem] shrink-0 items-center gap-0.5 truncate rounded px-1 font-mono text-[10px] leading-4 ${
        tag ? "bg-warn/15 text-warn" : remota ? "border border-line text-ink-faint" : "bg-accent/15 text-accent"
      }`}
      title={tag ? `tag ${texto}` : remota ? `${texto} (${nombre.startsWith("remoto/") ? "en el remoto de tu repo" : "en tu repo"})` : `rama ${texto}`}
    >
      {tag ? <Tag className="size-2.5" aria-hidden /> : <GitBranch className="size-2.5" aria-hidden />}
      {texto.replace(/^origin\//, "tu ").replace(/^remoto\//, "gh ")}
    </span>
  );
}

function MenuStash({
  deshabilitado,
  hayPreparados,
  onGuardar,
}: {
  deshabilitado: boolean;
  hayPreparados: boolean;
  onGuardar: (opciones: { mensaje?: string; incluirNuevos?: boolean; soloPreparados?: boolean }) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const pedir = (opciones: { incluirNuevos?: boolean; soloPreparados?: boolean }) => {
    setAbierto(false);
    onGuardar({ ...opciones, ...(mensaje.trim() ? { mensaje: mensaje.trim() } : {}) });
    setMensaje("");
  };
  return (
    <span className="relative">
      <button type="button" title="Stash: guardar los cambios para después" disabled={deshabilitado} onClick={() => setAbierto(!abierto)} className={ICONO}>
        <Archive className="size-3.5" aria-hidden />
      </button>
      {abierto && (
        <div className="absolute top-full right-0 z-20 mt-1 w-60 overflow-hidden rounded-md border border-line bg-surface pb-1 text-[12px] normal-case shadow-xl">
          <input
            autoFocus
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") pedir({ incluirNuevos: true });
              if (e.key === "Escape") setAbierto(false);
            }}
            placeholder="Mensaje del stash (opcional)"
            className="mb-1 h-7 w-full border-b border-line bg-canvas px-2 font-normal tracking-normal text-ink outline-none"
          />
          <button type="button" onClick={() => pedir({ incluirNuevos: true })} className="block w-full px-3 py-1 text-left font-normal tracking-normal text-ink hover:bg-surface-2">
            Guardar todo (con archivos nuevos)
          </button>
          <button type="button" onClick={() => pedir({ incluirNuevos: false })} className="block w-full px-3 py-1 text-left font-normal tracking-normal text-ink hover:bg-surface-2">
            Guardar sólo lo modificado
          </button>
          {hayPreparados && (
            <button type="button" onClick={() => pedir({ soloPreparados: true })} className="block w-full px-3 py-1 text-left font-normal tracking-normal text-ink hover:bg-surface-2">
              Guardar sólo lo preparado
            </button>
          )}
        </div>
      )}
    </span>
  );
}

export function Vista({ titulo, acciones, children }: { titulo: string; acciones?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex h-9 shrink-0 items-center gap-1 px-3 text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
        <span className="min-w-0 flex-1 truncate">{titulo}</span>
        {acciones}
      </div>
      {children}
    </div>
  );
}

function Seccion({
  titulo,
  contador,
  acciones,
  cerrada = false,
  children,
}: {
  titulo: string;
  contador: number;
  acciones?: React.ReactNode;
  cerrada?: boolean;
  children: React.ReactNode;
}) {
  const [abierta, setAbierta] = useState(!cerrada);
  return (
    <div className="border-t border-line">
      <div className="group flex h-6 items-center pr-2">
        <button
          type="button"
          onClick={() => setAbierta(!abierta)}
          className="flex min-w-0 flex-1 items-center gap-1 px-2 text-[11px] font-semibold tracking-wide text-ink-dim uppercase hover:text-ink"
        >
          <span className={`inline-block transition-transform ${abierta ? "rotate-90" : ""}`}>›</span>
          <span className="truncate">{titulo}</span>
          <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-[10px] font-normal">{contador}</span>
        </button>
        {acciones && <span className="hidden items-center gap-0.5 group-hover:flex">{acciones}</span>}
      </div>
      {abierta && <div className="pb-1">{children}</div>}
    </div>
  );
}
