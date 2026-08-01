---
tags: [producto]
aliases: [Estado, Madurez]
---

# Estado del producto

Versión `0.1.0`, privado, monorepo npm. Node ≥ 22.

## Verificado funcionando

- **Memoria de la empresa**: se siembra, se agrupa por tema, entra en el prompt,
  se deduplica y sobrevive a la corrida. Cubierto por tests sin gastar tokens
  (`packages/engine/src/memory.test.ts`). Ver [[Memoria de la empresa]].
- **Presión de cierre** en los tres tramos (holgado / poco margen / cerrá ahora),
  con el presupuesto mandando sobre los ciclos.
- **Atribución de autoría con turnos en paralelo**: test de regresión con 4
  agentes concurrentes (`packages/engine/src/scheduler.test.ts`).
- **Corrida completa con modelos gratuitos, costo US$0.00**: 4 ciclos, 8
  mensajes, 4 tareas y un entregable que **cita la memoria sembrada**.
- **Tolerancia a fallos del proveedor**: un agente que falla pierde el turno y
  queda registrado; el resto de la empresa sigue.
- **Catálogo vivo de OpenRouter** (343 modelos) con resolución de los tiers a
  precios reales. Ver [[Capa LLM y tiers]].
- **Dos servidores MCP conectados** (`filesystem` y `memory`), 23 herramientas
  descubiertas, telemetría de estado e invocaciones, probador manual.
- **Coordinación real entre agentes**: un encargo descompuesto y delegado a
  cuatro direcciones que a su vez se coordinaron entre sí (16 mensajes en 2
  ciclos).
- **Tope de presupuesto** cortando la corrida, con el motivo visible en la UI.
- **Jerarquía y validación de argumentos** cubiertas por tests.
- **Producción audiovisual**: video, deck, íconos, visuales, música y narración,
  con tests de parseo de guion y de export (`packages/tools/src/skills/`).

## Pendiente de verificar de punta a punta

Una corrida completa hasta el entregable final **con modelos pagos reales**. La
cuenta de OpenRouter usada quedó sin crédito (saldo negativo), así que la
memoria y la presión de cierre están verificadas de forma determinista con un
proveedor falso, pero no observadas contra un LLM de pago. Con crédito y los
roles coordinadores en `standard`, debería completarse.

> [!warning] Cuenta sin crédito
> Con saldo negativo, el cupo gratuito de OpenRouter sólo tolera pedidos
> triviales: un turno de agente real (miles de tokens de entrada) recibe **402 a
> todo**, y eso se ve como una corrida que muere en el tercer ciclo sin producir
> nada. Corré `npm run check:llm` antes de una corrida larga. Ver
> [[Diagnóstico de problemas]].

## Fuera de alcance en esta versión

- Multiusuario y autenticación de la propia herramienta.
- Despliegue en producción.
- Acceso directo a filesystem o shell para los agentes — entra por
  [[Integración MCP|MCP]] y queda visible en el Hub.

## Limitaciones conocidas

| Limitación | Consecuencia práctica |
|---|---|
| Las corridas no sobreviven al reinicio del servidor | podés leer y reproducir una corrida vieja, pero no continuarla |
| El tope de gasto se evalúa **antes** de cada turno, no durante | una sola llamada cara puede pasarse del tope antes de que se detecte; configurá también un límite en el proveedor |
| No hay migraciones versionadas | el esquema es idempotente y lo aplica el constructor de `Store`; ver [[Base de datos]] |
| No hay linter | `npm run typecheck` es la puerta de calidad; ver [[Pruebas y calidad]] |
| `data/musica/` viene vacía | los videos salen en silencio hasta que dejes pistas; `npm run musica:cama` sintetiza dos para arrancar |

## Aviso de seguridad abierto

`npm audit` reporta `GHSA-frvp-7c67-39w9` sobre `@hono/node-server`, arrastrado
por el SDK de MCP. **No es alcanzable** —el proyecto importa exclusivamente el
lado cliente— y forzar el override de major puede romper el SDK. La nota
completa está en `package.json → auditNotes`. Ver [[Seguridad]].

## Enlaces

- [[Hoja de ruta]] — lo próximo
- [[Trampas conocidas]] — lo que ya costó caro
- [[Pruebas y calidad]] — cómo se verifica
