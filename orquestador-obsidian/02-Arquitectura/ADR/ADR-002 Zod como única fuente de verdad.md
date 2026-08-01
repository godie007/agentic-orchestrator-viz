---
tags: [adr, arquitectura]
---

# ADR-002 Zod como única fuente de verdad

**Estado:** aceptada

## Contexto

Un monorepo con servidor y frontend en TypeScript tiene tres lugares donde el
mismo dato puede divergir: el tipo del servidor, el tipo del cliente y la
validación de entrada. Además, una empresa tiene que ser **exportable a JSON**
para versionarla en git e importarla en otra instalación.

## Decisión

`packages/shared/src/schema.ts` define el dominio **entero** en Zod. El servidor
valida contra esos esquemas, el frontend infiere sus tipos de ahí, y
`CompanyBlueprint` es la empresa completa serializable.

**Un campo nuevo se agrega ahí primero.**

Lo mismo con la traza: `packages/shared/src/events.ts` define `TraceEvent` como
unión discriminada, con un helper `isEvent()` para estrecharla.

## Alternativas consideradas

**Tipos de TypeScript a secas, con validación aparte.** Rechazada: la validación
se desincroniza del tipo en el primer cambio, y no hay forma de detectarlo
—TypeScript no comprueba que un `z.object` corresponda a una `interface`.

**Un esquema por capa (DTO del servidor, modelo del cliente).** Rechazada: es el
costo de mantenimiento que se buscaba evitar, y en un sistema de un solo usuario
no compra nada.

## Consecuencias

### A favor
- Imposible que el tipo del cliente y la validación del servidor difieran.
- Los defaults viven en el esquema (`.default(...)`), así que un blueprint viejo
  al que le falta un campo nuevo se importa igual.
- El `inputSchema` de una herramienta es JSON Schema y va directo al modelo.
- Las restricciones del dominio quedan documentadas donde se leen: `body` hasta
  50.000 caracteres, `content` hasta 500.000, `maxTurns` entre 1 y 50.

### En contra / lo que se resignó
- Todo cambio de dominio toca un archivo compartido, y `schema.ts` es largo
  (~640 líneas).
- Zod cuesta algo en tiempo de validación en cada request. Irrelevante a esta
  escala.

### Cómo se revisaría
No se revisaría: es el invariante más barato de sostener del proyecto. Ver
[[Invariantes de arquitectura]] §1.
