---
tags: [adr, arquitectura]
---

# ADR-006 Video en una sola pasada de ffmpeg

**Estado:** aceptada

## Contexto

`export_video` tiene que producir un `.mp4` con portada, escenas tituladas,
viñetas que aparecen mientras se habla, diálogo con una voz por personaje,
imágenes, íconos, logo y música de fondo.

## Decisión

Se arma con **lo que ffmpeg ya trae** —libass para la tipografía, `gradients`
para el fondo— y **en una sola pasada**: no hay un clip por escena ni cadena de
`xfade`.

La única fuente de verdad del tiempo son **las duraciones medidas del audio**;
todo lo que se ve se calcula a partir de ellas.

## Alternativas consideradas

**Navegador headless para maquetar las placas.** Rechazada: cambiar 150 MB de
dependencia por un `<div>`, para maquetar seis placas de texto que libass ya sabe
dibujar.

**Un clip por escena + `xfade`.** Rechazada: obliga a generar y sincronizar
archivos intermedios de video, y cada uno es un punto donde el tiempo se puede
desfasar del audio.

**Una biblioteca de edición de video en Node.** Rechazada por la misma razón que
la primera: peso y superficie de dependencia desproporcionados al problema.

## Consecuencias

### A favor
- Sin archivos intermedios de video que sincronizar.
- Sin dependencias nuevas: ffmpeg ya hacía falta para el audio.
- El mismo guion produce video y deck (`export_slides`) desde `parseGuion`, así
  que **las dos salidas no pueden decir cosas distintas**.

### En contra / lo que se resignó
- Las transiciones son las que se pueden expresar en un solo grafo de filtros.
- El filtro-grafo es largo y hay que razonarlo entero para cambiar algo.
- Hay tres trampas de ffmpeg que se pagan con un video mal filmado:

| Trampa | Consecuencia si se ignora |
|---|---|
| **La viñeta apaga los bordes**, que es justo donde vive el texto alineado a la izquierda | el texto se ve apagado |
| `loudnorm` devuelve **192 kHz sí o sí**, así que el `aresample` va después | la cama entra a la mezcla al triple de velocidad, sonando a cinta acelerada |
| La imagen hay que **sobremuestrearla** antes del acercamiento y **correrla en el tiempo** con `setpts` | `zoompan` amplía sobre lo que recibe (puro reescalado), y el fundido de entrada ocurre en el segundo cero del video en vez de al entrar la escena |

### Decisiones que se apoyan en esta
- **Los íconos se dibujan, no se instalan** — trazos ASS `{\p1}`, no emojis. Ver
  [[Íconos y visuales vectoriales]].
- **Los visuales se definen una vez y se emiten en dos medios** (ASS y SVG),
  porque un segundo set dibujado aparte se desincroniza a la primera corrección.
- **Lo que no entra en el alto útil pasa de página** en vez de desbordarse por
  abajo del cuadro.

Ver [[Producción audiovisual]].
