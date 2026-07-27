import type { ReactNode } from "react";

/** Piezas visuales compartidas. Densas, sin adornos: es una herramienta. */

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // `min-w-0` es obligatorio: como ítem de grilla o flex, el default es
    // `min-width:auto`, que impide achicarse por debajo del ancho del contenido.
    // Sin esto un texto largo estira el panel y desborda sobre las columnas
    // vecinas en lugar de recortarse o hacer scroll adentro.
    <section
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-line bg-surface ${className}`}
    >
      {(title || actions) && (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">{title}</h2>
          {actions}
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const styles = {
    default: "bg-surface-2 hover:bg-line text-ink border-line",
    primary: "bg-accent/15 hover:bg-accent/25 text-accent border-accent/40",
    danger: "bg-danger/15 hover:bg-danger/25 text-danger border-danger/40",
    ghost: "bg-transparent hover:bg-surface-2 text-ink-dim border-transparent",
  }[variant];

  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ready: "bg-ok/15 text-ok border-ok/40",
  running: "bg-accent/15 text-accent border-accent/40",
  connecting: "bg-warn/15 text-warn border-warn/40",
  reconnecting: "bg-warn/15 text-warn border-warn/40",
  paused: "bg-warn/15 text-warn border-warn/40",
  awaiting_approval: "bg-approval/15 text-approval border-approval/40",
  error: "bg-danger/15 text-danger border-danger/40",
  failed: "bg-danger/15 text-danger border-danger/40",
  budget_exceeded: "bg-danger/15 text-danger border-danger/40",
  stopped: "bg-danger/15 text-danger border-danger/40",
  completed: "bg-ok/15 text-ok border-ok/40",
  disabled: "bg-surface-2 text-ink-faint border-line",
  idle: "bg-surface-2 text-ink-dim border-line",
};

export function Status({ value, label }: { value: string; label?: string }) {
  const style = STATUS_STYLES[value] ?? "bg-surface-2 text-ink-dim border-line";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${style}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label ?? value}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-6 text-center text-xs text-ink-faint">
      {children}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium tracking-wide text-ink-dim uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded border border-line bg-canvas px-2 py-1.5 text-sm text-ink outline-none focus:border-accent";

export function money(value: number): string {
  return value < 0.01 && value > 0 ? `US$${value.toFixed(5)}` : `US$${value.toFixed(3)}`;
}

/**
 * Cantidad de tokens en forma legible: 1.2M, 348k, 812.
 *
 * En una corrida real son millones, y el número crudo con separadores ocupa
 * más de lo que informa —lo que importa es el orden de magnitud y si creció—.
 */
export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)}min`;
  return `hace ${Math.round(seconds / 3600)}h`;
}
