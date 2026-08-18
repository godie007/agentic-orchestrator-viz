import { Brain, Cpu, Gift, Sparkles, Zap } from "lucide-react";

/**
 * Con qué modelo corre un agente, dicho en un ícono.
 *
 * Una empresa puede mezclar suscripciones —Claude para lo creativo, los modelos
 * gratuitos de opencode para lo mecánico— y con el escalado por dificultad el
 * modelo **cambia de un turno a otro**. Sin esto, el organigrama muestra seis
 * agentes idénticos y no hay forma de ver que uno está gastando Opus en revisar
 * un archivo. El slug crudo no alcanza: hay que poder leerlo de un vistazo en
 * una tarjeta de 208px, y ahí un ícono con color entra donde no entra un texto.
 */

/** Familia visual del modelo: lo único que hace falta para elegir ícono y color. */
export type FamiliaModelo = "smart" | "standard" | "cheap" | "free" | "desconocido";

const FAMILIAS = {
  smart: { Icono: Brain, color: "var(--t-approval)", titulo: "modelo de mayor capacidad" },
  standard: { Icono: Sparkles, color: "var(--t-accent)", titulo: "modelo estándar" },
  cheap: { Icono: Zap, color: "var(--t-warn)", titulo: "modelo económico" },
  free: { Icono: Gift, color: "var(--t-ok)", titulo: "modelo sin costo" },
  desconocido: { Icono: Cpu, color: "var(--t-ink-faint)", titulo: "modelo" },
} as const;

/**
 * De qué familia es un modelo.
 *
 * Se mira el slug primero y el tier después, y no al revés: el tier dice qué se
 * pidió, el slug dice qué respondió. Con un `modelSlug` fijo no hay tier, y con
 * escalado el tier del rol es sólo el punto de partida.
 */
export function familiaDeModelo(slug: string | null, tier?: string | null): FamiliaModelo {
  const s = (slug ?? "").toLowerCase();
  // Lo gratuito se reconoce por el sufijo que usan los catálogos (`-free` en
  // opencode, `:free` en OpenRouter) y gana sobre la familia del modelo: un
  // Nemotron gratis y uno pago no cuestan lo mismo aunque sean el mismo modelo.
  if (s.endsWith("-free") || s.endsWith(":free")) return "free";
  if (s.includes("opus") || s.includes("-pro")) return "smart";
  if (s.includes("sonnet")) return "standard";
  if (s.includes("haiku") || s.includes("flash") || s.includes("mini") || s.includes("nano")) {
    return "cheap";
  }
  if (tier === "free" || tier === "cheap" || tier === "standard" || tier === "smart") return tier;
  return s ? "desconocido" : "desconocido";
}

/** Nombre corto del modelo: `claude-code/sonnet` → `sonnet`. */
export function nombreCortoDeModelo(slug: string | null): string {
  if (!slug) return "sin correr";
  const ultimo = slug.split("/").pop() ?? slug;
  return ultimo.replace(/-free$|:free$/, "").replace(/-\d{8}$/, "");
}

export interface ModeloBadgeProps {
  slug: string | null;
  providerId?: string | null;
  tier?: string | null;
  /** `true` cuando el tier lo eligió el medidor de dificultad. */
  escalado?: boolean;
  /** Por qué se eligió, tal como lo explicó el motor. Va al tooltip. */
  motivo?: string | null;
  /** Sin la etiqueta, sólo el ícono: para tarjetas apretadas. */
  soloIcono?: boolean;
}

export function ModeloBadge({
  slug,
  providerId,
  tier,
  escalado = false,
  motivo,
  soloIcono = false,
}: ModeloBadgeProps) {
  const familia = familiaDeModelo(slug, tier);
  const { Icono, color, titulo } = FAMILIAS[familia];
  const titulo_ = [
    slug ?? "todavía no corrió",
    providerId ? `proveedor: ${providerId}` : null,
    escalado ? "elegido por dificultad" : null,
    motivo,
    titulo,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={titulo_}
      className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-[10px] leading-none font-medium"
      style={{
        color,
        background: `color-mix(in oklch, ${color} 14%, transparent)`,
      }}
    >
      <Icono size={10} strokeWidth={2.25} aria-hidden />
      {!soloIcono && <span className="max-w-20 truncate">{nombreCortoDeModelo(slug)}</span>}
      {/* El escalado se marca con un punto y no con otra palabra: en una
          tarjeta de agente no hay lugar, y lo que importa es que se note que el
          modelo lo eligió el sistema y no la configuración del rol. */}
      {escalado && !soloIcono && <span className="opacity-60">·</span>}
    </span>
  );
}
