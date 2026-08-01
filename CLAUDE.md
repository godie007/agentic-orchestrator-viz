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
