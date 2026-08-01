---
tags: [adr, arquitectura]
aliases: [Agent SDK, Suscripción de Claude, Tool Runner, Managed Agents]
---

# ADR-001 No usar Claude Agent SDK

**Estado:** aceptada · *revisada tras verificar la documentación vigente*

## Contexto

El pedido original era usar la suscripción de Claude vía Claude Agent SDK, para
no pagar tokens por API.

La pregunta esconde **dos preguntas distintas** que conviene separar antes de
decidir, porque tienen respuestas diferentes:

1. **¿Puede quien desarrolla correr el SDK con su propio login?** Sí.
2. **¿Pueden los usuarios del producto autenticarse con *su* suscripción?** No
   por un camino soportado.

## Decisión

**No se usa el Agent SDK.** Hay un agent loop propio
(`packages/engine/src/loop.ts`) detrás de una interfaz `LlmProvider`
(`packages/llm/src/types.ts`) con formato de mensajes neutro; cada adaptador
traduce en su borde.

---

## Las cuatro formas de construir un agente

La versión original de este ADR planteaba una dicotomía falsa —"Agent SDK vs.
loop propio"—. Hay cuatro opciones, y se distinguen por **dos ejes
independientes**: quién pone el *harness* (el loop y el manejo de contexto) y
quién pone el *despliegue*.

| # | Opción | Escribís | Harness / despliegue | Herramientas |
|---|---|---|---|---|
| 1 | **Loop manual** ← lo que hace el orquestador | el `while stop_reason == "tool_use"` | tuyo / tuyo | sólo las que definís |
| 2 | **Tool Runner** (`client.beta.messages.tool_runner`) | sólo las funciones de las tools | **SDK** / tuyo | sólo las que definís |
| 3 | **Managed Agents** (beta, REST) | config del agente + resultados de tools | **Anthropic** / **Anthropic** | sandbox con bash, archivos, code exec + MCP + skills |
| 4 | **Claude Agent SDK** | un prompt + opciones | **SDK** (Claude Code) / tuyo | Read/Write/Edit/Bash/Glob/Grep/WebSearch integradas |

> [!warning] Tool Runner ≠ Claude Agent SDK
> Suenan parecido y son paquetes distintos. El **Tool Runner** es parte del SDK
> normal de la API (`anthropic` / `@anthropic-ai/sdk`): automatiza el ciclo
> pedido → ejecutar → repetir sobre *tus* tools, con hooks por turno para
> aprobación, intercepción de errores y reintentos. El **Claude Agent SDK**
> (`claude-agent-sdk` / `@anthropic-ai/claude-agent-sdk`) es Claude Code
> empaquetado como librería, con herramientas built-in, subagentes, hooks y
> permisos.
>
> Las opciones 1, 2 y 4 **las hospedás vos**. Sólo Managed Agents agrega
> despliegue.

---

## Alternativas consideradas

### Usar el Agent SDK con la suscripción de los usuarios — rechazada

No hay camino soportado. Los SDK resuelven credenciales en cadena —
`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → **perfil OAuth de
`ant auth login`** → Workload Identity Federation → perfil por defecto— y Claude
Code y el Agent SDK honran la misma resolución. Pero la documentación acota para
qué sirve cada eslabón:

> El login interactivo es para desarrollo en tu propia máquina. Para cargas no
> interactivas (CI, servidores, contenedores) se usa **Workload Identity
> Federation**.

Y WIF son credenciales de organización: facturación de API. Es decir, el camino
soportado para un servidor **es la API key**, no la suscripción de nadie.

> [!info] Sobre la restricción legal
> La versión original de este ADR citaba que Anthropic no permite ofrecer login
> de claude.ai ni los límites de suscripción en productos de terceros sin
> aprobación previa. **Eso no se pudo re-verificar** contra la documentación de
> API vigente, que cubre autenticación y SDK pero no los términos de servicio. Lo
> que sí está confirmado es el límite técnico de arriba, y apunta al mismo lugar.
> Si esto alguna vez importa para una decisión de producto, hay que leer los ToS,
> no este archivo.

**Lo que sí funciona hoy:** correr el orquestador contra tu propio perfil de
`ant auth login`, sin API key en `.env`. Eso es un adaptador nuevo en
`packages/llm/src/adapters/` que construya el cliente **sin argumentos** y deje
que la cadena resuelva sola. Ver [[Cómo agregar un proveedor LLM]].

### Usar el Agent SDK con API key — rechazada

Por una razón de producto, no legal: **el SDK está atado a modelos Anthropic**, y
eso rompe el requisito central de elegir modelo por agente según la complejidad
de su trabajo. Un ejecutor de triage y un CEO que descompone un encargo no tienen
por qué correr con el mismo modelo — ni pagarse igual. Ver
[[Capa LLM y tiers]], y el caso medido del CEO en `cheap` que se fue a descargar
PDFs al azar.

Es el argumento que **sostiene esta decisión**: sobrevive intacto aunque la
restricción legal cambie mañana.

### Usar el Tool Runner — rechazada, pero es la más cercana

Hace casi exactamente lo que hace `packages/engine/src/loop.ts`, incluidos los
hooks por turno que harían falta para `requiresApproval`, y ahorraría el código
de reintentos y corte. Pero **sólo habla con proveedores Anthropic**, así que
choca con lo mismo: cinco adaptadores conviviendo es el requisito, no un adorno.

### Usar Managed Agents — rechazada

Anthropic pone el harness **y** hospeda un sandbox por sesión. Dos problemas,
y el segundo es peor para este producto:

1. Mismo techo de proveedor que el Agent SDK.
2. **El loop corre en la infraestructura de Anthropic.** Se pierde la
   instrumentación paso a paso de la que salen el organigrama animado, el
   timeline con replay y `check_activity`. Ver [[Observabilidad y trazas]].

---

## Consecuencias

### A favor
- Cinco proveedores intercambiables (`openrouter`, `anthropic`, `openai`,
  `ollama`, `nvidia`), con Ollama a costo cero.
- **Cada paso se puede instrumentar**, que es lo que hace posible el organigrama
  animado, el timeline con replay y `check_activity`. Ninguna de las opciones 2,
  3 y 4 expone las iteraciones internas del loop con este detalle.
- El ledger mide costo real por rol y por tick, porque la llamada la hacemos
  nosotros.

### En contra / lo que se resignó
- Hay que mantener el agent loop: reintentos, backoff, corte por tiempo, corte
  por repetición, continuación de turnos interrumpidos. Todo eso es código propio
  que el Tool Runner o el Agent SDK habrían dado — y varias de esas piezas
  existen porque **se rompieron primero** (ver [[Trampas conocidas]]).
- Cada proveedor nuevo es un adaptador y su traducción de tool-calling.
- Nos perdemos lo que traiga el harness de Anthropic sin que lo escribamos:
  compaction del lado del servidor, edición de contexto, tool search.

### Cómo se revisaría

Esta decisión se cae si deja de valer el requisito multi-proveedor. Dos señales
concretas:

- **Si la empresa se estandariza en un solo proveedor**, el Tool Runner pasa a
  ser la opción sensata: mismo control por turno, mucho menos código propio.
- **Si en algún momento hace falta un proveedor "suscripción Claude"**, es un
  archivo nuevo en `packages/llm/src/adapters/` y nada más — la interfaz ya está.

Lo que **no** se revisa por costo de mantenimiento: el loop propio ya está
escrito y sus cortes están medidos contra corridas reales.

## Enlaces

- [[Capa LLM y tiers]] — el requisito que sostiene esta decisión
- [[Motor de agentes]] — lo que el loop propio hace y por qué
- [[Cómo agregar un proveedor LLM]]
- [[Observabilidad y trazas]]
