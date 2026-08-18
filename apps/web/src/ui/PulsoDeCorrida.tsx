import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CircleDot, PauseCircle, TriangleAlert } from "lucide-react";
import { api } from "../api.js";
import { calcularProgreso, type Salud } from "../lib/progreso.js";

/**
 * Cuánto lleva el proyecto trabajando en su encargo, en la barra de arriba.
 *
 * Está en el shell y no en la pantalla de proceso a propósito: un encargo dura
 * horas y quien lo sigue no se queda mirando la traza — está en el tablero, en
 * la salida o en otra pantalla. El reloj tiene que acompañarlo a todas.
 *
 * Muestra **dos** tiempos y no uno, porque uno solo engaña: una corrida de dos
 * horas puede estar trabajando o colgada, y lo que las distingue es hace cuánto
 * pasó algo. Es la pregunta que uno termina haciéndole a la traza a mano.
 */

const ESTILO: Record<Salud, { color: string; Icono: typeof Activity; texto: string }> = {
  trabajando: { color: "var(--t-ok)", Icono: Activity, texto: "corriendo" },
  callado: { color: "var(--t-warn)", Icono: CircleDot, texto: "sin novedad" },
  "sin-señal": { color: "var(--t-danger)", Icono: TriangleAlert, texto: "sin señal" },
  detenida: { color: "var(--t-ink-faint)", Icono: PauseCircle, texto: "detenida" },
};

export function PulsoDeCorrida({ companyId }: { companyId: string }) {
  const pulso = useQuery({
    queryKey: ["progreso", companyId],
    queryFn: () => api.progreso(companyId),
    // El servidor se consulta cada 5 segundos y el reloj lo lleva el navegador:
    // pedirle la hora al servidor una vez por segundo sería gastar una llamada
    // para saber algo que el cliente ya sabe.
    refetchInterval: (query) => (query.state.data?.viva ? 5_000 : 30_000),
  });

  // Un tick propio para que el contador avance entre consultas.
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const reloj = setInterval(() => setAhora(Date.now()), 1_000);
    return () => clearInterval(reloj);
  }, []);

  const run = pulso.data?.run;
  if (!run) return null;

  const p = calcularProgreso(run, pulso.data?.progreso ?? null, pulso.data?.viva ?? false, ahora);
  const { color, Icono, texto } = ESTILO[p.salud];

  return (
    <div
      title={
        `${run.objective.slice(0, 160)}…\n\n` +
        `Ciclo ${p.ciclo} · ${p.acciones} acciones ejecutadas` +
        (p.desdeUltimaSenal ? `\nÚltima señal hace ${p.desdeUltimaSenal}` : "") +
        (run.stopReason ? `\nSe detuvo: ${run.stopReason}` : "")
      }
      className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1 text-[11px]"
    >
      <span className="flex items-center gap-1 font-medium" style={{ color }}>
        <Icono size={12} strokeWidth={2.5} aria-hidden />
        {texto}
      </span>
      {/* `tabular-nums` para que el reloj no baile al cambiar de dígito. */}
      <span className="font-mono tabular-nums text-ink">{p.transcurrido}</span>
      <span className="text-ink-faint">ciclo {p.ciclo}</span>
      <span className="text-ink-faint">{p.acciones} acciones</span>
      {p.desdeUltimaSenal && p.salud !== "detenida" && (
        <span className={p.salud === "trabajando" ? "text-ink-faint" : ""} style={
          p.salud === "trabajando" ? undefined : { color }
        }>
          señal hace {p.desdeUltimaSenal}
        </span>
      )}
    </div>
  );
}
