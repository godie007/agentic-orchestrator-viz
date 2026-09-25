import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Trash2 } from "lucide-react";
import { api, type EstadoVivoDeServicio } from "../../api.js";
import { COLOR_ESTADO } from "./Servicios.js";

/**
 * La salida de un servicio levantado, como el panel "Output" de VS Code.
 *
 * Se piden sólo las líneas nuevas (`desde`, un contador absoluto del
 * servidor): con un backend que loguea cada request, traer todo cada segundo
 * serían megas por minuto. Los secretos de su `.env` llegan tapados.
 */

const MAX_LINEAS = 4_000;

function colorDe(linea: string): string {
  if (/\b(error|err!|failed|fatal|exception|uncaught)\b/i.test(linea)) return "text-danger";
  if (/\b(warn|warning|deprecated)\b|⚠/i.test(linea)) return "text-warn";
  if (/^\$ |^✓|^↪/.test(linea)) return "text-accent";
  return "text-ink-dim";
}

export function Salida({ repoId, servicioId }: { repoId: string; servicioId: string }) {
  const [lineas, setLineas] = useState<string[]>([]);
  const [vivo, setVivo] = useState<EstadoVivoDeServicio | null>(null);
  const [seguir, setSeguir] = useState(true);
  const desde = useRef(0);
  const fondo = useRef<HTMLDivElement>(null);

  useEffect(() => {
    desde.current = 0;
    setLineas([]);
    let activo = true;
    let reloj: ReturnType<typeof setTimeout> | null = null;
    const pedir = async () => {
      try {
        const r = await api.logsDeServicio(repoId, servicioId, desde.current);
        if (!activo) return;
        // El servicio se reinició: su contador volvió a empezar.
        if (r.siguiente < desde.current) {
          desde.current = 0;
          setLineas([]);
        }
        if (r.lineas.length) setLineas((previas) => [...previas, ...r.lineas].slice(-MAX_LINEAS));
        desde.current = r.siguiente;
        setVivo(r.vivo);
      } catch {
        // se reintenta en la próxima vuelta
      }
      if (activo) reloj = setTimeout(() => void pedir(), 1_200);
    };
    void pedir();
    return () => {
      activo = false;
      if (reloj) clearTimeout(reloj);
    };
  }, [repoId, servicioId]);

  useEffect(() => {
    if (seguir) fondo.current?.scrollIntoView({ block: "end" });
  }, [lineas, seguir]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-[11px] text-ink-faint">
        {vivo && <span className={`size-2 rounded-full ${COLOR_ESTADO[vivo.estado]}`} aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-mono">{vivo?.comando ?? "sin arrancar"}</span>
        <button
          type="button"
          title={seguir ? "Siguiendo la salida" : "Seguir la salida"}
          onClick={() => setSeguir(!seguir)}
          className={`rounded p-0.5 hover:bg-surface-2 ${seguir ? "text-accent" : ""}`}
        >
          <ArrowDownToLine className="size-3.5" aria-hidden />
        </button>
        <button type="button" title="Limpiar la vista" onClick={() => setLineas([])} className="rounded p-0.5 hover:bg-surface-2 hover:text-ink">
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-3 py-1.5 font-mono text-[11.5px] leading-[1.55]"
        onWheel={(e) => {
          if (e.deltaY < 0) setSeguir(false);
        }}
      >
        {lineas.length === 0 && <p className="text-ink-faint">Sin salida todavía.</p>}
        {lineas.map((linea, i) => (
          <div key={i} className={`break-all whitespace-pre-wrap ${colorDe(linea)}`}>
            {linea || " "}
          </div>
        ))}
        <div ref={fondo} />
      </div>
    </div>
  );
}
