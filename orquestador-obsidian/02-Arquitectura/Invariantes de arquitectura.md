---
tags: [arquitectura]
aliases: [Invariantes, Reglas]
---

# Invariantes de arquitectura

Las reglas que no se ven leyendo un solo archivo. Romper cualquiera de estas
produce un bug que cuesta caro encontrar — la mayoría están acá porque ya pasó.

---

## 1. Zod es la única fuente de verdad

`packages/shared/src/schema.ts` define el dominio y ambos lados infieren los
tipos. **Un campo nuevo se agrega ahí primero.**

Ver [[ADR-002 Zod como única fuente de verdad]].

## 2. El motor no conoce al servidor

`packages/engine` depende sólo de `@orq/llm`, `@orq/tools` y `@orq/shared` — ni
Fastify ni SQLite. Recibe `LlmProvider` y `Persistence` inyectados.

**Por qué importa:** los tests corren con `FakeProvider` y `noPersistence`, sin
gastar tokens ni tocar disco. Mantené esa frontera.

Ver [[ADR-003 Motor desacoplado del servidor]].

## 3. El actor se ata por turno, no se guarda

`RunState.forActor(actorId)` devuelve un `AgentWorkspace` con el actor capturado
en el closure.

> [!danger] Bug histórico
> Con el actor en un campo mutable y turnos en paralelo, un agente pisaba al otro
> y los mensajes quedaban firmados por el rol equivocado. **Nunca introduzcas
> estado mutable por turno en `RunState`.** Hay un test de regresión con 4
> agentes concurrentes en `packages/engine/src/scheduler.test.ts`.

## 4. Todo lo que pasa tiene que emitir un evento

El motor emite a `EventBus`, el servidor persiste y reemite por SSE, y la UI
deriva su estado de la traza. Un paso que no emite evento es un paso invisible:
agregá la variante en `packages/shared/src/events.ts`.

Ver [[Observabilidad y trazas]] y [[Cómo agregar un evento]].

## 5. `agent.turn_end` se emite en `finally`

Si un turno falla y no lo emite, el nodo del organigrama queda "pensando…" para
siempre.

## 6. Las herramientas de coordinación se otorgan siempre

`packages/tools/src/registry.ts` → `forRole` las expone sin mirar `role.toolIds`.
`toolIds` sólo controla `capability`, `skill` y `mcp`.

Si tocás la UI de asignación, **no las presentes como si se pudieran quitar**.

## 7. Una habilidad no se otorga sola

Al revés que la anterior: `origin: "skill"` y `origin: "capability"` dependen de
`toolIds`. Si armás una empresa por código, registrá también las habilidades en
la tabla `tools` — o vas a ver a un agente explicando que no encuentra
`export_video`.

## 8. El router acota las opcionales, no el total

Coordinación y habilidades se exponen siempre y **no compiten** por los lugares
del ranking.

> [!danger] Bug histórico
> Cuando sí competían, 15 herramientas de coordinación dejaban 5 lugares para 20
> herramientas, y un agente al que se le pidió un PDF se quedaba sin su propia
> `export_pdf` frente a tools de MCP.

Ver [[Herramientas y tool router]].

## 9. Las habilidades reciben una clave, nunca el contenido

Un documento largo pasado como argumento se trunca cuando el modelo agota
`max_tokens` a mitad del JSON, y perdés el documento entero. El agente guarda con
`write_artifact` y después pasa la `key`.

Ver [[ADR-005 Las habilidades trabajan sobre entregables ya escritos]].

## 10. Las bandas de precio de los tiers son disjuntas

Sin piso, `standard` y `smart` resuelven al mismo modelo. Sin techo, `smart`
elige algo de US$60/MTok y un turno se come el presupuesto.

Ver [[ADR-004 Bandas de precio disjuntas]].

## 11. Un tick de retardo es deliberado

Lo que un agente emite entra a las bandejas del ciclo *siguiente*. Modela que
nadie contesta en el mismo instante y evita ida y vuelta infinito dentro de un
tick.

## 12. Los entregables sobreviven a que se borre su corrida

`artifacts.company_id` existe para eso, y `listArtifactsByCompany` filtra por ahí
en vez de unir con `runs`. `deleteRun` se lleva eventos, mensajes, tareas,
aprobaciones y ledger —el registro de *cómo* se llegó— pero **nunca** los
artefactos.

## 13. Toda llamada de red que salga de una herramienta lleva corte por tiempo

Un endpoint que acepta la conexión y se queda callado deja el turno esperando
para siempre: el agente no falla, no sigue, y no se le puede pedir que cambie de
enfoque. Medido con el endpoint de imágenes de NVIDIA
(`packages/tools/src/skills/imagenes.ts` → `CORTE_MS`).

## 14. `packages/tools` no decide dónde van los archivos

El `SkillStorage` lo inyecta el servidor. Y `packages/tools` **no lee el disco**:
recibe `resolverImagen`, que es quien sanea la ruta que propuso un modelo.

## 15. Los secretos de MCP se guardan por referencia

La config almacena el **nombre** de la variable de entorno, nunca el valor, para
que una empresa exportada a JSON no lleve credenciales. Mantené esa regla al
agregar campos de configuración MCP.

## 16. Los `packages/` no se compilan

Su `exports` apunta directo a `./src/index.ts` y los consumen tsx y Vite.
`npm run build` sólo afecta a `apps/`. **No agregues un paso de build a un
package sin necesidad real.**

## 17. Un archivo por entregable y formato, no uno por versión

`key.pdf`, no `key-v3.pdf`. La versión va en la portada, y al exportar se borran
los `key-vN.ext` que dejó la forma vieja.

## 18. El render de documentos no tiene reloj

La fecha entra **formateada desde el llamador** (`DocumentMeta`, `TurnDeps.fechaHoy`).
Así los tests son deterministas — y el agente sabe en qué año vive, que no es un
detalle: un auditor sin fecha marcó como typo una fecha correcta y el corrector
le hizo caso.

---

## Checklist antes de un cambio grande

- [ ] ¿Agregué el campo en `schema.ts` primero?
- [ ] ¿El motor sigue sin importar Fastify ni SQLite?
- [ ] ¿Introduje estado mutable por turno en `RunState`?
- [ ] ¿El paso nuevo emite un evento?
- [ ] ¿La llamada de red nueva tiene corte por tiempo?
- [ ] ¿`npm run typecheck` y `npm test` pasan?

Ver [[Guía de contribución]] y [[Trampas conocidas]].
