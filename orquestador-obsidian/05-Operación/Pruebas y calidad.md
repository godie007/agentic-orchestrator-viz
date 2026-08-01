---
tags: [operación]
aliases: [Tests, Calidad, Vitest]
---

# Pruebas y calidad

## `typecheck` es la puerta de calidad

**No hay linter.** `tsconfig.base.json` usa:

| Flag | Qué atrapa |
|---|---|
| `strict` | lo de siempre |
| `noUncheckedIndexedAccess` | `array[0]` es `T \| undefined`, no `T` |
| `verbatimModuleSyntax` | fuerza `import type` donde corresponde |

```bash
npm run typecheck      # tsc --build
```

## Tests

```bash
npm test               # vitest run (todos los workspaces)
npm run test:watch
npx vitest run packages/engine/src/memory.test.ts
npx vitest run -t "cada mensaje queda atribuido"
```

## Qué está cubierto

| Archivo | Qué verifica |
|---|---|
| `packages/engine/src/memory.test.ts` | memoria: siembra, agrupación por tema, inyección en el prompt, deduplicación, supervivencia a la corrida (23 tests) |
| `packages/engine/src/scheduler.test.ts` | el tick, los cortes, y **el test de regresión de atribución con 4 agentes concurrentes** |
| `packages/engine/src/loop.test.ts` | el agent loop: iteraciones, tool calls, presión de cierre, cortes |
| `packages/engine/src/state.test.ts` | bandejas, tareas, `forActor` |
| `packages/engine/src/roles.test.ts` | jerarquía y validación |
| `packages/tools/src/coordination.test.ts` | las 20 herramientas de coordinación, incluidas las guardias |
| `packages/tools/src/router.test.ts` | que coordinación y habilidades **no compitan** por los lugares del ranking |
| `packages/tools/src/skills/skills.test.ts` | registro de habilidades y exportación |
| `packages/tools/src/skills/guion.test.ts` | parseo del guion: escenas, diálogo, íconos, imágenes |
| `packages/tools/src/skills/permisos.test.ts` | `puedeBorrar` por nivel de autoridad |
| `packages/tools/src/skills/gate.test.ts` | `revisarCalidad` de `write_artifact` |
| `packages/tools/src/calculo.test.ts` · `busqueda.test.ts` | cálculo y búsqueda |
| `packages/shared/src/programacion.test.ts` | el próximo disparo: estrictamente posterior, cron inválido → `null`, OR en cron |
| `packages/llm/src/ledger.test.ts` | costo acumulado y corte por presupuesto |
| `apps/server/src/db.test.ts` | el `Store`: en particular que borrar una corrida **no** se lleve entregables |
| `apps/server/src/exports.test.ts` | `ExportStore`: saneo de rutas, procedencia, publicar |

## Por qué los tests no gastan tokens

`packages/engine` recibe `LlmProvider` y `Persistence` **inyectados**
(`testing/fake-provider.ts` y `noPersistence`). Ver
[[ADR-003 Motor desacoplado del servidor]].

Lo mismo con el tiempo: la fecha entra formateada desde el llamador, así que los
tests de render y de prompt son deterministas.

## Los tests que existen por un bug

Estos no son cobertura genérica: cada uno vigila un bug que ya pasó.

| Test | Bug que vigila |
|---|---|
| atribución con 4 agentes concurrentes | actor mutable en `RunState`: los mensajes quedaban firmados por el rol equivocado |
| router: `export_pdf` sigue expuesta | las de coordinación competían por los lugares y un agente perdía su propia habilidad |
| `db.test.ts`: borrar corrida conserva artefactos | limpiar la lista de corridas le costaba a la empresa su trabajo |
| `programacion.test.ts`: estrictamente posterior | una misión recién corrida se redisparaba en el mismo minuto, para siempre |
| `guion.test.ts`: diálogo en un solo párrafo | las cuatro intervenciones las decía de corrido el primero que habló |

Ver [[Trampas conocidas]].

## Antes de un commit

```bash
npm run typecheck && npm test
```

No hay hook que lo fuerce. Ver [[Guía de contribución]].

## Lo que no está cubierto por tests

- Una corrida completa contra un **LLM de pago real**. Ver
  [[Estado del producto]].
- El render final de video (se testea el parseo del guion, no el `.mp4`).
- La UI: no hay tests de componente.

## Enlaces

- [[Comandos]]
- [[Guía de contribución]]
- [[Trampas conocidas]]
