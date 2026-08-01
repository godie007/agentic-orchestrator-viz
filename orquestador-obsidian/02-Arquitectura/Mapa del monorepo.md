---
tags: [arquitectura, referencia]
aliases: [Estructura de carpetas, Mapa del repo]
---

# Mapa del monorepo

Monorepo con **npm workspaces**: `packages/*` y `apps/*`. Node ≥ 22, ESM
(`"type": "module"`), TypeScript con `strict`, `noUncheckedIndexedAccess` y
`verbatimModuleSyntax` (`tsconfig.base.json`).

> [!info] Los `packages/` no se compilan
> Su `exports` apunta directo a `./src/index.ts` y los consumen tsx (servidor) y
> Vite (web). `npm run build` sólo afecta a `apps/`. Ver
> [[Invariantes de arquitectura]] §16.

```
orquestadorAgentico/
├── packages/
│   ├── shared/     modelo de dominio y eventos
│   ├── llm/        proveedores, tiers, costo
│   ├── tools/      herramientas, MCP, habilidades
│   └── engine/     el motor
├── apps/
│   ├── server/     Fastify + SQLite
│   └── web/        React + Vite
├── scripts/        utilidades de línea de comandos
├── data/           base, exports y música (git-ignored)
├── CLAUDE.md       instrucciones para agentes de código
├── README.md       pitch y estado
└── orquestador-obsidian/   ← esta bóveda
```

---

## `packages/shared` — el dominio

| Archivo | Qué contiene |
|---|---|
| `schema.ts` | **todo el modelo de dominio en Zod.** Empresa, departamento, rol, política, misión, herramienta, MCP, corrida, mensaje, tarea, entregable, aprobación, solicitud, aprendizaje, ledger, blueprint |
| `events.ts` | catálogo de `TraceEvent` como unión discriminada |
| `programacion.ts` | cálculo **puro** del próximo disparo de una misión (intervalo / semanal / cron) |
| `ids.ts` | generadores de identificadores por tipo |

Ver [[Modelo de dominio]], [[Referencia de eventos]], [[Misiones programadas]].

## `packages/llm` — los proveedores

| Archivo | Qué contiene |
|---|---|
| `types.ts` | la interfaz `LlmProvider` y el formato de mensajes neutro |
| `registry.ts` | qué proveedores están configurados y cómo se resuelve uno |
| `tiers.ts` | resolución de `free`/`cheap`/`standard`/`smart` contra el catálogo vivo |
| `ledger.ts` | `RunLedger`: costo acumulado y `BudgetExceededError` |
| `adapters/openrouter.ts` · `anthropic.ts` · `openai.ts` · `ollama.ts` · `nvidia.ts` | un adaptador por proveedor |
| `adapters/openai-shared.ts` | lo común del formato OpenAI, que reusan varios |

Ver [[Capa LLM y tiers]], [[Cómo agregar un proveedor LLM]].

## `packages/tools` — lo que los agentes pueden hacer

| Archivo | Qué contiene |
|---|---|
| `types.ts` | `RegisteredTool`, `ToolContext`, `ToolResult`, `ok()` / `fail()` |
| `registry.ts` | `ToolRegistry`: registro, `forRole`, `describe` |
| `router.ts` | `selectTools`: acota las opcionales sobre el umbral |
| `coordination.ts` | las **20 herramientas** que se otorgan siempre (incluidas `calcular`, `verificar_cifras` y `buscar_en_entregables`) |
| `capability.ts` | `web_search` y `fetch_url` (con bloqueo de red privada) |
| `calculo.ts` · `busqueda.ts` | `calcular`, `verificar_cifras`, `buscar_en_entregables` |
| `correo.ts` | `crearCorreo` + `send_email` por webhook de n8n |
| `mcp/bridge.ts` | `McpBridge`: conexión, descubrimiento, telemetría |
| `mcp/ca-fetch.ts` | fetch con CA propia para servidores HTTP con certificado local |
| `skills/` | las habilidades — ver abajo |

### `packages/tools/src/skills/`

| Archivo | Qué contiene |
|---|---|
| `index.ts` | registro de las habilidades y la interfaz `SkillStorage` |
| `markdown.ts` | parseo del markdown a **bloques neutros** — una sola vez, tres salidas |
| `render.ts` | `renderDocx` y `renderPdf` |
| `guion.ts` | markdown leído como **línea de tiempo**: escenas, diálogo, imágenes |
| `video.ts` | `renderVideo` — ffmpeg en una sola pasada |
| `slides.ts` | `renderSlides` — el mismo guion como deck HTML autocontenido |
| `narracion.ts` | Kokoro local, con `say` de macOS como respaldo |
| `musica.ts` | biblioteca de camas, elección por clima, normalización |
| `iconos.ts` | trazos vectoriales en ASS y SVG (`:objetivo:`) |
| `visuales.ts` | composiciones (`visual:flujo`), personas dibujadas con curvas |
| `imagenes.ts` | generación por API con caché y corte por tiempo |
| `permisos.ts` | `puedeBorrar`: quién da de baja qué, según autoridad |

Ver [[Habilidades de producción]], [[Producción audiovisual]].

## `packages/engine` — el motor

| Archivo | Qué contiene |
|---|---|
| `scheduler.ts` | `Orchestrator`: el **tick**, los tres modos, los cortes |
| `loop.ts` | `runAgentTurn`: el **turno** de un rol, iteraciones y tool calls |
| `state.ts` | `RunState`: bandejas, tareas, entregables, actividad, `forActor` |
| `prompt.ts` | `buildSystemPrompt` y `buildTurnPrompt` |
| `events.ts` | `EventBus` |
| `testing/fake-provider.ts` · `testing/factory.ts` | lo que hace posible testear sin gastar tokens |

Ver [[Motor de agentes]], [[Scheduler y ciclo de una corrida]].

## `apps/server` — Fastify

| Archivo | Qué contiene |
|---|---|
| `index.ts` | arranque: env, store, runtime, rutas, planificador de misiones |
| `env.ts` | validación de la configuración **una vez al arrancar** |
| `routes.ts` | REST + SSE — ver [[Referencia de API]] |
| `db.ts` | `Store`: esquema idempotente y todas las consultas |
| `runtime.ts` | lo que está vivo: runtimes de empresa y corridas activas |
| `exports.ts` | `ExportStore`: el directorio de salida, saneo de rutas, procedencia, publicar |
| `misiones.ts` | `MisionScheduler` |
| `seed.ts` | la empresa de ejemplo "Codytion S.A." |
| `migrate.ts` | reservado para cuando haga falta una migración de verdad |

## `apps/web` — React

| Archivo | Qué contiene |
|---|---|
| `App.tsx` | las 9 pestañas y el selector de empresa |
| `api.ts` | cliente HTTP — **ojo con el `content-type`**, ver [[Trampas conocidas]] |
| `lib/stream.ts` | suscripción SSE |
| `lib/derive.ts` | **estado derivado de la traza** — el corazón del replay |
| `lib/acciones.ts` | descripciones legibles de lo que hace un agente |
| `lib/ui.tsx` | primitivas visuales (`Panel`, `Empty`, …) |
| `routes/LiveProcess.tsx` | la pantalla principal |
| `routes/OrgGraph.tsx` | el organigrama con React Flow |
| `routes/Board.tsx` · `McpHub.tsx` · `Requests.tsx` · `Settings.tsx` · `Output.tsx` · `Memory.tsx` | el resto |

Ver [[Frontend web]].

## `scripts/`

| Script | Comando | Qué hace |
|---|---|---|
| `check-models.ts` | `npm run check:models` | qué modelo resuelve cada tier, con precio real |
| `check-llm.ts` | `npm run check:llm` | una llamada real con tool-calling, por proveedor |
| `seed-estudio-codytion.ts` | `npm run db:estudio` | el estudio audiovisual: 4 roles, un video |
| `generar-cama.ts` | `npm run musica:cama` | sintetiza dos camas musicales con ffmpeg |

Ver [[Comandos]].

## `data/` (git-ignored)

```
data/
├── orquestador.db          SQLite
├── exports/<empresa>/      lo que produce la empresa
│   ├── marca/logo.png      ruta fija, no configurable
│   ├── imagenes/           generadas, con caché por prompt
│   ├── publicado/          lo que una persona aprobó
│   └── .orq-generado.json  procedencia (oculto)
└── musica/                 las pistas las dejás vos
```
