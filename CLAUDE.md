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

npm run db:estudio     # el estudio audiovisual de Codytion: 4 roles, un video
npm run musica:cama    # genera una cama musical propia en data/musica
```

`check:llm` acepta `--model=<slug>` para probar uno puntual. Vale la pena
correrlo antes de una corrida larga: una cuenta sin crédito contesta **402 a
todo**, y eso se ve como una corrida que muere en el tercer ciclo sin producir
nada. El seed del estudio usa el tier `free` por ese motivo; con
`ORQ_SEED_TIER=standard` corre con modelos pagos.

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
*producir*: hoy `export_docx`, `export_pdf`, `export_video` y —sólo si hay una
API key de imágenes— `generar_imagen`. Se asignan por rol como cualquier otra.
La que no se puede cumplir no se registra: ofrecerle al agente una herramienta
que siempre falla le hace gastar turnos intentándola. Reciben la **clave de un entregable ya escrito**, nunca el
contenido por argumento: un documento largo pasado como argumento se trunca
cuando el modelo agota `max_tokens` a mitad del JSON. El markdown se parsea una
sola vez a bloques neutros (`markdown.ts`) y de ahí salen las tres salidas; el
`SkillStorage` lo inyecta el servidor, así que `packages/tools` no decide dónde
van los archivos.

Los documentos se arman para que alguien los abra: portada con quién firma,
encabezado y pie con numeración, tablas con bordes y encabezado repetido, listas
numeradas de verdad y control de huérfanos. La portada la compone el sistema con
datos que ya tiene (`DocumentMeta`), no el modelo. **La fecha entra formateada
desde el llamador**: el render no tiene reloj, y así los tests son deterministas.

**El video es el mismo markdown leído como línea de tiempo.** `export_video`
(`skills/video.ts`) no maqueta un documento: interpreta el guion como una
secuencia. `guion.ts` traduce los bloques a escenas —`#` es la portada, cada
`##` abre una escena, los párrafos son la voz en off, las viñetas se muestran
mientras se habla— y `**Nombre:** texto` marca diálogo, donde **cada personaje
recibe una voz distinta** y su línea aparece en pantalla cuando le toca.

Se arma con lo que ffmpeg ya trae —libass para la tipografía, `gradients` para
el fondo— y **en una sola pasada**: no hay un clip por escena ni cadena de
`xfade`, así que no hay archivos intermedios de video que sincronizar. La única
fuente de verdad del tiempo son las duraciones medidas del audio; todo lo que se
ve se calcula a partir de ellas. Agregar un navegador headless para maquetar seis
placas de texto sería cambiar 150 MB de dependencia por un `<div>`.

La voz sale de **Kokoro** local (gratis, ilimitado; se busca en `ORQ_KOKORO_HOME`
y en `~/.cache/`), con `say` de macOS como respaldo. El respaldo no es un lujo:
sin él, una máquina sin el modelo descargado no puede producir un video y la
habilidad quedaría rota sin decir por qué.

Tres trampas que ya costaron un video mal filmado: **un diálogo se escribe sin
renglones en blanco** —una línea por personaje, como en un guion— y en markdown
eso es *un solo párrafo*, así que hay que volver a partirlo por cada `**Nombre:**`
o las cuatro intervenciones las dice de corrido el primero que habló, leyendo en
voz alta los nombres de los demás. Lo que no entra en el alto útil **pasa de
página** en vez de desbordarse por abajo del cuadro. Y **la viñeta de ffmpeg
apaga los bordes**, que es justo donde vive el texto alineado a la izquierda.

**Una empresa puede convocar gente que no tenía.** `convocar_especialista`
incorpora un rol **en el acto**, sin esperar aprobación, y arranca en el ciclo
siguiente: `RunState.incorporarRol` lo agrega al roster vivo y lo guarda como rol
de la empresa, así que sobrevive a la corrida que lo creó. Es la diferencia entre
una empresa que puede abordar un problema que no previó y una que sólo ejecuta el
organigrama con el que arrancó.

`request_new_role` sigue existiendo y no sobra: la diferencia no es de permisos
sino de **tiempo**. Proponer y esperar a una persona es lo correcto para
incorporar a alguien de forma permanente; convocar es para cuando el trabajo ya
empezó, falta una capacidad concreta y esperar significa perder la corrida.

**Los tres frenos son del ejecutor, no del prompt.** Sólo convoca quien tiene
autoridad `executive`. **El convocado nace `executor`**, así que no puede
convocar a su vez — sin eso un equipo se multiplica solo: cada especialista
descubre que le falta otro y la corrida termina con treinta agentes hablándose
entre ellos. Y hay un tope por corrida: si un encargo necesita más de cuatro
capacidades que la empresa no tenía, el problema no es de gente, es que nadie
entendió el encargo, y sumar agentes lo empeora porque cada uno agrega mensajes
que los demás tienen que leer.

**Convocar reparte capacidades, no las inventa**: sólo se otorgan herramientas
que ya están en el catálogo del proyecto. Una que no existe **se nombra en la
respuesta** en vez de descartarse en silencio — un especialista que nace sin la
herramienta que se le prometió gasta su primer turno buscándola, y desde afuera
parece que no entendió la tarea.

**Un servidor MCP se da de alta pegando su configuración, desde el Hub.** La
capacidad estaba entera desde el principio —descubrimiento, salud, reconexión,
probador— y sin embargo MCP no se usaba: no había forma de *agregar* un servidor
sin un `curl`, porque `api.ts` no tenía los métodos y el Hub no tenía formulario.
`parsearConfigMcp` (`packages/shared/src/mcp-config.ts`) acepta el bloque
`{"mcpServers": {…}}` que publica cada servidor en su README —el mismo que ya
tenés pegado en Claude o en Cursor— y también el mapa a secas, porque los README
se reparten entre las dos formas.

**Al importar, un secreto literal se descarta con un aviso.** El formato del
ecosistema mete el valor adentro del JSON (`"env": {"GITHUB_TOKEN": "ghp_…"}`) y
acá se guarda **la referencia**: el nombre de la variable, nunca el valor. Un
valor que parece un nombre (`GITHUB_TOKEN`, `${GITHUB_TOKEN}`) entra; uno que
parece un secreto no entra y se explica por qué. Ante la duda gana no guardar: un
falso negativo cuesta escribir el nombre a mano, un falso positivo escribe una
credencial en la base y rompe la garantía de que una empresa exportada a JSON no
lleva credenciales adentro. Descartarlo en silencio sería peor que no importar —
el servidor arrancaría sin credencial y el error aparecería lejos de su causa.

**Un servidor MCP remoto puede pedir OAuth, como en `claude mcp add --transport
http`** (el de Supabase, el de Sentry). Un transporte HTTP sin cabeceras de
credencial recibe un proveedor OAuth (`mcp-oauth.ts`, inyectado al `McpBridge`
como `FabricaOAuth`: `packages/tools` no decide dónde van los tokens). Si el
servidor exige iniciar sesión, la URL queda en `health.autorizacion`, el Hub
ofrece **Autorizar** y la vuelta llega a `/api/mcp/oauth/callback`, que la ata
al servidor por el `state` y reconecta. Tres reglas: el puente **no reintenta**
mientras falte autorizar (el servidor va a decir que no hasta que alguien
inicie sesión); los tokens van a `data/mcp-oauth/<id>.json` con permisos 0600 y
**nunca a la base** —la misma regla de secretos por referencia— y se borran con
el servidor; y como las tools recién aparecen al autorizar, el alta guarda a
quién dárselas (`otorgarAlConectar`), que se otorga sola al conectar (también en
las corridas vivas) y se vacía.

Con `autoApproveTools` apagado, sólo pide aprobación lo que el servidor **no**
declara de sólo lectura (`annotations.readOnlyHint`): en una base de datos,
listar tablas corre solo y una migración espera a una persona. INSPIA tiene el
de **staging** (`vrmbrxxcvxeaflsgtyfa`) así; producción es otro proyecto
(`qnfeqicedlysxredgzid`) y no se dio de alta.

**Aprobar una herramienta la ejecuta** (`Orchestrator.ejecutarAprobada`). Una
tool con `requiresApproval` no corre: abre una aprobación y el turno espera.
Antes, aprobar sólo le mandaba "Aprobación concedida" al agente, y si la volvía
a llamar pedía aprobación otra vez — una migración aprobada no se aplicaba
nunca. Ahora al aprobar se corre **esa** llamada, con los argumentos que vio la
persona (el agente no puede cambiar el SQL después), queda en la traza y en
`activity`, y el resultado le llega al solicitante en el mismo mensaje. El chat
del IDE muestra la aprobación en línea con el SQL resaltado.

**Un agente de código con un MCP de base de datos recibe cómo trabajar con él**
(`bloqueDeBaseDeDatos` en `codigo-servidor.ts`): mirar el esquema antes de
tocarlo, y que un cambio de esquema tiene dos mitades que no se separan —el
archivo versionado en el repo (la carpeta de migraciones se detecta:
`backend/migrations` en INSPIA) y **el mismo SQL** aplicado con
`apply_migration`—. Sin decirlo, un agente hace una sola: SQL en vivo que nadie
puede reproducir, o un archivo que nunca se aplica.

**Una consulta del chat es trabajo aunque no deje código.** "¿Qué tablas hay?"
no produce entregables, mensajes ni ediciones, y el detector de pedidos
perdidos la marcaba `failed`. En una corrida enfocada (`run.foco`), un turno que
usó herramientas y cerró con una respuesta cuenta.

**La lista autoritativa de servidores es la base, no la memoria del runtime.**
`McpBridge.disconnect` cierra la conexión y da de baja las herramientas pero no
publica un último estado, así que el mapa de salud se quedaba con la entrada del
servidor borrado: en el Hub se veía un **servidor fantasma** en `ready`, con su
botón de reconectar y sin forma de sacarlo porque ya no tenía configuración
detrás. `Runtime.mcpHealth` filtra por lo que sigue configurado, y la UI hace lo
mismo con lo que llega por SSE, que conserva el último estado de algo que ya no
existe.

**Un agente puede pedir un servidor MCP nuevo; conectarlo lo decide una persona.**
`solicitar_servidor_mcp` acepta el mismo bloque `{"mcpServers": …}` del Hub y lo
sanea **en la herramienta**, no en quien aprueba: lo que llega a la bandeja ya no
puede llevar un secreto adentro, y los avisos de lo descartado los ve el agente
en el momento (así sabe que la credencial la carga la persona por su lado). Al
aprobar (`Runtime.applyRequest`) se guarda la configuración, se conecta de
verdad —el handshake se espera para poder decir qué herramientas aparecieron— y
las descubiertas se le **otorgan al solicitante**: un servidor aprobado cuyas
tools no le llegan a nadie deja al agente igual de bloqueado que antes. Como la
corrida congela su catálogo al arrancar, las tools nuevas se le suman explícito
con `incorporarHerramienta` + `updateRoleTools`, o el agente no las ve hasta la
corrida siguiente. Un servidor que la empresa ya tiene no abre solicitud: la
herramienta redirige a `request_tool_access`, que es lo que de verdad falta.

**Un agente puede crearse herramientas, pero sólo componiendo las que ya puede
ejecutar.** `crear_herramienta` (`packages/tools/src/compuestas.ts`) arma una
tool **declarativa**: una secuencia de hasta 6 pasos de herramientas existentes,
con argumentos fijos y huecos `{{parametro}}` que definen el esquema de entrada
(cerrado con `additionalProperties: false`, para que el memo de lecturas
funcione). No hay código del agente corriendo en el servidor, y por eso no
necesita sandbox ni aprobación: no puede hacer nada que sus componentes no
pudieran. Los frenos viven en el ejecutor, como siempre: la crea `executive` o
`manager` —un ejecutor pide lo que le falta—, sólo compone lo que el creador
tiene asignado (crear no escala permisos), sin compuestas de compuestas (dos que
se llamen entre sí no terminan nunca) y sin pasos que requieran aprobación (la
secuencia no puede quedar esperando a una persona por la mitad). La fila se
persiste con `origin: "creada"` y su `composicion` adentro, sobrevive a la
corrida como un especialista convocado, y `companyRuntime` la vuelve ejecutable
al levantar. Dos trampas que ya están fijadas con tests: `persistMcpTools`
**saltea** las creadas —`describe()` no lleva la composición, y re-guardarlas
desde ahí las dejaba vacías: una herramienta que existe pero no ejecuta nada—, y
el router las trata como a las habilidades: siempre expuestas, porque alguien la
armó a propósito para ese trabajo y perderla en el ranking anula el motivo por
el que existe. Una secuencia que falla **se corta en el paso que falló** y lo
nombra: un pipeline que sigue después de un fallo produce basura con cara de
éxito.

**Un agente que produce algo visual tiene que poder verlo.** El motor le presta
al proveedor el directorio de salida de la empresa (`TurnDeps.dirDeTrabajo`, que
inyecta el servidor igual que la fecha) y `claude-code` lo usa como directorio de
trabajo del CLI: así el diseñador abre con sus propias herramientas la
previsualización de la lámina que programó, en vez de decidir a ciegas sobre un
archivo que sólo puede describir de memoria. "No reportó errores" no es lo mismo
que "se ve bien".

**Se presta en sólo lectura, y eso no es una precaución de más.** Con el
directorio de la empresa montado, al CLI se le otorga únicamente `Read`, `Glob`,
`Grep` y las web (`ALLOWED_TOOLS_LECTURA`): sin `Write`, sin `Edit` y sin `Bash`.
Producir sigue yendo por `write_output_file`, que es lo único que sanea la ruta
segmento por segmento, anota la procedencia en `.orq-generado.json` y aplica la
jerarquía de borrado. Un `Write` del CLI saltearía las tres garantías de una sola
vez y encima sin dejar rastro en la traza. La regla se arma en `construirArgs`,
que está exportada justo para poder fijarla con un test: una regla de seguridad
que sólo vive adentro de un `spawn` no se puede verificar.

**`inspeccionar_medio` es `check_activity` aplicado al disco.** Mide el archivo
—duración, resolución, si tiene pista de audio, cuánto pesa— para que un rol
verifique lo que produjo en vez de repetir lo que dijo la herramienta que lo
produjo. Lo pagamos: la realizadora informó "76 segundos" porque eso decía el
mensaje de su propia exportación, y cuando el render leía de más el video salía de
131 sin que nadie de la empresa pudiera notarlo hasta que una persona lo abría. Un
dato que sólo se puede repetir no es una verificación. Avisa fuerte cuando un
video salió **sin pista de audio**, que es la falla que más cuesta ver: se ve
perfecto y se manda mudo.

**Hay un segundo motor de video, y no reemplaza al primero.** `export_video`
dibuja todo con ffmpeg y no necesita nada instalado: sigue siendo lo correcto
para un guion que es texto y viñetas. `export_video_estudio` (`skills/estudio.ts`)
compone **cada escena como una lámina HTML** y la revela con el navegador. Existe
por dos razones que el motor de ASS no puede cubrir: un diagrama que se dibuja
solo, una retícula de tarjetas o una cifra grande no se maquetan en ASS; y sobre
todo **HTML es el lenguaje que un agente sabe programar**, así que las láminas se
le pueden encargar a un rol con capacidad de escribir código, que las prueba con
`revisar_lamina` y las corrige. Esto revisa la nota de arriba sobre el navegador
headless: cambiar 150 MB por un `<div>` seguía siendo mal negocio para seis
placas de texto, no para esto.

**No se instala ningún navegador**: `skills/chrome.ts` maneja el Chrome que ya
está en la máquina por CDP, con el `WebSocket` nativo de Node — cero dependencias
nuevas, la misma regla que ffmpeg y Kokoro. Si no hay navegador, las dos
habilidades **no se registran**, como cualquier otra que no se puede cumplir.

**Hay un tercer motor de video: clips reales empalmados** (`skills/clips.ts` +
`abrirGrabacion` en `chrome.ts`). Un tutorial de software se mira mejor viendo
el software moverse: `grabar_clip` filma el Chrome instalado sobre una app viva
con `Page.startScreencast` —cada repintado llega con su instante, así el clip
dura lo que duró la interacción— y `export_video_clips` los empalma **a pantalla
completa** con la narración encima. Tres decisiones que no son estéticas: la
**preparación pasa fuera de cámara** (login, navegación, esperas) y la grabación
arranca sobre la pantalla lista, por eso un clip no puede mostrar el formulario
de acceso ni un loader de entrada; `esperar_texto` exige el texto visible **y
estable** (sobrevive 1,2 s), que es la regla anti-loader de siempre; y la
sincronía voz↔pantalla es **por construcción** — la duración de cada escena la
manda su narración (`ubicarEscenas`, el mismo reloj de los otros dos motores) y
el clip se estira clonando su último cuadro o se recorta a esa duración
(`tpad` **antes** de `trim`: al revés un clip corto deja entrar el corte
siguiente antes que su voz). Los clips se atan por número como las láminas
(`01-….mp4` es la escena 1), la escena sin clip sale como placa lisa **con
aviso**, y el pasaje es un corte, no un encadenado: en un tutorial el corte es
el lenguaje. Sin navegador, el par entero no se registra.

**El login no se repite: la sesión del navegador se reusa.** `grabar_clip` acepta
`sesion` y con ese nombre el perfil de Chrome **sobrevive entre llamadas**
(`abrirGrabacion({perfil})`, que además no lo borra al cerrar). Sin eso, cada
toma abría un perfil nuevo y volvía a iniciar sesión: medido en una corrida
real, once tomas de la misma escena repitieron los mismos seis pasos de acceso,
casi seis minutos de reloj. Es la clase de costo que un modelo más capaz **no**
baja —no es una decisión, es estado que se tiraba—. Dos cuidados: dos Chrome
sobre el mismo `--user-data-dir` no conviven, así que hay un candado por nombre
y la toma que llega segunda graba con un perfil temporal **y lo dice** (fallar
sería peor: el clip es lo que importa, la sesión era el atajo); y una sesión
vencida hace fallar la toma en el primer paso, que es la señal de volver a poner
el login una vez.

La **portada es el clip `00-…`** y es el visual de la escena del `#`; los clips
numerados se atan al **ordinal de las escenas `##`, sin contar la portada** —
numerarlas juntas fue un bug que corrió un video entero una escena—. La duración
de la portada la da el reloj compartido (3,8 s de aire si no narra). Se filma
con `grabar_clip` sobre el HTML que la empresa ya produjo, vía
`ir: "salida://ruta"` (resuelto y saneado por el servidor). Ojo con el **texto
suelto entre el `#` y la primera `##`** —"Personajes:", "Tono:"—: es narración
de portada y la voz lo lee al abrir el video; el motor lo avisa fuerte en el
resultado, porque lo pagamos con un video que arrancaba leyendo los metadatos. Y **quien revisa tiene que poder mirar**:
`extraer_cuadros` saca PNG repartidos de cualquier video a `revision/` —el
nombre trae el segundo— y un rol con proveedor `claude-code` los abre con sus
herramientas de lectura. Medir con `inspeccionar_medio` no reemplaza mirar: es
el mismo principio del diseñador de láminas, aplicado al control de calidad.

**El cuadro se calcula, no se graba.** Se pausan todas las animaciones y se les
fija el tiempo cuadro por cuadro (`Animation.currentTime`): el resultado es
idéntico en cualquier máquina, y no depende de que la captura vaya al día. De ahí
salen tres reglas del kit que no son estéticas: **nada de bucles infinitos** —no
se pueden filmar sin capturar el video entero—, nada de `<animate>` de SVG —SMIL
no aparece en `getAnimations()`, así que no se puede adelantar— y nada de pedidos
a la red. Y se captura **sólo la entrada**: una lámina entra en dos segundos y
después se queda quieta, así que filmar los quince restantes serían 450 PNG
idénticos. Lo que evita que la pantalla se vea muerta es que las láminas son
**transparentes** y el fondo lo sigue generando ffmpeg, moviéndose por detrás.

**Las dos salidas comparten lo que no puede divergir**: el reloj (`ubicarEscenas`
en `guion.ts`), la voz, el catálogo de íconos y la mezcla con la cama musical
(`sonido.ts`). Es la misma lección de los íconos del deck: un segundo set
dibujado aparte se desincroniza a la primera corrección. Lo único distinto entre
los motores es cómo se dibuja el cuadro.

**Una lámina se ata a su escena por el número del nombre** (`01-portada.html`),
no por un campo del guion: el guion ya dice el orden, y pedirle además que nombre
archivos es pedirle que mantenga dos listas sincronizadas. La escena sin lámina
propia se maqueta con la plantilla del sistema (`tema.ts`), que usa exactamente
las mismas clases que le pedimos al agente — así un guion sin una sola línea de
HTML igual sale filmado, y una lámina programada se ve como una mejora de eso y
no como otra cosa.

**Las instrucciones de los agentes están en inglés; el producto habla
castellano.** En el seed del estudio (`scripts/seed-estudio-codytion.ts`) y en la
guía del kit (`estudio/GUIA.md`), lo que es especificación técnica larga va en
inglés porque un modelo la sigue con más precisión en el idioma en el que se
entrenó mayoritariamente. Lo que **sale** —guion, texto en pantalla, voz— es
castellano rioplatense, y cada instrucción lo dice explícitamente arriba de todo:
sin esa línea, una instrucción en inglés arrastra la respuesta al inglés y el
video termina hablando en otro idioma. Los nombres de clase del kit siguen en
castellano: son la API, no instrucciones.

**Los íconos se dibujan, no se instalan** (`skills/iconos.ts`). `:objetivo:` al
empezar una viñeta o un `##` mete un trazo vectorial de ASS —el mismo `{\p1}` de
la regla y la barra de progreso—, así que escalan sin perder nitidez, toman el
color del estilo y no hay assets que empaquetar. Los emojis quedaron descartados
a propósito: libass los dibuja en monocromo o los saltea según la fuente
instalada, y un video que en una máquina muestra un cohete y en otra un cuadrado
no es una salida confiable. Las coordenadas van en una caja de 100×100 y **un
agujero se dibuja con el contorno invertido**: ASS rellena por regla non-zero, y
sin invertirlo un candado es una mancha con forma de candado. Ojo también con
superponer contornos: si el hueco del arco pisa la tapa, el candado termina
pareciendo un bolso. Un nombre que no está devuelve `null` y quien llama dibuja
la viñeta cuadrada de siempre — un `:crecimiiento:` mal escrito degrada, no
rompe la escena, y **la marca queda a la vista** para que el agente vea el error.

Dos trampas que aparecen con cualquier modelo. El **encabezado del documento**
arriba del guion —"# Guion video institucional (v4)" y recién abajo el `#` con el
título real—: la portada anunciaba el número de versión del borrador y el título
de verdad quedaba como una placa del medio. Un segundo `#` con la portada todavía
sin cuerpo pisa el título en vez de abrir escena; si la portada ya dijo algo, sí
abre.

Y la marca de ícono escrita **sola en
su renglón**, debajo del título, en vez de al principio del `##` o de la viñeta.
En markdown eso es un párrafo, y un párrafo es voz en off: el video decía
":objetivo:" en el medio. Un párrafo que es sólo una marca conocida se toma como
el ícono de la escena. Una marca *desconocida* sí se dice, a propósito, porque es
la única forma de que el error se note.

**Un diagrama no es una foto de peor calidad** (`skills/visuales.ts`).
`![lo que muestra](visual:flujo)` dibuja una composición —un chat, un flujo de
proceso, tarjetas de dato, un tablero, una ficha de contacto—. Cuando lo que hay
que mostrar es de dónde sale un dato y a dónde llega, una foto de gente en una
oficina no dice nada y un diagrama lo dice todo; además no depende de ningún
proveedor, no cuesta nada y sale siempre en la paleta de la marca. Cada visual se
define **una vez** en una caja de 100×100 y se emite en los dos medios, igual que
los íconos, con una diferencia: acá hay texto adentro del dibujo y ASS no sabe
poner una palabra dentro de una forma, así que `visualAss` devuelve el dibujo
**despiezado** —formas primero, rótulos después— y quien renderiza los apila. Ojo
con el ancla del texto: en SVG la `y` es la línea de base y en ASS es el techo,
así que hay que restar un cuerpo o los rótulos caen un renglón más abajo que su
caja.

**Las personas se dibujan con curvas.** `visual:llamada|Cuénteme cómo cierra el
día` pone un personaje en un escenario —bodega, escritorio, llamada— con lo que
dice en un globo, y **lo que dice lo escribe el guion**, después del `|`: el
mismo escenario sirve para otra campaña con otra frase. El cuerpo se arma con
`M`/`L`/`C` y no con círculos y rectángulos porque un cuerpo hecho de cajas se
lee como un muñeco de bloques, y una lámina de venta con muñecos de bloques se ve
como una plantilla gratis. Esa es también la razón de la restricción a cuatro
comandos de SVG: `trazoAAss` los traduce a `m`/`l`/`b` sin escribir un intérprete,
y si sobrevive una `M` libass descarta el dibujo entero y la persona no aparece.
Las caras van sin rasgos a propósito —un ojo mal puesto por un generador arruina
la figura— y hay dos tonos de piel, no una paleta: media docena elegida por un
programa termina en un reparto que parece un folleto.

El globo **calcula su propio corte** a partir del ancho que tiene; pasarle un
número de caracteres a ojo es lo que hacía que la frase se saliera por el
costado. Y cuando muevas una figura, acordate de mover los props: el teléfono y
la vincha del auricular están en coordenadas absolutas de la caja, así que una
persona que se corre seis unidades deja el teléfono flotando en el aire.

**Lo que entra a un turno delegado se acota en la puerta, porque después no se
puede.** El motor ya se defiende del contexto cuadrático con
`compactarConversacion`, pero esa defensa actúa sobre **su** conversación, y los
proveedores que delegan (`claude-code`, `opencode`) no tienen una: corren su
propio loop y el motor ve una sola iteración. La regla se invierte al cruzar esa
frontera — en el loop propio se compacta *después*, cuando el resultado ya se
consumió; en el delegado no hay un después, así que `acotar.ts` corta al entrar.
Tres frenos, todos en `claude-mcp.ts`, medidos sobre corridas reales de seis
agentes que gastaron 21,1M de tokens de entrada para 132k de salida (160:1, con
96-100% servido desde caché — el caché abarata pero **no exime**: bajo
suscripción esos tokens consumen la ventana igual):

1. **Memo de lecturas.** El del loop no llegaba acá. Una relectura idéntica
   devuelve un puntero: el contenido sigue más arriba en la conversación del CLI.
2. **Tope de tamaño** (`TOPE_RESULTADO`, 16.000 caracteres). El número sale de
   los datos y no del gusto: el entregable más grande de la empresa medida son
   11.127 caracteres y la mediana 3.881, así que ninguna lectura de trabajo se
   toca y sí se cortan listados, volcados de navegador y documentos patológicos.
   El aviso de recorte **ofrece sólo argumentos que la herramienta declara**
   (leídos de su esquema): sugerir `start` o `page` es lo que ya costó 534k
   tokens de entrada para 2k de salida.
3. **Freno por largo de delegación** (aviso a las 50 llamadas, tope a las 80), y
   es el que más pega. El costo de un turno delegado es **cuadrático en su
   largo**; medimos turnos de 145, 112 y 108 llamadas contra una mediana de 21.
   Pasado el tope se niegan las **lecturas** y se dejan pasar las escrituras: lo
   que alarga un turno es explorar y lo que lo cierra es entregar, así que negar
   todo le sacaría al agente la posibilidad de guardar lo que ya averiguó.
   Proyectado sobre los 16 turnos reales: 35,7% menos caracteres reenviados,
   **sin tocar 13 de ellos** — sólo corta la cola patológica.

Los dos primeros no ahorraron nada en las corridas medidas y eso está bien: son
seguros contra una patología documentada que hoy no ocurre porque los agentes
leen por secciones y los entregables son chicos. Un seguro que no se cobra
todavía no es un seguro que sobra.

**Reconocer y filmar tienen que pasar en el mismo navegador.** `explorar_pantalla`
(`skills/index.ts`, sólo con Chrome presente) recorre una pantalla sin filmarla
usando la **misma `sesion`** que `grabar_clip`: mismo perfil, o sea el mismo
login, mismo lienzo de 1920×1080 y el mismo motor de acciones. Antes el
reconocimiento iba por el MCP de navegador —otro Chrome, otra sesión, otro
tamaño— y lo verificado no era lo que veía la cámara; encima cada `browser_find`
devolvía media página al contexto. Esto devuelve texto acotado (4.000 caracteres)
y, sobre todo, dice de cada texto si es **estable**: uno que aparece y se borra
es un loader y no sirve como ancla de `esperar_texto`. Descubrirlo acá cuesta un
segundo; descubrirlo filmando cuesta la toma. Playwright queda para lo que el
motor de clips no hace: **crear los datos de demo** y leer consola y red.

Una trampa que costó una hora: el código que se evalúa en la página viaja adentro
de un template literal, así que **una barra sin escapar se la come el template** —
la regex de espacios llegaba como `/s+/g` y le comía las eses a cada palabra
("Orquestador" volvía "Orque tador")— y un backtick ahí adentro cierra el
template y rompe el archivo. Los comentarios sobre ese código van **afuera**.

**El logo va chico y quieto**, en `marca/logo.png` dentro del directorio de la
empresa —una ruta fija, no una opción de configuración: se sube por la misma
pestaña que todo lo demás—. Grande en la portada, discreto en la esquina del
resto. No se recorta ni se le hace el acercamiento lento de las fotos: un logo
deformado es peor que ningún logo. La posición se da como **expresión** de
ffmpeg (`W-w-180`) y así se ancla al borde derecho sin que nadie mida el archivo.
La paleta también sale del logo y no del CSS del sitio: el sitio usa un azul
plano y un ámbar de botón, el logo es un lazo de turquesa, azul y violeta, y eso
es lo que hace reconocible a la marca.

**Una imagen entra por markdown y sale por overlay.** `![lo que se ve](fotos/x.jpg)`
muestra un archivo del directorio de salida; `![lo que se ve](generar)` describe
una imagen que todavía no existe, y esa descripción *es* el prompt
(`skills/imagenes.ts`, primer proveedor con credencial: Google, OpenAI, NVIDIA).
Las generadas quedan en `imagenes/` **dentro del directorio de salida** y con un
nombre derivado del prompt: sin ese caché, re-exportar vuelve a pagarlas todas y
además cambia el aspecto del video sin que nadie lo haya tocado. La imagen no va
de fondo con el texto encima —una foto detrás de un párrafo lo vuelve ilegible
justo cuando alguien lo está leyendo—: van en dos columnas, y la única que ocupa
el cuadro entero es la de la portada, con un velo oscuro que sostiene el título.
`packages/tools` no lee el disco: recibe `resolverImagen` del servidor, que es
quien sanea la ruta que propuso un modelo.

Dos detalles del render que no son estéticos: la imagen se **sobremuestrea**
antes del acercamiento, porque `zoompan` amplía sobre lo que recibe y con el
tamaño final el movimiento es puro reescalado; y hay que **correrla en el tiempo**
con `setpts`, o el fundido de entrada ocurre en el segundo cero del video y la
escena la recibe ya entrada.

**El mismo guion también es un deck** (`skills/slides.ts`, `export_slides`). Un
video no se puede citar, ni copiar una frase, ni saltar a la escena siete, y la
mitad de las veces lo que hace falta es exactamente eso. Sale del mismo
`parseGuion`, así que las dos salidas no pueden decir cosas distintas. Lo que en
el video es voz en off acá es la nota al pie de la lámina: en pantalla nadie la
escucha, pero sí la lee. **Los íconos son los mismos**: `iconoSvg` traduce los
trazos de ASS a SVG —`m`/`l`/`b` contra `M`/`L`/`C`, y las dos rellenan por regla
non-zero, así que los agujeros siguen siendo agujeros— porque un segundo set
dibujado aparte se desincroniza a la primera corrección. El archivo es **uno
solo y sin pedidos a la red**: las imágenes viajan como `data:`, porque un deck
que depende de rutas relativas se rompe apenas alguien lo adjunta a un correo,
que es justo lo que se hace con un deck. **La firma es la empresa**, no el rol que lo produjo: un
Word interno lleva el nombre de quien lo escribió porque alguien responde por él;
una pieza que se le manda a un cliente, no —ahí el autor es la marca, y el nombre
del agente no le dice nada a quien la recibe—. En la UI se dibuja en un iframe con
`sandbox` vacío: el archivo se sirve desde el mismo origen que la aplicación, y
un `.html` que escribió un agente no puede correr con su sesión.

**Cómo suena la marca es un dato de la empresa** (`vozSchema`), no del guion:
el nombre se pronuncia igual en todos sus videos. `pronunciacion` se aplica
**sólo al texto que va al sintetizador** —escribir "codishon" en el guion sería
una falta de ortografía en pantalla— y compara por palabra entera, porque una
regla para "IA" sin ese corte reescribe "familia" por dentro. `unaSolaVoz` apaga
el reparto: varias voces suenan a elenco de actores, y una pieza institucional
la dice la empresa.

**La música la ponés vos.** Las pistas viven en `MUSICA_DIR` (`data/musica/`) y no
en el repo: la música tiene licencia, y un orquestador que baja un mp3 y lo pega
en el video de una empresa la mete en un problema que no sabe que tiene. El clima
se lee del **nombre del archivo y de su carpeta**, así que agregar una pista es
copiarla. La biblioteca se recorre en profundidad: quien compra música deja el
paquete tal cual —`Corporate/Corporate Harmonics.mp3`— y con un `readdir` a secas
esas pistas no existían para el sistema; el video salía en silencio con el
archivo ahí, a la vista de todos menos del programa. Del mismo tema en `.wav` y
`.mp3` entra uno solo, y **entre pistas que empatan gana la más larga**: una cama
que se repite cada cuarenta segundos se escucha como una cama que se repite.

**Una cama que no se escucha es peor que no tener música.** Los dos números que
lo deciden viven juntos en `sonido.ts` (`MUSICA.lufs` y `DUCKING`) porque el
error fue la **suma** de dos decisiones que por separado parecían prudentes:
normalizar a −26 LUFS —ya bajo para una cama— y encima ducking con `ratio=10`,
que a esa altura no aparta la música, la apaga. Medido sobre un video real, la
música quedaba en −40 dB. Un ducking musical baja 8-10 dB bajo la voz, no 20:
`ratio=4`, `attack` corto (agarra la primera sílaba, si no cada frase arranca
con un pico de música encima) y `release=300` para que la cama vuelva **entre
frase y frase**, que es cuando una cama se tiene que oír. Verificalo midiendo
el hueco entre dos frases, no el promedio del video ni la cola (ahí está el
fade out y siempre da bajo).

**Le erramos dos veces al nivel de la cama, en direcciones opuestas.** Primero
−26 LUFS con ducking `ratio=10` la dejó en −40 dB: inaudible. Corregido el
ducking, subirla a −20 la puso a 4-5 dB de la voz, o sea compitiendo. El número
sale de una cuenta y no del gusto: **una cama va 10-12 dB por debajo de la
narración**, y con `ratio=4` eso es −26 LUFS. Medido sobre el video terminado,
renderizando el mismo guion con y sin música: bajo la voz la cama aporta entre
+0,1 y +0,5 dB —o sea nada— y en los huecos entre frases, +3 a +5 dB, que es
justo donde una cama tiene que oírse. Bajar más no la hace más sutil, la hace
desaparecer: a −30 el aporte se vuelve indistinguible del ruido de la mezcla.
**La prueba que vale es renderizar dos veces, con y sin música, y restar**; medir
sólo el video mezclado no distingue una cama alta de una voz alta.

**La cama se mide en sonoridad, no en volumen.** Un `volume` fijo no significa
nada: una pista comprada llega a −14 LUFS y una sintetizada a −24, así que el
mismo número deja una inaudible y la otra encima de la voz. Se normaliza con
`loudnorm` a `MUSICA.lufs` y recién ahí se la acuesta bajo la narración. `loudnorm`
devuelve **192 kHz sí o sí**, así que el `aresample` va después: antes, la cama
entraba a la mezcla al triple de velocidad y sonaba a cinta acelerada.
`npm run musica:cama` sintetiza dos con ffmpeg para arrancar sin nada: una en
modo menor para institucional y otra en modo mayor **con pulso** para campañas.
El clima no es decoración — el menor suena a reflexión y sirve para "así
trabajamos"; para que alguien sienta ganas de poner plata hace falta modo mayor,
más brillo y un pulso audible, que es lo que da sensación de que algo avanza. El
pulso va **sólo en la nota grave y más fuerte que las sostenidas**: parejo con el
acorde, la modulación cae de 6 dB a 4 y la cama vuelve a ser quieta. La cama
se aparta sola cuando alguien habla (`sidechaincompress` con la voz de cadena
lateral): sin eso hay que elegir entre una cama inaudible y una voz tapada, y las
dos suenan a video hecho a las apuradas. **Nada de esto puede hacer fallar un
video**: sin biblioteca se filma en silencio, y una imagen que no se pudo mostrar
vuelve como aviso en el resultado de la herramienta —que es lo único que el
agente puede leer para corregir el guion— en vez de tirar la corrida abajo.

**Un archivo por entregable y formato**, no uno por versión: `key.pdf`, no
`key-v3.pdf`. Con la versión en el nombre cada re-exportación dejaba otro
archivo y pedir un PDF terminaba en v1, v2 y v3 conviviendo. La versión va en la
portada, y al exportar se borran los `key-vN.ext` que dejó la forma vieja.

**`write_artifact` rechaza lo que no es un entregable** (`revisarCalidad`): un
título que habla del proceso interno —"Ciclo 2", "Bandeja de entrada"— o un muro
de texto de más de 400 caracteres sin una sola sección. El render maqueta lo que
recibe, pero no puede inventar una estructura que no está. Se verifica en la
herramienta y no solo en el prompt: un agente puede ignorar una instrucción,
no al ejecutor.

Tres trampas de pdfkit que ya costaron caro: escribir debajo del margen inferior
**agrega una página** —el pie duplicaba el documento— así que se baja
`page.margins.bottom` mientras se dibuja; en texto `continued` la posición y el
ancho van solo en el primer tramo, o cada negrita parte el párrafo; y las fuentes
estándar usan WinAnsi, así que un emoji sale como mojibake —"✅ Sí" se imprimía
"' Sí"— y hay que descartarlo (`sinEmoji`).

En las tablas, cada columna necesita un **ancho mínimo igual al de su palabra más
larga**: sin eso el reparto proporcional parte las palabras al medio. Y una línea
en blanco entre grupos de filas **no** termina la tabla: los agentes separan así
los bloques, y cortar ahí dejaba media tabla maquetada y el resto como texto con
pipes a la vista.

Los entregables son **de la empresa, no de la corrida**: al arrancar se cargan
los de corridas anteriores (`listArtifactsByCompany`), así un área lee lo que
otra escribió y lo versiona en vez de reiniciar en v1. Los previos no se
re-persisten y `list_artifacts` los marca como de otro trabajo.

La salida va a `data/proyectos/<Nombre>/salida/`, en carpetas: la habilidad acepta
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

**`check_activity` deja auditar lo que un agente hizo, no lo que contó.**
`RunState.activity` registra cada llamada a herramienta con su resultado real —lo
graba el agent loop, no el agente— y la herramienta lo expone filtrable por rol.
Es lo único que detecta la clase de error más repetida: ejecutar algo con éxito
y después informar que no se pudo. Se conservan las últimas 500 entradas.

**Las herramientas de coordinación se otorgan siempre.** `packages/tools/src/registry.ts`
las expone sin mirar `role.toolIds`; `toolIds` solo controla capacidad y MCP. Si
tocás la UI de asignación, no las presentes como si se pudieran quitar.

**Las bandas de precio de los tiers son disjuntas a propósito**
(`packages/llm/src/tiers.ts`). Sin piso, `standard` y `smart` resuelven al mismo
modelo; sin techo, `smart` elige algo de US$60/MTok y un turno se come el
presupuesto. Los `QUALITY_HINTS` penalizan variantes `-fast` (cobran el doble por
velocidad, no por calidad).

**El modelo de un turno puede elegirlo la dificultad, no el rol.** Con
`model.escalado.activo` (campo de `modelSelectionSchema`, default `null` para
que las filas viejas parseen), el motor mide el turno con las mismas señales de
`presupuestoDeIteraciones` —bandeja, tareas, contexto— más autoridad,
reanudación y fallos consecutivos (`RunState.fallosConsecutivos`, leído de
`activity`, sin estado mutable por turno) y elige el tier dentro del rango
`tierMinimo..tierMaximo`. La función es pura (`packages/engine/src/dificultad.ts`)
y los cortes están fijados con tests: más señales nunca bajan el tier. Un
`modelSlug` fijo apaga el escalado — el slug gana siempre. **Todo turno emite
`model.selected`** con su `motivo`; la cronología sólo dibuja los escalados. Los
convocados y los roles aprobados nacen con escalado acotado por autoridad
(`conEscaladoPorAutoridad` en `runtime.ts`); una empresa en tier `free` no
escala a modelos pagos — iría derecho a un 402.

**Los servidores MCP conocidos se instalan desde la tienda, no pegando JSON.**
`CATALOGO_MCP` (`packages/shared/src/tienda-mcp.ts`) es un catálogo curado en el
repo —validado por schema en CI, no en runtime— con categoría, ícono Lucide y
`envRequeridas` declaradas de antemano: una credencial faltante se dice **al
instalar**, no en un handshake fallido de después. `Runtime.instalarServidoresMcp`
hace el ciclo completo (dedupe → chequeo de env → alta → sync esperando el
handshake → descubrir → otorgar opcional) y lo reusan la aprobación de
solicitudes, la tienda y nada más lo duplica. Pegar JSON sigue existiendo en el
Hub para lo que no está en el catálogo. El CRUD de `mcp-servers` ya no es el
`registerChild` genérico: el alta deduplica por nombre (409, el nombre es parte
de `mcp__<servidor>__<tool>`) y sincroniza al toque, y **el borrado va en
cascada** — disconnect del bridge, `deleteToolsByMcpServer` y
`podarToolIdsHuerfanos`, o quedan herramientas fantasma y roles apuntando a ids
muertos.

**Un proyecto puede nacer con equipo.** `PLANTILLAS_EQUIPO`
(`packages/shared/src/plantillas.ts`) trae organigramas probados extraídos de
los seeds; `Runtime.generarEquipo` los materializa resolviendo nombres de
herramientas contra el catálogo y **nombrando las faltantes** (las condicionadas
al entorno —imágenes, navegador— pueden faltar legítimamente). El proveedor de
los agentes nuevos sale de `proveedorPreferido()` — `claude-sesion > anthropic >
claude-code > openrouter` — nunca de un hardcodeo. Los `mcpSugeridos` de la
plantilla **no se instalan solos**: conectar lo decide una persona, desde la
tienda.

**La navegación vive en la URL.** react-router v7 en modo librería:
`/p/:companyId/{empresa,proceso,tablero,tienda,mcp,…}` con shell de sidebar
(App.tsx). "Qué proyecto está abierto" ya no es estado de React: al borrar una
empresa se navega a `/proyectos` (el reemplazo de `onCompanyGone`). El tema
claro/oscuro va por tokens indirectos (`--t-*` en styles.css) con
`data-theme` y default al sistema, aplicado en `index.html` **antes del primer
pintado** para que la carga no parpadee; los componentes usan los mismos nombres
de clase de siempre (`canvas`, `ink`, `surface`). Los componentes compartidos
nuevos viven en `apps/web/src/ui/` (Modal sobre `<dialog>`, Toast, ConfirmDialog,
Badge, Tabs…); `lib/ui.tsx` se reexporta desde ahí durante la transición —
importá de `ui/index.js`.

**Una misión es la receta de una corrida, más cuándo repetirla.** No confundir
`mode: "cron"` de una corrida —que pacea los ciclos *dentro* de una corrida— con
una **misión** (`misionSchema`, `apps/server/src/misiones.ts`), que es un encargo
que se dispara solo. El próximo disparo se guarda en la base (`proximaAt`), no en
un timer: un timer por misión se pierde entero al reiniciar y obliga a
reprogramarlo cada vez que alguien edita la misión. El planificador se despierta
cada `MISION_TICK_MS`, mira qué venció y larga.

El cálculo de cuándo toca es puro y vive en `packages/shared/src/programacion.ts`,
separado del servidor a propósito: el bug clásico de un scheduler es que anda en
la máquina de quien lo escribió y no el domingo a medianoche. Tres formas, las
mismas del nodo Schedule de n8n —intervalo, día y hora, o cron—. Dos cosas que se
verifican con tests y no se dan por obvias: el próximo disparo es **estrictamente
posterior** a `desde` (si no, una misión que acaba de correr se redispara en el
mismo minuto para siempre), y una expresión inválida deja `proximaAt` en `null` en
vez de disparar a cualquier hora. En cron, día-del-mes y día-de-semana
restringidos son un **OR**, no un AND: es el comportamiento histórico, y con AND
`0 0 1 * 1` casi no dispararía.

**Una misión no larga una corrida si la empresa ya tiene una viva**
(`tieneCorridaViva`): dos equipos completos escribiendo sobre los mismos
entregables se pisan, y queda una versión que mezcla dos trabajos. Se pierde el
turno y se reprograma, que es más sano.

**Publicar es lo único del circuito que un agente no puede hacer.** La misión
produce, avisa por correo y espera. `ExportStore.publicar` mueve el archivo a
`publicado/`, así "aprobado" es un hecho verificable en el disco y no un estado
que hay que creer. El botón está en la pestaña Salida.

**El correo sale por un webhook de n8n, no por SMTP.** `packages/tools/src/correo.ts`
le pasa el mensaje al flujo y ese decide con qué cuenta sale; el contrato usa
nombres en inglés (`to`, `subject`, `text`, `attachments`) porque son los campos
del nodo Send Email, y así el otro lado es un mapeo y no una traducción. Los
adjuntos viajan como **enlace al servidor local**, no como bytes: sirve para que
quien recibe el aviso lo abra desde la misma red, no desde cualquier lado. Sin
`N8N_EMAIL_WEBHOOK_URL` la herramienta falla diciendo exactamente qué falta y de
quién es el problema.

**El trabajo abierto sobrevive a su corrida; lo terminado no vuelve.** Un
encargo largo no entra en una corrida, y hasta acá la siguiente arrancaba con
el tablero vacío: los entregables sobrevivían, las tareas no. Ahora
`listTasksAbiertasByCompany` las carga en `CompanyConfig.tasks` y `RunState`
las **adopta** —pasan a la corrida nueva, con `heredadaDeRunId` recordando de
dónde vienen—, así que sus dueños arrancan con trabajo pendiente y el scheduler
los convoca desde el primer ciclo. `done` y `cancelled` quedan afuera: lo
terminado no es trabajo, y su registro vive en la traza.

**Supervisar es mirar el tablero, no preguntarle a los agentes.**
`estado_del_proceso` (coordinación, `readOnly`) da la foto del encargo: tareas
de **todos** los roles con lo trabado, entregables, quién no ejecutó nada y los
últimos fallos. `check_activity` responde "qué ejecutó cada uno" y
`list_my_tasks` sólo lo propio; faltaba "dónde está trabado el trabajo" — y sin
eso supervisar era creerle a un agente que informa como hecho lo que no hizo,
que es el error más repetido del sistema. Corregir sigue siendo `update_task` +
`assign_task` + `send_message`.

**Una corrida no sobrevive al reinicio, y ahora se nota.** El estado vivo está
en memoria; con un apagado ordenado quedan en `stopped`, pero una caída dura
las dejaba en `running` para siempre — la UI mostraba una corrida en curso
inexistente y `tieneCorridaViva` bloqueaba las misiones de esa empresa.
`Store.sanearCorridasHuerfanas()` corre al arrancar el servidor y las cierra
explicando por qué.

**Todo lo que pasa tiene que emitir un evento.** El motor emite a `EventBus`, el
servidor persiste y reemite por SSE, y la UI deriva su estado de la traza — no
hace polling. "Ver en vivo" y "retroceder en el timeline" son la misma operación.
Un paso que no emite evento es un paso invisible: agregá la variante en
`packages/shared/src/events.ts`.

**Un CLI que cierra mal no significa que el agente no haya trabajado.** Los dos
proveedores que delegan rescatan lo que alcanzaron a producir: `opencode` cuando
se corta por tiempo (`hayTexto`) y `claude-code` cuando el CLI termina con
`is_error` (`ultimoTextoDeAsistente`). Sin eso el turno se registra como fallido
y **sin resumen** aunque el trabajo esté hecho: medido, un verificador hizo 27
llamadas, escribió su entregable y movió su tarea; falló su última llamada, el
CLI cortó a las 33 vueltas y se perdió el turno entero. El costo no es sólo el
resumen — un fallo alimenta `fallosConsecutivos`, así que el medidor de
dificultad escala el turno siguiente a un modelo más caro por un fracaso que no
ocurrió. Los mensajes `<synthetic>` se saltean: los fabrica el propio CLI al
cortar, no son del agente. Y el texto rescatado va con su aviso pegado, porque
un resumen a medias sin aviso se lee como trabajo terminado.

**Emití `agent.turn_end` en `finally`.** Si un turno falla y no lo emite, el nodo
del organigrama queda "pensando…" para siempre.

**El loop corta al agente que repite una llamada fallida.** A la tercera vez con
la misma herramienta y los mismos argumentos se le inyecta un mensaje pidiéndole
que cambie de enfoque, y si insiste se termina el turno. Sin eso, un error que el
modelo no puede resolver —una ruta MCP fuera del directorio permitido— le come
las `maxTurns` enteras y la corrida se queda sin entregable.

**El ciclo es una cadena, no una ronda: nadie corre dos veces por tick.** Lo que
un agente entrega lo toma **en el mismo ciclo** quien todavía no trabajó; quien
ya tuvo su turno espera al siguiente. Antes el retardo era total —todo lo
emitido caía en las bandejas del ciclo *siguiente*— y en una cadena eso se paga
carísimo: con guion → rodaje → revisión, cada eslabón costaba un ciclo entero y
cada ciclo reenvía el contexto completo de cada turno. Medido acá: corridas de
269 llamadas a herramientas que avanzaron 3 ciclos, o sea el trabajo estaba
hecho y el tiempo se iba esperando.

Lo que el retardo protegía sigue protegido, y por eso el cambio es seguro: la
cota "una vez por rol y por ciclo" hace **imposible** el ida y vuelta infinito
dentro de un tick, que era su verdadera razón de ser. Hay un test con dos
agentes que se escriben sin parar y que igual corren una sola vez cada uno.

**El orden dentro del ciclo no es casual** (`ordenarPorUrgencia`): primero quien
tiene un pedido sin contestar —ese bloqueo se propaga—, después el peso del
trabajo propio, y al final quien viene encadenando errores. Con la concurrencia
acotada, ese orden decide el ciclo.

**Una lección es un reclamo que requiere evidencia, no un hecho a guardar.** `record_lesson` exige el argumento `evidence` y el ejecutor rechaza la lección de un agente cuya actividad en la corrida no muestra ninguna herramienta más allá de mensajes (la lista `HABLAR_NO_ES_EVIDENCIA` en packages/tools/src/coordination.ts — el corte es por nombre y no por origin, porque los fallos de edit_artifact también son de coordinación y son exactamente la evidencia que se pide). El caso que lo motivó: un rol concluyó que edit_artifact estaba rota —era el índice de read_artifact el que le mostraba secciones duplicadas inexistentes— y la lección falsa entró a la memoria de la empresa, lista para degradar todas las corridas siguientes. Además `timesConfirmed` ya no cuenta repetición textual: confirmar exige otro autor u otra corrida, y queda registrado quién en el campo `confirmaciones`.

**Refutar no es borrar.** Una lección falsa se marca `estado: "refutada"` con su motivo (PATCH /learnings/:id, o desde la pantalla Memoria), deja de entrar al prompt (buildMemorySection la filtra) pero la fila queda: el registro de por qué se creyó y por qué era falso evita re-aprender el mismo error. La refutación es humana a propósito: un agente que discrepa registra la corrección con evidencia y la tensión la resuelve una persona. En el vault, la nota muestra las refutadas tachadas en una sección propia, y la nota ya no invita a editarla a mano (el espejo es unidireccional: lo editado a mano se pisa — la memoria se edita desde la UI). El prompt ya no dice "dalo por válido": gradúa la confianza por confirmaciones y muestra la procedencia (autor y fecha) de cada lección.

**`Store.listLearnings` parsea por Zod, y no es un detalle.** `Store.many` hace JSON.parse crudo, así que los `.default()` del esquema no se aplican solos; las filas guardadas antes del cambio de esquema no tienen `estado` ni `confirmaciones`, y sin el parse en la lectura el filtro de refutadas compararía contra undefined. Es el único punto de lectura de learnings — si se agrega otro, tiene que parsear también. La regla de dedupe (`normalizarLeccion`) vive en @orq/shared porque la memoria entra por dos puertas (record_lesson y el POST de la API) y con dos copias de la regla lo que una puerta consideraba repetido la otra lo creaba de nuevo.

**Lo que la empresa sabe vive en dos lugares, y la línea la fija la aritmética.**
La memoria corta —una lección de un párrafo— sigue en la base y viaja en el
prompt de cada turno; lo largo vive en un **vault de Obsidian** por empresa
(`ContextoStore`, `CONTEXTO_DIR`, una rama por empresa) y se abre con
`leer_contexto` sólo cuando hace falta. No es gusto: medido acá, una llamada a
herramienta dentro de un turno delegado cuesta **una iteración entera**, o sea
20.000 a 28.000 tokens de prefijo reenviado, así que por debajo de ~800
caracteres sale más barato **mandar** que ir a buscar, y por encima, al revés.
El **mapa** del árbol viaja en el prompt y el contenido no: medido en la empresa
del video, 465 tokens de mapa apuntan a 59.743 caracteres de conocimiento — 32 a
1. El mapa se acota por tamaño y no sólo por cantidad, misma lección que la
memoria.

**Una nota tiene que ser legible *desde Obsidian*, no sólo desde un `cat`.**
Tres cosas que no son cosméticas: **línea en blanco antes de cada `##`** —sin
ella markdown no lo toma como encabezado y la nota sale como un bloque de texto
plano—, **frontmatter** con empresa, tema, cantidad y fecha, que es lo que
Obsidian muestra como propiedades y lo que hace el vault filtrable, y
**enlaces**. Sin `[[…]]` entre notas el grafo es una estrella desde el índice y
no dice nada: las notas se enlazan con las de su misma familia —la primera
palabra del tema, así `inspia:escena-8` encuentra a `inspia:escena-9`— y todas
vuelven al índice. Medido al arreglarlo: de 20 enlaces a 258, y de 0 notas con
propiedades a 24. La fecha entra formateada desde el llamador, como en el render
de documentos: el renderizador no tiene reloj.

**La memoria nueva llega sola al árbol.** `record_lesson` de un agente y el alta
por API de una persona **espejan las dos** (`Runtime.espejarAprendizajes`): si
sólo espejara la primera, lo que carga una persona no aparecería en Obsidian y
el vault mentiría por omisión. Se reescribe la nota del tema entera, no se
agrega al final, así la nota se lee como un documento y no como un log.

**El vault NO pasa por el plugin de Obsidian, y eso es la decisión.** Un vault es
una carpeta con markdown: escribirlo por el filesystem evita una segunda
instancia de Obsidian, un segundo puerto y un segundo token — y sobre todo evita
que el contexto **dependa de que una aplicación de escritorio esté abierta**,
que ya nos falló media tarde. Es la regla de ffmpeg, Kokoro y Chrome: usar lo que
hay y degradar con aviso. Obsidian queda como visor y editor, que es donde
aporta: el grafo, la búsqueda y poder **corregir a mano** lo que el sistema
aprendió mal. `escribir_contexto` reemplaza la nota entera, así que quien
escribe último decide; lo que edita una persona se lee tal cual hasta que un
agente lo reescriba.

Dos cuidados: la ruta que propone un modelo se sanea segmento por segmento
(`ExportStore.safePath`) y se le fuerza `.md`, porque un `.txt` en el medio no se
indexa, no entra en el grafo y rompe los enlaces `[[…]]`; y `buscar_contexto`
devuelve **dónde** apareció, no el párrafo, por la misma razón que todo lo
demás — lo que entra a un turno delegado se reenvía en cada vuelta.
`npx tsx scripts/vault-contexto.ts <companyId>` vuelca la memoria de la base al
árbol: en la empresa medida había 58 lecciones y entraban unas diez, así que 48
existían sin que ningún agente pudiera verlas ni pedirlas.

**Los entregables sobreviven a que se borre su corrida.** `artifacts.company_id`
existe para eso, y `listArtifactsByCompany` filtra por ahí en vez de unir con
`runs`. `deleteRun` se lleva eventos, mensajes, tareas, aprobaciones y ledger
—el registro de *cómo* se llegó— pero nunca los artefactos. Limpiar la lista de
corridas no puede costarle a la empresa el trabajo que produjo.

**Borrar una empresa toca tres lugares, no uno** (`Runtime.eliminarEmpresa`).
`store.deleteCompany` limpia la base, pero el runtime de empresa sostiene
**procesos de servidores MCP** —que no se caen porque borres filas— y
`data/exports/<empresa>/` queda con todo lo producido y sin ninguna pantalla
desde la cual verlo, porque todas navegan por empresa. `olvidarEmpresa` es
`olvidarCorrida` un nivel más arriba y existe por lo mismo. En la UI, además, hay
que soltar la empresa seleccionada (`onCompanyGone`) o la pantalla queda cargando
un id muerto para siempre.

**`TABLAS_POR_EMPRESA` y `TABLAS_POR_CORRIDA` se comparten** entre el borrado en
cascada y el barrido de residuos (`Store.residuos` / `purgarResiduos`). Una tabla
nueva agregada en un solo lado deja basura que el barrido no ve, o hace que el
barrido se lleve filas que sí tenían dueño. `artifacts` va en la de empresa
—sobrevive a su corrida, no a su empresa—; `runs` no está en ninguna porque su
cascada se hace a mano, pero `residuos()` la cuenta aparte.

**Un diagnóstico tiene que anunciar exactamente lo que va a borrar.** El barrido
decía 1 fila y borraba 3: no contaba la corrida huérfana ni sus mensajes, porque
comparaba contra `runs` a secas y esa corrida todavía existía. Se compara contra
las corridas que **van a sobrevivir**. Un botón destructivo que subdeclara no se
vuelve a creer, y hay un test que lo fija.

**Consultar el disco no puede escribirlo.** `ExportStore.dirFor` crea la carpeta
al pasar, así que un barrido de carpetas residuales que lo use **produce los
residuos que viene a buscar**: pedir el árbol de una empresa borrada alcanzaba
para dejarla de nuevo en disco. Todo el camino de medición usa `pathFor`.

**Vaciar la salida se guía por el manifiesto, no por la extensión.** El logo es
un `.png` que subió una persona, vive en una ruta fija y no se vuelve a generar
solo: un `kind: "all"` se lo lleva. Y `VACUUM` va suelto y al final — SQLite no
lo admite dentro de una transacción—, porque sin compactar el archivo pesa lo
mismo después de purgar y parece que la limpieza no hizo nada.

**`claude-sesion` es el mismo adaptador de Anthropic con otra credencial.**
`ClaudeSesionProvider` existe como `providerId` aparte —y no como una opción de
`anthropic`— porque un rol elige proveedor **por id**: separados, le podés dar la
sesión de `ant auth login` a un agente y la API key al resto. Tres cosas que no
se ven leyendo el archivo: el token va como `Authorization: Bearer` **y** exige
el beta `oauth-2025-04-20` (sin él, `/v1/messages` rechaza un token válido); el
SDK instalado todavía no lee el perfil de `~/.config/anthropic/`, así que hay que
exportar `ANTHROPIC_AUTH_TOKEN` a mano —el cliente se construye vacío para que el
día que el SDK lo soporte ande solo—; y una **`ANTHROPIC_API_KEY` vacía gana
igual** su lugar en la cadena y autentica en blanco, por eso `buildRegistry` la
borra del entorno al prender la sesión. No es la suscripción de claude.ai: sigue
facturando como API.

**Los precios de Claude son una tabla curada, no vienen de la API.** La API de
Anthropic no los publica; `modelos-claude.ts` (`packages/llm`) los completa con
precios de lista fechados, así `computeCost` valoriza tokens y **`budgetUsd`
corta de verdad** con `anthropic` y `claude-sesion`. El costo es una estimación
por precio de lista, no un `reportedCostUsd`. Los tiers de esos proveedores
tampoco pasan por las bandas de `tiers.ts`: con precios reales, Haiku
(US$1.80 mezclado) y Sonnet (US$5.40) caerían los dos en la banda `standard` —
`resolverTierEstatico` asigna el tier por mapa (cheap=Haiku, standard=Sonnet,
smart=Opus) y las bandas quedan para catálogos heterogéneos como OpenRouter.
Cuando sale un modelo nuevo, se agrega una fila a `PRECIOS_CLAUDE` y listo. En
`claude-code` el costo sigue en 0 a propósito: la suscripción no factura por
token.

**`opencode` es la segunda suscripción, y se integra como la primera.**
`packages/llm/src/adapters/opencode.ts` delega el turno entero al CLI de
opencode, igual que `claude-code`: el motor ve cero `tool_calls` y corta en la
primera iteración. Qué credencial usa lo decide `opencode auth login` —el plan
de Zen, una sesión de Anthropic, Copilot, una API key propia—, así que **el
catálogo depende de la máquina**: sale de `opencode models` (428 slugs acá) y no
de una tabla. Tres cosas que no se ven leyendo el archivo. Los slugs **ya vienen
namespaceados** (`opencode/claude-sonnet-5`, `zai/glm-5`) y se guardan tal cual:
volver a prefijarlos con el id del proveedor daba `opencode/opencode/…`, que el
CLI no conoce. Los tiers salen del mapa curado de `modelos-claude.ts` con listas
que **cruzan proveedores** (Zen → Anthropic → Copilot, gana el primero que
exista), porque sin precios las bandas no resuelven ni uno; `free` va a los que
Zen marca con sufijo `-free` (`opencode/deepseek-v4-flash-free`), que es el
único tier afirmable sin saber en qué plan está la cuenta — y el que deja probar
una empresa entera con la credencial sin saldo. Y el costo
que informa el CLI **no** se reporta por default (`ORQ_OPENCODE_COSTO=1` lo
prende): bajo un plan dispararía `budgetUsd` cortando corridas que no cuestan
dinero, pero con créditos por uso el gasto es real y ahí conviene contarlo.

**Un turno delegado que se corta por tiempo no puede tirar el trabajo.** La
salida del CLI llega **recién al final**, así que un corte a mitad de camino se
lleva el turno entero: lo medimos con un agente que hizo 31 llamadas útiles
—leer entregables, loguearse, navegar hasta la no conformidad, sacar la captura—
y murió a los diez minutos sin dejar ni un resumen. Ahora, si alcanzó a emitir
texto, ese texto vuelve como resultado con `AVISO_DE_CORTE` pegado (va en el
texto y no en un campo aparte porque es lo único que la organización lee: un
resumen a medias sin aviso se lee como trabajo terminado). Y el corte de
`opencode` es de **veinte** minutos, no los diez de Claude Code: los modelos
gratuitos van en cola y son lentos, así que copiar aquel número era garantizar la
muerte por tiempo. Se ajusta con `OPENCODE_TIMEOUT_MS`.

**La configuración de opencode se fusiona, no se reemplaza.** El turno escribe
su propio `OPENCODE_CONFIG`, pero la del usuario (`~/.config/opencode/`) sigue
en pie: sus servidores MCP globales también le llegarían al agente, y con ellos
una vía de escribir que el org no ve. Por eso el agente del turno arranca con
`"*": false` y habilita sólo lo suyo — las de lectura, y las del org, que
opencode nombra `<servidor>_<tool>` y se toman con `orq*`. La regla de sólo
lectura sobre el directorio de la empresa es la misma que en Claude Code y por
los mismos tres motivos, con un cuidado extra: se corre con `--auto` porque un
pedido de permiso interactivo deja el proceso esperando para siempre —la falla
de "un proveedor que no contesta cuelga la corrida"—, así que lo que no se
quiere que pase se **niega** explícito (`edit`, `bash`) en vez de dejarse en
"preguntar". `configDelTurno` y `construirArgs` están exportadas justo para
poder fijarlo con tests.

**Qué proveedores delegan es una propiedad del proveedor, no una lista en el
motor.** `LlmProvider.delegaElTurno` es lo que hace que `loop.ts` les preste el
puente MCP del org (`claude-mcp.ts`, que es agnóstico del CLI: lo único que
cambia es cómo cada uno declara el servidor). Antes era `provider.id ===
"claude-code"`, y con eso sumar un CLI obligaba a tocar el motor.

**Una empresa creada por la API tiene que sembrar sus herramientas**
(`Runtime.sembrarHerramientas`, en `POST /api/companies`). Es el mismo problema
que el seed: sin filas en `tools`, `role.toolIds` no puede apuntar a nada y el
proyecto nace sin nada que asignarle a un agente. Sólo `capability` y `skill`;
las de coordinación se otorgan siempre y mostrarlas las presentaría como
quitables.

**"Proyecto" es el rótulo de una pantalla, no una entidad.** `apps/web/src/routes/Proyectos.tsx`
gestiona empresas y las llama proyectos porque esa es la unidad de trabajo; el
dominio sigue siendo `Company` y adentro se sigue hablando de empresa, agentes y
departamentos. No renombres el dominio: toda la metáfora del producto es
organizacional y sin ella el organigrama no significa nada.

**El resumen de proyectos se cuenta con `GROUP BY`, y parte de `listCompanies`.**
Traer las filas para contarlas se lleva el contenido entero de cada entregable a
memoria; y un `GROUP BY` a secas **pierde los proyectos vacíos**, que son
justamente los recién creados.

**Una habilidad no se otorga sola.** `ToolRegistry.forRole` sólo regala las de
coordinación: `origin: "skill"` y `origin: "capability"` dependen de `toolIds`.
Si armás una empresa por código, registrá también las habilidades en la tabla
`tools` —`npm run db:seed` filtraba sólo `capability`, así que sus roles no
podían exportar nada— o vas a ver a un agente explicando que no encuentra
`export_video`.

**Un proveedor que no contesta cuelga la corrida entera.** No basta con manejar
el error: un endpoint que acepta la conexión y se queda callado deja el turno
esperando para siempre —el agente no falla, no sigue, y no se le puede pedir que
cambie de enfoque—. Toda llamada de red que salga de una herramienta lleva corte
por tiempo (`imagenes.ts`, `CORTE_MS`). Lo medimos con el endpoint de imágenes de
NVIDIA, que hoy no responde.

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

**En un turno delegado, la cantidad de llamadas pesa más que el tamaño de cada
resultado.** El costo de un loop de agente es cuadrático en su largo —cada
vuelta reenvía el prefijo entero, 20.000 a 28.000 tokens—, así que devolver un
índice para que el agente pida 18 secciones cuesta **dos órdenes de magnitud
más** que mandar el documento de una vez: 18 vueltas contra ~5.000 tokens.
Medido acá: 132 lecturas sobre 298 llamadas de un ciclo, con un informe leído
entero, sección por sección, una vez por turno — 90 lecturas del mismo
documento en cinco turnos. Por eso `TOPE_ENTERO` pasó de 4.000 a **15.000**
caracteres (la default es el documento entero, el recorte es la excepción — el
mismo criterio que la herramienta `Read` de un agente de código) y `seccion`
acepta **varias separadas por coma**. El techo no es libre: lo que entra a un
turno delegado se acota a `TOPE_RESULTADO` (16.000) en `acotar.ts`, así que
mandar más sería mandar algo que llega cortado. **Los dos números están
acoplados**; si movés uno, mirá el otro.

Lo que **no** hay que hacer es memoizar la relectura *entre* turnos. El memo por
turno ya existe (`claude-mcp.ts`) y funciona; entre turnos la conversación del
CLI se reinicia, así que releer es legítimo y devolver un puntero ahí le sacaría
al agente un documento que ya no tiene. La relectura no es el problema: el
problema era que cada lectura costaba 18 viajes.

**Para buscar se parte el documento; para mostrarlo, no.** `bloques()`
(`busqueda.ts`) corta los tramos de más de 1.200 caracteres y **repite el
título en cada uno** —para puntuar un fragmento alcanza y sobra— pero usarla
para el índice de `read_artifact` miente dos veces, y las dos las pagamos en la
misma corrida. Un informe de **18 encabezados se anunciaba como 23 secciones**,
con cinco títulos apareciendo dos veces; dos agentes leyeron eso como
encabezados duplicados y gastaron nueve llamadas fallidas más una reescritura
entera del documento en corregir un archivo que estaba sano. Y al rearmar el
texto de una sección había que reponer los `#` a mano, con `##` fijo: en la
costura entre dos tramos aparecía un `## Resumen ejecutivo` **que el documento
no tiene**, el agente lo copiaba a un `buscar` —hacía bien: es lo que le
mostramos— y `edit_artifact` no lo encontraba nunca. `secciones()` corta por
encabezados reales, conserva el nivel (`###` sigue siendo `###`) y devuelve un
**recorte literal**, que es lo único que se puede copiar a un `buscar`. Cuando
la lectura muestra varias secciones seguidas lo **avisa**: en el documento no
van necesariamente juntas, y pegarlas describe un texto que no existe.

El corolario vale para cualquier herramienta: **si un agente concluye que una
herramienta está rota, sospechá primero de lo que la herramienta le mostró.**
Acá la lección quedó grabada en la memoria de la empresa —"`edit_artifact` no
sirve para multilínea, reescribí el documento entero"— y de ahí en más iba a
inducir el gasto en todas las corridas siguientes. Un falso positivo persistido
es peor que el error que lo causó.

**Borrar una lección también se espeja al vault.** El alta llamaba a
`espejarAprendizajes` y la baja no, así que Obsidian conservaba entera una
lección ya borrada de la base — el vault mentía por comisión, que es peor que
por omisión: nadie sospecha de una nota que está ahí. Y un tema que se queda
sin lecciones se **borra**: reescribir la nota no alcanza cuando no queda nada
que escribir.

**La fila de un servidor MCP serializa, pero no espacia.** Son cosas distintas
y el límite de tasa pide la segunda: dos agentes del mismo ciclo salen uno
detrás del otro y, si el primero contesta en medio segundo, las dos llamadas
caen dentro del mismo segundo. Con Brave en plan Free —una consulta por
segundo— eso es un 429 garantizado, y lo medimos con dos búsquedas estampadas
en el mismo segundo: la primera con resultados, la segunda rechazada. El
reintento va **dentro** de la fila (`bridge.ts`): esperar afuera dejaría entrar
otra llamada en el hueco, contra el mismo límite. Se reconoce por el **texto**
—un servidor MCP no devuelve códigos, devuelve el mensaje que armó con la
respuesta de su API— y se le hace caso al `retry-after` cuando viene, acotado
para que uno disparatado no congele la fila. Dos reintentos y no más: si el
límite es de cuota diaria y no de tasa, insistir no lo arregla y sólo demora el
turno del resto.

**Lo que editás en la configuración tiene que llegar a la corrida que está
andando.** Para el borrado ya estaba resuelto (`removeRoleFromLiveRuns`); para
la edición no, y ahí el síntoma es peor porque **nada falla**:
`Runtime.actualizarRolEnCorridasVivas` (enganchado al guardado de roles) refleja
el rol editado en cada corrida viva e **incorpora al catálogo de la corrida** las
herramientas nuevas antes de otorgarlas —un `toolIds` que apunta a algo que la
corrida no tiene en catálogo no le agrega nada al agente; lo ejecutable ya está,
porque el `ToolRegistry` es el de la empresa y lo comparten—. Lo medimos con
Brave instalado desde la tienda, conectado y `ready`, con sus dos tools
otorgadas a los tres roles: la base impecable, cero invocaciones, y una corrida
entera insistiendo con `web_search` —que su proveedor no soporta— teniendo al
lado el servidor que sí podía buscar. Ojo con el otro lado del mismo hueco: la
tienda instala **sin otorgarle a nadie**, así que después de instalar hay que
asignar las herramientas a un rol o no las usa nadie.

**Qué corrida se puede continuar es una sola pregunta, y tenía tres respuestas
distintas.** `esCorridaTerminal` (`packages/shared/src/schema.ts`) es la única
lista de estados de los que una corrida no vuelve; la usan el motor, el servidor
y la UI. Antes cada lado la escribía por su cuenta y en negativo —"todo lo que no
sea `running`, `paused` o `idle`"— y así `awaiting_approval` caía entre las
terminadas: la pantalla decía "terminada" y ofrecía **borrar** una corrida que
sólo esperaba una respuesta. Por lo mismo el freno de borrado usa
`Runtime.sePuedeContinuar` (en memoria y no terminal) y no `estaViva` (sólo
`running`): con `estaViva`, "limpiar terminadas" se llevaba puestas las
pausadas.

**Pausar es un pedido, no un estado.** En modo continuo el estado no alcanza:
entre ciclo y ciclo ya es `paused`, y el bucle arrancaba el siguiente igual —el
botón parpadeaba y la corrida seguía, así que la única forma de frenar era
terminarla, que no se puede continuar—. `Orchestrator.pause` deja
`pauseRequested` y `runContinuous` lo mira antes de cada ciclo; `tick()` y
`runContinuous()` lo limpian al entrar, porque avanzar es la contraorden de
pausar y una pausa vieja no puede frenar el ciclo que alguien pidió después. El
turno en vuelo no se aborta: la pausa se hace efectiva al cerrar el ciclo, que
es lo que promete el botón. `awaiting_approval` no se pisa con `paused`: esa
espera ya frena la corrida y su motivo es lo único que explica por qué no
avanza. Y `Runtime.pause` **persiste** el snapshot como `stop`, o la fila queda
en `running` y una caída la deja informando que avanzaba.

**Contestar reanuda, apruebes o respondas.** `reanudarSiEsperaba` corre también
desde `paused` y mira las dos cosas pendientes —solicitudes y aprobaciones—,
porque resolver la última aprobación deja la corrida en `paused`: sin eso,
aprobar no hacía nada visible y había que apretar "continuar" a mano, que es
justo lo que esa función existe para evitar.

**Una carpeta legible por proyecto, y la encuentra la marca, no el nombre.**
`directorios.ts` es la única fuente de rutas: `data/proyectos/<Nombre legible>/`
con `salida/`, `repos/`, `worktrees/` y `tmp/` adentro, y un `.empresa` con el
id. Antes la salida iba por id (`data/exports/cmp_msw30yi82fdt1e`), el vault por
nombre, y nadie podía decir desde el Finder qué carpeta era de qué proyecto. Se
busca por la marca para que renombrar no cree una carpeta nueva al lado de la
vieja; dos proyectos homónimos toman `Nombre (abc123)`, y una carpeta sin marca
no se reclama nunca. `ExportStore` recibe la disposición (`porId` para tests y
seeds, `porProyecto` en el servidor) y **leer ya no crea**: `tree` sobre una
empresa sin salida devuelve vacío. Al arrancar, `Runtime.migrarLayout` muda
`data/exports/<id>` **antes de levantar cualquier MCP** y reescribe los
argumentos MCP que apuntaban a la ruta vieja —el Playwright de reconocimiento la
lleva en `--output-dir`—; si una empresa tiene salida en los dos layouts no se
fusiona sola. `publicar` conserva la subcarpeta y contesta 409 en vez de pisar
una versión publicada.

**Renombrar un proyecto no es un PATCH del nombre** (`Runtime.renombrarEmpresa`,
`POST /companies/:id/renombrar`; el PATCH genérico lo deriva ahí si cambia
`name`). La marca hace que no *haga falta* mudar la carpeta, pero una persona lee
nombres, y el vault se resuelve **por nombre**: sin `ContextoStore.renombrar` el
proyecto renombrado abría un vault vacío al lado del que tenía la memoria.
Mudar la carpeta (`Directorios.mudar`) rompe lo que guardaba rutas absolutas, y
son dos cosas: los **worktrees** —git anota la ruta en los dos lados, así que
sin `git worktree repair` un `git status` dentro de la sesión falla; el test lo
fija corriendo git *desde adentro* del worktree, que es como lo abre una
persona— y los **servidores MCP** con la ruta en sus argumentos, que se
reescriben con `reescribirRutasMcp` y se resincronizan. Por eso no se renombra
con una corrida en curso. Un **repo** se renombra sólo de nombre: la carpeta
`repos/<slug>` no se mueve —el slug es técnico y moverlo obligaría a reparar
worktrees por nada— y como el repo también se encuentra por slug, un agente que
todavía dice el nombre viejo en su turno sigue llegando; por eso ese renombre no
pide detener la corrida. El nombre de repo no puede repetirse: es el argumento
`repo=` de las herramientas.

**El orquestador programa, sobre un clon y en una rama.** Una persona carga código
desde la pestaña Código (ruta local o URL git) y el equipo trabaja sobre un
**clon gestionado** en `repos/<slug>`, nunca sobre su carpeta: un `git worktree
add` directo sobre su repo parece inofensivo y escribe en su `.git`, dispara sus
hooks y le deja refs. Hay un test que hashea el `.git` original antes y después.
Una carpeta sin git se **copia** y se versiona en `data/` —no se le hace `git
init` a la carpeta de la persona— y al integrar se copian de vuelta sólo los
archivos tocados, rechazando los que ella cambió desde la base. `.git/info/exclude`
deja afuera `.env*`, `node_modules`, `dist`: sin eso el commit base se llevaba
los secretos y los agentes los podían leer.

La **sesión** (`sesiones_codigo`) es un worktree, uno por repo, y **sobrevive a
la corrida** como las tareas heredadas. **Trabaja en la rama del proyecto**
(`dev` en INSPIA), no en una inventada: la persona tiene su rama, su historia y
su forma de trabajar, y el IDE tiene que estar parado donde está ella —una
`orq/20260925-4t33` en la barra de estado no le dice nada—. Para eso el clon
**suelta** la rama base (queda en HEAD desprendido: git no deja una rama
abierta en dos carpetas) y la adelanta hasta la de la persona antes de abrirla
(`RepoStore.usaRamaDelProyecto`, `soltarRamaDelClon`). Integrar es adelantar
su `dev` con fast-forward (`integrarRamaPropia`); descartar **no borra** la
rama: la vuelve a `origin/<rama>`. Las sesiones viejas en `orq/…` sin trabajo
propio se pasan solas a la rama del proyecto (`alinearConLaRamaDelProyecto`);
con commits se dejan, y se decide desde el panel. Un repo creado por la
empresa o una copia sin git siguen con su `orq/…`: no hay rama de afuera que
respetar.

**Los agentes no commitean: la persona prepara, escribe el mensaje, commitea y
publica** (el flujo de Cursor; `repositorio.commitsAutomaticos`, default
`false`). Lo que edita un turno —por las herramientas del org o por el `Edit`
propio del CLI— queda sin commitear en la rama del proyecto, junto con lo que
haya editado ella, y nada se commitea por nadie (ni lo de la persona antes del
turno, ni `package.json` al instalar una dependencia). Para que cada pedido
del chat se siga pudiendo **ver y deshacer**, el turno toma dos
**instantáneas** (`RepoStore.instantanea`): un `commit-tree` armado con un
índice aparte (`GIT_INDEX_FILE`), anclado en `refs/orq/instantaneas/…`, que no
toca ni la rama ni el índice de la sesión. `codigo.checkpoint` lleva `antes`,
`sha` y `commit: false`; "ver cambios" es el diff entre las dos y "deshacer"
lo aplica al revés sobre el árbol (`deshacerEntre`), y si ella tocó después las
mismas líneas no aplica nada y lo dice. Con `commitsAutomaticos` prendido vuelve
el checkpoint por turno con el rol como autor.

**Publicar** (antes "integrar") exige que no quede nada sin commitear —no
commitea por ella con un mensaje genérico—. En la rama del proyecto adelanta su
`dev` con fast-forward y **la sesión sigue abierta** (se sigue trabajando sobre
`dev`, con los servicios andando; la base pasa a ser lo publicado). Con
`subir`, además hace `git push origin <rama>` desde su repo, con su ayudante de
credenciales o su agente SSH, sin hooks y sin forzar nunca: es una acción hacia
afuera que la persona marca explícitamente. Absorber la base antes de publicar
sigue pasando **dentro del worktree**: un conflicto se le pide a un agente,
nunca se resuelve en la carpeta de ella.

**Git del servidor, endurecido** (`git.ts`): sin hooks (`core.hooksPath=/dev/null`),
sin fsmonitor, sin config global ni de sistema, identidad fija, nunca pregunta
(`GIT_TERMINAL_PROMPT=0`, SSH batch) y siempre con `--git-dir` explícito — el `.git`
de un worktree es un archivo de texto que cualquier cosa que corra adentro puede
reescribir. Una URL con `user:token@` se rechaza (misma regla que MCP), y `ext::`,
`file://` y lo que empiece con `-` también. El ayudante de credenciales de la
persona se lee aparte y se pasa explícito: sin él un repo privado no se clona.

**Uno escribe por vez: el arriendo.** `TurnDeps.codigo.abrirTurno` le da a un rol
con herramientas que escriben el arriendo del repo; el que no lo consigue va en
sólo lectura **y el resumen del prompt lo dice**, así no intenta editar para
chocar contra la negativa. Sin eso, dos agentes editan el mismo árbol y uno corre
los tests sobre la edición a medias del otro. Vive en memoria (`ArriendosDeCodigo`)
con vencimiento, porque es de un turno vivo.

**Las herramientas de código** (`packages/tools/src/codigo/`, origin `skill`)
toman los diseños que ya funcionan en otros harness: `editar_codigo` es el
`str_replace` de Claude Code —match exacto y único; si hay varios, nombra las
líneas—, `leer_codigo` numera y lee por ventanas (`LINEAS_POR_LECTURA`, acoplado a
`TOPE_RESULTADO`; `desde` está en `ACOTADORES`), `buscar_codigo` es `git grep
--untracked` (un archivo recién creado existe aunque no esté commiteado) y
`mapa_del_codigo` es el repo map de Aider sin dependencias: regex por lenguaje y
ranking por cuántos archivos nombran cada símbolo, acotado por caracteres y con
caché por mtime —no se persiste índice, así las ediciones del CLI lo invalidan
solas—. Dos reglas que no son estéticas: un bloque igual **salvo indentación**
se informa y **no se aplica** (en Python o YAML la indentación es código), y las
rutas se resuelven con `realpath` contra el worktree, sin `safePath` —que le saca
el punto a `.gitignore` y rompe `[id].tsx`— y rechazando `.git/**`. Se registran
en toda empresa aunque no haya repo, a propósito: la plantilla las otorga antes
de que alguien cargue código, y sin repo cada una dice qué falta y quién lo carga.

**Comandos: la allowlist decide qué, el sandbox contiene.** `ejecutar_comando`
tokeniza a argv **sin shell** (`@orq/shared/argv.ts`, compartido con la UI: con dos
copias, lo que una aceptaba la otra lo rechazaba), compara **por token** —`npm
test` no habilita `npm testx`— y rechaza como entrada de la lista los prefijos que
lo permiten todo (`npx`, `bash`, `node` solo, `npm run` sin script). Pero permitir
`npm test` es permitir los tests que escribió el agente, así que la frontera de
verdad es `sandbox-exec`: escribe sólo en el worktree, `tmp/` y los cachés de
paquetes, **nunca** en el `.git` del clon ni en el archivo `.git` del worktree
(un hook ahí corre fuera del sandbox en el próximo checkpoint), y no lee
`~/.ssh`, `~/.aws` ni las credenciales de `gh`. Sin sandbox, el repo necesita el
opt-in `sinAislamiento` de una persona. El entorno va sin `*_KEY`/`*_TOKEN` y con
`CI=1` (sin eso vitest y jest arrancan en watch y no terminan), el corte mata el
**grupo** de procesos (los nietos incluidos) y hay una fila por repo.
**`exit ≠ 0` vuelve como `ok:true`**: si fuera un fallo, el ciclo corregir → testear
chocaría contra `TOLERANCIA_IDENTICA` a la tercera corrida. Lo que falta se pide
con `solicitar_comando` (tipo de solicitud `comando`): la persona lo aprueba
**una vez** (argv exacto, se consume) o **siempre** (un prefijo que puede
recortar), porque `requiresApproval` no sirve acá — aprobar sólo le mandaba un
mensaje al agente y la herramienta volvía a pedir aprobación para siempre.

**El CLI de Claude edita, pero no tiene `Bash`.** En modo código
(`OrgToolsSession.codigo`) el `cwd` es el worktree y el turno con el arriendo
recibe `Edit/MultiEdit/Write`; nadie recibe `Bash`, que además se niega explícito
junto con `Edit(.git/**)`/`Write(.git/**)` (verificado contra el CLI 2.1.282).
Los comandos van por `ejecutar_comando`, que es lo único con sandbox, entorno
limpio y rastro. Lo que el CLI usa por su cuenta se parsea del stream-json
(`herramientasPropiasDelCli`) y cuenta en `herramientas` y en `check_activity`:
sin eso, un programador que sólo usa `Edit` cuenta cero y el scheduler lo deja de
convocar a los dos turnos. Un turno de código usa `timeoutCodigoMs` (25 min en
Claude Code). `entornoDelCli` saca `ANTHROPIC_API_KEY`: si no, `claude -p` factura
por API en vez de por la suscripción, y el costo lo reportamos en 0. `opencode`
va en sólo lectura también sobre código —no hay cómo negarle `.git` por patrón—
y edita por las herramientas del org.

**La pestaña Código es un IDE, y es el mismo worktree de los agentes.** Monaco
—el editor de VS Code— empaquetado con Vite (`routes/codigo/monaco.ts`, sin CDN:
un IDE que no abre archivos sin red no es un IDE) y cargado con `lazy` sólo al
entrar. Explorador con estado git, pestañas, diff lado a lado contra la base de
la sesión, búsqueda (`git grep` literal), control de código fuente y una
terminal. Tres reglas que no son de diseño:

- **Mientras un agente tiene el arriendo, el editor es de sólo lectura** y el
  archivo abierto se refresca solo: es como se lo ve trabajar. Guardar contesta
  409 con el nombre de quien escribe; la edición queda en el editor.
- **Guardar lleva el hash de lo que se cargó.** Si el archivo cambió en disco
  —lo tocó un agente—, 409 con `conflicto` y la persona elige qué versión
  queda. Pisar el trabajo de un agente sin que nadie se entere es lo que el
  arriendo evita entre agentes, y vale igual entre agente y persona.
- **Lo que editó una persona se commitea a su nombre antes del próximo turno**
  (`abrirTurnoDeCodigo`): sin eso el checkpoint del agente se llevaba su trabajo
  firmado por el agente. La identidad es la de git de la máquina, leída aparte
  porque `git.ts` no lee la config global.

La terminal **no es una shell**: corre sólo la allowlist del repo, en el mismo
sandbox que los agentes. La API escucha en localhost con CORS abierto, y un
endpoint que corre lo que le pidan sería una puerta que cualquier página del
navegador puede golpear. Las vistas laterales quedan montadas y se ocultan: si
se desmontaran, ir a Buscar y volver cerraba todas las carpetas.

**Cada repo es una raíz del explorador**, como un workspace de varias carpetas
de VS Code: su árbol, su rama y sus acciones (archivo nuevo, configurar,
sacarlo del proyecto). Las pestañas llevan el `repoId`; el "repo activo" —el de
la pestaña abierta o el último que tocaste— es sobre el que operan el control
de código, la búsqueda, la terminal y el chat.

**El chat de IA es una corrida enfocada, no un sistema aparte.** `createRunSchema.foco`
(`rolId`, `repoId`, `contexto`) arma una corrida con **un solo rol** —el
organigrama se reduce a él y no adopta tareas ajenas: si no, "mejorá esta
función" terminaba en una reunión de cuatro agentes—, pocos ciclos (4 por
default) y el repo elegido como principal del turno (`abrirTurnoDeCodigo`,
`repoPrincipalId`). El contexto que adjunta la persona (archivos con `@`, la
selección del editor con ⌘L) viaja **en el mensaje**, con contenido y con
presupuesto (`armarContexto`, 30k caracteres): se reenvía en cada vuelta de un
turno delegado. Lo que cambió un pedido son sus checkpoints —de ahí salen "Ver
cambios" (diff entre `primero^` y `último`) y "Deshacer" (`git revert`, no
reescribir la historia)—. El "Mejorador de código" (`MEJORADOR_DE_CODIGO`) se
crea con un click, con todas las tools de código y Opus si está `claude-code`.
Las herramientas propias del CLI ahora emiten `tool.start`/`tool.end`
(`cli:Edit`…) además de contar: sin eso el chat no podía mostrar qué editó.
Llegan al final del turno, porque el CLI devuelve todo junto.

**La vista previa corre código de un agente en tu navegador, y eso decidió tres
cosas.** Se sirve por `/api/repos/:id/vista/*` con `Content-Security-Policy:
sandbox allow-scripts` —el sandbox lo pone el servidor, así vale también si se
abre en otra pestaña, donde ningún atributo `sandbox` la protege y correría con
el origen de la app, con acceso a toda la API por el proxy—; con origen opaco
los ES modules necesitan CORS, así que **sólo esas respuestas** van con
`Access-Control-Allow-Origin: *`; y la API dejó de contestarle a cualquier
origen (`construirApp({ origenes })`, antes `origin: true`): la UI va por el
proxy de Vite y no lo nota, pero una página cualquiera —o la vista previa— ya
no puede leer lo que devuelve. Se recarga sola con cada guardado y cada
checkpoint.

**Una grilla CSS sin columnas explícitas crece con su contenido.** El IDE es
`grid-cols-[minmax(0,1fr)]`: con la columna `auto` implícita, abrir el chat
corría la página entera de costado (Monaco mide 16M px de ancho interno).

**Un turno delegado no puede esperar a una API saturada.** Medido en una
corrida de cuatro agentes en Opus: 45 de sus 65 minutos fueron **huecos de
quince minutos exactos** sin una sola llamada, y otra corrida perdió sus dos
primeros turnos en diez reintentos de la API (esperas de hasta 38 s) con error
desconocido —el binario del CLI trae el mensaje: "high demand for Opus"—. Lo
que no es del agente se resuelve en el adaptador (`claude-code.ts`):

- `--fallback-model` (`RESPALDO`: opus→sonnet, sonnet→opus, haiku→sonnet): si
  el modelo está saturado responde otro, y **se dice**. `diagnosticoDelTurno`
  lee `modelUsage` del `result` y el aviso va a la traza vía `ChatResult.avisos`;
  el `modelSlug` del turno es el que respondió de verdad.
- `CLAUDE_CODE_MAX_RETRIES=4` (el CLI trae 10) en `entornoDelCli`, respetando
  lo que haya puesto quien corre el servidor.
- **Vigilante de silencio** (`SILENCIO_MAX_MS`, 180 s, `CLAUDE_CODE_SILENCIO_MS`):
  con `--include-partial-messages` el CLI emite un evento por trozo de texto, así
  que el silencio no es "está pensando". Mientras corre una herramienta del org
  no cuenta —`OrgToolsSession.ocupada()`, que lleva el puente—: un `npm test`
  de cinco minutos no es un cuelgue. Los eventos parciales se usan de latido y
  **no se guardan**: multiplicaban por diez la memoria de un turno.
- El `rate_limit_event` del stream avisa cuando la suscripción pasa el 80% de
  su ventana (5 horas o semanal).
- Cada turno deja su transcripción en `CLAUDE_CODE_WORKDIR/transcripciones/`
  (las últimas 300): cuando se colgó uno no había nada que mirar.

Y en el motor: si un ciclo entero falla por el proveedor, `runContinuous`
**espera** antes del siguiente (30 s, 60 s, 120 s; `ORQ_ESPERA_PROVEEDOR_MS`,
cero en los tests) en vez de repetir al toque contra la misma API caída.

**Un comando sobre el mismo árbol da el mismo resultado.** `ejecutar_comando`
reutiliza el último resultado si la huella del árbol (HEAD + `git diff HEAD`
con los archivos nuevos vía `--intent-to-add`) no cambió en 30 minutos, y lo
dice; `repetir: true` lo fuerza. Medido: 24 `npm test` en una corrida, casi
todos sobre el mismo código. La terminal del IDE siempre corre de verdad.

**`npm run dev` reinicia el servidor con cada cambio, y un reinicio mata las
corridas en memoria.** `tsx watch` recarga al tocar cualquier archivo que el
servidor importa —`packages/` incluidos—: editar el motor con una corrida viva
la corta con "Servidor detenido". Lo abierto se hereda, pero el turno en vuelo
se pierde. Para trabajar sobre el orquestador con una corrida larga andando,
esperar a que termine o correr el servidor sin `watch`.

**Un programa nuevo va en un repo nuevo, y lo crea el equipo.** `crear_repositorio`
(sólo `manager`/`executive`: un ejecutor que crea repos reparte el trabajo en
tres) arma un repo con origen `creado` —README, `.gitignore`, y `npm test`,
`node --test` y `node --check` ya permitidos, porque el primer paso de un equipo
sin eso era pedir permiso para testear lo que acababa de crear—; integrar es
avanzar su propio `main`. Sin ningún repo, `abrirTurnoDeCodigo` igual devuelve
un resumen (`dir: null`) que dice dónde va el código, y `write_output_file`
avisa si le llega código fuente. Lo medimos: un equipo entero escribió un
simulador en la salida archivo por archivo y llamó a `listar_repositorios` 36
veces esperando que apareciera un repo.

**Sacar un repo con trabajo sin integrar deja un respaldo** en la salida
(`respaldos/<repo>-<rama>.bundle` y `.patch`). El bundle lleva la historia
entera: uno "delgado" necesita el repo de origen para abrirse, y el respaldo
existe justo para cuando ya no está. Lo pagamos con un simulador de tres etapas
que vivía sólo en la rama de la sesión y se fue con el clon.

**Una dependencia se pide, se aprueba y aprobar instala.** Un agente no tiene red
—`curl` no entra en ninguna allowlist— y eso dejó un simulador 3D sin dibujar:
el código importaba Three.js y nadie podía traerlo. `instalar_dependencia` abre
una solicitud tipo `dependencia` y **aprobarla instala** (`Runtime.instalarDependencias`):
el gestor del repo (por lockfile) corre en el sandbox, con red, y el resultado se
commitea a nombre de quien aprobó. Si falla, la aprobación falla y la solicitud
queda pendiente —aprobar algo que no quedó instalado le mentiría al agente—. Dos
reglas en `@orq/shared/dependencias.ts`, validadas en la herramienta **y otra vez
al aprobar**: sólo paquetes del registro por nombre (nada de URLs, `git:`,
`file:` ni rutas: la persona ve un nombre y cree que sabe qué instala) y siempre
`--ignore-scripts` (un `postinstall` es código arbitrario corriendo al instalar).
`node_modules` no entra al checkpoint; `package.json` y el lockfile sí.

**Una subcarpeta de un repo más grande se carga como copia de esa carpeta**, no
clonando el repo que la contiene: la persona señaló esa carpeta. Con la regla
vieja, cargar un programa que estaba en `data/` clonó el orquestador entero.

**Un monorepo son varios programas, y cada uno se levanta distinto.** Un repo
como el de INSPIA es un solo git con backend (Express), frontend (Vite), app
móvil (Expo) y un vault de Obsidian adentro. `servicioSchema` (en
`repositorioSchema.servicios`) describe cada parte: carpeta, tipo
(`api|web|movil|docs|otro`), comando de arranque con `{puerto}`, la variable del
puerto, el **puerto que usa en la máquina de la persona**, la ruta de salud y
sus `.env`. Se detecta al cargar (`detectarServicios` en `apps/server/src/servicios.ts`
sobre la clasificación pura `clasificarServicio` de `@orq/shared/servicios.ts`):
Expo gana a Vite aunque traiga `react-dom` —clasificado como web se arranca con
el comando equivocado—, y la raíz cuenta como docs sólo si no hay una carpeta de
notas propia (en INSPIA `.obsidian` está en la raíz pero las notas en
`inspia-obsidian/`). Los comandos del monorepo llevan `carpeta` (`ejecutar_comando`,
`instalar_dependencia`, la terminal del IDE): cada parte tiene su `package.json`.

**La vista previa de un servicio le habla a la vista previa, no a la persona.**
`ServiciosVivos` levanta cada servicio sobre el worktree de la sesión (así se ve
lo que cambiaron los agentes, y Vite/`ts-node-dev` recargan solos), en el
sandbox de los comandos, en un puerto propio del rango `PUERTOS` (4300-4399):
el 3001 y el 5173 los está usando ella con su versión. Por eso las URLs a
`localhost:<puerto original>` de los `.env` se **reescriben**
(`redirigirUrlsLocales`): sin eso el frontend de la sesión le hablaba al backend
de la persona, que es la peor falla de una vista previa — se ve bien y muestra
otra cosa. La dependencia es circular (el CORS del backend necesita la URL del
frontend y viceversa), así que el puerto de cada hermano se **reserva** aunque no
esté levantado: el orden de arranque no importa. Las URLs de la propia app que
apuntan afuera (`EXPO_PUBLIC_API_URL` a staging) se avisan —no las de Supabase ni
las de un webhook, que son legítimas y tapaban el aviso que importa— y un click
las pisa con `{url:backend}`.

Los `.env` se leen **al arrancar** y se inyectan: no se copian al worktree (el
clon los excluye y ahí los leería `leer_codigo`) ni se guardan en la base (el
blueprint borra sus rutas). Sus valores secretos se tapan en los logs y en las
respuestas de `probar_servicio`, que es lo que lee un agente. Sólo se aceptan
archivos que se llaman `.env*`: el servidor los inyecta en un proceso que corre
código de un agente. Sin `CI=1` (Expo apaga la recarga) y con `BROWSER=none`
(`expo start --web` abre una pestaña en el Chrome de la persona).

Las dependencias de un servicio se **clonan** del `node_modules` de la persona con
`cp -c` (APFS, copy-on-write: instantáneo y sin ocupar disco) si su lockfile es
idéntico al de la sesión; si no, `npm ci --ignore-scripts` en el sandbox. Los
procesos van en su propio grupo, así que un reinicio de `tsx watch` los dejaría
huérfanos ocupando puertos: se anotan en `data/proyectos/.servicios-vivos.json`
(pid + hora de inicio, para no matar un pid reciclado) y se barren al arrancar;
el `exit` y el `shutdown` los matan. Integrar, descartar o sacar el repo los
detiene primero —corren sobre el worktree que se va— y renombrar el proyecto con
servicios vivos se rechaza.

Los agentes **ven y prueban, no levantan**: `servicios` (estado, URL, logs) y
`probar_servicio` (un pedido HTTP sólo a un servicio del repo), y el resumen del
prompt dice qué parte es qué y dónde está la documentación. Levantar es de la
persona: es donde se inyectan sus credenciales.

**Señalar en la vista previa, como en Cursor.** El iframe de un frontend es
otro origen y el IDE no puede tocar su DOM, así que los servicios `web` y
`movil` escuchan en un puerto interno (`PUERTOS_INTERNOS`, 4400-4499) y el
público lo atiende un proxy propio (`proxy-vista.ts`) que reenvía todo —también
el websocket de la recarga en caliente— y a las páginas HTML les inyecta el
selector (`/__orq__/selector.js`). Es un puerto propio y no un prefijo del
servidor porque Vite y Metro usan rutas absolutas. Tres cuidados que ya
costaron: al reescribir el HTML hay que sacar `transfer-encoding` (con
`content-length` al lado la respuesta es inválida y el navegador la descarta),
**no se reenvían pedidos condicionales** de HTML (un 304 devuelve la página
guardada, sin selector) y la salud se pide al puerto interno (el proxy contesta
502 mientras arranca, y cualquier respuesta cuenta como lista). El selector
duerme hasta que el IDE lo activa por `postMessage`, sólo le habla al origen que
lo activó, se come los clics mientras está activo y manda la ruta, la cadena de
componentes de React (leída de la fibra), el texto, los atributos y el HTML.
El chat (`elemento.ts`, `buscarCandidatos`) busca en la carpeta del servicio
dónde se **define** cada componente y dónde aparece el texto visible, y manda al
agente los candidatos con el tramo de código de la línea que coincide: el
agente va derecho al archivo en vez de buscarlo.

**El mismo script es el inspector** (consola y red, como DevTools, con un
botón "Al chat"). Por eso se inyecta **al principio del `<head>` y sin
`defer`**: tiene que envolver `console`, `fetch` y `XMLHttpRequest` (axios va
por el segundo) antes de que corra un solo módulo de la app, o se pierde justo
el error que tira al arrancar. Lo registrado antes del saludo del IDE
(`orq-inspector`) espera en una cola acotada; después sólo se le habla a ese
origen — el único mensaje a `*` es "estoy lista", sin datos. De la red se
guarda el **cuerpo de la respuesta sólo de lo que falla** (ahí está el mensaje
del backend), de lo enviado sólo la **descripción** de un multipart (nombre,
tamaño y tipo de cada archivo: lo que diagnostica una subida) y **nunca
cabeceras**, que llevan el token. En el chat la falla viaja con los archivos
propios que nombra el stack —Vite los sirve con su ruta real, `/src/…:línea`—
y la vecindad de la línea que tiró. El script se prueba en una VM
(`proxy-vista.test.ts`) y sigue sin backticks ni `${`. Ojo con el nombre de
archivo: `inspector.ts` al lado de `Inspector.tsx` **choca en macOS** (el
sistema de archivos no distingue mayúsculas y tsc lo rechaza), por eso los
tipos viven en `sonda.ts`.

**El chat tiene conversaciones** (`foco.conversacionId`). Cada pedido es una
corrida nueva y el agente arranca sin memoria, así que los pedidos anteriores
de la misma conversación viajan en el mensaje (`Runtime.historiaDeConversacion`:
pedido y respuesta final, del más nuevo al más viejo, con presupuesto — no la
traza, que se reenvía en cada vuelta del turno delegado). Sin eso "dejalo como
estaba antes" no se refiere a nada. "Nueva conversación" arranca limpia; los
pedidos de antes de esto se ven juntos como "Pedidos anteriores".

**Dos gits sobre el mismo worktree se cruzan.** El IDE pide `git status` cada
tres segundos, y `status` toma `index.lock` para refrescar el índice: el
checkpoint de un turno falló con "index.lock: File exists" y el cambio del
agente quedó sin commitear (el turno siguiente lo habría firmado como de la
persona). `git.ts` corre con `GIT_OPTIONAL_LOCKS=0` —las lecturas no toman el
lock— y reintenta unas pocas veces cuando el lock está ocupado.

**El control de versiones del IDE es el de Cursor, sobre la sesión** (`scm.ts`,
`/api/sesiones/:id/scm/*`): preparar y quitar por archivo, descartar (confirmado:
lo nuevo se borra, sin papelera), commit con la identidad de git de la persona
—sin nada preparado commitea todo, como el smart commit de VS Code— y amend sólo
sobre commits de la sesión (modificar uno de la base reescribiría una historia
que no es de acá), stash con y sin archivos nuevos, y ramas: crear, cambiar,
fusionar y borrar. Cuatro reglas:

- **Cambiar de rama mueve la sesión** (`RepoStore.cambiarRamaDeSesion`): integrar
  lleva la rama abierta, y si la fila siguiera diciendo `orq/…` se integraría
  una rama sin el trabajo. La base está abierta en el clon y git no deja abrirla
  dos veces: se ofrece crear una rama desde ella.
- **Una fusión con conflicto se aborta y nombra los archivos.** Un árbol con
  marcas de conflicto que nadie mira es donde el próximo checkpoint de un agente
  las commitea como código.
- **Nada escribe mientras un agente tiene el arriendo**, y lo que mueve el árbol
  entero (stash, ramas, fusión) espera además a que no haya corrida viva: su
  próximo turno arrancaría sobre otra cosa sin saberlo.
- **`--intent-to-add` rompe `git stash`** ("not uptodate. Cannot save the current
  worktree state"), y el diff de la sesión, la huella de los comandos y el
  mensaje generado marcan así los archivos nuevos. `soltarIntencionDeAgregar`
  los devuelve a "nuevo sin seguimiento" antes de guardar un stash o cambiar de
  rama, y el panel los muestra como nuevos, no como agregados.

**El repo de la persona tiene su propia historia, y el IDE la muestra entera.**
El clon trae todo (en INSPIA, 881 commits de `dev`), y las ramas locales de la
persona quedan como `origin/*`. `RepoStore.sincronizarConOrigen` las actualiza
—también los tags y, si el origen es una carpeta, las ramas de **su** remoto
(GitHub) como `remoto/*`—: el panel lo pide en segundo plano (cada 45 s como
mucho) y el botón lo fuerza, así lo que ella commiteó desde su editor aparece
solo. El historial es el de la rama abierta **completo**, paginado, con las
ramas y tags de cada commit y marcando lo que todavía no está en su base
(`origin/dev`); la línea de la base dice cuánto lleva la sesión sin integrar y
cuánto avanzó ella (↓N, con "Traer", que es fusionar `origin/<base>`). Abrir una
rama suya crea la local que la sigue (`switch --track`, explícito: con la misma
rama en `origin/` y `remoto/` git se niega a adivinar).

**Integrar una rama con nombre propio nunca la pisa** (`integrarRamaPropia`).
Las `orq/*` son nuestras y se actualizan con `+rama:rama`; con esa misma regla,
una sesión abierta en `main` le habría reescrito el `main` a la persona. Una
rama que no es `orq/*`: si la tiene abierta, fast-forward sobre su carpeta
limpia; si no, `rama:rama` sin `+`, que git sólo acepta si avanza. Si no se
puede, la sesión **no** se da por integrada y se explica cómo traer sus cambios.

El ✨ del mensaje (`Runtime.generarMensajeDeCommit`) es **una sola llamada** al
tier `cheap` del proveedor preferido, no una corrida: describe lo preparado (o
todo, si no hay nada preparado) e imita los últimos commits del repo —idioma,
`tipo(área): …`—, porque un mensaje correcto pero escrito distinto al historial
es ruido que alguien reescribe. Se le sacan las firmas que agrega el CLI de
Claude (`Co-Authored-By: Claude…`): es un commit de la persona.

**`data/proyectos/package.json` existe a propósito** (`{"type": "commonjs"}`,
`Directorios.prepararRaiz`). `data/` vive adentro del repo del orquestador, cuyo
`package.json` dice `"type": "module"`, y Node decide cómo cargar un `.js` por el
`package.json` más cercano: `ts-node-dev` escribe su hook en `TMPDIR` y lo carga
con `require`, y el backend de INSPIA moría con "require is not defined". En la
máquina de la persona el temporal está en `/var/folders` y por eso ahí andaba.

**Una corrida que editó código no está vacía.** El detector de "pedido perdido"
del scheduler contaba entregables y mensajes entre roles; un pedido del chat del
IDE no produce ninguna de las dos cosas —su producción es la edición y el
checkpoint— y terminaba `failed` aunque estuviera resuelto. Ahora cuenta las
ediciones exitosas (`HERRAMIENTAS_QUE_ESCRIBEN_CODIGO` y `cli:Edit/Write`).

**La documentación de Obsidian se lee en el IDE como en Obsidian** (`Nota.tsx`):
`[[enlaces]]` que navegan (primero la nota de la misma carpeta), `![[imagen]]`
servida por la vista estática, callouts y frontmatter como propiedades. El código
entre backticks no se transforma: un `[[ejemplo]]` escrito como código no es un
enlace.

**`ENABLE_TOOL_SEARCH=false` en el CLI**: con las herramientas del org
diferidas, Claude Code hacía un `ToolSearch` para cargar cada esquema —58 en una
corrida, cada uno una vuelta entera del loop—. Son decenas y el caché de prompt
las absorbe: van de entrada.

**`git` con `--work-tree` necesita también `cwd`.** `grep --untracked` y
`ls-files -o` trabajan sobre el directorio actual: sin `cwd`, buscar en la
sesión devolvía archivos **del orquestador**. `git.ts` ahora usa el worktree como
cwd por default. Y `vitest.config.ts` excluye `data/`: los tests de los repos de
los proyectos son de ellos.

Dos arreglos que salieron de acá y valen para todo: el memo de lecturas del
puente delegado **no se vaciaba nunca** (leer → editar → leer devolvía el puntero
a la versión vieja, también con `read_artifact`/`edit_artifact`); ahora comparte
`invalidarMemo` con el loop. Y el enum de tipos de solicitud estaba copiado a mano
en `events.ts`: ahora reusa `agentRequestTypeSchema`.

## Trampas conocidas

- **`active.run` queda viejo.** El estado autoritativo de una corrida es
  `orchestrator.snapshot`; `active.run` no se actualiza al pausar o detener, y
  leerlo hacía que una corrida ya detenida dijera "está en curso".
- **Una promesa sin dueño mata el servidor entero.** `POST /runs/:id/resume`
  contesta sin esperar —retomar dura minutos— y hacía `void runtime.resume(id)`:
  al pedirlo sobre una corrida que no sobrevivió a un reinicio, el `throw` salía
  por una promesa rechazada sin manejar y **Node se cae**, llevándose puestas
  las corridas que sí estaban trabajando. Lo pagamos dos veces en la misma
  tarde. Ahora se valida antes con `Runtime.estaEnMemoria` (que no es
  `estaViva`: una pausada no corre y sí se puede continuar) y el `void` lleva su
  `.catch`. Cualquier otro fire-and-forget del servidor necesita las dos cosas.
- **Los entregables no tienen `updatedAt`.** Sólo `createdAt` y `version`.
  Ordenar por `updatedAt` para encontrar "el último" deja todos los valores en
  `undefined`, el orden queda como salió de SQLite y se trabaja sobre una
  versión vieja sin que nada falle. Lo pagamos renderizando un guion viejo
  encima del entregable bueno: el video salió de 1m32s en vez de 2m54s y el
  único síntoma fue la duración. Se ordena por `version` y, a igual versión, por
  `createdAt`.
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
- **Los nodos del organigrama se actualizan, no se rearman.** React Flow los
  deja en `visibility: hidden` hasta medirlos; si en cada render recibe objetos
  nuevos pierde la medición y vuelve a empezar. Con la traza llegando por SSE
  nunca terminaba y **el grafo quedaba invisible** —nodos en el DOM, ninguno en
  pantalla—. `OrgGraph` reusa el objeto anterior con `useNodesState`.
- **Los roles nuevos nacen en la posición (0,0)** y se apilarían en el organigrama;
  `OrgGraph.autoLayout` los acomoda por jerarquía cuando detecta posiciones
  repetidas, y respeta las que hayas movido a mano.
- **Un rol se convoca por sus tareas abiertas, y eso puede volverse un livelock.**
  Un agente que habla y no ejecuta nada sigue teniendo la tarea abierta, así que
  vuelve a ser convocado el ciclo siguiente: medimos catorce ciclos seguidos así,
  hasta morir por límite de ciclos sin producir nada. El scheduler cuenta ahora
  las herramientas que ejecuta cada turno y deja de convocar por tareas al que
  hace dos turnos vacíos seguidos; un mensaje nuevo en la bandeja lo reactiva.
- **Insistir no acelera a nadie.** `send_message` rechaza escribirle de nuevo a
  quien todavía no contestó. Sin la guardia los agentes mandaban pedido,
  recordatorio, seguimiento y escalamiento sobre lo mismo —diez mensajes a la
  misma persona en una corrida— y, peor, se quedaban esperando en vez de avanzar
  con lo que sí podían hacer solos.
- **Una pregunta se contesta con una respuesta, no con un permiso.** Antes toda
  resolución de `request_context` salía como `approval_grant` con el asunto "Tu
  solicitud fue aprobada": el agente veía "Aprobación concedida" y el dato que
  había pedido quedaba escondido en el cuerpo. Lo medimos volviendo a preguntar
  lo mismo al ciclo siguiente.
- **Una solicitud pendiente se hereda, y su respuesta tiene que encontrar a la
  heredera.** Las corridas cargan las solicitudes pendientes de la empresa al
  arrancar; si la corrida que la creó ya murió, `notifyRequester` busca la
  corrida viva que la tenga pendiente y espeja ahí (y reanuda esa, no la del
  `runId` original). Sin ese fallback, una corrida con todo el trabajo aprobado
  quedaba en `awaiting_approval` para siempre por una solicitud ya resuelta.
- **La corrida tiene su propia copia de las solicitudes.** Resolver una por la
  API toca la base; hay que reflejarla también en `RunState.resolverSolicitud`, o
  la corrida queda esperando para siempre una respuesta que ya está dada. Y
  `runContinuous` se destraba sola si el estado es `awaiting_approval` pero ya no
  hay nada pendiente: sin eso, retomar era un no-op.
- **Un argumento inventado derrota al memo de lecturas.** El modelo cree que
  puede paginar un entregable largo y llama `read_artifact` con `start=4000`,
  `start=8000`… La herramienta no declara ese campo, lo ignora y devuelve el
  documento **entero** cada vez. Como la huella del memo se calculaba sobre todos
  los argumentos, cada llamada parecía nueva: el mismo texto de 40k caracteres
  entró once veces al contexto y la corrida gastó 534k tokens de entrada para
  2k de salida (259:1). La huella ahora se calcula sólo sobre lo que el esquema
  declara cuando cierra con `additionalProperties: false`, y una relectura
  devuelve un puntero en vez del contenido: ahorrar el viaje al servidor no
  servía de nada, el costo está en los tokens que se reenvían en cada iteración.
- **Los agentes no tienen reloj.** `TurnDeps.fechaHoy` entra formateada desde el
  llamador —igual que en el render de documentos— y aparece en el encabezado del
  ciclo. Sin eso un auditor marcó como typo una fecha correcta y pidió cambiarla
  a un año anterior; el corrector le hizo caso y **corrompió el dato**. Un
  verificador que no puede verificar inventa hallazgos, y sus falsos positivos se
  propagan aguas abajo con la misma autoridad que los reales.
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
