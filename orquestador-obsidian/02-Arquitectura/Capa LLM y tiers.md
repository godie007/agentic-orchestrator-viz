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
| `claude-sesion` | `adapters/anthropic.ts` → `ClaudeSesionProvider` | **el mismo Anthropic, autenticado con la sesión de `ant auth login`**. Ver abajo |
| `claude-code` | `adapters/claude-code.ts` → `ClaudeCodeProvider` | **delega al CLI oficial de Claude Code**; corre bajo tu suscripción. Ver abajo |

`adapters/openai-shared.ts` concentra lo común del formato OpenAI, que reusan
varios. Ver [[Cómo agregar un proveedor LLM]].

**Cada rol elige su proveedor y su modelo por separado.** Eso es lo que permite
correr los roles rutinarios barato y pagar sólo donde la decisión lo justifica.

## Claude con la sesión, como proveedor aparte

`claude-sesion` es el **mismo adaptador** que `anthropic`: sólo cambia de dónde
sale la credencial. Es un `providerId` distinto —y no una opción del anterior—
porque un rol elige proveedor **por id**: separados, le podés dar la sesión a un
agente y la API key al resto.

Se prende con `ORQ_CLAUDE_SESION=1`. Es un interruptor, no una credencial: la
credencial la aporta `ant`.

```sh
ant auth login
export ANTHROPIC_AUTH_TOKEN=$(ant auth print-credentials --access-token)
```

> [!warning] No es la suscripción de claude.ai
> `ant auth login` es un login a la **plataforma de desarrollo**: sigue
> facturando como API contra tu organización. Lo que ahorra es tener una clave
> estática en `.env`, no los tokens.

### Cuatro cosas que cuestan un rato si no se saben

**El token viaja distinto que la clave.** No es cambiar un valor: va como
`Authorization: Bearer` en vez de `x-api-key`, **y** exige el beta
`oauth-2025-04-20`. Sin ese header, `/v1/messages` rechaza un token válido. Lo
pone el adaptador, no quien configura.

**El SDK todavía no lee el perfil de disco.** La versión instalada (0.68)
resuelve `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN` y nada más — no hay
`ANTHROPIC_PROFILE` ni `ANTHROPIC_CONFIG_DIR` en el paquete. Por eso hace falta
exportar el token a mano. El adaptador construye el cliente **vacío** cuando no
le dan credencial, así que el día que el SDK sume la cadena completa, esto
empieza a andar solo sin tocar una línea.

**El token vence y no se refresca solo** al pasarlo por variable de entorno. Si
ese rol andaba y dejó de autenticar, es volver a exportarlo — no es el adaptador.

> [!danger] Una `ANTHROPIC_API_KEY` **vacía** rompe esto
> Gana igual su lugar en la cadena de credenciales del SDK y autentica con una
> clave en blanco: la sesión nunca se usa y el error es un 401 sin explicación.
> `.env.example` la trae vacía, así que copiarlo encima basta para caer acá.
> `buildRegistry` la saca del entorno al prender la sesión — vacía no le servía a
> nadie, porque con ella el proveedor `anthropic` tampoco se registra.

### Los tiers no resuelven acá

La API de Anthropic no publica precios, así que `blendedPrice` devuelve `null` y
ningún modelo califica para una banda. **El rol que use este proveedor tiene que
fijar su `modelSlug` exacto desde la UI.** Vale igual para `anthropic`.

> [!danger] Sin precios, el tope de presupuesto no corta
> Es la consecuencia grave del mismo hueco. `computeCost` toma
> `model.inputPricePerMTok ?? null` → sin precio, `costUsd` es **0** → `spentUsd`
> no crece nunca → `budgetUsd` **jamás se dispara**. Medido: una corrida de 4
> llamadas y 33k tokens de entrada quedó en `spentUsd: 0.0000`.
>
> Con los tres proveedores, **el único freno real es `maxTicks`** cuando no hay
> precios. Vale para `anthropic`, `claude-sesion` y `claude-code`.

## Claude Code (suscripción)

`claude-code` es la **única vía** de correr un agente tuyo con tu suscripción de
claude.ai (Pro/Max). En vez de pegar a la API (que factura por uso a la
organización), **delega cada turno al CLI oficial** (`adapters/claude-code.ts`):

- El modelo corre **del lado de Anthropic con el login de esta máquina**; el
  ledger registra el gasto como **US$ 0**.
- Prende con `ORQ_CLAUDE_CODE=1` en `.env`; un `CLAUDE_CODE_WORKDIR` guarda los
  archivos que el agente trabaje.
- No publica precios, así que no hay tiers: el rol tiene que **fijar
  `modelSlug` explícito** (`claude-code/sonnet`, `claude-code/opus`,
  `claude-code/haiku`).

### Diferencias con `claude-sesion`

| | `claude-sesion` | `claude-code` |
|---|---|---|
| Cómo corre | SDK de Anthropic | CLI oficial de Claude Code |
| Autentica | token OAuth de `ant` | login de la máquina |
| Factura | API → tu organización | tu suscripción Pro/Max |
| Modelo | el que fijes | resuelve el CLI |
| Tools | las del engine | las **del engine** vía puente MCP + las del CLI |

> El **puente MCP** es el camino por el que `claude-code` sí toca las tools de
> coordinación del org. El CLI corre su propio loop y no devuelve `tool_calls`
> (el engine no puede interceptarlas con `ToolRegistry`), así que el engine
> expone las tools del **rol** como un servidor MCP que vive **en su propio
> proceso**, con acceso directo a `RunState` y al `bus`. Ver
> `packages/engine/src/claude-mcp.ts`:
>
> - Transporte: socket Unix + relay stdio (`packages/llm/src/adapters/
>   claude-code-relay.mjs`). Claude escribe su protocolo MCP en stdin y el
>   relay lo canaliza al socket donde escucha el engine; las respuestas vuelven
>   por el mismo camino.
> - Cada delegación (`open()`) crea un socket y un servidor MCP **nuevos**, para
>   que los turnos de `claude-code` en paralelo no compartan estado.
> - Las llamadas se resuelven con la **misma maquinaria que el loop**
>   (`executeOne`): respetan aprobaciones, memo de lecturas, activity y emiten
>   los mismos eventos de coordinación.
> - El adaptador arma el `--mcp-config` con `--strict-mcp-config` y una
>   **allowlist de solo las tools expuestas** (`mcp__orq__<tool>`), no
>   `--dangerously-skip-permissions`.

> [!warning] Límites
> (1) La credencial es de esta máquina; no sirve para un server multi-usuario.
> (2) Pro/Max tienen rate-limits por ventana (5 h) y semanales, pensados para
> uso interactivo: un farm 24/7 se va a throttlear. (3) La allowlist de
> herramientas usa solo las del rol más las tools básicas del CLI (bash,
> archivos).

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
