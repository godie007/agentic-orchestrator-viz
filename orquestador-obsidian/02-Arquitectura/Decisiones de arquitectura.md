---
tags: [arquitectura, adr, moc]
aliases: [ADR, Decisiones]
---

# Decisiones de arquitectura

Cada ADR registra **qué se decidió, contra qué alternativa, y qué se resignó**.
Una decisión sin su costo no se puede revisar más adelante.

| # | Decisión | Estado |
|---|---|---|
| [[ADR-001 No usar Claude Agent SDK]] | agent loop propio detrás de `LlmProvider`; compara las **cuatro** formas de construir un agente | aceptada · revisada |
| [[ADR-002 Zod como única fuente de verdad]] | el dominio se define una vez y ambos lados infieren | aceptada |
| [[ADR-003 Motor desacoplado del servidor]] | `packages/engine` no importa Fastify ni SQLite | aceptada |
| [[ADR-004 Bandas de precio disjuntas]] | los tiers tienen piso y techo | aceptada |
| [[ADR-005 Las habilidades trabajan sobre entregables ya escritos]] | reciben una `key`, nunca el contenido | aceptada |
| [[ADR-006 Video en una sola pasada de ffmpeg]] | sin navegador headless, sin clips intermedios | aceptada |
| [[ADR-007 Correo por webhook de n8n]] | el orquestador no habla SMTP | aceptada |
| [[ADR-008 Publicar lo decide una persona]] | `publicar` no es una herramienta de agente | aceptada |

## Plantilla

```markdown
---
tags: [adr]
---

# ADR-00N Título en una línea

**Estado:** propuesta | aceptada | reemplazada por [[ADR-00M ...]]

## Contexto
Qué situación obligaba a decidir.

## Decisión
Qué se hizo, en imperativo.

## Alternativas consideradas
Qué más se evaluó y por qué no.

## Consecuencias
### A favor
### En contra / lo que se resignó
### Cómo se revisaría
```

Ver [[Convenciones de documentación]].
