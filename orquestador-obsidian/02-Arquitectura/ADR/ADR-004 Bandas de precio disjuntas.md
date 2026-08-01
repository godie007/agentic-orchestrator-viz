---
tags: [adr, arquitectura]
---

# ADR-004 Bandas de precio disjuntas

**Estado:** aceptada

## Contexto

Un rol elige modelo por **tier** (`free`, `cheap`, `standard`, `smart`) en vez de
por slug, para que la configuración no envejezca cuando salen modelos nuevos. El
tier se resuelve contra el catálogo vivo del proveedor, por precio real
(`packages/llm/src/tiers.ts`).

La pregunta era cómo definir cada tier.

## Decisión

Bandas de **precio mezclado** (USD/MTok) **disjuntas**, con piso y techo:

| Tier | Banda | Contexto mínimo |
|---|---|---|
| `free` | exactamente 0 | 32k |
| `cheap` | > 0 y ≤ 1 | 32k |
| `standard` | > 1 y ≤ 8 | 128k |
| `smart` | > 8 y ≤ 25 | 128k |

El precio mezclado es `entrada × 0.8 + salida × 0.2`, la proporción típica de un
agente: mucho contexto de entrada, salidas cortas.

## Alternativas consideradas

**Lista curada de slugs por tier.** Rechazada: envejece con cada modelo nuevo, y
es exactamente el mantenimiento que el tier venía a evitar.

**Bandas sólo con techo (sin piso).** Rechazada, y es el caso que motivó el ADR:
sin piso, `standard` y `smart` resuelven **al mismo modelo** —el mejor por debajo
de 8 también está por debajo de 25— y la distinción por complejidad deja de
existir.

**Sin techo en `smart`.** Rechazada: la resolución elegiría lo más caro del
catálogo. Hay opciones a **US$60/MTok**, y un solo turno consumiría el
presupuesto entero de la corrida.

## Consecuencias

### A favor
- Los cuatro tiers resuelven a modelos distintos, garantizado.
- Un modelo nuevo entra solo, sin tocar código.
- Un turno de `smart` tiene costo acotado por diseño.

### En contra / lo que se resignó
- **Un modelo excelente de US$30/MTok es inalcanzable por tier.** Se accede
  fijando el `modelSlug` exacto desde la UI, que tiene prioridad sobre el tier.
- Los límites son números elegidos a mano; hay que revisarlos si el mercado se
  mueve mucho.
- Dentro de la banda hace falta un desempate curado (`QUALITY_HINTS`), que es la
  única parte no automática. Se puede editar sin efectos colaterales.

### Los desempates que valen la pena mirar
- `[-:]fast$` → **−6**: cobran el doble por generar más rápido, no por ser
  mejores. En una empresa que corre sola la latencia no es el cuello de botella.
- `:free$` → **−10** fuera del tier `free`: sus límites de uso cortan corridas
  largas sin avisar. Dentro de `free` se ignora, donde no discrimina nada.

Ver [[Capa LLM y tiers]] y [[Costos y presupuesto]].
