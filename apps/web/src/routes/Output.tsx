import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CompanyBundle, type TreeFile, type TreeFolder } from "../api.js";
import { Button, Empty, Panel, inputClass } from "../lib/ui.js";

/**
 * Directorio de salida: el árbol de lo que la empresa produjo.
 *
 * Los entregables viven en la base como texto; acá está lo que las habilidades
 * convirtieron en archivo. Se muestra como un árbol y no como una lista porque
 * la salida se organiza en carpetas por tema, y una lista plana de treinta
 * documentos no le sirve a nadie.
 */

const ICONO: Record<string, string> = {
  pdf: "📕",
  docx: "📘",
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  svg: "🖼️",
  mp4: "🎬",
  mov: "🎬",
  webm: "🎬",
  mp3: "🎵",
  wav: "🎵",
  m4a: "🎵",
};

const iconoDe = (nombre: string): string =>
  ICONO[nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase()] ?? "📄";

const peso = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function Output({ company }: { company: CompanyBundle }) {
  const companyId = company.company.id;
  const queryClient = useQueryClient();
  const [nuevaCarpeta, setNuevaCarpeta] = useState("");
  const [error, setError] = useState<string | null>(null);

  const tree = useQuery({
    queryKey: ["export-tree", companyId],
    queryFn: () => api.exportTree(companyId),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  const refrescar = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["export-tree", companyId] });
  };

  const crear = useMutation({
    mutationFn: (path: string) => api.createFolder(companyId, path),
    onSuccess: () => {
      setNuevaCarpeta("");
      setError(null);
      refrescar();
    },
    onError: (e: Error) => setError(e.message),
  });

  const borrar = useMutation({
    mutationFn: (path: string) => api.deleteFile(companyId, path),
    onSuccess: () => {
      setError(null);
      refrescar();
    },
    // El servidor rechaza borrar un entregable; el motivo se muestra tal cual.
    onError: (e: Error) => setError(e.message),
  });

  const raiz = tree.data;
  const vacio = !raiz || raiz.children.length === 0;

  return (
    <div className="h-full overflow-auto p-2">
      <Panel
        title="Directorio de salida"
        actions={
          <span className="text-[10px] normal-case text-ink-faint">
            los agentes borran multimedia y lo que generaron · vos, cualquier cosa
          </span>
        }
      >
        <div className="space-y-3 p-3">
          <div className="flex gap-2">
            <input
              value={nuevaCarpeta}
              onChange={(event) => setNuevaCarpeta(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && nuevaCarpeta.trim()) crear.mutate(nuevaCarpeta.trim());
              }}
              placeholder="comercial/propuestas"
              className={inputClass}
            />
            <Button
              variant="primary"
              onClick={() => nuevaCarpeta.trim() && crear.mutate(nuevaCarpeta.trim())}
              disabled={crear.isPending || !nuevaCarpeta.trim()}
            >
              + carpeta
            </Button>
          </div>

          {error && (
            <p className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              {error}
            </p>
          )}

          {vacio ? (
            <Empty>
              Todavía no hay archivos. Un agente con la habilidad <code>export_docx</code> o{" "}
              <code>export_pdf</code> los produce, y puede crear la carpeta destino sola.
            </Empty>
          ) : (
            <ul className="font-mono text-xs">
              {raiz.children.map((hijo) => (
                <Nodo
                  key={hijo.path}
                  nodo={hijo}
                  companyId={companyId}
                  nivel={0}
                  onBorrar={(path) => borrar.mutate(path)}
                  borrando={borrar.isPending}
                />
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </div>
  );
}

/** Una rama del árbol. Las carpetas se pliegan; los archivos se descargan. */
function Nodo({
  nodo,
  companyId,
  nivel,
  onBorrar,
  borrando,
}: {
  nodo: TreeFolder | TreeFile;
  companyId: string;
  nivel: number;
  onBorrar: (path: string) => void;
  borrando: boolean;
}) {
  const [abierta, setAbierta] = useState(true);
  const [confirmando, setConfirmando] = useState(false);
  const sangria = { paddingLeft: `${nivel * 16 + 4}px` };

  if (nodo.kind === "folder") {
    const cuenta = contarArchivos(nodo);
    return (
      <li>
        <button
          onClick={() => setAbierta((valor) => !valor)}
          style={sangria}
          className="flex w-full items-center gap-1.5 rounded py-1 text-left hover:bg-surface-2"
        >
          <span className="text-ink-faint">{abierta ? "▾" : "▸"}</span>
          <span>📁</span>
          <span className="text-ink">{nodo.name}</span>
          <span className="text-[10px] text-ink-faint">
            {cuenta === 0 ? "vacía" : `${cuenta} archivo${cuenta === 1 ? "" : "s"}`}
          </span>
        </button>
        {abierta && (
          <ul>
            {nodo.children.map((hijo) => (
              <Nodo
                key={hijo.path}
                nodo={hijo}
                companyId={companyId}
                nivel={nivel + 1}
                onBorrar={onBorrar}
                borrando={borrando}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li style={sangria} className="group flex items-center gap-1.5 py-1 hover:bg-surface-2">
      <span className="w-3" />
      <span>{iconoDe(nodo.name)}</span>
      <a
        href={api.exportUrl(companyId, nodo.path)}
        download
        className="truncate text-accent hover:underline"
      >
        {nodo.name}
      </a>
      <span className="text-[10px] text-ink-faint">{peso(nodo.sizeBytes)}</span>
      {/* Los que no generó la empresa son tuyos: el agente los deja en paz y
          conviene que se note de dónde salió cada archivo. */}
      {!nodo.generadoPorAgente && !nodo.esMultimedia && (
        <span
          title="No lo generó la empresa: un agente no puede borrarlo. Vos sí, desde acá."
          className="cursor-help rounded border border-line px-1 text-[9px] text-ink-faint"
        >
          externo
        </span>
      )}

      {/* Se puede borrar cualquier archivo, pero un entregable es el trabajo de
          la empresa y no hay papelera: ese pide confirmación. Un archivo de
          apoyo se borra de una, que es lo que uno espera al limpiar. */}
      {confirmando ? (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-warn">¿seguro? no se puede deshacer</span>
          <button
            onClick={() => {
              onBorrar(nodo.path);
              setConfirmando(false);
            }}
            className="rounded border border-danger/50 bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger"
          >
            sí, borrar
          </button>
          <button
            onClick={() => setConfirmando(false)}
            className="px-1 text-[10px] text-ink-faint hover:text-ink"
          >
            cancelar
          </button>
        </span>
      ) : (
        <button
          onClick={() => (nodo.esMultimedia ? onBorrar(nodo.path) : setConfirmando(true))}
          disabled={borrando}
          title={
            nodo.esMultimedia
              ? "Borrar este archivo"
              : "Borrar este entregable. No hay papelera: pide confirmación."
          }
          className="ml-auto rounded border border-danger/30 px-1.5 py-0.5 text-[10px] text-danger/80 hover:bg-danger/20 hover:text-danger disabled:opacity-40"
        >
          borrar
        </button>
      )}
    </li>
  );
}

function contarArchivos(carpeta: TreeFolder): number {
  return carpeta.children.reduce(
    (total, hijo) => total + (hijo.kind === "folder" ? contarArchivos(hijo) : 1),
    0,
  );
}
