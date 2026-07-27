# Orquestador Agéntico

Herramienta para **modelar una empresa completa con agentes LLM y verla operar**.
Configurás departamentos, roles, herramientas y políticas; le das un encargo; y
mirás cómo los agentes se escriben entre sí, delegan, escalan, piden aprobación y
producen entregables — con el costo a la vista y un tope que corta solo.

Corre local, un solo usuario, sin infraestructura externa más allá del proveedor
LLM y los servidores MCP que conectes.

---

## Arranque rápido

```bash
npm install
cp .env.example .env          # completá al menos una API key
npm run db:seed               # crea la empresa de ejemplo "Codytion S.A."
npm run dev                   # servidor :3001 + UI :5173
```

Abrí <http://localhost:5173>. El **MCP Hub** ya muestra dos servidores MCP
conectados; en **Proceso en vivo** le das un encargo a la empresa y arranca.

Verificaciones sin levantar la UI:

```bash
npm run check:models    # qué modelo resuelve cada tier, con precio real
npm run check:llm       # una llamada real con tool-calling, por proveedor
npm test                # tests del motor y de las herramientas
```

---

## Las dos pantallas que importan

**Proceso en vivo.** El organigrama es el escenario: los nodos pulsan mientras el
agente piensa y muestran qué herramienta está ejecutando; las aristas se animan
cuando un mensaje viaja. Al costado, el feed de actividad, los hilos de
mensajería, el tablero de tareas, los entregables y las aprobaciones pendientes.
Abajo, un timeline que retrocede y **reproduce la corrida** desde la traza
guardada. Podés inyectarle un mensaje a cualquier agente en cualquier momento.

**MCP Hub.** Cada servidor con su semáforo, latencia de handshake, herramientas
descubiertas, invocaciones y errores. La matriz *Quién usa qué* es también el
editor de accesos: un clic le da o le quita a un agente todas las herramientas de
un servidor. Y un probador manual para ejecutar una tool y ver qué devuelve sin
arrancar la empresa.

---

## Cómo está armado

```
packages/
  shared/   modelo de dominio en Zod — única fuente de verdad
  llm/      interfaz LlmProvider + adaptadores intercambiables
  tools/    registro de herramientas, puente MCP, tool router
  engine/   agent loop, bus de mensajes, scheduler, bus de eventos
apps/
  server/   Fastify: REST + SSE + SQLite
  web/      React + Vite: las pantallas
```

`packages/engine` no importa Fastify ni SQLite: recibe un `LlmProvider` y una
`Persistence` inyectados. Por eso los tests lo corren con un proveedor falso y
sin base de datos, y por eso cambiar de proveedor no toca el motor.

### Multi-LLM

Todo pasa por una interfaz con formato de mensajes neutro propio; cada adaptador
traduce en su borde. Vienen cuatro: **OpenRouter**, **Anthropic**, **OpenAI** y
**Ollama** (local, costo cero). **Cada rol elige su proveedor y su modelo por
separado**, que es lo que permite correr los roles rutinarios barato y pagar solo
donde la decisión lo justifica.

Un rol puede fijar un slug exacto o elegir un *tier*, que se resuelve contra el
catálogo vivo del proveedor —con precios reales, sin slugs hardcodeados—:

| Tier | Banda (USD/MTok mezclado) | Para qué |
|---|---|---|
| `free` | 0 | probar la empresa sin gastar |
| `cheap` | hasta 1 | triage de bandeja, formateo, resúmenes |
| `standard` | 1 – 8 | el día a día de la mayoría de los roles |
| `smart` | 8 – 25 | decisiones ejecutivas, planificación |

Las bandas son disjuntas a propósito: sin piso, `standard` y `smart` colapsan en
el mismo modelo; sin techo, `smart` elige lo más caro del catálogo (hay opciones
a US$60/MTok) y un solo turno se come el presupuesto.

> **Sobre `free`.** Hay 14 modelos gratuitos con tool-calling en OpenRouter y
> funcionan: una corrida completa de 4 ciclos produjo un entregable coherente
> por US$0.00. Pero el cupo gratuito es frágil — 429 y 402 son habituales— así
> que el motor reintenta con backoff y un agente que falla no detiene la
> empresa: pierde el turno y el resto sigue. **Con saldo de cuenta negativo el
> cupo gratuito solo tolera pedidos triviales**; un turno de agente real
> (miles de tokens de entrada) recibe 402. Cualquier recarga lo destraba.
>
> **Ojo con `cheap`.** Elige por precio, y el modelo más barato del catálogo puede
> no servir para coordinar. En una prueba, el CEO con un modelo de US$0.014/MTok
> se fue a descargar PDFs al azar en vez de delegar; el mismo rol con `standard`
> repartió el trabajo a las cuatro direcciones correctamente. **Usá `cheap` para
> ejecutores, no para roles que coordinan.**

### Cómo se comunican los agentes

No comparten contexto. Cada rol tiene bandeja propia y solo sabe lo que le
escriben, igual que en una organización real. Toda la coordinación pasa por
herramientas: `send_message`, `reply`, `assign_task`, `update_task`, `escalate`,
`request_approval`, `write_artifact`, `read_artifact`, `broadcast`.

La jerarquía se valida **en código**, no en el prompt: un agente puede ignorar
una instrucción, pero no puede saltearse el ejecutor de la herramienta. Si un
ejecutor intenta asignarle una tarea a su jefe, la llamada vuelve con el error y
la lista de su equipo real.

Un *tick* es un ciclo de la empresa: se toman los roles con trabajo pendiente,
ejecutan su turno en paralelo acotado, y lo que emiten entra a las bandejas del
ciclo siguiente. Esa demora de un ciclo es deliberada: modela que nadie contesta
en el mismo instante, y evita ida y vuelta infinito dentro de un mismo tick.

Tres modos: **manual** (un ciclo por click, para observar), **continuo** y
**cron** (un ciclo cada N minutos, para simular el ritmo de un negocio).

### Habilidades — que la empresa entregue un archivo, no solo texto

Además de con quién habla y de dónde lee, un rol tiene **habilidades**: lo que
sabe producir. Vienen dos, `export_docx` y `export_pdf`, y se asignan por agente
como cualquier otra herramienta —podés darle PDF a uno y Word a otro—.

Trabajan sobre un entregable ya escrito: el agente guarda el contenido con
`write_artifact` y después pasa su clave. Es deliberado, y no un rodeo: un
documento largo pasado como argumento se trunca cuando el modelo agota
`max_tokens` a mitad del JSON, y perderías el documento entero.

El markdown se respeta —títulos, listas anidadas, tablas, citas, código y
negritas—, y el archivo queda descargable desde la pestaña **Entregables**. Si el
entregable siguió versionándose después de exportarlo, el enlace lo dice: te
avisa que ese Word es de la v1 y el texto ya va por la v5.

### Selección automática de herramientas

El agente elige por function-calling. Con varios MCP conectados el catálogo llega
a decenas de tools, así que por encima de un umbral un router acota el set por
relevancia contra la tarea. La decisión no queda oculta: se emite un evento
`tool.selection` con las candidatas, las expuestas y el motivo, y la UI lo muestra
como *"por qué tenía esta herramienta a mano"*.

### Memoria de la empresa — no volver a pagar por lo mismo

Las corridas son efímeras, pero lo que la empresa **aprende** no: vive a nivel
empresa y sobrevive. Los agentes lo registran con `record_lesson`; vos podés
sembrarlo o corregirlo desde la pestaña **Memoria**.

Lo aprendido se inyecta en el **prompt de sistema** de cada agente, no detrás de
una herramienta. Eso es deliberado: detrás de una tool el agente gastaría un
turno en descubrirla, otro en llamarla, y muchas veces no la llamaría — justo el
consumo que esto busca evitar. En el prompt ya está, cuesta unos cientos de
tokens de entrada y se cachea.

Dos límites para que la memoria no cueste más de lo que ahorra: se deduplica por
tema y texto normalizado (repetir una lección sube su contador en vez de crear
una fila nueva), y se inyectan como mucho 25, las más reafirmadas primero.

Sembrar la memoria antes de la primera corrida es la forma más barata de que la
empresa arranque sabiendo algo — una tarifa, un criterio de estimación, una
preferencia de un tipo de cliente.

### Convergencia — que la empresa cierre en un entregable

Sin presión de cierre, los agentes se piden información entre sí hasta que la
corrida muere por presupuesto sin haber producido nada. Cada turno recibe cuánto
queda de ciclos y de presupuesto: sobre la mitad no dice nada, por debajo pide
dejar de abrir pedidos nuevos, y al final exige producir el entregable con
`write_artifact` aunque esté incompleto, dejando explícito qué falta. Manda el
más apremiante de los dos límites: da igual que sobren ciclos si no queda
presupuesto para ejecutarlos.

### Observabilidad

El motor emite un evento por cada paso (`agent.thinking`, `tool.selection`,
`tool.start`, `mcp.status`, `cost.updated`…). El servidor los persiste y los
reemite por SSE; la UI **no hace polling**. Como el estado se deriva de la traza,
"ver en vivo" y "retroceder en el timeline" son la misma operación con un corte
distinto — por eso el replay muestra exactamente lo que se vio la primera vez.

---

## Seguridad y costos

- **Rotá la API key de OpenRouter que pegaste en el chat.** Quedó en el historial
  de esa conversación. La nueva va en `.env`, que está git-ignored.
- Los secretos de los servidores MCP se guardan **por referencia**: la config
  almacena el nombre de la variable de entorno, no el valor. Una empresa exportada
  a JSON no lleva credenciales adentro.
- `fetch_url` bloquea loopback, rangos privados y link-local, para que un prompt
  no pueda usar a un agente para escanear la red interna del host.
- El tope de gasto corta la corrida, pero **se evalúa antes de cada turno, no
  durante**: una sola llamada cara puede pasarse del tope antes de que se detecte.
  Configurá también un límite en el dashboard de tu proveedor.
- Las herramientas marcadas `requiresApproval` no se ejecutan: abren una
  solicitud y esa rama del trabajo queda detenida hasta que alguien resuelva.

---

## Estado actual

**Verificado funcionando:**

- Memoria de empresa: se siembra, se agrupa por tema, entra en el prompt, se
  deduplica y sobrevive a la corrida (23 tests, sin gastar tokens).
- Presión de cierre en los tres tramos (holgado / poco margen / cerrá ahora),
  con el presupuesto mandando sobre los ciclos.
- Atribución correcta de autoría con turnos en paralelo (test de regresión).
- **Corrida completa con modelos gratuitos, costo US$0.00**: 4 ciclos, 8 mensajes,
  4 tareas y un entregable que **cita la memoria sembrada** — tomó las "900-1200
  horas" y el "plan de migración sin cortar la operación" de las lecciones en
  lugar de re-derivarlas. Es la demostración de que la memoria evita repetir
  consumo.
- Un agente que falla (proveedor saturado) no tumba la corrida: pierde el turno,
  queda registrado y el resto sigue.

- Catálogo vivo de OpenRouter (343 modelos) y resolución de los tres tiers con
  precios reales.
- Llamada real con tool-calling y costo calculado desde el catálogo.
- Dos servidores MCP conectados (`filesystem` y `memory`), 23 herramientas
  descubiertas, telemetría de estado e invocaciones, probador manual.
- Coordinación real entre agentes: el CEO descompuso un encargo y delegó a cuatro
  direcciones, que a su vez se coordinaron entre sí (16 mensajes en 2 ciclos, con
  hilos abiertos y cerrados).
- Tope de presupuesto cortando la corrida, con el motivo visible en la UI.
- Jerarquía y validación de argumentos cubiertas por tests.

**Lo que falta probar de punta a punta:** una corrida completa hasta el entregable
final con modelos reales. La cuenta de OpenRouter usada quedó sin crédito
(saldo negativo), así que la memoria y la presión de cierre están verificadas de
forma determinista con un proveedor falso, pero no observadas contra un LLM real.
Con crédito y los roles coordinadores en `standard`, debería completarse.

**Fuera de alcance en esta versión:** multiusuario y autenticación de la propia
herramienta; despliegue en producción; acceso directo a filesystem o shell para
los agentes (entra por MCP, y queda visible en el Hub como cualquier conexión).

**Las corridas no sobreviven a un reinicio del servidor.** El estado vivo está en
memoria; la traza queda persistida, así que podés leer y reproducir una corrida
vieja, pero no continuarla.

---

## Sobre la suscripción de Claude

El pedido original era usar la suscripción de Claude vía Claude Agent SDK. No se
usa, por dos razones:

1. La documentación oficial del Agent SDK indica que Anthropic **no permite** que
   desarrolladores terceros ofrezcan login de claude.ai ni los límites de la
   suscripción en sus productos sin aprobación previa.
2. El Agent SDK está atado a modelos Anthropic, lo que rompe el requisito de
   elegir modelo por agente según la complejidad.

En su lugar hay un agent loop propio detrás de `LlmProvider`, que además es lo que
permite instrumentar cada paso para la visualización. Si en algún momento querés
un proveedor "suscripción Claude", es un archivo nuevo en `packages/llm/adapters/`
y nada más.
