---
tags: [capacidad]
aliases: [Voz, Kokoro, Música, Cama musical]
---

# Música y narración

## La voz

`skills/narracion.ts`. **Kokoro local** (gratis, ilimitado; se busca en
`ORQ_KOKORO_HOME` y en `~/.cache/`), con **`say` de macOS como respaldo**.

> El respaldo no es un lujo: sin él, una máquina sin el modelo descargado no
> puede producir un video y la habilidad quedaría rota sin decir por qué.

Cada personaje de un diálogo recibe **una voz distinta**, y su línea aparece en
pantalla cuando le toca.

## Cómo suena la marca es un dato de la empresa

`vozSchema`, en `Company.voz`. No es una decisión de cada guion: **el nombre se
pronuncia igual en todos sus videos**.

```ts
voz: {
  unaSolaVoz: true,
  pronunciacion: { Codytion: "códishon" }
}
```

### `pronunciacion`

Se aplica **sólo al texto que va al sintetizador** — escribir "codishon" en el
guion sería una falta de ortografía en pantalla.

> [!warning] Compara por palabra entera
> Una regla para "IA" sin ese corte reescribe **"familia"** por dentro.

### `unaSolaVoz`

Apaga el reparto: varias voces suenan a elenco de actores, y **una pieza
institucional la dice la empresa**.

---

## La música la ponés vos

`skills/musica.ts`. Las pistas viven en `MUSICA_DIR` (`data/musica/`) y **no en
el repo**:

> La música tiene licencia, y un orquestador que baja un mp3 y lo pega en el
> video de una empresa la mete en un problema que no sabe que tiene.

### Cómo se elige una pista

El clima se lee del **nombre del archivo y de su carpeta**, así que agregar una
pista es copiarla. `corporativo-calmo.mp3` responde a un guion que pide
"corporativo" o "calmo".

> [!danger] La biblioteca se recorre en profundidad
> Quien compra música deja el paquete tal cual —`Corporate/Corporate
> Harmonics.mp3`— y con un `readdir` a secas esas pistas **no existían** para el
> sistema: el video salía en silencio con el archivo ahí, a la vista de todos
> menos del programa.

Dos reglas de desempate:

- Del mismo tema en `.wav` y `.mp3` entra **uno solo**.
- Entre pistas que empatan **gana la más larga**: una cama que se repite cada
  cuarenta segundos se escucha como una cama que se repite.

### La cama se mide en sonoridad, no en volumen

> Un `volume` fijo no significa nada: una pista comprada llega a **−14 LUFS** y
> una sintetizada a **−24**, así que el mismo número deja una inaudible y la otra
> encima de la voz.

Se normaliza con `loudnorm` a `MUSICA.lufs` y recién ahí se la acuesta bajo la
narración.

> [!danger] `loudnorm` devuelve 192 kHz sí o sí
> El `aresample` va **después**. Antes, la cama entraba a la mezcla al triple de
> velocidad y sonaba a cinta acelerada.

### La cama se aparta sola cuando alguien habla

`sidechaincompress` con la voz de cadena lateral. Sin eso hay que elegir entre
una cama inaudible y una voz tapada, y las dos suenan a video hecho a las
apuradas.

---

## `npm run musica:cama`

`scripts/generar-cama.ts` sintetiza **dos camas con ffmpeg** para arrancar sin
nada:

| Cama | Modo | Para qué |
|---|---|---|
| institucional | **menor** | "así trabajamos" — suena a reflexión |
| campaña | **mayor con pulso** | para que alguien sienta ganas de poner plata |

> El clima no es decoración. Para una campaña hacen falta modo mayor, más brillo
> y un **pulso audible**, que es lo que da sensación de que algo avanza.

> [!warning] El pulso va sólo en la nota grave, y más fuerte que las sostenidas
> Parejo con el acorde, la modulación cae de 6 dB a 4 y la cama vuelve a ser
> quieta.

## Nada de esto puede hacer fallar un video

Sin biblioteca de música, se filma **en silencio**. Ver
[[Producción audiovisual]].

## Enlaces

- [[Producción audiovisual]]
- [[Variables de entorno]] — `MUSICA_DIR`, `ORQ_KOKORO_HOME`
- [[Comandos]]
