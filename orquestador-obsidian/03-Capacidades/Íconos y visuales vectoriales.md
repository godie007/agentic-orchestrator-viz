---
tags: [capacidad]
aliases: [Íconos, Visuales, ASS, SVG]
---

# Íconos y visuales vectoriales

## Los íconos se dibujan, no se instalan

`skills/iconos.ts`. `:objetivo:` al empezar una viñeta o un `##` mete un **trazo
vectorial de ASS** —el mismo `{\p1}` de la regla y la barra de progreso—, así que
escala sin perder nitidez, toma el color del estilo y no hay assets que
empaquetar.

### Por qué no emojis

> libass los dibuja en monocromo o los saltea según la fuente instalada, y **un
> video que en una máquina muestra un cohete y en otra un cuadrado no es una
> salida confiable**.

### Cómo se dibuja uno

Las coordenadas van en una caja de **100×100**.

> [!danger] Un agujero se dibuja con el contorno invertido
> ASS rellena por regla **non-zero**. Sin invertir el contorno interior, un
> candado es una mancha con forma de candado.

> [!warning] Ojo con superponer contornos
> Si el hueco del arco pisa la tapa, el candado termina pareciendo un bolso.

### Degrada, no rompe

Un nombre que no está devuelve `null` y quien llama dibuja la viñeta cuadrada de
siempre. Un `:crecimiiento:` mal escrito **degrada, no rompe la escena**, y la
marca queda a la vista para que el agente vea el error.

El listado disponible está en `ICONOS_DISPONIBLES` y se le expone al agente.

---

## Un diagrama no es una foto de peor calidad

`skills/visuales.ts`. `![lo que muestra](visual:flujo)` dibuja una composición: un
chat, un flujo de proceso, tarjetas de dato, un tablero, una ficha de contacto.

> Cuando lo que hay que mostrar es **de dónde sale un dato y a dónde llega**, una
> foto de gente en una oficina no dice nada y un diagrama lo dice todo.

Además no depende de ningún proveedor, no cuesta nada y sale siempre en la paleta
de la marca.

### Definido una vez, emitido en dos medios

Cada visual se define **una vez** en una caja de 100×100 y se emite en ASS (para
el video) y en SVG (para el deck), igual que los íconos — porque un segundo set
dibujado aparte se desincroniza a la primera corrección.

Hay una diferencia con los íconos: acá hay **texto adentro del dibujo**, y ASS no
sabe poner una palabra dentro de una forma. Por eso `visualAss` devuelve el dibujo
**despiezado** —formas primero, rótulos después— y quien renderiza los apila.

> [!danger] El ancla del texto no es la misma en los dos medios
> En SVG la `y` es la **línea de base**; en ASS es el **techo**. Hay que restar un
> cuerpo, o los rótulos caen un renglón más abajo que su caja.

---

## Las personas se dibujan con curvas

`visual:llamada|Cuénteme cómo cierra el día` pone un personaje en un escenario
—bodega, escritorio, llamada— con lo que dice en un globo. **Lo que dice lo
escribe el guion**, después del `|`: el mismo escenario sirve para otra campaña
con otra frase.

### Cuatro comandos de SVG

El cuerpo se arma con `M`, `L` y `C`. No con círculos y rectángulos:

> Un cuerpo hecho de cajas se lee como un muñeco de bloques, y una lámina de
> venta con muñecos de bloques se ve como una plantilla gratis.

Esa es también la razón de la restricción a cuatro comandos: `trazoAAss` los
traduce a `m`/`l`/`b` **sin escribir un intérprete**, y si sobrevive una `M`,
libass **descarta el dibujo entero** y la persona no aparece.

### Dos decisiones sobre las figuras

- **Las caras van sin rasgos** a propósito: un ojo mal puesto por un generador
  arruina la figura.
- **Dos tonos de piel, no una paleta**: media docena elegida por un programa
  termina en un reparto que parece un folleto.

### El globo calcula su propio corte

A partir del ancho que tiene. Pasarle un número de caracteres a ojo es lo que
hacía que la frase se saliera por el costado.

> [!warning] Al mover una figura, mové los props
> El teléfono y la vincha del auricular están en **coordenadas absolutas** de la
> caja, así que una persona que se corre seis unidades deja el teléfono flotando
> en el aire.

---

## Compatibilidad entre los dos medios

| | ASS (video) | SVG (deck) |
|---|---|---|
| Comandos | `m` `l` `b` | `M` `L` `C` |
| Relleno | non-zero | non-zero |
| Agujeros | contorno invertido | contorno invertido |
| Ancla del texto | techo | línea de base |

Que las dos rellenen por **regla non-zero** es lo que hace que los agujeros
sigan siendo agujeros al traducir. `iconoSvg` se apoya exactamente en eso.

## Enlaces

- [[Producción audiovisual]]
- [[ADR-006 Video en una sola pasada de ffmpeg]]
