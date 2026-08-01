---
tags: [capacidad]
aliases: [Video, Deck, export_video, export_slides, Guion]
---

# Producción audiovisual

> **El video es el mismo markdown leído como línea de tiempo.**

`export_video` (`skills/video.ts`) no maqueta un documento: interpreta el guion
como una secuencia. Y `export_slides` (`skills/slides.ts`) lo lee como un deck.
Los dos salen del mismo `parseGuion`, así que **no pueden decir cosas distintas**.

## Cómo se lee un guion

`skills/guion.ts` → `parseGuion`

| En el markdown | En el video |
|---|---|
| `#` | la **portada** |
| `##` | abre una **escena** |
| párrafo | **voz en off** |
| viñeta | se muestra **mientras se habla** |
| `**Nombre:** texto` | **diálogo**: cada personaje con voz distinta, su línea en pantalla cuando le toca |
| `:objetivo:` al empezar un `##` o una viñeta | un **ícono vectorial** |
| `![lo que muestra](visual:flujo)` | un **diagrama** compuesto |
| `![lo que se ve](fotos/x.jpg)` | una imagen del directorio de salida |
| `![lo que se ve](generar)` | una imagen que se genera; **la descripción es el prompt** |

## Las trampas del guion

Cada una costó un video mal filmado.

> [!danger] Un diálogo es un solo párrafo en markdown
> Se escribe sin renglones en blanco —una línea por personaje, como en un guion—
> y en markdown eso es **un solo párrafo**. Hay que volver a partirlo por cada
> `**Nombre:**`, o las cuatro intervenciones las dice de corrido el primero que
> habló, **leyendo en voz alta los nombres de los demás**.

> [!danger] El encabezado del documento arriba del guion
> "# Guion video institucional (v4)" y recién abajo el `#` con el título real: la
> portada anunciaba el número de versión del borrador y el título de verdad
> quedaba como una placa del medio. Un segundo `#` con la portada todavía sin
> cuerpo **pisa el título** en vez de abrir escena; si la portada ya dijo algo, sí
> abre.

> [!danger] La marca de ícono sola en su renglón
> Debajo del título, en vez de al principio del `##` o de la viñeta: en markdown
> eso es un párrafo, y un párrafo es voz en off — **el video decía ":objetivo:"
> en el medio**. Un párrafo que es sólo una marca conocida se toma como el ícono
> de la escena. Una marca *desconocida* sí se dice, a propósito, porque es la
> única forma de que el error se note.

> [!warning] Lo que no entra pasa de página
> En vez de desbordarse por abajo del cuadro.

## Cómo se filma

En **una sola pasada** de ffmpeg, con libass para la tipografía y `gradients`
para el fondo. Sin clips por escena, sin cadena de `xfade`, sin archivos
intermedios de video que sincronizar. **La única fuente de verdad del tiempo son
las duraciones medidas del audio.**

Ver [[ADR-006 Video en una sola pasada de ffmpeg]] para las alternativas
descartadas y las tres trampas de ffmpeg.

## Imágenes

`skills/imagenes.ts`. Primer proveedor con credencial, en orden: **Google
(Gemini)**, **OpenAI**, **NVIDIA**.

- Las generadas quedan en `imagenes/` **dentro del directorio de salida**, con
  nombre derivado del prompt. Sin ese caché, re-exportar vuelve a pagarlas todas
  **y además cambia el aspecto del video** sin que nadie lo haya tocado.
- La imagen **no va de fondo con el texto encima** —una foto detrás de un párrafo
  lo vuelve ilegible justo cuando alguien lo está leyendo—: van en dos columnas.
  La única que ocupa el cuadro entero es la de la portada, con un velo oscuro que
  sostiene el título.
- `packages/tools` **no lee el disco**: recibe `resolverImagen` del servidor, que
  es quien sanea la ruta que propuso un modelo.
- Toda llamada lleva **corte por tiempo** (`CORTE_MS`). Se midió con el endpoint
  de imágenes de NVIDIA, que hoy no responde: un endpoint que acepta la conexión
  y se calla deja el turno esperando para siempre.

## El logo

En `marca/logo.png` dentro del directorio de la empresa — **una ruta fija, no una
opción de configuración**: se sube por la misma pestaña que todo lo demás.

Grande en la portada, discreto en la esquina del resto. **No se recorta ni se le
hace el acercamiento lento de las fotos**: un logo deformado es peor que ningún
logo. La posición se da como **expresión** de ffmpeg (`W-w-180`), así se ancla al
borde derecho sin que nadie mida el archivo.

La paleta sale **del logo y no del CSS del sitio**: el sitio usa un azul plano y
un ámbar de botón; el logo es un lazo de turquesa, azul y violeta, y eso es lo que
hace reconocible a la marca.

## El deck (`export_slides`)

> Un video no se puede citar, ni copiar una frase, ni saltar a la escena siete, y
> la mitad de las veces lo que hace falta es exactamente eso.

- Sale del mismo `parseGuion`.
- **Lo que en el video es voz en off, acá es la nota al pie de la lámina**: en
  pantalla nadie la escucha, pero sí la lee.
- **Los mismos íconos**: `iconoSvg` traduce los trazos de ASS a SVG. Un segundo
  set dibujado aparte se desincroniza a la primera corrección.
- **Un archivo solo y sin pedidos a la red**: las imágenes viajan como `data:`,
  porque un deck que depende de rutas relativas se rompe apenas alguien lo adjunta
  a un correo — que es justo lo que se hace con un deck.
- **La firma es la empresa, no el rol que lo produjo.** Un Word interno lleva el
  nombre de quien lo escribió porque alguien responde por él; una pieza que se le
  manda a un cliente, no: ahí el autor es la marca, y el nombre del agente no le
  dice nada a quien la recibe.
- En la UI se dibuja en un **iframe con `sandbox` vacío**: se sirve desde el mismo
  origen que la aplicación, y un `.html` que escribió un agente no puede correr
  con su sesión.

## Nada de esto puede hacer fallar un video

Sin biblioteca de música se filma en silencio. Una imagen que no se pudo mostrar
vuelve **como aviso en el resultado de la herramienta** —que es lo único que el
agente puede leer para corregir el guion— en vez de tirar la corrida abajo.

## Enlaces

- [[Íconos y visuales vectoriales]]
- [[Música y narración]]
- [[CU-02 Video institucional]]
- [[ADR-006 Video en una sola pasada de ffmpeg]]
