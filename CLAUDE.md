# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

El código, los comentarios y la UI están en español rioplatense. Seguí esa
convención: un comentario nuevo en inglés desentona con todo lo que lo rodea.

El `README.md` explica **qué hace** el producto y por qué está diseñado así
(tiers, memoria, convergencia, seguridad). Este archivo cubre lo operativo y los
invariantes que no se ven leyendo un solo archivo.

## Comandos

```bash
npm run dev            # servidor :3001 + UI :5173 (concurrently)
npm run dev:server     # solo Fastify, con tsx watch
npm run dev:web        # solo Vite

npm run typecheck      # tsc --build — la verificación principal
npm test               # vitest run (todos los workspaces)
npm run test:watch

npm run db:migrate     # aplica el esquema y lista las tablas con sus filas
npm run db:seed        # empresa de ejemplo "Codytion S.A."
npm run check:models   # qué modelo resuelve cada tier, con precio real
npm run check:llm      # una llamada real con tool-calling, por proveedor
```

Un solo archivo o un solo caso:

```bash
npx vitest run packages/engine/src/memory.test.ts
npx vitest run -t "cada mensaje queda atribuido"
```

**No hay linter.** `npm run typecheck` es la puerta de calidad; `tsconfig.base.json`
usa `strict` más `noUncheckedIndexedAccess` y `verbatimModuleSyntax`.

**No hay migraciones versionadas.** El esquema es idempotente y el constructor de
`Store` (`apps/server/src/db.ts`) lo aplica solo; `db:migrate` sirve para crear o
inspeccionar la base sin levantar el servidor. Si algún día hace falta una
migración de verdad, entra en `apps/server/src/migrate.ts`.

## Estructura

Monorepo con npm workspaces. **Los `packages/` no se compilan**: su `exports`
apunta directo a `./src/index.ts` y los consumen tsx y Vite. `npm run build` solo
afecta a `apps/`. No agregues un paso de build a un package sin necesidad real.

```
packages/shared   modelo de dominio en Zod (schema.ts) + eventos (events.ts)
packages/llm      interfaz LlmProvider + adaptadores + tiers + ledger
packages/tools    registro de herramientas, puente MCP, tool router
packages/engine   agent loop, estado de corrida, scheduler, bus de eventos
apps/server       Fastify: REST + SSE + SQLite (better-sqlite3)
apps/web          React 19 + Vite + Tailwind v4 + React Flow + TanStack Query
```

## Invariantes de arquitectura

**Zod es la única fuente de verdad.** `packages/shared/src/schema.ts` define el
dominio y ambos lados infieren los tipos. Un campo nuevo se agrega ahí primero.

**El motor no conoce al servidor.** `packages/engine` depende solo de `@orq/llm`,
`@orq/tools` y `@orq/shared` — ni Fastify ni SQLite. Recibe `LlmProvider` y
`Persistence` inyectados, y por eso los tests corren con `FakeProvider` y
`noPersistence`, sin gastar tokens ni tocar disco. Mantené esa frontera.

**El actor se ata por turno, no se guarda.** `RunState.forActor(actorId)` devuelve
un `AgentWorkspace` con el actor capturado en el closure. Hubo un bug serio por
tener el actor en un campo mutable: con turnos en paralelo un agente pisaba al
otro y los mensajes quedaban firmados por el rol equivocado. Nunca introduzcas
estado mutable por turno en `RunState`; hay un test de regresión con 4 agentes
concurrentes en `scheduler.test.ts`.

**Las habilidades son un origen de herramienta, no un sistema aparte.**
`origin: "skill"` (`packages/tools/src/skills/`) agrupa lo que un rol sabe
*producir*: hoy `export_docx` y `export_pdf`. Se asignan por rol como cualquier
otra. Reciben la **clave de un entregable ya escrito**, nunca el contenido por
argumento: un documento largo pasado como argumento se trunca cuando el modelo
agota `max_tokens` a mitad del JSON. El markdown se parsea una sola vez a bloques
neutros (`markdown.ts`) y de ahí salen las dos salidas; el `SkillStorage` lo
inyecta el servidor, así que `packages/tools` no decide dónde van los archivos.

Los documentos se arman para que alguien los abra: portada con quién firma,
encabezado y pie con numeración, tablas con bordes y encabezado repetido, listas
numeradas de verdad y control de huérfanos. La portada la compone el sistema con
datos que ya tiene (`DocumentMeta`), no el modelo. **La fecha entra formateada
desde el llamador**: el render no tiene reloj, y así los tests son deterministas.

Dos trampas de pdfkit que ya costaron caro: escribir debajo del margen inferior
**agrega una página** —el pie duplicaba el documento— así que se baja
`page.margins.bottom` mientras se dibuja; y en texto `continued` la posición y el
ancho van solo en el primer tramo, o cada negrita parte el párrafo.

Los entregables son **de la empresa, no de la corrida**: al arrancar se cargan
los de corridas anteriores (`listArtifactsByCompany`), así un área lee lo que
otra escribió y lo versiona en vez de reiniciar en v1. Los previos no se
re-persisten y `list_artifacts` los marca como de otro trabajo.

La salida va a `data/exports/<empresa>/`, en carpetas: la habilidad acepta
`folder` y la crea sola. Sobre ese directorio los agentes **crean, modifican y
borran** (`write_output_file`, `delete_files`, `export_docx`, `export_pdf`,
`list_output`). `delete_files` acepta `kind` para borrar un grupo entero —"borrá
toda la multimedia" es una llamada, no una por archivo: encadenarlas hacía que el
agente fallara a la mitad—.

**Un agente solo borra lo suyo.** `removeComoAgente` acepta multimedia o archivos
que la empresa generó; lo que trajo una persona lo rechaza. La procedencia se
registra en `.orq-generado.json` dentro del directorio de cada empresa —oculto,
el árbol ignora los que empiezan con punto— y se actualiza al escribir y al
borrar. Si el manifiesto no existe, todo cuenta como externo: falla seguro.

**Borrar mira la jerarquía; crear y modificar no.** `puedeBorrar`
(`skills/permisos.ts`) resuelve contra `role.authority`: `executive` da de baja
cualquier cosa, `manager` solo material de apoyo —no un .docx ni un .pdf— y
`executor` no borra. Producir queda abierto: un ejecutor tiene que poder
trabajar sin pedir permiso. El rechazo **nombra a quién escalarle**, así el
agente sigue con `escalate` en vez de trabarse. En lote se filtra antes de
borrar: un `kind` amplio no puede ser la vía para saltear la jerarquía.

El borrado **desde la UI no pasa por ninguna de las dos reglas**: ahí decidís
vos, con confirmación y sin papelera.

Lo que **sí** sigue en pie es el saneo: toda ruta que propone un agente se limpia
**segmento por segmento** (`ExportStore.safePath`), así que se escribe y se borra
dentro del directorio de la empresa y en ningún otro lado.

**El router acota las opcionales, no el total.** Las de coordinación y las
habilidades se exponen siempre y no compiten por los lugares del ranking. Cuando
sí competían, 15 de coordinación dejaban 5 lugares para 20 herramientas y un
agente se quedaba sin su propia `export_pdf` frente a tools de MCP.

**Las herramientas de coordinación se otorgan siempre.** `packages/tools/src/registry.ts`
las expone sin mirar `role.toolIds`; `toolIds` solo controla capacidad y MCP. Si
tocás la UI de asignación, no las presentes como si se pudieran quitar.

**Las bandas de precio de los tiers son disjuntas a propósito**
(`packages/llm/src/tiers.ts`). Sin piso, `standard` y `smart` resuelven al mismo
modelo; sin techo, `smart` elige algo de US$60/MTok y un turno se come el
presupuesto. Los `QUALITY_HINTS` penalizan variantes `-fast` (cobran el doble por
velocidad, no por calidad).

**Todo lo que pasa tiene que emitir un evento.** El motor emite a `EventBus`, el
servidor persiste y reemite por SSE, y la UI deriva su estado de la traza — no
hace polling. "Ver en vivo" y "retroceder en el timeline" son la misma operación.
Un paso que no emite evento es un paso invisible: agregá la variante en
`packages/shared/src/events.ts`.

**Emití `agent.turn_end` en `finally`.** Si un turno falla y no lo emite, el nodo
del organigrama queda "pensando…" para siempre.

**El loop corta al agente que repite una llamada fallida.** A la tercera vez con
la misma herramienta y los mismos argumentos se le inyecta un mensaje pidiéndole
que cambie de enfoque, y si insiste se termina el turno. Sin eso, un error que el
modelo no puede resolver —una ruta MCP fuera del directorio permitido— le come
las `maxTurns` enteras y la corrida se queda sin entregable.

**Un tick de retardo es deliberado.** Lo que un agente emite entra a las bandejas
del ciclo *siguiente*. Modela que nadie contesta en el mismo instante y evita ida
y vuelta infinito dentro de un tick.

**Los entregables sobreviven a que se borre su corrida.** `artifacts.company_id`
existe para eso, y `listArtifactsByCompany` filtra por ahí en vez de unir con
`runs`. `deleteRun` se lleva eventos, mensajes, tareas, aprobaciones y ledger
—el registro de *cómo* se llegó— pero nunca los artefactos. Limpiar la lista de
corridas no puede costarle a la empresa el trabajo que produjo.

**La salida se mira antes de descargar.** El PDF y las imágenes los dibuja el
navegador desde la misma URL con `?inline` —un `attachment` dentro de un iframe
dispara la descarga en vez de dibujarse—. Word no lo abre ningún navegador, así
que el servidor extrae su texto de `word/document.xml`: si no, el único formato
que la empresa produce en Word sería justo el que no se puede revisar antes de
mandarlo. Ojo con el orden al desarmar el XML: `</w:p>` dentro de una celda hay
que descartarlo **antes** que los genéricos, o cada celda cae en su renglón y la
tabla se deshace.

**Los controles de la corrida se muestran según su estado.** Ofrecer "pausar"
sobre una corrida terminada obliga a adivinar cuál sirve; cada botón dice qué
hace y su `title` explica cuándo conviene. Solo una corrida `running` no se puede
borrar, y al borrarla hay que soltarla del runtime (`olvidarCorrida`) o queda un
orquestador vivo escribiendo eventos de algo que ya no existe.

## Trampas conocidas

- **`active.run` queda viejo.** El estado autoritativo de una corrida es
  `orchestrator.snapshot`; `active.run` no se actualiza al pausar o detener, y
  leerlo hacía que una corrida ya detenida dijera "está en curso".
- **Las corridas no sobreviven a un reinicio del servidor.** El estado vivo está
  en memoria; la traza queda persistida, así que podés reproducir una corrida
  vieja pero no continuarla.
- **Contestar una solicitud cuya corrida ya cerró** no llega a ninguna bandeja: el
  `runtime.notifyRequester` la guarda como `Learning` de la empresa, que sí entra
  en el prompt de las corridas siguientes.
- **`fetch` con `content-type: application/json` y body vacío** hace que Fastify
  responda 400. `apps/web/src/api.ts` solo pone el header cuando hay cuerpo; si lo
  cambiás, todos los DELETE se rompen.
- **Un proceso viejo puede quedar tomando el 3001** y servir código anterior:
  `lsof -ti:3001 | xargs kill -9`. `pkill -f` no siempre alcanza. Vite usa
  `strictPort: true` para que no se corra de puerto en silencio.
- **En grillas CSS, poné `min-w-0`** en `Panel` y columnas: sin eso `min-width:auto`
  desborda la página a lo ancho.
- **Los roles nuevos nacen en la posición (0,0)** y se apilarían en el organigrama;
  `OrgGraph.autoLayout` los acomoda por jerarquía cuando detecta posiciones
  repetidas, y respeta las que hayas movido a mano.
- **`write_artifact` rechaza claves que son variantes de una existente**
  (`-ciclo3`, `_v2`, `-final`, y sufijos colgados como `-detalle`) y le pide al
  agente que versione la original. Los modelos baratos fragmentan el entregable si
  esa guardia no está.
- **El aviso de npm audit sobre `@hono/node-server`** está documentado en
  `package.json` → `auditNotes`: llega por el SDK de MCP, no es alcanzable (solo
  importamos el lado cliente) y forzar el override de major puede romper el SDK.
  No lo "arregles" sin leer esa nota.

## Configuración

`.env` (git-ignored, ver `.env.example`): al menos una API key de proveedor, más
`PORT`, `DATABASE_URL`, `DEFAULT_RUN_BUDGET_USD`, `DEFAULT_MAX_TICKS` y
`AGENT_CONCURRENCY`.

Los secretos de los servidores MCP se guardan **por referencia** — el nombre de la
variable de entorno, nunca el valor — para que una empresa exportada a JSON no
lleve credenciales. Mantené esa regla al agregar campos de configuración MCP.
