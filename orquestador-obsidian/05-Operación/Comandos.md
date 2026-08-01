---
tags: [operación, referencia]
aliases: [Scripts, npm run, CLI]
---

# Comandos

Todos desde la raíz del monorepo.

## Desarrollo

```bash
npm run dev            # servidor :3001 + UI :5173 (concurrently)
npm run dev:server     # solo Fastify, con tsx watch
npm run dev:web        # solo Vite
npm run build          # solo afecta a apps/ — los packages no se compilan
```

## Calidad

```bash
npm run typecheck      # tsc --build — LA verificación principal
npm test               # vitest run (todos los workspaces)
npm run test:watch
```

**No hay linter.** `typecheck` es la puerta de calidad: `tsconfig.base.json` usa
`strict` más `noUncheckedIndexedAccess` y `verbatimModuleSyntax`.

Un solo archivo o un solo caso:

```bash
npx vitest run packages/engine/src/memory.test.ts
npx vitest run -t "cada mensaje queda atribuido"
```

Ver [[Pruebas y calidad]].

## Base de datos

```bash
npm run db:migrate     # aplica el esquema y lista las tablas con sus filas
npm run db:seed        # empresa de ejemplo "Codytion S.A."
npm run db:estudio     # el estudio audiovisual: 4 roles, un video
```

`db:migrate` no es una migración versionada: el esquema es idempotente y lo
aplica solo el constructor de `Store`. Sirve para crear o inspeccionar la base
sin levantar el servidor. Ver [[Base de datos]].

```bash
ORQ_SEED_TIER=standard npm run db:estudio   # con modelos pagos
```

## Verificación del proveedor

```bash
npm run check:models                  # qué modelo resuelve cada tier, con precio real
npm run check:llm                     # una llamada real con tool-calling, por proveedor
npm run check:llm -- --model=<slug>   # uno puntual
```

> [!warning] Vale la pena antes de una corrida larga
> Una cuenta sin crédito contesta **402 a todo**, y eso se ve como una corrida
> que muere en el tercer ciclo sin producir nada.

## Producción audiovisual

```bash
npm run musica:cama    # genera dos camas propias en data/musica
```

Una en modo menor para institucional, otra en modo mayor **con pulso** para
campañas. Ver [[Música y narración]].

## Diagnóstico

```bash
lsof -ti:3001 | xargs kill -9    # un proceso viejo tomando el puerto
```

`pkill -f` no siempre alcanza. Ver [[Diagnóstico de problemas]].

## Tabla completa

| Comando | Workspace | Qué hace |
|---|---|---|
| `dev` | raíz | servidor + UI |
| `dev:server` | `@orq/server` | Fastify con watch |
| `dev:web` | `@orq/web` | Vite |
| `build` | `apps/*` | compila las apps |
| `typecheck` | raíz | `tsc --build` |
| `test` / `test:watch` | raíz | vitest |
| `db:migrate` | `@orq/server` | esquema + listado |
| `db:seed` | `@orq/server` | Codytion S.A. |
| `db:estudio` | raíz (tsx) | Estudio Codytion |
| `musica:cama` | raíz (tsx) | camas musicales |
| `check:llm` | raíz (tsx) | llamada real |
| `check:models` | raíz (tsx) | catálogo y tiers |

Los scripts con `tsx --env-file-if-exists=.env` leen el `.env` solos.

## Enlaces

- [[Instalación y arranque]]
- [[Pruebas y calidad]]
- [[Base de datos]]
