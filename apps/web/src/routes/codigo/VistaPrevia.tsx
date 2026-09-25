import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RotateCw, ShieldCheck, Zap, ZapOff } from "lucide-react";
import { api } from "../../api.js";

/**
 * La vista previa: el proyecto corriendo, en una pestaña del editor.
 *
 * El iframe va con `sandbox="allow-scripts"` y **sin** `allow-same-origin`:
 * lo que corre acá lo escribió un agente, y con el origen de la app podría
 * llamar a toda la API con sólo cargarse. Con origen opaco no puede —el
 * servidor además cerró CORS a la app—, y la página igual corre su JS, su
 * WebGL y sus módulos.
 *
 * Se recarga sola cuando cambia algo: un guardado tuyo o un checkpoint de un
 * agente. Es la forma de ver el efecto de un pedido del chat sin tocar nada.
 */
export function VistaPrevia({
  repoId,
  ruta,
  version,
  onCambiarRuta,
}: {
  repoId: string;
  ruta: string;
  /** Sube con cada guardado o checkpoint: dispara la recarga automática. */
  version: string;
  onCambiarRuta: (ruta: string) => void;
}) {
  const [auto, setAuto] = useState(true);
  const [recargas, setRecargas] = useState(0);
  const versionVista = useRef(version);
  if (auto && version !== versionVista.current) versionVista.current = version;

  const arbol = useQuery({ queryKey: ["arbol", repoId], queryFn: () => api.arbolDeRepo(repoId) });
  const paginas = useMemo(
    () => (arbol.data?.archivos ?? []).filter((a) => /\.html?$/i.test(a) && !a.includes("node_modules/")),
    [arbol.data],
  );
  const [direccion, setDireccion] = useState(ruta);
  useEffect(() => setDireccion(ruta), [ruta]);

  const url = api.vistaUrl(repoId, ruta);
  const clave = `${url}#${recargas}#${auto ? versionVista.current : "fija"}`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-surface px-2">
        <button
          type="button"
          title="Recargar"
          onClick={() => setRecargas((n) => n + 1)}
          className="rounded p-1 text-ink-dim hover:bg-surface-2 hover:text-ink"
        >
          <RotateCw className="size-3.5" aria-hidden />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center rounded border border-line bg-canvas px-2"
          onSubmit={(e) => {
            e.preventDefault();
            onCambiarRuta(direccion.trim().replace(/^\/+/, "") || "index.html");
          }}
        >
          <ShieldCheck className="mr-1.5 size-3 shrink-0 text-ok" aria-hidden />
          <input
            list={`paginas-${repoId}`}
            value={direccion}
            onChange={(e) => setDireccion(e.target.value)}
            className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none"
          />
          <datalist id={`paginas-${repoId}`}>
            {paginas.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </form>
        <button
          type="button"
          title={auto ? "Recarga automática al guardar o con cada checkpoint: activada" : "Recarga automática: desactivada"}
          onClick={() => setAuto(!auto)}
          className={`rounded p-1 hover:bg-surface-2 ${auto ? "text-accent" : "text-ink-faint"}`}
        >
          {auto ? <Zap className="size-3.5" aria-hidden /> : <ZapOff className="size-3.5" aria-hidden />}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="Abrir en una pestaña nueva del navegador"
          className="rounded p-1 text-ink-dim hover:bg-surface-2 hover:text-ink"
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <iframe
        key={clave}
        src={url}
        title={`Vista previa de ${ruta}`}
        sandbox="allow-scripts allow-pointer-lock allow-forms"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
