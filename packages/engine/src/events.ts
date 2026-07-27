import { ids, type TraceEvent, type TraceEventInput } from "@orq/shared";

/**
 * Bus de eventos del motor.
 *
 * Todo lo que ocurre pasa por acá: el servidor lo persiste (para reproducir la
 * corrida con el timeline) y lo reemite por SSE. Si un paso no emite evento,
 * es un paso que el usuario no puede ver — que es justo lo contrario de lo que
 * esta herramienta busca.
 */
export type EventListener = (event: TraceEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: TraceEventInput): TraceEvent {
    const event = { ...input, id: ids.event(), at: Date.now() } as TraceEvent;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Un consumidor roto (una conexión SSE que se cayó) no puede tumbar la
        // corrida: se lo ignora y el resto sigue recibiendo.
      }
    }
    return event;
  }
}
