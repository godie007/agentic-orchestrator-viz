---
tags: [contribuir]
aliases: [Nuevo evento, Traza nueva]
---

# Cómo agregar un evento

> **Un paso que no emite evento es un paso invisible.**

Si agregaste algo que el usuario debería poder ver —en vivo o en el replay—
necesita su variante en la traza.

## 1. La variante

`packages/shared/src/events.ts`:

```ts
const miEvento = z.object({
  ...base,                          // id, runId, tick, at
  type: z.literal("mi.evento"),
  roleId: idSchema.nullable().default(null),
  detalle: z.string().max(500),     // acotá los textos largos
});
```

**Acotá los previews.** `tool.end.preview` está limitado a 2000 caracteres y
`agent.message.preview` a 500, para no volcar el payload entero en cada evento —
que además se persiste en la base.

## 2. Sumarla a la unión

```ts
export const traceEventSchema = z.discriminatedUnion("type", [
  // …
  miEvento,   // ←
]);
```

`TraceEventInput` (el evento sin `id` ni `at`) y el helper `isEvent()` se derivan
solos. No hay nada más que tocar en `shared`.

## 3. Emitirlo desde el motor

```ts
bus.emit({
  type: "mi.evento",
  runId: state.runId,
  tick: state.tick,
  roleId: role.id,
  detalle: "…",
});
```

> [!important] Emití **antes** de ejecutar, no después
> Así la UI muestra lo que está pasando y no un resumen a posteriori. Es la
> convención de todos los eventos del motor.

> [!danger] Si el paso puede fallar, emití el cierre en `finally`
> Es la lección de `agent.turn_end`: sin eso, el nodo del organigrama queda
> "pensando…" para siempre.

## 4. El servidor

No hay que hacer nada: persiste y reemite todo lo que llega al `EventBus`. La
persistencia con `seq` es lo que hace posible el replay.

## 5. La UI

`apps/web/src/lib/derive.ts` — si el evento cambia el estado derivado (mensajes,
tareas, entregables, costo, quién habló con quién), manejalo ahí.

`apps/web/src/lib/acciones.ts` — la descripción legible, **en castellano**, para
el feed de actividad.

## 6. Documentarlo

[[Referencia de eventos]] y, si cambia cómo se lee el sistema,
[[Observabilidad y trazas]].

---

## Antes de agregar uno, preguntate

| Pregunta | Si la respuesta es… |
|---|---|
| ¿es diagnóstico y no un paso del proceso? | usá `log` con el `level` que corresponda, no una variante nueva |
| ¿ya hay una variante que lo cubre con otro campo? | agregá el campo, no el evento |
| ¿el usuario necesita verlo? | si no, quizá no va en la traza — se persiste todo |
| ¿tiene un cierre? | si tiene start, tiene que tener end, y el end va en `finally` |

## Lista de control

- [ ] variante en `events.ts` y en `traceEventSchema`
- [ ] textos largos acotados con `.max()`
- [ ] se emite **antes** del paso
- [ ] si hay start, hay end, y el end está en `finally`
- [ ] `derive.ts` lo maneja, si cambia el estado derivado
- [ ] `acciones.ts` lo describe en castellano
- [ ] [[Referencia de eventos]] actualizada
- [ ] `npm run typecheck && npm test`

## Enlaces

- [[Observabilidad y trazas]]
- [[Referencia de eventos]]
- [[Frontend web]]
