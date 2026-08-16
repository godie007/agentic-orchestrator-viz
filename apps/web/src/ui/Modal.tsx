import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "../lib/ui.js";

/**
 * Modal sobre `<dialog>` nativo: foco atrapado, Escape y backdrop gratis, sin
 * dependencia. Cada pantalla venía armando el suyo con divs y ninguno se
 * comportaba igual.
 */
export function Modal({
  abierto,
  titulo,
  onCerrar,
  children,
  ancho = "max-w-lg",
}: {
  abierto: boolean;
  titulo: ReactNode;
  onCerrar: () => void;
  children: ReactNode;
  ancho?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (abierto && !dialog.open) dialog.showModal();
    if (!abierto && dialog.open) dialog.close();
  }, [abierto]);

  return (
    <dialog
      ref={ref}
      onClose={onCerrar}
      onClick={(evento) => {
        // Click en el backdrop (el dialog mismo, no su contenido) cierra.
        if (evento.target === ref.current) onCerrar();
      }}
      className={`m-auto w-full ${ancho} rounded-lg border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/50 open:animate-none`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        <button
          type="button"
          onClick={onCerrar}
          className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          title="Cerrar"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
    </dialog>
  );
}

/**
 * Confirmación destructiva con un solo patrón. Reemplaza a los estados
 * `borrando`/`confirmando` ad-hoc que cada pantalla dibujaba distinto.
 */
export function ConfirmDialog({
  abierto,
  titulo,
  detalle,
  confirmar = "borrar",
  pendiente = false,
  onConfirmar,
  onCancelar,
}: {
  abierto: boolean;
  titulo: string;
  detalle: ReactNode;
  confirmar?: string;
  pendiente?: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  return (
    <Modal abierto={abierto} titulo={titulo} onCerrar={onCancelar} ancho="max-w-md">
      <div className="space-y-3">
        <div className="text-xs text-ink-dim">{detalle}</div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancelar}>
            cancelar
          </Button>
          <Button variant="danger" disabled={pendiente} onClick={onConfirmar}>
            {pendiente ? "trabajando…" : confirmar}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
