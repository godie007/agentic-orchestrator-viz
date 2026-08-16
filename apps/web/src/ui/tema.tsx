import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

/**
 * El tema es una elección de tres estados: sistema (default, no marca nada y
 * manda el media query), claro u oscuro. Se guarda en localStorage y se aplica
 * como `data-theme` en el html; el script de index.html lo repone antes del
 * primer pintado para que la carga no parpadee.
 */

export type Tema = "system" | "light" | "dark";

const CLAVE = "orq-tema";

function aplicar(tema: Tema): void {
  if (tema === "system") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(CLAVE);
    return;
  }
  document.documentElement.dataset.theme = tema;
  localStorage.setItem(CLAVE, tema);
}

function leido(): Tema {
  const guardado = localStorage.getItem(CLAVE);
  return guardado === "light" || guardado === "dark" ? guardado : "system";
}

const ORDEN: Tema[] = ["system", "light", "dark"];
const ETIQUETA: Record<Tema, string> = {
  system: "Tema: como el sistema",
  light: "Tema: claro",
  dark: "Tema: oscuro",
};

export function BotonDeTema() {
  const [tema, setTema] = useState<Tema>("system");
  useEffect(() => setTema(leido()), []);

  const siguiente = ORDEN[(ORDEN.indexOf(tema) + 1) % ORDEN.length]!;
  const Icono = tema === "light" ? Sun : tema === "dark" ? Moon : Monitor;

  return (
    <button
      type="button"
      title={`${ETIQUETA[tema]} — click para ${ETIQUETA[siguiente].toLowerCase()}`}
      onClick={() => {
        aplicar(siguiente);
        setTema(siguiente);
      }}
      className="rounded border border-line bg-surface-2 p-1.5 text-ink-dim transition-colors hover:text-ink"
    >
      <Icono className="size-3.5" aria-hidden />
    </button>
  );
}
