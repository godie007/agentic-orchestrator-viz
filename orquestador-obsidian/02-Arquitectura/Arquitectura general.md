---
tags: [arquitectura]
aliases: [Arquitectura, Overview técnico]
---

# Arquitectura general

## Vista de capas

```mermaid
graph TB
  subgraph web["apps/web — React 19 + Vite + Tailwind v4"]
    UI["9 pantallas<br/>React Flow · TanStack Query"]
    DER["lib/derive.ts<br/>estado derivado de la traza"]
  end

  subgraph server["apps/server — Fastify"]
    API["routes.ts<br/>REST + SSE"]
    RT["runtime.ts<br/>lo que está vivo"]
    DB["db.ts<br/>SQLite (better-sqlite3)"]
    EX["exports.ts<br/>directorio de salida"]
    MIS["misiones.ts<br/>planificador"]
  end

  subgraph engine["packages/engine — el motor"]
    SCH["scheduler.ts<br/>Orchestrator · el tick"]
    LOOP["loop.ts<br/>agent loop · el turno"]
    ST["state.ts<br/>RunState · bandejas"]
    PR["prompt.ts<br/>sistema + turno"]
    BUS["events.ts<br/>EventBus"]
  end

  subgraph tools["packages/tools"]
    REG["registry.ts"]
    ROUT["router.ts"]
    COORD["coordination.ts"]
    SK["skills/"]
    MCP["mcp/bridge.ts"]
  end

  subgraph llm["packages/llm"]
    IFACE["types.ts<br/>LlmProvider"]
    AD["adapters/<br/>openrouter · anthropic<br/>openai · ollama · nvidia"]
    TIER["tiers.ts"]
    LED["ledger.ts"]
  end

  SHARED["packages/shared<br/>Zod: schema.ts + events.ts<br/>única fuente de verdad"]

  UI --> API
  DER -.SSE.- API
  API --> RT
  RT --> DB
  RT --> EX
  RT --> SCH
  MIS --> RT
  SCH --> LOOP
  LOOP --> ST
  LOOP --> PR
  LOOP --> BUS
  LOOP --> REG
  LOOP --> IFACE
  REG --> ROUT
  REG --> COORD
  REG --> SK
  REG --> MCP
  IFACE --> AD
  AD --> TIER
  AD --> LED

  engine -.tipos.-> SHARED
  tools -.tipos.-> SHARED
  llm -.tipos.-> SHARED
  server -.tipos.-> SHARED
  web -.tipos.-> SHARED
```

La flecha que **no** existe es la importante: `packages/engine` no depende de
Fastify ni de SQLite. Recibe `LlmProvider` y `Persistence` inyectados, y por eso
los tests corren con `FakeProvider` y `noPersistence`, sin gastar tokens ni tocar
disco. Ver [[Invariantes de arquitectura]].

## Flujo completo de una corrida

```mermaid
sequenceDiagram
  actor P as Persona
  participant W as apps/web
  participant S as apps/server
  participant O as Orchestrator
  participant L as agent loop
  participant M as LlmProvider
  participant T as Herramienta

  P->>W: encargo (objective)
  W->>S: POST /api/runs
  S->>O: crear corrida + RunState
  W->>S: GET /api/runs/:id/stream (SSE)

  loop cada tick
    O->>O: elegir roles con trabajo pendiente
    O-->>S: tick.start
    par turnos en paralelo (AGENT_CONCURRENCY)
      O->>L: runAgentTurn(rol)
      L->>L: drainInbox + listTasks
      L-->>S: tool.selection
      loop hasta maxTurns o sin tool calls
        L-->>S: agent.thinking
        L->>M: chat(mensajes, herramientas)
        M-->>L: texto y/o tool calls
        L-->>S: tool.start
        L->>T: ejecutar
        T-->>L: resultado
        L-->>S: tool.end
      end
      L-->>S: agent.turn_end (en finally)
    end
    O-->>S: tick.end
  end

  S->>S: persistir eventos
  S-->>W: reemitir por SSE
  W->>W: derivar estado (sin polling)
  O-->>P: entregable + archivos en data/exports/
```

## Los cinco paquetes

| Paquete | Responsabilidad | Detalle |
|---|---|---|
| `packages/shared` | modelo de dominio en Zod + catálogo de eventos | [[Modelo de dominio]], [[Referencia de eventos]] |
| `packages/llm` | interfaz `LlmProvider`, adaptadores, tiers, ledger | [[Capa LLM y tiers]] |
| `packages/tools` | registro de herramientas, puente MCP, tool router, habilidades | [[Herramientas y tool router]] |
| `packages/engine` | agent loop, estado de corrida, scheduler, bus de eventos | [[Motor de agentes]], [[Scheduler y ciclo de una corrida]] |
| `apps/server` | Fastify: REST + SSE + SQLite + directorio de salida + misiones | [[API HTTP y SSE]], [[Persistencia y esquema SQL]] |
| `apps/web` | React 19 + Vite + Tailwind v4 + React Flow + TanStack Query | [[Frontend web]] |

Ver [[Mapa del monorepo]] para el detalle archivo por archivo.

## Los dos niveles de "lo que está vivo"

`apps/server/src/runtime.ts` sostiene dos cosas con vidas distintas:

- **Runtime de empresa** (`CompanyRuntime`): vive mientras el servidor esté
  arriba. Sostiene las conexiones MCP y el registro de herramientas — por eso el
  MCP Hub muestra servidores conectados aunque no haya ninguna corrida.
- **Corrida activa** (`ActiveRun`): efímera, se apoya en el runtime de empresa.
  No sobrevive a un reinicio.

> [!warning] `active.run` queda viejo
> El estado autoritativo de una corrida es `orchestrator.snapshot`, no
> `active.run`: este último no se actualiza al pausar o detener. Ver
> [[Trampas conocidas]].

## Frontera de datos

```mermaid
graph LR
  Z["Zod<br/>packages/shared/src/schema.ts"] --> SRV["servidor:<br/>valida entrada"]
  Z --> WEB["frontend:<br/>infiere tipos"]
  Z --> BP["blueprint JSON:<br/>exporta / importa"]
```

Un campo nuevo se agrega **primero** en `schema.ts`. Los dos lados infieren de
ahí, así que no hay un tipo de request duplicado que se pueda desincronizar.

## Enlaces

- [[Invariantes de arquitectura]] — las reglas que no se rompen
- [[Decisiones de arquitectura]] — por qué es así y no de otra forma
- [[Trampas conocidas]] — lo que ya salió mal
