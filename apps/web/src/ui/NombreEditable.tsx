import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

/**
 * Un nombre que se renombra en el lugar: lápiz al pasar, Enter guarda, Esc
 * cancela. Es lo que hace el explorador de VS Code con F2 y la barra de
 * Finder; abrir un modal para cambiar seis letras obliga a dejar de mirar la
 * lista que se estaba ordenando.
 *
 * Salir del campo **guarda**, no cancela: quien escribió un nombre y hizo click
 * afuera lo quería. Si el servidor lo rechaza (repetido, corrida en curso), el
 * campo sigue abierto con el motivo, en vez de volver en silencio al nombre
 * viejo y hacerle creer a la persona que se guardó.
 */
export function NombreEditable({
  valor,
  onGuardar,
  className = "",
  deshabilitado,
  motivoDeshabilitado,
  etiqueta = "Renombrar",
}: {
  valor: string;
  onGuardar: (nuevo: string) => Promise<unknown>;
  className?: string;
  deshabilitado?: boolean;
  motivoDeshabilitado?: string;
  etiqueta?: string;
}) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(valor);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editando) setTexto(valor);
  }, [valor, editando]);

  useEffect(() => {
    if (editando) campo.current?.select();
  }, [editando]);

  const cerrar = () => {
    setEditando(false);
    setError(null);
    setTexto(valor);
  };

  const guardar = async () => {
    if (guardando) return;
    const limpio = texto.trim();
    if (!limpio || limpio === valor) return cerrar();
    setGuardando(true);
    try {
      await onGuardar(limpio);
      setEditando(false);
      setError(null);
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : String(fallo));
    } finally {
      setGuardando(false);
    }
  };

  if (editando) {
    return (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          ref={campo}
          value={texto}
          maxLength={120}
          disabled={guardando}
          aria-label={etiqueta}
          onChange={(evento) => setTexto(evento.target.value)}
          onClick={(evento) => evento.stopPropagation()}
          onKeyDown={(evento) => {
            evento.stopPropagation();
            if (evento.key === "Enter") void guardar();
            if (evento.key === "Escape") cerrar();
          }}
          onBlur={() => void guardar()}
          className={`min-w-0 rounded border border-accent bg-canvas px-1 py-px text-ink outline-none ${className}`}
        />
        {error && <span className="text-[10px] leading-snug font-normal text-danger">{error}</span>}
      </span>
    );
  }

  return (
    <span className="group/nombre flex min-w-0 items-center gap-1">
      <span
        className={`truncate ${className}`}
        title={deshabilitado ? valor : `${valor} — doble click para renombrar`}
        onDoubleClick={(evento) => {
          if (deshabilitado) return;
          evento.stopPropagation();
          setEditando(true);
        }}
      >
        {valor}
      </span>
      <button
        type="button"
        disabled={deshabilitado}
        title={deshabilitado ? motivoDeshabilitado : etiqueta}
        aria-label={etiqueta}
        onClick={(evento) => {
          evento.stopPropagation();
          setEditando(true);
        }}
        className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 group-hover/nombre:opacity-100 focus-visible:opacity-100 hover:text-ink disabled:cursor-not-allowed disabled:hover:text-ink-faint"
      >
        <Pencil className="size-3" aria-hidden />
      </button>
    </span>
  );
}
