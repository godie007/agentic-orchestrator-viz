import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  AtSign,
  Bot,
  Bug,
  Check,
  FileCode2,
  History,
  Loader2,
  MessageSquarePlus,
  MousePointerClick,
  PackagePlus,
  ShieldAlert,
  Plus,
  Sparkles,
  Square,
  TextSelect,
  Undo2,
  X,
} from "lucide-react";
import { esCorridaTerminal, type Role, type Run, type TraceEvent } from "@orq/shared";
import { api, type CompanyBundle, type RepoConSesion } from "../../api.js";
import { useRunStream } from "../../lib/stream.js";
import { relativeTime, useToast } from "../../ui/index.js";
import { IconoDeArchivo } from "./Explorador.js";
import { lenguajeDe } from "./monaco.js";
import { Markdown } from "./Markdown.js";
import { buscarCandidatos, rotuloDeElemento, type ElementoSeleccionado } from "./elemento.js";
import { archivosDelStack, type FallaDeVista } from "./sonda.js";

/**
 * El chat de IA del IDE, a la manera de Cursor: le pedís a un agente una
 * mejora sobre el código **con el contexto justo** —los archivos que elegís
 * con `@`, la selección del editor (⌘L), lo que escribís— y lo ves trabajar.
 *
 * Por debajo no hay un sistema aparte: cada pedido es una **corrida enfocada**
 * (un solo agente, sobre un repo, pocos ciclos) con todas las garantías de
 * siempre —arriendo de escritura, sandbox, checkpoint por turno, traza—. Lo que
 * el pedido cambió son sus checkpoints, así que "Deshacer" es revertirlos y
 * "Ver cambios" es el diff entre ellos, no todo lo acumulado en la sesión.
 */

export type Adjunto =
  | { tipo: "archivo"; ruta: string }
  | { tipo: "seleccion"; ruta: string; desde: number; hasta: number; texto: string }
  /**
   * Un elemento señalado en la vista previa del frontend corriendo, como el
   * "select element" de Cursor. `ruta` es la carpeta del servicio: es donde
   * se buscan los archivos que lo dibujan.
   */
  | { tipo: "elemento"; ruta: string; servicioId: string; servicioNombre: string; elemento: ElementoSeleccionado }
  /**
   * Una falla que la persona vio en el inspector de la vista previa: un error
   * de consola o un pedido que falló, con su stack o su respuesta. `ruta` es la
   * carpeta del servicio, contra la que se resuelven los archivos del stack.
   */
  | { tipo: "falla"; ruta: string; servicioId: string; servicioNombre: string; falla: FallaDeVista };

const claveDe = (a: Adjunto) =>
  a.tipo === "archivo"
    ? `f:${a.ruta}`
    : a.tipo === "seleccion"
      ? `s:${a.ruta}:${a.desde}-${a.hasta}`
      : a.tipo === "falla"
        ? `x:${a.servicioId}:${a.falla.titulo}`
        : `e:${a.servicioId}:${a.elemento.ruta}:${a.elemento.selector}`;

/** Una conversación nueva: los pedidos anteriores no viajan en ella. */
const nuevaConversacion = () => `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function leerConversacion(repoId: string): string {
  try {
    return localStorage.getItem(`orq-chat-conversacion-${repoId}`) ?? "anteriores";
  } catch {
    return "anteriores";
  }
}
function guardarConversacion(repoId: string, id: string): void {
  try {
    localStorage.setItem(`orq-chat-conversacion-${repoId}`, id);
  } catch {
    // sin almacenamiento: al recargar vuelve a los pedidos anteriores
  }
}

/**
 * La cadena de componentes, con los del repo adelante. La cadena cruda trae
 * los internos de las librerías —`RenderedRoute`, `DataRoutes`, `Location`—,
 * que no se tocan y distraen; lo que importa es qué componente propio lo dibuja.
 */
function componentesDelRepo(e: ElementoSeleccionado, candidatos: Array<{ ruta: string; linea: number; motivo: string }>): string[] {
  const propios = e.componentes.filter((c) => candidatos.some((x) => x.motivo === `define <${c}>`));
  const lineas: string[] = [];
  if (propios.length) {
    lineas.push(
      `- Lo dibuja ${propios
        .map((c) => {
          const def = candidatos.find((x) => x.motivo === `define <${c}>`)!;
          return `<${c}> (\`${def.ruta}:${def.linea}\`)`;
        })
        .join(", dentro de ")}.`,
    );
  } else if (e.componentes.length) {
    lineas.push(`- Componentes de React, del más cercano al más lejano: ${e.componentes.slice(0, 4).map((c) => `<${c}>`).join(" ← ")}.`);
  }
  return lineas;
}

/**
 * Un elemento señalado, contado para el agente: qué es, dónde está en la app,
 * qué componentes lo dibujan y —lo que más ahorra— en qué archivos del repo.
 */
async function describirElemento(
  repoId: string,
  a: Extract<Adjunto, { tipo: "elemento" }>,
  restante: number,
): Promise<string> {
  const e = a.elemento;
  const candidatos = await buscarCandidatos(repoId, a.ruta, e);
  const atributos = Object.entries(e.atributos)
    .filter(([k]) => k !== "class")
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  const partes = [
    `#### Elemento señalado en la vista previa de ${a.servicioNombre} (${a.ruta || "raíz"}/), en la ruta \`${e.ruta}\``,
    `- Es un \`<${e.etiqueta}>\` de ${e.tamano} px${e.texto ? ` con el texto «${e.texto.slice(0, 200)}»` : ""}.`,
    ...componentesDelRepo(e, candidatos),
    ...(atributos ? [`- Atributos: ${atributos}`] : []),
    `- Selector CSS: \`${e.selector}\``,
    "```html",
    e.html.slice(0, Math.min(2_500, Math.max(400, restante / 4))),
    "```",
  ];
  if (candidatos.length) {
    partes.push("Dónde está en el código (búsqueda automática; confirmalo leyendo):");
    for (const c of candidatos) partes.push(`- \`${c.ruta}:${c.linea}\` — ${c.motivo}`);
    // El mejor candidato va con su vecindad: casi siempre es el archivo a
    // tocar. Gana donde aparece el texto **dentro** del archivo de un
    // componente de la cadena —la línea exacta del botón, no la definición
    // del componente doscientas líneas más arriba—.
    const definiciones = new Set(candidatos.filter((c) => c.motivo.startsWith("define")).map((c) => c.ruta));
    const mejor =
      candidatos.find((c) => c.motivo.startsWith("contiene") && definiciones.has(c.ruta)) ??
      candidatos.find((c) => c.motivo.startsWith("contiene")) ??
      candidatos[0]!;
    try {
      const contenido = (await api.archivo(repoId, mejor.ruta)).contenido;
      if (contenido && restante > 4_000) {
        const lineas = contenido.split("\n");
        const desde = Math.max(0, mejor.linea - 25);
        const tramo = lineas.slice(desde, mejor.linea + 25).join("\n");
        partes.push(
          `Líneas ${desde + 1}–${Math.min(lineas.length, mejor.linea + 25)} de \`${mejor.ruta}\` (la ${mejor.linea} es la que coincide):`,
          `\`\`\`${FENCE[lenguajeDe(mejor.ruta)] ?? ""}`,
          tramo,
          "```",
        );
      }
    } catch {
      // sin el tramo: el agente lo lee con leer_codigo
    }
  } else {
    partes.push("No se encontró automáticamente dónde está en el código: buscalo con buscar_codigo por el texto o los componentes.");
  }
  return partes.join("\n");
}

/**
 * Una falla del inspector, contada para el agente: qué se vio, dónde, y —si el
 * stack nombra archivos propios— la vecindad de la línea que tiró. Es lo que
 * una persona le pegaría a un colega: el error entero, no "no anda".
 */
async function describirFalla(repoId: string, a: Extract<Adjunto, { tipo: "falla" }>, restante: number): Promise<string> {
  const f = a.falla;
  const partes = [
    `#### Falla vista en la vista previa de ${a.servicioNombre} (${a.ruta || "raíz"}/), en la página \`${f.pagina || "/"}\``,
    `**${f.titulo}**`,
    "```",
    f.detalle.slice(0, Math.min(6_000, Math.max(800, restante / 3))),
    "```",
  ];
  const propios = archivosDelStack(f.detalle).map((x) => ({ ...x, ruta: a.ruta ? `${a.ruta}/${x.ruta}` : x.ruta }));
  if (propios.length) {
    partes.push("Archivos del repo que nombra el stack:");
    for (const x of propios) partes.push(`- \`${x.ruta}:${x.linea}\``);
    const primero = propios[0]!;
    try {
      const contenido = (await api.archivo(repoId, primero.ruta)).contenido;
      if (contenido && restante > 4_000) {
        const lineas = contenido.split("\n");
        const desde = Math.max(0, primero.linea - 15);
        partes.push(
          `Líneas ${desde + 1}–${Math.min(lineas.length, primero.linea + 15)} de \`${primero.ruta}\` (la ${primero.linea} es la del stack):`,
          `\`\`\`${FENCE[lenguajeDe(primero.ruta)] ?? ""}`,
          lineas.slice(desde, primero.linea + 15).join("\n"),
          "```",
        );
      }
    } catch {
      // el stack puede nombrar un archivo generado: el agente lo busca
    }
  } else if (f.titulo.includes("→")) {
    partes.push(
      "Es un pedido de red: buscá con buscar_codigo dónde lo arma el frontend y qué ruta lo atiende en el backend, y leé la respuesta de arriba antes de suponer la causa.",
    );
  }
  return partes.join("\n");
}

/** Cuánto contenido adjunto viaja en el pedido. Lo que no entra, va por nombre. */
const PRESUPUESTO = 30_000;
const TOPE_POR_ARCHIVO = 12_000;

const FENCE: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "python",
  html: "html",
  css: "css",
  json: "json",
  markdown: "md",
  shell: "bash",
  cpp: "glsl",
};

/**
 * Arma el contexto que viaja con el pedido. El contenido va adentro —el agente
 * no gasta vueltas en leer lo que ya le diste—, pero con presupuesto: lo que
 * se reenvía en cada vuelta de un turno delegado cuesta en todas las vueltas.
 */
export async function armarContexto(repoId: string, nombreRepo: string, adjuntos: Adjunto[]): Promise<string> {
  if (adjuntos.length === 0) return "";
  let restante = PRESUPUESTO;
  const partes: string[] = [`---\nContexto que adjuntó la persona (repo "${nombreRepo}"):`];
  for (const a of adjuntos) {
    if (a.tipo === "elemento" || a.tipo === "falla") {
      const texto = a.tipo === "elemento" ? await describirElemento(repoId, a, restante) : await describirFalla(repoId, a, restante);
      restante -= texto.length;
      partes.push(texto);
      continue;
    }
    const fence = FENCE[lenguajeDe(a.ruta)] ?? "";
    if (a.tipo === "seleccion") {
      const texto = a.texto.slice(0, Math.max(0, restante));
      restante -= texto.length;
      partes.push(`#### \`${a.ruta}\`, líneas ${a.desde}–${a.hasta} (selección)\n\`\`\`${fence}\n${texto}\n\`\`\``);
      continue;
    }
    let contenido: string | null = null;
    try {
      contenido = (await api.archivo(repoId, a.ruta)).contenido;
    } catch {
      contenido = null;
    }
    if (contenido == null || restante < 500) {
      partes.push(`#### \`${a.ruta}\` (no se adjunta el contenido: leelo con leer_codigo)`);
      continue;
    }
    const tope = Math.min(TOPE_POR_ARCHIVO, restante);
    const recortado = contenido.length > tope;
    const cuerpo = recortado ? contenido.slice(0, tope) : contenido;
    restante -= cuerpo.length;
    partes.push(
      `#### \`${a.ruta}\` (${recortado ? `primeros ${tope} caracteres de ${contenido.length}; el resto, con leer_codigo` : "archivo completo"})\n\`\`\`${fence}\n${cuerpo}\n\`\`\``,
    );
  }
  return partes.join("\n\n");
}

export function ChatDeIA({
  company,
  repo,
  archivos,
  archivoActivo,
  adjuntos,
  onAdjuntos,
  onAbrirDiff,
  onAbrirArchivo,
  onCerrar,
}: {
  company: CompanyBundle;
  repo: RepoConSesion;
  /** Los archivos del repo, para el selector de `@`. */
  archivos: string[];
  archivoActivo: string | null;
  adjuntos: Adjunto[];
  onAdjuntos: (adjuntos: Adjunto[]) => void;
  onAbrirDiff: (ruta: string, desde: string, hasta: string) => void;
  onAbrirArchivo: (ruta: string, linea?: number) => void;
  onCerrar: () => void;
}) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const avisar = useToast();
  const [texto, setTexto] = useState("");
  const [mencion, setMencion] = useState<string | null>(null);
  const [indiceMencion, setIndiceMencion] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fondoRef = useRef<HTMLDivElement>(null);

  // Los agentes que pueden editar código: los que tienen `editar_codigo`.
  const editores = useMemo(() => {
    const idsEditar = new Set(company.tools.filter((t) => t.name === "editar_codigo").map((t) => t.id));
    return company.roles.filter((r) => r.toolIds.some((id) => idsEditar.has(id)));
  }, [company]);
  const mejorador = editores.find((r) => r.name === "Mejorador de código");
  const [rolId, setRolId] = useState<string | null>(null);
  const rol = editores.find((r) => r.id === rolId) ?? mejorador ?? editores[0] ?? null;

  const crearMejorador = useMutation({
    mutationFn: () => api.crearMejorador(companyId),
    onSuccess: (nuevo: Role) => {
      setRolId(nuevo.id);
      void queryClient.invalidateQueries({ queryKey: ["company", companyId] });
      avisar("Listo: el Mejorador de código ya está en la empresa.", "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  const [conversacion, setConversacionEstado] = useState(() => leerConversacion(repo.repo.id));
  useEffect(() => setConversacionEstado(leerConversacion(repo.repo.id)), [repo.repo.id]);
  const setConversacion = (id: string) => {
    setConversacionEstado(id);
    guardarConversacion(repo.repo.id, id);
  };
  const [historialAbierto, setHistorialAbierto] = useState(false);
  const conversaciones = useQuery({
    queryKey: ["conversaciones", repo.repo.id],
    queryFn: () => api.conversaciones(repo.repo.id),
    refetchInterval: 15_000,
  });
  const pedidos = useQuery({
    queryKey: ["pedidos", repo.repo.id, conversacion],
    queryFn: () => api.pedidosDeRepo(repo.repo.id, conversacion),
    refetchInterval: 4_000,
  });
  const lista = useMemo(() => [...(pedidos.data ?? [])].reverse(), [pedidos.data]);

  useEffect(() => {
    fondoRef.current?.scrollIntoView({ block: "end" });
  }, [lista.length]);

  const enviar = useMutation({
    mutationFn: async () => {
      if (!rol) throw new Error("Elegí un agente.");
      const contexto = await armarContexto(repo.repo.id, repo.repo.nombre, adjuntos);
      // Los pedidos de antes no tienen conversación: escribir ahí abre una.
      const conversacionId = conversacion === "anteriores" ? nuevaConversacion() : conversacion;
      if (conversacionId !== conversacion) setConversacion(conversacionId);
      return api.createRun({
        companyId,
        objective: texto.trim().slice(0, 8000),
        mode: "continuous",
        foco: { rolId: rol.id, repoId: repo.repo.id, contexto, conversacionId },
      });
    },
    onSuccess: (run) => {
      guardarAdjuntosDe(run.id, adjuntos);
      setTexto("");
      onAdjuntos([]);
      void queryClient.invalidateQueries({ queryKey: ["pedidos", repo.repo.id] });
      void queryClient.invalidateQueries({ queryKey: ["conversaciones", repo.repo.id] });
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  // `@` abre el selector de archivos, como en Cursor.
  const candidatos = useMemo(() => {
    if (mencion === null) return [];
    const f = mencion.toLowerCase();
    return archivos
      .filter((a) => a.toLowerCase().includes(f))
      .sort((a, b) => (a.split("/").at(-1)!.toLowerCase().startsWith(f) ? -1 : 0) - (b.split("/").at(-1)!.toLowerCase().startsWith(f) ? -1 : 0))
      .slice(0, 8);
  }, [archivos, mencion]);

  const agregar = (a: Adjunto) => {
    if (adjuntos.some((x) => claveDe(x) === claveDe(a))) return;
    onAdjuntos([...adjuntos, a]);
  };

  const elegirMencion = (ruta: string) => {
    const area = areaRef.current;
    const cursor = area?.selectionStart ?? texto.length;
    const antes = texto.slice(0, cursor).replace(/@[\w./-]*$/, "");
    setTexto(antes + texto.slice(cursor));
    setMencion(null);
    agregar({ tipo: "archivo", ruta });
    requestAnimationFrame(() => area?.focus());
  };

  const puedeEnviar = texto.trim().length > 0 && rol != null && !enviar.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <Sparkles className="size-3.5 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-ink-dim uppercase">
          Chat de IA
          {conversacion !== "anteriores" && lista.length > 0 && (
            <span className="ml-1.5 font-normal tracking-normal text-ink-faint normal-case">
              · {conversaciones.data?.find((c) => c.id === conversacion)?.titulo ?? ""}
            </span>
          )}
        </span>
        <span className="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-ink-faint" title="Repo sobre el que trabaja el agente">
          {repo.repo.nombre}
        </span>
        <button
          type="button"
          title="Nueva conversación: el agente arranca sin lo hablado antes"
          disabled={lista.length === 0 && conversacion !== "anteriores"}
          onClick={() => {
            setConversacion(nuevaConversacion());
            setTexto("");
            onAdjuntos([]);
            setHistorialAbierto(false);
            requestAnimationFrame(() => areaRef.current?.focus());
          }}
          className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-40"
        >
          <MessageSquarePlus className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          title="Conversaciones anteriores"
          onClick={() => setHistorialAbierto((a) => !a)}
          className={`rounded p-1 hover:bg-surface-2 ${historialAbierto ? "text-accent" : "text-ink-faint hover:text-ink"}`}
        >
          <History className="size-3.5" aria-hidden />
        </button>
        <button type="button" title="Cerrar (⌘L sin selección en el editor lo vuelve a abrir)" onClick={onCerrar} className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink">
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {historialAbierto && (
        <div className="max-h-[45%] shrink-0 overflow-auto border-b border-line bg-canvas py-1">
          {(conversaciones.data ?? []).length === 0 && <p className="px-3 py-2 text-[12px] text-ink-faint">Todavía no hay conversaciones.</p>}
          {(conversaciones.data ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setConversacion(c.id);
                setHistorialAbierto(false);
              }}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-2 ${c.id === conversacion ? "bg-accent/10" : ""}`}
            >
              <span className={`min-w-0 flex-1 truncate text-[12px] ${c.id === "anteriores" ? "text-ink-faint italic" : "text-ink"}`}>{c.titulo}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">
                {c.pedidos} · {relativeTime(c.ultima)}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        {lista.length === 0 && (
          <div className="space-y-2 pt-6 text-center text-[12px] leading-relaxed text-ink-faint">
            <Bot className="mx-auto size-6 text-ink-faint" aria-hidden />
            <p>{conversacion === "anteriores" ? "Pedile a un agente que mejore el código." : "Conversación nueva."}</p>
            <p>
              Adjuntá archivos con <kbd className="rounded bg-surface-2 px-1">@</kbd>, seleccioná código en el editor y apretá{" "}
              <kbd className="rounded bg-surface-2 px-1">⌘L</kbd>, o señalá un elemento en la vista previa del frontend (
              <MousePointerClick className="inline size-3" aria-hidden />
              ). Cada pedido queda como un checkpoint que podés deshacer, y los de una misma conversación se recuerdan entre sí.
            </p>
          </div>
        )}
        {lista.map((run) => (
          <Pedido
            key={run.id}
            run={run}
            rol={company.roles.find((r) => r.id === run.foco?.rolId) ?? null}
            sesionId={repo.sesion?.id ?? null}
            companyId={companyId}
            archivos={archivos}
            onAbrirDiff={onAbrirDiff}
            onAbrirArchivo={onAbrirArchivo}
          />
        ))}
        <div ref={fondoRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-line p-2">
        <div className="rounded-lg border border-line bg-canvas focus-within:border-accent">
          <div className="flex flex-wrap items-center gap-1 px-2 pt-2">
            {adjuntos.map((a) => (
              <span key={claveDe(a)} className="flex max-w-full items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-dim">
                {a.tipo === "archivo" ? (
                  <IconoDeArchivo nombre={a.ruta} className="size-3" />
                ) : a.tipo === "elemento" ? (
                  <MousePointerClick className="size-3 text-accent" aria-hidden />
                ) : a.tipo === "falla" ? (
                  <Bug className="size-3 text-danger" aria-hidden />
                ) : (
                  <TextSelect className="size-3 text-accent" aria-hidden />
                )}
                <span
                  className="truncate"
                  title={
                    a.tipo === "elemento"
                      ? `${a.servicioNombre} ${a.elemento.ruta} · ${a.elemento.selector}`
                      : a.tipo === "falla"
                        ? `${a.servicioNombre} ${a.falla.pagina}\n${a.falla.detalle.slice(0, 600)}`
                        : a.ruta
                  }
                >
                  {a.tipo === "elemento" ? rotuloDeElemento(a.elemento) : a.tipo === "falla" ? a.falla.titulo.slice(0, 60) : a.ruta.split("/").at(-1)}
                  {a.tipo === "seleccion" && <span className="text-ink-faint"> :{a.desde}-{a.hasta}</span>}
                  {a.tipo === "elemento" && <span className="text-ink-faint"> {a.elemento.ruta}</span>}
                </span>
                <button type="button" title="Quitar" onClick={() => onAdjuntos(adjuntos.filter((x) => claveDe(x) !== claveDe(a)))} className="text-ink-faint hover:text-ink">
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            <button
              type="button"
              title="Adjuntar un archivo (o escribí @)"
              onClick={() => {
                setTexto((t) => `${t}@`);
                setMencion("");
                areaRef.current?.focus();
              }}
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <AtSign className="size-3" aria-hidden /> archivo
            </button>
            {archivoActivo && !adjuntos.some((a) => a.tipo === "archivo" && a.ruta === archivoActivo) && (
              <button
                type="button"
                title={`Adjuntar ${archivoActivo}`}
                onClick={() => agregar({ tipo: "archivo", ruta: archivoActivo })}
                className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-ink-faint hover:bg-surface-2 hover:text-ink"
              >
                <Plus className="size-3" aria-hidden /> {archivoActivo.split("/").at(-1)}
              </button>
            )}
          </div>
          <div className="relative">
            {mencion !== null && candidatos.length > 0 && (
              <div className="absolute right-2 bottom-full left-2 z-10 mb-1 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
                {candidatos.map((ruta, i) => (
                  <button
                    key={ruta}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      elegirMencion(ruta);
                    }}
                    className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] ${i === indiceMencion ? "bg-accent/20 text-ink" : "text-ink-dim hover:bg-surface-2"}`}
                  >
                    <IconoDeArchivo nombre={ruta} className="size-3.5" />
                    <span className="truncate">{ruta.split("/").at(-1)}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">{ruta}</span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={areaRef}
              value={texto}
              rows={3}
              onChange={(e) => {
                setTexto(e.target.value);
                const antes = e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length);
                const m = /@([\w./-]*)$/.exec(antes);
                setMencion(m ? (m[1] ?? "") : null);
                setIndiceMencion(0);
              }}
              onKeyDown={(e) => {
                if (mencion !== null && candidatos.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setIndiceMencion((i) => Math.min(candidatos.length - 1, i + 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setIndiceMencion((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    elegirMencion(candidatos[indiceMencion] ?? candidatos[0]!);
                    return;
                  }
                  if (e.key === "Escape") {
                    setMencion(null);
                    return;
                  }
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey) && puedeEnviar) {
                  e.preventDefault();
                  enviar.mutate();
                }
              }}
              placeholder="Pedí una mejora… (@ para adjuntar, Enter para enviar, ⇧Enter nueva línea)"
              className="block w-full resize-none bg-transparent px-2 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          <div className="flex items-center gap-1.5 px-2 pb-2">
            {editores.length > 0 ? (
              <select
                value={rol?.id ?? ""}
                onChange={(e) => setRolId(e.target.value)}
                title="Qué agente hace el pedido"
                className="h-6 max-w-[55%] rounded border border-line bg-surface px-1 text-[11px] text-ink-dim"
              >
                {editores.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.model.modelSlug?.replace(/^claude-code\//, "") ?? r.model.tier}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] text-ink-faint">Ningún agente edita código todavía.</span>
            )}
            {!mejorador && (
              <button
                type="button"
                onClick={() => crearMejorador.mutate()}
                disabled={crearMejorador.isPending}
                title="Crea un agente dedicado a mejorar código, con todas las herramientas de código"
                className="flex items-center gap-1 rounded border border-dashed border-accent/50 px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10"
              >
                <Sparkles className="size-3" aria-hidden /> Mejorador de código
              </button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              disabled={!puedeEnviar}
              onClick={() => enviar.mutate()}
              title="Enviar (Enter)"
              className="flex size-7 items-center justify-center rounded-full bg-accent text-white transition-opacity disabled:opacity-30"
            >
              {enviar.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Un pedido y su respuesta -------------------------------------------------

/** Lo adjuntado viaja en el mensaje al agente; acá se recuerda sólo para mostrarlo. */
function guardarAdjuntosDe(runId: string, adjuntos: Adjunto[]): void {
  try {
    localStorage.setItem(
      `orq-chat-adjuntos-${runId}`,
      JSON.stringify(
        adjuntos.map((a) =>
          a.tipo === "elemento"
            ? { ...a, elemento: { ...a.elemento, html: "" } }
            : a.tipo === "falla"
              ? { ...a, falla: { ...a.falla, detalle: a.falla.detalle.slice(0, 600) } }
              : { ...a, texto: undefined },
        ),
      ),
    );
  } catch {
    // sin almacenamiento: el pedido se muestra sin sus adjuntos
  }
}
function leerAdjuntosDe(runId: string): Adjunto[] {
  try {
    return JSON.parse(localStorage.getItem(`orq-chat-adjuntos-${runId}`) ?? "[]") as Adjunto[];
  } catch {
    return [];
  }
}
function leerDecision(runId: string): "mantenido" | "deshecho" | null {
  try {
    const v = localStorage.getItem(`orq-chat-decision-${runId}`);
    return v === "mantenido" || v === "deshecho" ? v : null;
  } catch {
    return null;
  }
}
function guardarDecision(runId: string, decision: "mantenido" | "deshecho"): void {
  try {
    localStorage.setItem(`orq-chat-decision-${runId}`, decision);
  } catch {
    // no pasa nada: se vuelve a ofrecer
  }
}

const VERBOS: Record<string, string> = {
  leer_codigo: "Leyó",
  "cli:Read": "Leyó",
  editar_codigo: "Editó",
  "cli:Edit": "Editó",
  "cli:MultiEdit": "Editó",
  escribir_codigo: "Escribió",
  "cli:Write": "Escribió",
  aplicar_parche: "Aplicó un parche",
  buscar_codigo: "Buscó",
  "cli:Grep": "Buscó",
  buscar_archivos: "Buscó archivos",
  "cli:Glob": "Buscó archivos",
  mapa_del_codigo: "Miró el mapa del código",
  listar_repositorios: "Revisó el repo",
  estado_git: "Revisó los cambios",
  ejecutar_comando: "Corrió",
  revertir_codigo: "Revirtió",
  solicitar_comando: "Pidió permiso para",
};

interface Paso {
  id: string;
  verbo: string;
  detalle: string;
  ok: boolean | null;
}

function pasosDe(eventos: TraceEvent[]): Paso[] {
  const args = new Map<string, Record<string, unknown>>();
  const pasos: Paso[] = [];
  for (const e of eventos) {
    if (e.type === "tool.start") args.set(e.callId, e.args);
    if (e.type !== "tool.end" || !VERBOS[e.toolName]) continue;
    const a = args.get(e.callId) ?? {};
    const detalle =
      (typeof a["ruta"] === "string" && a["ruta"]) ||
      (typeof a["comando"] === "string" && a["comando"]) ||
      (typeof a["patron"] === "string" && a["patron"]) ||
      (e.toolName === "ejecutar_comando" ? e.preview.split("\n")[0] ?? "" : "") ||
      "";
    const corto = String(detalle).replace(/^.*\/worktrees\/[^/]+\/[^/]+\//, "");
    const salida = e.toolName === "ejecutar_comando" ? /exit (\S+)/.exec(e.preview)?.[1] : null;
    pasos.push({
      id: e.id,
      verbo: VERBOS[e.toolName]!,
      detalle: salida ? `${corto} → exit ${salida}` : corto,
      ok: e.ok && (salida == null || salida === "0"),
    });
  }
  return pasos;
}

function Pedido({
  run,
  rol,
  sesionId,
  companyId,
  archivos: archivosDelRepo,
  onAbrirDiff,
  onAbrirArchivo,
}: {
  run: Run;
  rol: Role | null;
  sesionId: string | null;
  companyId: string;
  archivos: readonly string[];
  onAbrirDiff: (ruta: string, desde: string, hasta: string) => void;
  onAbrirArchivo: (ruta: string, linea?: number) => void;
}) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const terminal = esCorridaTerminal(run.status);
  // En vivo por SSE mientras corre; terminado, una sola lectura de la traza.
  const vivo = useRunStream(terminal ? null : run.id);
  const historia = useQuery({ queryKey: ["eventos", run.id], queryFn: () => api.runEvents(run.id), enabled: terminal });
  const eventos = terminal ? (historia.data ?? []) : vivo.events;

  const pasos = useMemo(() => pasosDe(eventos), [eventos]);
  const resumen = useMemo(() => {
    const cierres = eventos.filter((e): e is Extract<TraceEvent, { type: "agent.turn_end" }> => e.type === "agent.turn_end" && Boolean(e.summary));
    return cierres.at(-1)?.summary ?? null;
  }, [eventos]);
  const checkpoints = useMemo(
    () => eventos.filter((e): e is Extract<TraceEvent, { type: "codigo.checkpoint" }> => e.type === "codigo.checkpoint"),
    [eventos],
  );
  const shas = useMemo(() => checkpoints.map((e) => e.sha), [checkpoints]);
  /**
   * Sin commits automáticos, lo que cambió el pedido es la diferencia entre la
   * instantánea del principio de su primer turno y la del final del último: no
   * hay commits que listar ni revertir.
   */
  const tramo = useMemo(() => {
    if (!checkpoints.length || checkpoints.some((e) => e.commit !== false)) return null;
    const desde = checkpoints[0]!.antes;
    const hasta = checkpoints.at(-1)!.sha;
    return desde ? { desde, hasta } : null;
  }, [checkpoints]);
  const archivos = useQuery({
    queryKey: ["archivos-pedido", run.id, shas.join(","), tramo?.desde ?? ""],
    enabled: sesionId != null && shas.length > 0,
    queryFn: async () => {
      if (tramo) return (await api.cambiosEntre(sesionId!, tramo.desde, tramo.hasta)).archivos;
      const todos = new Map<string, string>();
      for (const sha of shas) {
        for (const a of (await api.archivosDeCommit(sesionId!, sha)).archivos) todos.set(a.ruta, a.estado);
      }
      return [...todos].map(([ruta, estado]) => ({ ruta, estado }));
    },
  });
  const [decision, setDecision] = useState(() => leerDecision(run.id));
  const [verTodos, setVerTodos] = useState(false);
  const adjuntos = useMemo(() => leerAdjuntosDe(run.id), [run.id]);

  const deshacer = useMutation({
    mutationFn: () => (tramo ? api.deshacerEntre(sesionId!, tramo.desde, tramo.hasta) : api.revertirCheckpoints(sesionId!, shas)),
    onSuccess: () => {
      guardarDecision(run.id, "deshecho");
      setDecision("deshecho");
      void queryClient.invalidateQueries({ queryKey: ["arbol"] });
      void queryClient.invalidateQueries({ queryKey: ["archivo"] });
      avisar("Se deshicieron los cambios del pedido.", "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });
  const detener = useMutation({ mutationFn: () => api.stop(run.id) });

  const visibles = verTodos ? pasos : pasos.slice(-8);

  return (
    <div className="space-y-2">
      {/* Lo que pidió la persona */}
      <div className="ml-6 rounded-lg bg-accent/10 px-3 py-2 text-[13px] text-ink">
        <Markdown texto={run.objective} archivos={archivosDelRepo} onAbrirArchivo={onAbrirArchivo} />
        {adjuntos.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {adjuntos.map((a, i) => (
              a.tipo === "falla" ? (
                <span key={i} className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] text-ink-dim" title={a.falla.detalle.slice(0, 600)}>
                  <Bug className="size-2.5 text-danger" aria-hidden />
                  {a.falla.titulo.slice(0, 60)}
                </span>
              ) : a.tipo === "elemento" ? (
                <span key={i} className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] text-ink-dim" title={a.elemento.selector}>
                  <MousePointerClick className="size-2.5 text-accent" aria-hidden />
                  {rotuloDeElemento(a.elemento)} <span className="text-ink-faint">{a.elemento.ruta}</span>
                </span>
              ) : (
                <button
                  key={i}
                  type="button"
                  onClick={() => onAbrirArchivo(a.ruta)}
                  className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                >
                  <FileCode2 className="size-2.5" aria-hidden />
                  {a.ruta.split("/").at(-1)}
                  {a.tipo === "seleccion" && `:${a.desde}-${a.hasta}`}
                </button>
              )
            ))}
          </div>
        )}
        <p className="mt-1 text-right text-[10px] text-ink-faint">{relativeTime(run.startedAt)}</p>
      </div>

      {/* Lo que hizo el agente */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
          <Bot className="size-3.5 text-accent" aria-hidden />
          {rol?.name ?? "Agente"}
          {!terminal && (
            <>
              {run.status === "awaiting_approval" ? (
                <span className="text-[11px] font-normal text-warn">esperando tu respuesta ↓</span>
              ) : (
                <>
                  <Loader2 className="size-3 animate-spin text-ink-faint" aria-hidden />
                  <span className="text-[11px] font-normal text-ink-faint">trabajando…</span>
                </>
              )}
              <span className="flex-1" />
              <button
                type="button"
                title="Detener el pedido"
                onClick={() => detener.mutate()}
                className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] font-normal text-ink-dim hover:border-danger/50 hover:text-danger"
              >
                <Square className="size-2.5" aria-hidden /> Detener
              </button>
            </>
          )}
        </div>
        {pasos.length > 8 && !verTodos && (
          <button type="button" onClick={() => setVerTodos(true)} className="pl-5 text-[11px] text-ink-faint hover:text-ink">
            … {pasos.length - 8} pasos antes
          </button>
        )}
        {visibles.map((p) => (
          <div key={p.id} className="flex items-baseline gap-1.5 pl-5 text-[12px]">
            <span className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${p.ok === false ? "bg-danger" : "bg-ok/70"}`} aria-hidden />
            <span className="text-ink-dim">{p.verbo}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint" title={p.detalle}>
              {p.detalle}
            </span>
          </div>
        ))}
        {resumen && (
          <div className="rounded-lg border border-line bg-canvas px-3 py-2">
            <Markdown texto={resumen} archivos={archivosDelRepo} onAbrirArchivo={onAbrirArchivo} />
          </div>
        )}
        {terminal && run.status !== "completed" && run.stopReason && (
          <p className="pl-5 text-[11px] text-warn">{run.stopReason}</p>
        )}

        {/* Los cambios del pedido */}
        {terminal && (archivos.data?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-line">
            <div className="flex items-center border-b border-line px-2 py-1 text-[11px] text-ink-dim">
              <span className="flex-1">
                {archivos.data!.length} archivo(s) cambiado(s)
                {tramo && decision !== "deshecho" && (
                  <span className="text-ink-faint" title="Quedaron en tu rama sin commitear: preparalos, escribí o generá el mensaje y hacé commit desde Control de código fuente">
                    {" "}· sin commitear
                  </span>
                )}
              </span>
              {decision === "deshecho" && <span className="text-warn">deshecho</span>}
              {decision === "mantenido" && <span className="text-ok">mantenido</span>}
            </div>
            {archivos.data!.map((a) => (
              <button
                key={a.ruta}
                type="button"
                onClick={() => (tramo ? onAbrirDiff(a.ruta, tramo.desde, tramo.hasta) : onAbrirDiff(a.ruta, `${shas[0]}^`, shas.at(-1)!))}
                title="Ver lo que cambió este pedido"
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-ink-dim hover:bg-surface-2"
              >
                <IconoDeArchivo nombre={a.ruta} className="size-3.5" />
                <span className="truncate text-ink">{a.ruta.split("/").at(-1)}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">{a.ruta}</span>
                <span className={`text-[10px] font-semibold ${a.estado === "A" ? "text-ok" : a.estado === "D" ? "text-danger" : "text-warn"}`}>
                  {a.estado}
                </span>
              </button>
            ))}
            {decision === null && (
              <div className="flex gap-1.5 border-t border-line p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    guardarDecision(run.id, "mantenido");
                    setDecision("mantenido");
                  }}
                  className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-ok/15 text-[11px] font-medium text-ok hover:bg-ok/25"
                >
                  <Check className="size-3" aria-hidden /> Mantener
                </button>
                <button
                  type="button"
                  disabled={deshacer.isPending || sesionId == null}
                  onClick={() => deshacer.mutate()}
                  title="Revierte los checkpoints de este pedido: quedan commits que los deshacen"
                  className="flex h-6 flex-1 items-center justify-center gap-1 rounded border border-line text-[11px] text-ink-dim hover:border-danger/50 hover:text-danger disabled:opacity-40"
                >
                  <Undo2 className="size-3" aria-hidden /> Deshacer
                </button>
              </div>
            )}
          </div>
        )}
        {terminal && shas.length === 0 && !resumen && (
          <p className="pl-5 text-[11px] text-ink-faint">Terminó sin cambios en el código.</p>
        )}
        {/* Lo que el agente necesita de vos para seguir, al final: es lo último que pasó. */}
        {!terminal && <SolicitudesDelPedido companyId={companyId} runId={run.id} />}
        {!terminal && <AprobacionesDelPedido runId={run.id} archivos={archivosDelRepo} />}
      </div>
    </div>
  );
}

// --- Lo que espera tu respuesta ----------------------------------------------

/**
 * Las solicitudes del pedido, **en el chat**. Antes vivían sólo en la pestaña
 * Solicitudes y el pedido se quedaba esperando sin que nadie lo notara: medido,
 * un simulador 3D con los botones muertos porque la instalación de Three.js
 * esperaba una aprobación que estaba en otra pantalla. Instalar una dependencia
 * o correr un comando una vez se aprueba acá mismo, como en Cursor; lo que
 * necesita más contexto (un rol nuevo, un servidor MCP) lleva a Solicitudes.
 */
/**
 * Una herramienta que escribe —en INSPIA, aplicar una migración o ejecutar SQL
 * en Supabase— espera a que la apruebes, y aprobar **la ejecuta** con los
 * argumentos que ves acá: el agente no puede cambiar el SQL después. Por eso
 * se muestra entero, resaltado, antes del botón.
 */
function AprobacionesDelPedido({ runId, archivos }: { runId: string; archivos: readonly string[] }) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const corrida = useQuery({ queryKey: ["run", runId, "aprobaciones"], queryFn: () => api.run(runId), refetchInterval: 3_000 });
  const pendientes = (corrida.data?.approvals ?? []).filter((a) => a.status === "pending");
  const [motivo, setMotivo] = useState("");

  const resolver = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "grant" | "deny" }) => api.resolveApproval(runId, id, decision, motivo.trim()),
    onSuccess: (_r, { decision }) => {
      setMotivo("");
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["arbol"] });
      avisar(decision === "grant" ? "Aprobado y ejecutado. El agente sigue con el resultado." : "Rechazado. El agente busca otra forma.", "ok");
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  if (pendientes.length === 0) return null;
  return (
    <div className="space-y-2">
      {pendientes.map((a) => {
        const [, servidor, herramienta] = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(a.toolName ?? "") ?? [];
        const args = a.toolArgs ?? {};
        const sql = typeof args["query"] === "string" ? (args["query"] as string) : null;
        const resto = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "query"));
        return (
          <div key={a.id} className="rounded-lg border border-warn/50 bg-warn/10 p-2.5 text-[12px]">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
              <ShieldAlert className="size-3.5" aria-hidden />
              Pide ejecutar {servidor ? `${servidor.charAt(0).toUpperCase()}${servidor.slice(1)} · ${herramienta}` : a.toolName}
            </div>
            <p className="mb-1.5 text-ink-dim">{a.reason}</p>
            {Object.keys(resto).length > 0 && (
              <pre className="mb-1.5 max-h-32 overflow-auto rounded bg-canvas p-1.5 font-mono text-[11px] whitespace-pre-wrap text-ink">
                {JSON.stringify(resto, null, 2)}
              </pre>
            )}
            {sql && (
              <div className="mb-2 max-h-72 overflow-auto rounded">
                <Markdown texto={`\`\`\`sql\n${sql}\n\`\`\``} archivos={archivos} />
              </div>
            )}
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Comentario para el agente (opcional)"
              className="mb-1.5 h-6 w-full rounded border border-line bg-canvas px-1.5 text-[11px] text-ink outline-none focus:border-accent"
            />
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={resolver.isPending}
                onClick={() => resolver.mutate({ id: a.id, decision: "grant" })}
                className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-accent text-[11px] font-medium text-white disabled:opacity-50"
              >
                {resolver.isPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Check className="size-3" aria-hidden />}
                Aprobar y ejecutar
              </button>
              <button
                type="button"
                disabled={resolver.isPending}
                onClick={() => resolver.mutate({ id: a.id, decision: "deny" })}
                className="flex h-6 flex-1 items-center justify-center gap-1 rounded border border-line text-[11px] text-ink-dim hover:border-danger/50 hover:text-danger disabled:opacity-50"
              >
                <X className="size-3" aria-hidden /> Rechazar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SolicitudesDelPedido({ companyId, runId }: { companyId: string; runId: string }) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const solicitudes = useQuery({
    queryKey: ["solicitudes", companyId],
    queryFn: () => api.requests(companyId),
    refetchInterval: 3_000,
  });
  const pendientes = (solicitudes.data ?? []).filter((r) => r.runId === runId && r.status === "pending");

  const resolver = useMutation({
    mutationFn: ({ id, decision, tipo }: { id: string; decision: "approve" | "reject"; tipo: string }) =>
      api.resolveRequest(companyId, id, decision, "", null, tipo === "comando" ? { alcance: "una-vez" } : null),
    onSuccess: (_r, { decision, tipo }) => {
      void queryClient.invalidateQueries({ queryKey: ["solicitudes", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["arbol"] });
      avisar(
        decision === "approve"
          ? tipo === "dependencia"
            ? "Instalado. El agente sigue con eso."
            : "Aprobado. El agente sigue."
          : "Rechazado. El agente busca otra forma.",
        "ok",
      );
    },
    // Si la instalación falla, la solicitud queda pendiente y el motivo se ve.
    onError: (e: Error) => avisar(e.message, "error"),
  });

  if (pendientes.length === 0) return null;
  return (
    <div className="space-y-2">
      {pendientes.map((r) => (
        <div key={r.id} className="rounded-lg border border-warn/50 bg-warn/10 p-2.5 text-[12px]">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-warn">
            <PackagePlus className="size-3.5" aria-hidden />
            {r.type === "dependencia"
              ? "Pide instalar una dependencia"
              : r.type === "comando"
                ? "Pide correr un comando"
                : "Espera tu respuesta"}
          </div>
          <p className="mb-1.5 text-ink-dim">{r.reason}</p>
          {r.type === "dependencia" && r.dependencia && (
            <ul className="mb-2 space-y-0.5 font-mono text-[11px]">
              {r.dependencia.paquetes.map((p) => (
                <li key={p}>
                  <a
                    href={`https://www.npmjs.com/package/${p.replace(/(?!^)@[^@/]*$/, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink hover:text-accent hover:underline"
                    title="Ver el paquete en npmjs.com antes de aprobar"
                  >
                    {p}
                  </a>
                  <span className="ml-1.5 font-sans text-[10px] text-ink-faint">
                    {r.dependencia!.gestor}, sin scripts de instalación
                  </span>
                </li>
              ))}
            </ul>
          )}
          {r.type === "comando" && r.comando && (
            <p className="mb-2 font-mono text-[11px] text-ink">{r.comando.argv.join(" ")}</p>
          )}
          {r.type === "dependencia" || r.type === "comando" ? (
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={resolver.isPending}
                onClick={() => resolver.mutate({ id: r.id, decision: "approve", tipo: r.type })}
                className="flex h-6 flex-1 items-center justify-center gap-1 rounded bg-accent text-[11px] font-medium text-white disabled:opacity-50"
              >
                {resolver.isPending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-3" aria-hidden />
                )}
                {r.type === "dependencia" ? (resolver.isPending ? "Instalando…" : "Instalar") : "Correr una vez"}
              </button>
              <button
                type="button"
                disabled={resolver.isPending}
                onClick={() => resolver.mutate({ id: r.id, decision: "reject", tipo: r.type })}
                className="flex h-6 flex-1 items-center justify-center rounded border border-line text-[11px] text-ink-dim hover:border-danger/50 hover:text-danger disabled:opacity-50"
              >
                Rechazar
              </button>
            </div>
          ) : (
            <a href={`/p/${companyId}/solicitudes`} className="text-[11px] text-accent hover:underline">
              Responder en Solicitudes →
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
