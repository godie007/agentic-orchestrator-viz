---
tags: [adr, arquitectura]
---

# ADR-003 Motor desacoplado del servidor

**Estado:** aceptada

## Contexto

El motor de agentes es la parte que hay que testear más y la que más caro sale
testear mal: cada corrida de prueba contra un LLM real cuesta tokens, tarda, y no
es determinista.

## Decisión

`packages/engine` depende **sólo** de `@orq/llm`, `@orq/tools` y `@orq/shared`.
No importa Fastify ni `better-sqlite3`. Recibe `LlmProvider` y `Persistence`
inyectados.

Dos piezas hacen que eso rinda:

- `packages/engine/src/testing/fake-provider.ts` — un `LlmProvider` con
  respuestas guionadas.
- `noPersistence` — una `Persistence` que no toca disco.

La misma idea se repite en los bordes: `packages/tools` recibe `SkillStorage` y
`resolverImagen` del servidor, así que **no decide dónde van los archivos ni lee
el disco**.

## Alternativas consideradas

**El motor consultando SQLite directamente.** Rechazada: cada test necesitaría
una base, y la frontera entre "estado de la corrida" y "lo que se guarda" se
volvería difusa — que es justo la frontera que permite decir que las corridas no
sobreviven al reinicio pero la traza sí.

**Mocks de Fastify y SQLite en los tests.** Rechazada: un mock de una dependencia
que no debería estar ahí resuelve el síntoma y deja el acoplamiento.

## Consecuencias

### A favor
- La suite del motor corre **sin gastar tokens ni tocar disco**: memoria (23
  tests), presión de cierre, atribución de autoría con 4 agentes concurrentes,
  jerarquía y validación de argumentos.
- Cambiar de proveedor LLM no toca el motor.
- Los tests son deterministas, lo que hace que un test de regresión sobre un bug
  de concurrencia tenga sentido.

### En contra / lo que se resignó
- Hay que **inyectar todo lo que el motor no puede saber**: la fecha de hoy
  (`TurnDeps.fechaHoy`, `OrchestratorDeps.fechaHoy`), el almacenamiento, la
  persistencia, el resolutor de imágenes. Es más ceremonia en cada llamada.
- Los tests de integración de punta a punta viven en `apps/server`, no acá.

### Nota sobre la fecha
Que el motor no tenga reloj no es sólo higiene de tests: `fechaHoy` es una
**función** en `OrchestratorDeps` porque una corrida puede cruzar la medianoche, y
un valor entra formateado en `TurnDeps` para el prompt del turno. Sin eso el
agente no sabe en qué año vive. Ver [[Motor de agentes]].
