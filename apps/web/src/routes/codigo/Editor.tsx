import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { AlertTriangle, Lock } from "lucide-react";
import { api } from "../../api.js";
import { useToast } from "../../ui/index.js";
import { lenguajeDe, monaco, useTemaMonaco } from "./monaco.js";

/**
 * El editor de un archivo y la vista de cambios, sobre Monaco.
 *
 * Lo que se edita vive en `ediciones` (del IDE) hasta que se guarda; el
 * contenido de disco lo trae react-query y **se refresca solo** mientras no
 * haya cambios sin guardar. Así, cuando un agente edita el archivo que tenés
 * abierto, lo ves cambiar; y si lo edita mientras vos también lo estabas
 * editando, no se pisa nada: aparece el aviso y decidís vos.
 */

const OPCIONES_BASE: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  fontLigatures: true,
  minimap: { enabled: true, renderCharacters: false, scale: 1 },
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  renderWhitespace: "selection",
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: "active", indentation: true },
  stickyScroll: { enabled: true },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  // Sin recuadros sobre −, × o –: en comentarios en castellano y fórmulas son
  // caracteres legítimos, y marcarlos todos es ruido. Los invisibles siguen.
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
  tabSize: 2,
  padding: { top: 8 },
};

export function EditorDeArchivo({
  repoId,
  ruta,
  nuevo,
  edicion,
  soloLectura,
  motivoSoloLectura,
  irALinea,
  onEditar,
  onGuardado,
  onCursor,
  onAgregarAlChat,
}: {
  repoId: string;
  ruta: string;
  nuevo: boolean;
  /** Lo editado sin guardar, o `undefined` si coincide con el disco. */
  edicion: string | undefined;
  soloLectura: boolean;
  motivoSoloLectura: string | null;
  irALinea: { linea: number; n: number } | null;
  onEditar: (ruta: string, valor: string | undefined) => void;
  onGuardado: (ruta: string) => void;
  onCursor: (linea: number, columna: number) => void;
  /** ⌘L: la selección (o el archivo entero) va al chat de IA, como en Cursor. */
  onAgregarAlChat: (seleccion: { ruta: string; desde: number; hasta: number; texto: string } | { ruta: string }) => void;
}) {
  const queryClient = useQueryClient();
  const avisar = useToast();
  const tema = useTemaMonaco();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const sucio = edicion !== undefined;

  const archivo = useQuery({
    queryKey: ["archivo", repoId, ruta],
    queryFn: () => api.archivo(repoId, ruta),
    // Mientras no haya cambios propios se sigue al disco: es la forma de ver
    // trabajar a un agente sobre el archivo abierto.
    refetchInterval: sucio ? false : 3_000,
    retry: nuevo ? false : 1,
  });
  const original = archivo.data?.contenido ?? (nuevo || archivo.isError ? "" : null);
  const hashCargado = useRef<string | null | undefined>(undefined);
  // El hash contra el que se guarda es el de lo que había cuando empezaste a
  // editar, no el último que llegó: si cambió en el medio, eso es un conflicto.
  if (!sucio) hashCargado.current = archivo.data?.hash ?? (nuevo ? null : undefined);
  const conflicto = sucio && archivo.data != null && hashCargado.current !== undefined && archivo.data.hash !== hashCargado.current;

  const guardar = useMutation({
    mutationFn: (forzar: boolean) =>
      api.guardarArchivo(repoId, ruta, edicion ?? original ?? "", forzar ? undefined : hashCargado.current ?? null),
    onSuccess: (r) => {
      queryClient.setQueryData(["archivo", repoId, ruta], {
        ruta,
        contenido: edicion ?? original ?? "",
        binario: false,
        bytes: (edicion ?? "").length,
        hash: r.hash,
      });
      onGuardado(ruta);
      void queryClient.invalidateQueries({ queryKey: ["arbol", repoId] });
    },
    onError: (e: Error) => avisar(e.message, "error"),
  });

  // Cmd/Ctrl+S se registra una vez en el editor; la función que llama tiene que
  // ser la de este render, por eso pasa por una ref.
  const guardarRef = useRef(() => {});
  guardarRef.current = () => {
    if (!soloLectura && (sucio || nuevo)) guardar.mutate(false);
  };

  const alChatRef = useRef(onAgregarAlChat);
  alChatRef.current = onAgregarAlChat;

  const alMontar: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => guardarRef.current());
    editor.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
    // La acción aparece en el menú contextual y en la paleta (F1), con ⌘L.
    editor.addAction({
      id: "orq.agregar-al-chat",
      label: "Agregar al chat de IA",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: (ed) => {
        const sel = ed.getSelection();
        const modelo = ed.getModel();
        if (sel && modelo && !sel.isEmpty()) {
          alChatRef.current({
            ruta,
            desde: sel.startLineNumber,
            hasta: sel.endLineNumber,
            texto: modelo.getValueInRange(sel),
          });
        } else {
          alChatRef.current({ ruta });
        }
      },
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !irALinea) return;
    editor.revealLineInCenter(irALinea.linea);
    editor.setPosition({ lineNumber: irALinea.linea, column: 1 });
    editor.focus();
  }, [irALinea, original === null]);

  if (archivo.data?.binario) {
    return (
      <Centro>
        {ruta} es binario o pesa más de 2 MB ({Math.round((archivo.data.bytes ?? 0) / 1024)} KB): no se abre en el editor.
      </Centro>
    );
  }
  if (original === null) return <Centro>{archivo.isLoading ? "Abriendo…" : "No se pudo abrir el archivo."}</Centro>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {soloLectura && motivoSoloLectura && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-1 text-[12px] text-ink-dim">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {motivoSoloLectura}
        </div>
      )}
      {conflicto && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1 text-[12px] text-warn">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            El archivo cambió en disco mientras lo editabas (lo tocó un agente). Elegí qué versión queda.
          </span>
          <button
            type="button"
            className="rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/15"
            onClick={() => onEditar(ruta, undefined)}
          >
            Quedarme con la del disco
          </button>
          <button
            type="button"
            className="rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/15"
            onClick={() => guardar.mutate(true)}
          >
            Guardar la mía igual
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          path={`${repoId}/${ruta}`}
          language={lenguajeDe(ruta)}
          value={edicion ?? original}
          theme={tema}
          onMount={alMontar}
          onChange={(valor) => onEditar(ruta, valor === original ? undefined : (valor ?? ""))}
          options={{ ...OPCIONES_BASE, readOnly: soloLectura }}
          loading={<Centro>Cargando el editor…</Centro>}
        />
      </div>
    </div>
  );
}

/**
 * La vista de cambios de un archivo. Por default, la base de la sesión contra
 * lo actual; con `desde`/`hasta`, entre dos commits —así se ve exactamente lo
 * que cambió un pedido del chat, y no todo lo acumulado en la sesión—.
 */
export function DiffDeArchivo({
  repoId,
  ruta,
  edicion,
  desde,
  hasta,
}: {
  repoId: string;
  ruta: string;
  edicion: string | undefined;
  desde?: string | undefined;
  hasta?: string | undefined;
}) {
  const tema = useTemaMonaco();
  const base = useQuery({
    queryKey: ["archivo-ref", repoId, ruta, desde ?? "base"],
    queryFn: () => (desde ? api.archivoEnRef(repoId, ruta, desde) : api.archivo(repoId, ruta, "base")),
  });
  const actual = useQuery({
    queryKey: hasta ? ["archivo-ref", repoId, ruta, hasta] : ["archivo", repoId, ruta],
    queryFn: () => (hasta ? api.archivoEnRef(repoId, ruta, hasta) : api.archivo(repoId, ruta)),
    refetchInterval: hasta ? false : 3_000,
    retry: false,
  });
  if (base.isLoading || actual.isLoading) return <Centro>Calculando cambios…</Centro>;
  const modificado = hasta ? (actual.data?.contenido ?? null) : (edicion ?? actual.data?.contenido ?? null);
  return (
    <DiffEditor
      original={base.data?.contenido ?? ""}
      modified={modificado ?? ""}
      originalModelPath={`orig/${repoId}/${desde ?? "base"}/${ruta}`}
      modifiedModelPath={`mod/${repoId}/${hasta ?? "actual"}/${ruta}`}
      language={lenguajeDe(ruta)}
      theme={tema}
      options={{
        ...OPCIONES_BASE,
        readOnly: true,
        // Un archivo nuevo o borrado no tiene "otro lado": en dos columnas la
        // mitad de la pantalla era un vacío rayado. Ahí va en línea, como VS Code.
        renderSideBySide: base.data?.contenido != null && modificado != null,
        originalEditable: false,
        minimap: { enabled: false },
      }}
      loading={<Centro>Cargando el editor…</Centro>}
    />
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-ink-faint">{children}</div>;
}
