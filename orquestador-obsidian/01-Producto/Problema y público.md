---
tags: [producto]
aliases: [Para quién es, Público]
---

# Problema y público

## El problema

Automatizar trabajo de conocimiento con un solo agente choca contra tres muros:

1. **El contexto.** Un agente que tiene que vender, estimar, calcular margen y
   redactar termina con un prompt de sistema imposible y decisiones mezcladas.
2. **El costo.** Si todo pasa por un modelo caro, tareas rutinarias (triage de
   bandeja, formateo, resumen) se pagan a precio de decisión ejecutiva.
3. **La opacidad.** Cuando algo sale mal, no hay forma de ver *dónde* salió mal:
   el resultado es un bloque de texto sin trazabilidad.

Y hay un cuarto muro, más caro que los tres: **el resultado no es un archivo**.
Un párrafo bien escrito no se manda a un cliente; una propuesta en Word con
portada, tablas y numeración sí.

## Cómo lo aborda este producto

| Muro | Respuesta |
|---|---|
| Contexto | un rol = un agente con prompt acotado, bandeja propia y herramientas asignadas ([[Modelo de dominio]]) |
| Costo | modelo **por rol**: `cheap` para ejecutores, `smart` para quien decide ([[Capa LLM y tiers]]) |
| Opacidad | un evento por paso, timeline con replay, y `check_activity` para auditar lo que un agente **hizo**, no lo que contó ([[Observabilidad y trazas]]) |
| Resultado | habilidades que producen archivos reales sobre un directorio propio ([[Habilidades de producción]]) |

## Para quién es

**Consultoras y equipos que producen entregables repetibles.** Propuestas
comerciales, informes, piezas de marketing, material institucional. El caso que
está sembrado en el repo es exactamente ese: ver [[Empresas de ejemplo]].

**Quien quiere entender cómo se comporta un sistema multiagente antes de
construirlo.** El valor acá es la observabilidad: podés ver un livelock, un
agente que informa mal, o un modelo barato que se va por las ramas — y medirlo,
no intuirlo. Varios de los [[Trampas conocidas|comportamientos documentados]]
salieron de mirar corridas reales.

**Quien necesita producción audiovisual programada.** Una [[Misiones programadas|misión]]
semanal que arma el guion, lo revisa, filma el video, arma el deck y te avisa por
correo para que lo revises antes de publicar. Ver [[Casos de uso]].

## Para quién NO es

- **Producción multiusuario.** No hay autenticación de la herramienta ni
  aislamiento entre usuarios. Ver [[Estado del producto]].
- **Agentes con acceso a shell o filesystem del host.** Eso entra por
  [[Integración MCP|MCP]] y queda visible en el Hub como cualquier otra conexión.
  El directorio de salida de la empresa está saneado segmento por segmento.
- **Cargas de trabajo grandes.** Es un proceso local con SQLite y estado vivo en
  memoria: las corridas no sobreviven a un reinicio del servidor.

## El costo real de usarlo

Una corrida completa de 4 ciclos con modelos gratuitos produjo un entregable
coherente por **US$0.00**. Con modelos pagos, el orden de magnitud depende del
tier de cada rol; el tope por corrida (`DEFAULT_RUN_BUDGET_USD`, por defecto 1
USD) es la red de contención. Ver [[Costos y presupuesto]].

El gasto que más sorprende no es el de salida: es el de **entrada**. Un memo de
lecturas mal calculado hizo que el mismo entregable de 40k caracteres entrara
once veces al contexto — 534k tokens de entrada para 2k de salida. Ver
[[Trampas conocidas]].
