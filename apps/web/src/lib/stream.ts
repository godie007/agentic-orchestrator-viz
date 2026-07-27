import { useEffect, useRef, useState } from "react";
import type { McpServerHealth, TraceEvent } from "@orq/shared";

/**
 * Suscripción a los streams SSE del servidor.
 *
 * Toda la visualización en vivo cuelga de acá: la UI no hace polling, reacciona
 * a los eventos que el motor emite en el momento en que ocurren.
 */

const MAX_EVENTS = 5000;

export function useRunStream(runId: string | null): {
  events: TraceEvent[];
  connected: boolean;
} {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connected, setConnected] = useState(false);
  // Los ids ya vistos: al abrir el stream el servidor reenvía la traza previa,
  // y una reconexión la reenvía de nuevo. Sin esto la UI duplicaría todo.
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setEvents([]);
    seen.current = new Set();
    if (!runId) {
      setConnected(false);
      return;
    }

    const source = new EventSource(`/api/runs/${runId}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("trace", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as TraceEvent;
      if (seen.current.has(event.id)) return;
      seen.current.add(event.id);
      setEvents((previous) => {
        const next = [...previous, event];
        // Una corrida larga puede emitir decenas de miles de eventos; se retiene
        // una ventana para que la pestaña no se coma la memoria. El histórico
        // completo está en la base y se lee con `api.runEvents`.
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    });

    return () => source.close();
  }, [runId]);

  return { events, connected };
}

export function useMcpStream(): Map<string, McpServerHealth> {
  const [health, setHealth] = useState(new Map<string, McpServerHealth>());

  useEffect(() => {
    const source = new EventSource("/api/mcp/stream");
    source.addEventListener("mcp", (message) => {
      const update = JSON.parse((message as MessageEvent<string>).data) as McpServerHealth;
      setHealth((previous) => new Map(previous).set(update.serverId, update));
    });
    return () => source.close();
  }, []);

  return health;
}
