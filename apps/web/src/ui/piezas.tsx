import type { ComponentType, ReactNode } from "react";

/** Piezas chicas que cada pantalla venía dibujando por su cuenta. */

export function Badge({
  children,
  tono = "neutro",
}: {
  children: ReactNode;
  tono?: "neutro" | "ok" | "warn" | "danger" | "accent";
}) {
  const estilo = {
    neutro: "border-line bg-surface-2 text-ink-dim",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-warn/40 bg-warn/10 text-warn",
    danger: "border-danger/40 bg-danger/10 text-danger",
    accent: "border-accent/40 bg-accent/10 text-accent",
  }[tono];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${estilo}`}>
      {children}
    </span>
  );
}

/** Esqueleto de carga: reemplaza los "Cargando…" de texto suelto. */
export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} aria-hidden />;
}

/** Botón de un solo ícono, con `title` obligatorio: el ícono solo no alcanza. */
export function IconButton({
  icono: Icono,
  title,
  onClick,
  variant = "default",
  disabled,
}: {
  icono: ComponentType<{ className?: string }>;
  title: string;
  onClick?: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
}) {
  const estilo =
    variant === "danger"
      ? "text-ink-faint hover:bg-danger/10 hover:text-danger"
      : "text-ink-faint hover:bg-surface-2 hover:text-ink";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${estilo}`}
    >
      <Icono className="size-4" aria-hidden />
    </button>
  );
}

/** Tabs simples controladas. */
export function Tabs<T extends string>({
  valor,
  opciones,
  onCambiar,
}: {
  valor: T;
  opciones: Array<{ id: T; etiqueta: string }>;
  onCambiar: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-line">
      {opciones.map((opcion) => (
        <button
          key={opcion.id}
          role="tab"
          aria-selected={valor === opcion.id}
          onClick={() => onCambiar(opcion.id)}
          className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors ${
            valor === opcion.id
              ? "border-accent text-accent"
              : "border-transparent text-ink-dim hover:text-ink"
          }`}
        >
          {opcion.etiqueta}
        </button>
      ))}
    </div>
  );
}
