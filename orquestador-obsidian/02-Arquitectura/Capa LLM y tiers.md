---
tags: [arquitectura]
aliases: [Proveedores, Tiers, Multi-LLM]
---

# Capa LLM y tiers

`packages/llm`. Todo pasa por una interfaz con **formato de mensajes neutro
propio**; cada adaptador traduce en su borde.

## Los cinco proveedores

| `providerId` | Adaptador | Notas |
|---|---|---|
| `openrouter` | `adapters/openrouter.ts` | cientos de modelos con una sola key; catálogo vivo con precios reales |
| `anthropic` | `adapters/anthropic.ts` | directo |
| `openai` | `adapters/openai.ts` | directo |
| `ollama` | `adapters/ollama.ts` | **local, costo cero** |
| `nvidia` | `adapters/nvidia.ts` | build.nvidia.com, modelos sin costo con límite de tasa |

`adapters/openai-shared.ts` concentra lo común del formato OpenAI, que reusan
varios. Ver [[Cómo agregar un proveedor LLM]].

**Cada rol elige su proveedor y su modelo por separado.** Eso es lo que permite
correr los roles rutinarios barato y pagar sólo donde la decisión lo justifica.

## `ModelSelection`

```ts
{ providerId, modelSlug: string | null, tier, temperature: number | null, maxOutputTokens }
```

`modelSlug` tiene **prioridad** sobre `tier`: el tier es el atajo para cuando no
querés elegir modelo a mano.

## Los cuatro tiers

`packages/llm/src/tiers.ts` → `resolveTier(models, tier)`. La resolución es por
**precio real del catálogo**, no por una lista de slugs hardcodeada, así que
sigue funcionando cuando salen modelos nuevos.

| Tier | Banda (USD/MTok mezclado) | Contexto mínimo | Criterio de elección |
|---|---|---|---|
| `free` | exactamente 0 | 32k | mejor capacidad; entre pares, más contexto |
| `cheap` | > 0 y ≤ 1 | 32k | **el más barato** que sirva |
| `standard` | > 1 y ≤ 8 | 128k | mejor capacidad de la banda; entre pares, el más barato |
| `smart` | > 8 y ≤ 25 | 128k | ídem |

Sólo se consideran modelos con `supportsTools`.

### Precio mezclado

```ts
blendedPrice = inputPricePerMTok * 0.8 + outputPricePerMTok * 0.2
```

La proporción es la típica de un agente: mucho contexto de entrada (historial,
herramientas, bandeja) y salidas relativamente cortas.

### Por qué las bandas son disjuntas

Ver [[ADR-004 Bandas de precio disjuntas]]. En corto: sin piso, `standard` y
`smart` colapsan en el mismo modelo y la distinción por complejidad deja de
existir; sin techo, `smart` elige lo más caro del catálogo —hay opciones a
US$60/MTok— y un solo turno consume un presupuesto entero.

### Desempate: `QUALITY_HINTS`

Es la **única** parte curada, y se puede editar sin tocar nada más.

| Patrón | Bonus | Motivo |
|---|---|---|
| `claude`, `gpt-[5-9]` | +3 | buen seguimiento de instrucciones y tool-calling |
| `gemini`, `deepseek` | +2 | |
| `qwen`, `llama` | +1 | |
| `preview\|alpha\|beta` | −2 | |
| `[-:]fast$` | **−6** | cobran el doble por generar más rápido, no por ser mejores. En una empresa que corre sola la latencia no es el cuello de botella |
| `:free$` | **−10** | límites agresivos que cortan corridas largas — se ignora dentro del tier `free`, donde no discrimina nada |

El contexto largo suma, pero acotado a 2 puntos: un modelo mediocre con ventana
enorme no le puede ganar a uno bueno.

Cuando ningún modelo califica, `resolveTier` devuelve `null` para que el llamador
pida un slug explícito en lugar de caer en un modelo arbitrario.

---

## Advertencias de uso

> [!warning] `cheap` no sirve para roles que coordinan
> Elige por precio, y el modelo más barato del catálogo puede no servir para
> coordinar. En una prueba, el CEO con un modelo de US$0.014/MTok **se fue a
> descargar PDFs al azar en vez de delegar**; el mismo rol con `standard`
> repartió el trabajo a las cuatro direcciones correctamente.
>
> Usá `cheap` para ejecutores, no para quien coordina.

> [!warning] `free` funciona, pero es frágil
> Hay 14 modelos gratuitos con tool-calling en OpenRouter y funcionan: una
> corrida completa de 4 ciclos produjo un entregable coherente por US$0.00. Pero
> 429 y 402 son habituales, así que el motor reintenta con backoff y un agente
> que falla no detiene la empresa: pierde el turno y el resto sigue.
>
> **Con saldo de cuenta negativo, el cupo gratuito sólo tolera pedidos
> triviales**: un turno real recibe 402. Cualquier recarga lo destraba. Corré
> `npm run check:llm` antes de una corrida larga.

## El ledger

`packages/llm/src/ledger.ts` → `RunLedger`. Acumula por llamada: tokens de
entrada, de salida, **cacheados**, costo en USD y latencia. Lanza
`BudgetExceededError` desde `assertWithinBudget()`.

El costo es el que **informa el proveedor** cuando lo informa; si no, se estima
con el precio del catálogo. Ver [[Costos y presupuesto]].

## Verificación sin levantar la UI

```bash
npm run check:models              # qué modelo resuelve cada tier, con precio real
npm run check:llm                 # una llamada real con tool-calling, por proveedor
npm run check:llm -- --model=<slug>   # uno puntual
```

Ver [[Comandos]] y [[Diagnóstico de problemas]].

## Enlaces

- [[Motor de agentes]] — quién consume esto
- [[Costos y presupuesto]]
- [[Cómo agregar un proveedor LLM]]
- [[ADR-001 No usar Claude Agent SDK]]
