---
tags: [contribuir]
aliases: [Contribuir, Cómo trabajar en esto]
---

# Guía de contribución

## Antes de escribir una línea

Leé, en este orden:

1. [[Invariantes de arquitectura]] — las reglas que no se rompen
2. [[Trampas conocidas]] — lo que ya costó caro
3. La nota de arquitectura del área que vas a tocar

## Idioma

**Español rioplatense** en el código, los comentarios y la UI. Un comentario
nuevo en inglés desentona con todo lo que lo rodea.

Los comentarios explican **por qué**, no qué. El código ya dice qué hace; lo que
no dice es qué pasó cuando se hizo de la otra forma. La mayoría de los
comentarios largos del repo son eso: el registro de un bug que costó caro.

## Calidad

```bash
npm run typecheck && npm test
```

**No hay linter** y no hay hook que lo fuerce. `typecheck` es la puerta:
`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`. Ver
[[Pruebas y calidad]].

## Reglas de estructura

| Regla | Por qué |
|---|---|
| Un campo nuevo entra **primero** en `packages/shared/src/schema.ts` | ambos lados infieren de ahí |
| Un paso nuevo **emite un evento** | un paso sin evento es invisible |
| `packages/engine` **no importa** Fastify ni SQLite | los tests corren sin tokens ni disco |
| Los `packages/` **no se compilan** | no agregues un paso de build sin necesidad real |
| Toda llamada de red **lleva corte por tiempo** | un endpoint mudo cuelga la corrida entera |
| Los secretos de MCP van **por referencia** | un blueprint exportado no puede llevar credenciales |

## Cuándo hace falta un test

Siempre que arregles un bug de comportamiento. Los tests del repo no son
cobertura genérica: **cada uno vigila un bug que ya pasó**. Ver la tabla en
[[Pruebas y calidad]].

Si el bug era de concurrencia, el test tiene que reproducirlo con concurrencia —
el de atribución usa 4 agentes en paralelo.

## Cuándo hace falta un ADR

Cuando la decisión:

- cierra una puerta (descarta una alternativa razonable),
- tiene un costo que alguien va a querer revisar más adelante,
- o contradice lo obvio.

Plantilla y lista en [[Decisiones de arquitectura]].

## Cuándo actualizar esta bóveda

| Cambiaste… | Actualizá |
|---|---|
| `schema.ts` | [[Modelo de dominio]] y [[Referencia de esquemas]] |
| `events.ts` | [[Referencia de eventos]] y [[Observabilidad y trazas]] |
| `routes.ts` | [[Referencia de API]] |
| una herramienta | [[Catálogo de herramientas]] y [[Referencia de herramientas]] |
| una variable de entorno | [[Variables de entorno]] |
| encontraste un bug caro | [[Trampas conocidas]] y [[Diagnóstico de problemas]] |
| una decisión de diseño | un ADR nuevo |

Ver [[Convenciones de documentación]].

## Los tres archivos de documentación del repo

| Archivo | Para quién |
|---|---|
| `README.md` | quien evalúa el producto |
| `CLAUDE.md` | agentes de código que trabajan sobre el repo |
| `orquestador-obsidian/` | esta bóveda: producto, arquitectura, operación |

Cuando haya conflicto, **manda el código**.

## Git

```bash
git checkout -b <rama>     # no trabajes sobre main
npm run typecheck && npm test
```

Mensajes de commit en español, explicando el **por qué** del cambio cuando no es
obvio.

## Cómo agregar cosas

- [[Cómo agregar un proveedor LLM]]
- [[Cómo agregar una herramienta]]
- [[Cómo agregar un evento]]

## Lo que NO hay que hacer

- Agregar un paso de build a un `package/`.
- "Arreglar" el aviso de `npm audit` sin leer `package.json → auditNotes`.
- Introducir estado mutable por turno en `RunState`.
- Presentar las herramientas de coordinación como si se pudieran quitar.
- Poner un reloj adentro del motor o del render.
- Usar `cheap` para un rol que coordina.
