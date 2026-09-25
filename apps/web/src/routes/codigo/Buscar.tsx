import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaseSensitive, Regex } from "lucide-react";
import { api } from "../../api.js";
import { IconoDeArchivo } from "./Explorador.js";
import { Vista } from "./ControlDeCodigo.js";

/**
 * Buscar en todo el repo (git grep), agrupado por archivo. Click en una línea
 * abre el archivo ahí.
 */
export function Buscar({ repoId, onAbrir }: { repoId: string; onAbrir: (ruta: string, linea: number) => void }) {
  const [texto, setTexto] = useState("");
  const [consulta, setConsulta] = useState("");
  const [mayusculas, setMayusculas] = useState(false);
  const [regex, setRegex] = useState(false);

  // Se busca al dejar de tipear, no en cada tecla: cada búsqueda es un git grep.
  useEffect(() => {
    const t = setTimeout(() => setConsulta(texto), 300);
    return () => clearTimeout(t);
  }, [texto]);

  const busqueda = useQuery({
    queryKey: ["buscar", repoId, consulta, mayusculas, regex],
    queryFn: () => api.buscarEnRepo(repoId, consulta, { mayusculas, regex }),
    enabled: consulta.trim().length >= 2,
  });

  const porArchivo = useMemo(() => {
    const grupos = new Map<string, Array<{ linea: number; texto: string }>>();
    for (const r of busqueda.data?.resultados ?? []) {
      const lista = grupos.get(r.ruta) ?? [];
      lista.push({ linea: r.linea, texto: r.texto });
      grupos.set(r.ruta, lista);
    }
    return [...grupos];
  }, [busqueda.data]);

  const Alternar = ({ activo, onClick, title, children }: { activo: boolean; onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded p-0.5 ${activo ? "bg-accent/25 text-accent" : "text-ink-faint hover:text-ink"}`}
    >
      {children}
    </button>
  );

  return (
    <Vista titulo="Buscar">
      <div className="px-2 pb-2">
        <div className="flex items-center gap-1 rounded border border-line bg-canvas pr-1 focus-within:border-accent">
          <input
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Buscar"
            className="h-6 min-w-0 flex-1 bg-transparent px-2 text-[12px] text-ink outline-none"
          />
          <Alternar activo={mayusculas} onClick={() => setMayusculas(!mayusculas)} title="Distinguir mayúsculas">
            <CaseSensitive className="size-3.5" aria-hidden />
          </Alternar>
          <Alternar activo={regex} onClick={() => setRegex(!regex)} title="Expresión regular">
            <Regex className="size-3.5" aria-hidden />
          </Alternar>
        </div>
        {busqueda.data && (
          <p className="mt-1.5 text-[11px] text-ink-faint">
            {busqueda.data.resultados.length} resultado(s) en {porArchivo.length} archivo(s)
            {busqueda.data.cortado ? " — se muestran los primeros 500" : ""}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {porArchivo.map(([ruta, lineas]) => {
          const nombre = ruta.split("/").at(-1) ?? ruta;
          return (
            <div key={ruta}>
              <div className="flex h-[22px] items-center gap-1.5 px-2 text-[13px] text-ink" title={ruta}>
                <IconoDeArchivo nombre={nombre} />
                <span className="truncate">{nombre}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{ruta.slice(0, -nombre.length - 1)}</span>
                <span className="rounded-full bg-surface-2 px-1.5 text-[10px] text-ink-dim">{lineas.length}</span>
              </div>
              {lineas.map((l) => (
                <button
                  key={l.linea}
                  type="button"
                  onClick={() => onAbrir(ruta, l.linea)}
                  className="flex w-full items-baseline gap-2 py-0.5 pr-2 pl-8 text-left font-mono text-[12px] text-ink-dim hover:bg-surface-2"
                >
                  <span className="w-8 shrink-0 text-right text-[10px] text-ink-faint">{l.linea}</span>
                  <span className="truncate">{l.texto.trim()}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </Vista>
  );
}
