---
tags: [contribuir, referencia]
aliases: [Trampas, Bugs históricos, Gotchas]
---

# Trampas conocidas

Cada una es un bug que ya pasó y costó tiempo. Están acá para que no vuelva a
pasar, y porque **el motivo importa más que la regla**. Para diagnosticar por
síntoma, ver [[Diagnóstico de problemas]].

---

## Motor y corridas

### El actor compartido en paralelo
Con el actor en un campo mutable de `RunState` y turnos concurrentes, **un agente
pisaba al otro y los mensajes quedaban firmados por el rol equivocado**. Se ata
por turno con `RunState.forActor(actorId)`, capturado en el closure. Test de
regresión con 4 agentes en `scheduler.test.ts`.

### `active.run` queda viejo
El estado autoritativo es `orchestrator.snapshot`. `active.run` no se actualiza al
pausar o detener, y leerlo hacía que **una corrida ya detenida dijera "está en
curso"**.

### Las corridas no sobreviven a un reinicio
El estado vivo está en memoria; la traza queda persistida. Podés reproducir una
corrida vieja, **no continuarla**.

### Una corrida borrada que sigue escribiendo
Al borrarla hay que soltarla del runtime (`olvidarCorrida`), o queda un
orquestador vivo emitiendo eventos de algo que ya no existe.

### Una empresa borrada que sigue conectada
Lo mismo un nivel más arriba. El runtime de empresa sostiene **procesos de
servidores MCP**, que no se caen porque borres filas en SQLite: sin
`olvidarEmpresa`, las conexiones seguían vivas hasta reiniciar el servidor y el
Hub mostraba en verde los servidores de algo que ya no existe.

### Y su carpeta quedaba en disco
`store.deleteCompany` limpiaba la base, pero `data/exports/<empresa>/` seguía ahí
con los Word, los PDF y los videos, **sin ninguna pantalla desde la cual verla**:
todas navegan por empresa. Hoy `Runtime.eliminarEmpresa` toca los tres lugares.

### La UI quedaba cargando la empresa que acabás de borrar
`App` guarda cuál está seleccionada; si esa referencia no se suelta, `activeId`
sigue apuntando a un id muerto y la pantalla queda en "Cargando la empresa…" para
siempre. De ahí el `onCompanyGone`.

### La corrida tiene su propia copia de las solicitudes
Resolver una por la API toca la base; hay que reflejarla también en
`RunState.resolverSolicitud`, **o la corrida queda esperando para siempre una
respuesta que ya está dada**. Y `runContinuous` se destraba sola si el estado es
`awaiting_approval` pero ya no hay nada pendiente: sin eso, retomar era un no-op.

### Contestar con la corrida ya cerrada
No llega a ninguna bandeja: `runtime.notifyRequester` lo guarda como `Learning`
de la empresa, que sí entra en el prompt de las corridas siguientes.

### Livelock por tarea abierta
Un agente que habla y no ejecuta nada sigue teniendo la tarea abierta, así que
vuelve a ser convocado. **Catorce ciclos seguidos medidos**, hasta morir por
límite de ciclos sin producir nada. El scheduler cuenta las herramientas por
turno y deja de convocar por tareas a los dos turnos vacíos; un mensaje nuevo lo
reactiva.

### Una llamada lenta bloquea el tick entero
Se midió una de **649 segundos** que dejó a los otros tres agentes esperando once
minutos. El ciclo avanza cuando terminan todos: el más lento manda. De ahí
`llmTimeoutMs`.

### Un proveedor mudo cuelga la corrida
Un endpoint que acepta la conexión y se queda callado deja el turno esperando
para siempre: el agente no falla, no sigue, y no se le puede pedir que cambie de
enfoque. **Toda llamada de red lleva corte por tiempo.**

---

## Costo y contexto

### Un argumento inventado derrota al memo de lecturas
El modelo cree que puede paginar y llama `read_artifact` con `start=4000`,
`start=8000`… La herramienta no declara ese campo, lo ignora y devuelve el
documento **entero** cada vez. Como la huella se calculaba sobre todos los
argumentos, cada llamada parecía nueva: el mismo texto de 40k caracteres entró
**once veces** y la corrida gastó **534k tokens de entrada para 2k de salida**
(259:1).

La huella ahora se calcula sólo sobre lo que el esquema declara cuando cierra con
`additionalProperties: false`, y una relectura devuelve un puntero.

### `cheap` en un rol que coordina
El CEO con un modelo de US$0.014/MTok **se fue a descargar PDFs al azar en vez de
delegar**; el mismo rol con `standard` repartió el trabajo correctamente.

### Sin piso, `standard` y `smart` colapsan
Y sin techo, `smart` elige algo de US$60/MTok. Ver
[[ADR-004 Bandas de precio disjuntas]].

---

## Agentes

### Los agentes no tienen reloj
Un auditor marcó como typo una fecha correcta y pidió cambiarla a un año
anterior; el corrector le hizo caso y **corrompió el dato**. `TurnDeps.fechaHoy`
entra formateada desde el llamador. **Un verificador que no puede verificar
inventa hallazgos, y sus falsos positivos se propagan aguas abajo con la misma
autoridad que los reales.**

### Insistir no acelera a nadie
Sin la guardia, los agentes mandaban pedido, recordatorio, seguimiento y
escalamiento sobre lo mismo — **diez mensajes a la misma persona en una
corrida** — y se quedaban esperando en vez de avanzar con lo que sí podían hacer
solos.

### `reply` no aceptaba el mensaje de la persona
El encargo inyectado desde la UI es de tipo `human`; cuando `reply` exigía
`request` o `escalation`, **nadie podía contestarle a la persona**. Se comió
**14 de 25 llamadas a `reply`** en una corrida real.

### Una pregunta contestada como un permiso
Toda resolución de `request_context` salía como `approval_grant` con el asunto
"Tu solicitud fue aprobada": el agente veía "Aprobación concedida" y el dato
quedaba escondido en el cuerpo. Se midió volviendo a preguntar lo mismo al ciclo
siguiente.

### Claves-variante fragmentando el entregable
`-ciclo3`, `_v2`, `-final`, `-detalle`. **Los modelos baratos fragmentan si la
guardia no está.**

### Un error irresoluble come las `maxTurns`
Una ruta MCP fuera del directorio permitido, por ejemplo. A la tercera llamada
idéntica fallida se inyecta un pedido de cambiar de enfoque; si insiste, se
termina el turno.

---

## Herramientas

### El router dejaba a un agente sin su propia habilidad
Contando las siempre-expuestas dentro del límite, **15 de coordinación dejaban 5
lugares para 20 herramientas**, y un desarrollador al que se le pidió un PDF no
tenía `export_pdf`. El router acota **las opcionales**, no el total.

### Un diagnóstico que produce los residuos que viene a buscar
`ExportStore.dirFor` **crea la carpeta al pasar**, así que cualquier consulta era
una escritura: pedir el árbol de una empresa que ya no está alcanzaba para
dejarla de nuevo en disco. Todo el camino de medición usa `pathFor`, que resuelve
sin crear.

### Un botón destructivo que subdeclara lo que se lleva
El barrido de residuos anunciaba **1 fila** y borraba **3**: no contaba la
corrida huérfana en sí —`runs` no está en `TABLAS_POR_EMPRESA`— ni los mensajes
que colgaban de ella, porque comparaba contra `runs` a secas y esa corrida
todavía existía. Ahora compara contra las corridas que **van a sobrevivir**, y
hay un test que fija que lo anunciado sea exactamente lo borrado.

### Vaciar la salida se llevaba el logo
Con criterio "toda la multimedia", sí: el logo es un `.png`, vive en una ruta
fija y **no se vuelve a generar solo**. El criterio es el manifiesto de
procedencia y nada más.

### El seed no registraba las habilidades
`npm run db:seed` filtraba sólo `capability`, así que sus roles no podían exportar
nada y el agente explicaba que no encontraba `export_video`.

---

## Documentos

| Trampa | Síntoma |
|---|---|
| escribir debajo del margen inferior (pdfkit) | **agrega una página**: el pie duplicaba el documento |
| posición y ancho en cada tramo de texto `continued` | cada negrita partía el párrafo |
| fuentes estándar con WinAnsi | "✅ Sí" salía "' Sí" — se descarta con `sinEmoji` |
| columnas sin ancho mínimo | el reparto proporcional **parte las palabras al medio** |
| línea en blanco entre grupos de filas | cortaba la tabla: media maquetada y el resto con pipes a la vista |
| `</w:p>` de celda descartado después de los genéricos | cada celda caía en su renglón y la tabla se deshacía |
| un archivo por versión (`key-v3.pdf`) | v1, v2 y v3 conviviendo |

---

## Guion y video

| Trampa | Síntoma |
|---|---|
| diálogo escrito con renglones en blanco | **un solo párrafo**: el primero que habla dice las cuatro intervenciones, leyendo en voz alta los nombres de los demás |
| encabezado de documento arriba del guion | la portada anuncia "(v4)" y el título real queda como una placa del medio |
| marca de ícono sola en su renglón | es un párrafo, y un párrafo es voz en off: **el video decía ":objetivo:"** |
| la viñeta de ffmpeg apaga los bordes | justo donde vive el texto alineado a la izquierda |
| `aresample` antes de `loudnorm` | `loudnorm` devuelve 192 kHz sí o sí: la cama sonaba a **cinta acelerada** |
| volumen fijo en vez de LUFS | una pista a −14 tapa la voz, una a −24 es inaudible |
| `readdir` a secas sobre la biblioteca | las pistas en subcarpetas no existían: **el video salía en silencio con el archivo ahí** |
| `zoompan` sin sobremuestrear | el acercamiento es puro reescalado |
| imagen sin `setpts` | el fundido de entrada ocurre en el segundo cero del video |
| agujero sin contorno invertido | un candado es una mancha con forma de candado |
| contornos superpuestos | el candado parece un bolso |
| `M` sobreviviendo a `trazoAAss` | libass **descarta el dibujo entero**: la persona no aparece |
| ancla de texto sin ajustar | en SVG la `y` es la línea de base, en ASS el techo: los rótulos caen un renglón abajo |
| mover una figura sin los props | el teléfono queda flotando en el aire |
| corte del globo por número de caracteres | la frase se sale por el costado |

---

## UI

### El organigrama invisible
React Flow deja los nodos en `visibility: hidden` hasta medirlos; con objetos
nuevos en cada render pierde la medición y vuelve a empezar. Con la traza
llegando por SSE **nunca terminaba: nodos en el DOM, ninguno en pantalla**.
`OrgGraph` reusa con `useNodesState`.

### `content-type` con body vacío
Fastify responde 400. `api.ts` sólo pone el header cuando hay cuerpo: si lo
cambiás, **todos los DELETE se rompen**.

### `min-w-0` en grillas
Sin eso, `min-width: auto` desborda la página a lo ancho.

### Roles nuevos en (0,0)
Se apilarían; `autoLayout` los acomoda al detectar posiciones repetidas, y respeta
las que moviste a mano.

### `?inline` para la vista previa
Un `attachment` dentro de un iframe dispara la descarga en vez de dibujarse.

---

## Entorno

### Un proceso viejo tomando el 3001
Sirve código anterior. `lsof -ti:3001 | xargs kill -9` — `pkill -f` no siempre
alcanza.

### Una cuenta sin crédito contesta 402 a todo
Se ve como una corrida que muere en el tercer ciclo sin producir nada. Con saldo
negativo, el cupo gratuito **sólo tolera pedidos triviales**.

### El aviso de `npm audit`
`@hono/node-server` vía el SDK de MCP: **no es alcanzable**, sólo importamos el
lado cliente, y forzar el override de major puede romper el SDK. Está documentado
en `package.json → auditNotes`. **No lo "arregles" sin leer esa nota.**

## Enlaces

- [[Diagnóstico de problemas]] — por síntoma
- [[Invariantes de arquitectura]] — las reglas que salieron de acá
- [[Pruebas y calidad]] — qué test vigila cada uno
