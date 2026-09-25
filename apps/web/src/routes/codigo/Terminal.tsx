import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { argvATexto, type Argv } from "@orq/shared";
import { api, type ResultadoDeComando } from "../../api.js";

/**
 * La terminal del IDE. No es una shell: corre sólo los comandos permitidos del
 * repo, en el mismo sandbox que usan los agentes. Una API en localhost que
 * corre lo que le pidan es una puerta que cualquier página abierta en el
 * navegador puede golpear.
 */

interface Entrada {
  id: number;
  comando: string;
  carpeta: string;
  resultado: ResultadoDeComando | null;
  error: string | null;
}

export function Terminal({
  repoId,
  sugeridos,
  carpetas = [],
}: {
  repoId: string;
  sugeridos: Argv[];
  /** En un monorepo, dónde correr: cada parte tiene su package.json. */
  carpetas?: string[];
}) {
  const [carpeta, setCarpeta] = useState("");
  const queryClient = useQueryClient();
  const [historial, setHistorial] = useState<Entrada[]>([]);
  const [comando, setComando] = useState("");
  const [indiceHistorial, setIndiceHistorial] = useState<number | null>(null);
  const fondo = useRef<HTMLDivElement>(null);
  const siguienteId = useRef(1);

  const correr = useMutation({
    mutationFn: async (texto: string) => {
      const id = siguienteId.current++;
      setHistorial((h) => [...h, { id, comando: texto, carpeta, resultado: null, error: null }]);
      try {
        const resultado = await api.ejecutarEnRepo(repoId, texto, carpeta);
        setHistorial((h) => h.map((e) => (e.id === id ? { ...e, resultado } : e)));
      } catch (error) {
        setHistorial((h) => h.map((e) => (e.id === id ? { ...e, error: (error as Error).message } : e)));
      }
    },
    // Un comando puede generar o cambiar archivos (snapshots, build): el árbol
    // se refresca al terminar.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["arbol", repoId] }),
  });

  useEffect(() => {
    fondo.current?.scrollIntoView({ block: "end" });
  }, [historial]);

  const ejecutar = (texto: string) => {
    if (!texto.trim() || correr.isPending) return;
    correr.mutate(texto.trim());
    setComando("");
    setIndiceHistorial(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas font-mono text-[12px]">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        {carpetas.length > 0 && (
          <select
            value={carpeta}
            onChange={(e) => setCarpeta(e.target.value)}
            title="Dónde se corre el comando"
            className="h-6 rounded border border-line bg-canvas px-1 font-sans text-[11px] text-ink"
          >
            <option value="">raíz del repo</option>
            {carpetas.map((c) => (
              <option key={c} value={c}>
                {c}/
              </option>
            ))}
          </select>
        )}
        {sugeridos.map((argv) => (
          <button
            key={argv.join(" ")}
            type="button"
            disabled={correr.isPending}
            onClick={() => ejecutar(argvATexto(argv))}
            className="flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-dim hover:border-accent hover:text-ink disabled:opacity-50"
          >
            <Play className="size-3 text-ok" aria-hidden /> {argvATexto(argv)}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          title="Limpiar"
          onClick={() => setHistorial([])}
          className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 leading-relaxed">
        {historial.length === 0 && (
          <p className="text-ink-faint">
            Corre los comandos permitidos del repo, en sandbox. Para sumar uno, agregalo en Repositorio → Comandos.
          </p>
        )}
        {historial.map((e) => (
          <div key={e.id} className="mb-3">
            <div className="text-ink">
              {e.carpeta && <span className="text-ink-faint">{e.carpeta}/ </span>}
              <span className="text-ok">❯</span> {e.comando}
            </div>
            {!e.resultado && !e.error && <div className="animate-pulse text-ink-faint">ejecutando…</div>}
            {e.error && <div className="text-danger">{e.error}</div>}
            {e.resultado && (
              <>
                <pre className="whitespace-pre-wrap text-ink-dim">{e.resultado.error ?? e.resultado.salida}</pre>
                <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                  <span
                    className={`rounded px-1.5 ${
                      e.resultado.codigo === 0 ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"
                    }`}
                  >
                    {e.resultado.cortadoPorTiempo ? "cortado por tiempo" : `exit ${e.resultado.codigo ?? "?"}`}
                  </span>
                  <span className="text-ink-faint">{(e.resultado.duracionMs / 1000).toFixed(1)} s</span>
                  {e.resultado.aislamiento === "sandbox" ? (
                    <span className="flex items-center gap-0.5 text-ink-faint">
                      <ShieldCheck className="size-3" aria-hidden /> sandbox
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 text-warn">
                      <ShieldOff className="size-3" aria-hidden /> sin aislamiento
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        <div ref={fondo} />
      </div>
      <form
        className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          ejecutar(comando);
        }}
      >
        <span className="text-ok">❯</span>
        <input
          value={comando}
          onChange={(ev) => setComando(ev.target.value)}
          onKeyDown={(ev) => {
            // Flechas para recorrer lo ya corrido, como en cualquier terminal.
            const previos = historial.map((h) => h.comando);
            if (ev.key === "ArrowUp" && previos.length) {
              ev.preventDefault();
              const i = indiceHistorial === null ? previos.length - 1 : Math.max(0, indiceHistorial - 1);
              setIndiceHistorial(i);
              setComando(previos[i] ?? "");
            } else if (ev.key === "ArrowDown" && indiceHistorial !== null) {
              ev.preventDefault();
              const i = indiceHistorial + 1;
              if (i >= previos.length) {
                setIndiceHistorial(null);
                setComando("");
              } else {
                setIndiceHistorial(i);
                setComando(previos[i] ?? "");
              }
            }
          }}
          disabled={correr.isPending}
          placeholder={correr.isPending ? "ejecutando…" : "npm test"}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
        />
      </form>
    </div>
  );
}
