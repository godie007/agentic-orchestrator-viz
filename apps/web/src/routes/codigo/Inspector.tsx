import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleX, Info, MessageSquarePlus, Trash2, X } from "lucide-react";
import { esError, falloLaRed, fallaDe, rutaDeUrl, type FallaDeVista, type Registro, type RegistroDeConsola, type RegistroDeRed } from "./sonda.js";

/**
 * El inspector de la vista previa: la consola y la red de la app corriendo,
 * como las pestañas de DevTools, pero con lo único que DevTools no tiene —
 * mandar la falla al chat para que un agente la arregle con el stack, el
 * pedido y la respuesta del backend adentro—.
 *
 * Los datos los junta la sonda que inyecta el proxy (`proxy-vista.ts`) desde
 * antes de que arranque la app, así que un error de carga también se ve.
 */

type Pestana = "consola" | "red";

export function Inspector({
  registros,
  sondaActiva,
  onLimpiar,
  onCerrar,
  onFalla,
}: {
  registros: Registro[];
  sondaActiva: boolean;
  onLimpiar: () => void;
  onCerrar: () => void;
  onFalla?: (falla: FallaDeVista) => void;
}) {
  const [pestana, setPestana] = useState<Pestana>("consola");
  const [soloErrores, setSoloErrores] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const lista = useRef<HTMLDivElement>(null);
  const pegadoAlFinal = useRef(true);

  const consola = registros.filter((r): r is RegistroDeConsola => r.clase === "consola");
  const red = registros.filter((r): r is RegistroDeRed => r.clase === "red");
  const erroresConsola = consola.filter(esError).length;
  const erroresRed = red.filter(esError).length;
  const busca = filtro.trim().toLowerCase();
  const visibles = (pestana === "consola" ? consola : red).filter(
    (r) =>
      (!soloErrores || esError(r)) &&
      (!busca || (r.clase === "consola" ? r.texto : `${r.metodo} ${r.url} ${r.estado ?? ""}`).toLowerCase().includes(busca)),
  );

  // Como la consola de DevTools: sigue lo último mientras no subas a leer.
  useEffect(() => {
    const el = lista.current;
    if (el && pegadoAlFinal.current) el.scrollTop = el.scrollHeight;
  }, [visibles.length, pestana]);

  const alternar = (clave: string) =>
    setAbiertos((previos) => {
      const siguiente = new Set(previos);
      if (siguiente.has(clave)) siguiente.delete(clave);
      else siguiente.add(clave);
      return siguiente;
    });

  const tab = (p: Pestana, rotulo: string, total: number, conError: number) => (
    <button
      type="button"
      onClick={() => setPestana(p)}
      className={`flex items-center gap-1 border-b-2 px-2 py-1 text-[12px] ${
        pestana === p ? "border-accent text-ink" : "border-transparent text-ink-dim hover:text-ink"
      }`}
    >
      {rotulo}
      <span className="text-[10px] text-ink-faint">{total}</span>
      {conError > 0 && <span className="rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{conError}</span>}
    </button>
  );

  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-line bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        {tab("consola", "Consola", consola.length, erroresConsola)}
        {tab("red", "Red", red.length, erroresRed)}
        <input
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder="Filtrar"
          aria-label="Filtrar registros"
          className="ml-2 h-6 w-40 min-w-0 rounded border border-line bg-canvas px-2 text-[12px] text-ink outline-none focus:border-accent"
        />
        <label className="ml-1 flex items-center gap-1 text-[12px] text-ink-dim">
          <input type="checkbox" checked={soloErrores} onChange={(e) => setSoloErrores(e.target.checked)} />
          Sólo errores
        </label>
        <span className="flex-1" />
        <button type="button" title="Limpiar" onClick={onLimpiar} className="rounded p-1 text-ink-dim hover:bg-surface-2 hover:text-ink">
          <Trash2 className="size-3.5" aria-hidden />
        </button>
        <button type="button" title="Cerrar el inspector" onClick={onCerrar} className="rounded p-1 text-ink-dim hover:bg-surface-2 hover:text-ink">
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div
        ref={lista}
        onScroll={(e) => {
          const el = e.currentTarget;
          pegadoAlFinal.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto font-mono text-[11.5px]"
      >
        {!sondaActiva ? (
          <p className="p-3 font-sans text-[12px] text-ink-faint">
            La sonda del inspector todavía no respondió. Se inyecta en las páginas HTML que sirve la vista previa: recargá la vista si
            no aparece nada.
          </p>
        ) : visibles.length === 0 ? (
          <p className="p-3 font-sans text-[12px] text-ink-faint">
            {registros.length === 0 ? "Sin registros todavía. Usá la app: lo que loguee y lo que pida aparece acá." : "Nada coincide con el filtro."}
          </p>
        ) : pestana === "consola" ? (
          (visibles as RegistroDeConsola[]).map((r) => (
            <FilaDeConsola key={`c${r.id}`} r={r} abierta={abiertos.has(`c${r.id}`)} onAlternar={() => alternar(`c${r.id}`)} onFalla={onFalla} />
          ))
        ) : (
          (visibles as RegistroDeRed[]).map((r) => (
            <FilaDeRed key={`r${r.id}`} r={r} abierta={abiertos.has(`r${r.id}`)} onAlternar={() => alternar(`r${r.id}`)} onFalla={onFalla} />
          ))
        )}
      </div>
    </div>
  );
}

const COLOR_NIVEL: Record<RegistroDeConsola["nivel"], string> = {
  error: "bg-danger/10 text-danger",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "text-ink",
  log: "text-ink",
  debug: "text-ink-faint",
};

function AlChat({ r, onFalla }: { r: Registro; onFalla: ((f: FallaDeVista) => void) | undefined }) {
  if (!onFalla) return null;
  return (
    <button
      type="button"
      title="Mandar esta falla al chat de IA, con su detalle y los archivos que nombra"
      onClick={(e) => {
        e.stopPropagation();
        onFalla(fallaDe(r));
      }}
      className="flex shrink-0 items-center gap-1 rounded border border-line bg-canvas px-1.5 py-0.5 font-sans text-[11px] text-ink-dim hover:border-accent hover:text-accent"
    >
      <MessageSquarePlus className="size-3" aria-hidden />
      Al chat
    </button>
  );
}

function FilaDeConsola({
  r,
  abierta,
  onAlternar,
  onFalla,
}: {
  r: RegistroDeConsola;
  abierta: boolean;
  onAlternar: () => void;
  onFalla: ((f: FallaDeVista) => void) | undefined;
}) {
  const [primera, ...resto] = r.texto.split("\n");
  const largo = resto.length > 0 || (primera?.length ?? 0) > 200;
  const Icono = r.nivel === "error" ? CircleX : r.nivel === "warn" ? AlertTriangle : Info;
  return (
    <div className={`group border-b border-line/60 px-2 py-1 ${COLOR_NIVEL[r.nivel]}`}>
      <div className="flex items-start gap-1.5">
        <button type="button" onClick={onAlternar} disabled={!largo} className="mt-0.5 shrink-0 text-ink-faint disabled:opacity-0">
          {abierta ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        </button>
        <Icono className={`mt-0.5 size-3 shrink-0 ${r.nivel === "log" || r.nivel === "debug" ? "opacity-0" : ""}`} aria-hidden />
        <span className={`min-w-0 flex-1 ${abierta ? "whitespace-pre-wrap break-words" : "truncate"}`}>{abierta ? r.texto : primera}</span>
        <span className="shrink-0 text-[10px] text-ink-faint" title={r.ruta}>
          {new Date(r.at).toLocaleTimeString()}
        </span>
        {(r.nivel === "error" || r.nivel === "warn") && <AlChat r={r} onFalla={onFalla} />}
      </div>
    </div>
  );
}

function FilaDeRed({
  r,
  abierta,
  onAlternar,
  onFalla,
}: {
  r: RegistroDeRed;
  abierta: boolean;
  onAlternar: () => void;
  onFalla: ((f: FallaDeVista) => void) | undefined;
}) {
  const fallo = falloLaRed(r);
  return (
    <div className={`border-b border-line/60 ${fallo ? "bg-danger/10" : ""}`}>
      {/* Un div y no un botón: adentro va "Al chat", y un botón no puede contener otro. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onAlternar}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onAlternar())}
        className="flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left hover:bg-surface-2"
      >
        {abierta ? <ChevronDown className="size-3 shrink-0 text-ink-faint" aria-hidden /> : <ChevronRight className="size-3 shrink-0 text-ink-faint" aria-hidden />}
        <span className="w-12 shrink-0 font-semibold text-ink-dim">{r.metodo}</span>
        <span className={`w-10 shrink-0 ${fallo ? "font-semibold text-danger" : "text-ink-dim"}`}>
          {r.enCurso ? "…" : r.estado === 0 || r.estado === null ? "✕" : r.estado}
        </span>
        <span className={`min-w-0 flex-1 truncate ${fallo ? "text-danger" : "text-ink"}`} title={r.url}>
          {rutaDeUrl(r.url)}
        </span>
        {r.cuerpo && <span className="max-w-[35%] shrink truncate text-[10px] text-ink-faint">{r.cuerpo}</span>}
        <span className="w-14 shrink-0 text-right text-[10px] text-ink-faint">{r.ms !== null ? `${r.ms} ms` : ""}</span>
        {fallo && <AlChat r={r} onFalla={onFalla} />}
      </div>
      {abierta && (
        <dl className="space-y-1 px-8 pb-2 text-[11px]">
          <Dato k="URL" v={r.url} />
          <Dato k="Página" v={r.ruta} />
          {r.cuerpo && <Dato k="Enviado" v={r.cuerpo} />}
          {r.tipoContenido && <Dato k="Tipo" v={r.tipoContenido} />}
          {r.error && <Dato k="Error" v={r.error} />}
          {r.respuesta && <Dato k="Respuesta" v={r.respuesta} pre />}
          {!r.respuesta && !fallo && !r.enCurso && (
            <p className="font-sans text-ink-faint">El cuerpo de la respuesta sólo se guarda cuando el pedido falla.</p>
          )}
        </dl>
      )}
    </div>
  );
}

function Dato({ k, v, pre }: { k: string; v: string; pre?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 font-sans text-ink-faint">{k}</dt>
      <dd className={`min-w-0 flex-1 text-ink ${pre ? "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas p-1.5" : "break-all"}`}>{v}</dd>
    </div>
  );
}
