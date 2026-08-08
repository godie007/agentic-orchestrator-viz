/**
 * Guion → MP4.
 *
 * El video se arma en **una sola pasada de ffmpeg**: un fondo generado por
 * filtro, toda la tipografía como subtítulos ASS y las voces colocadas en su
 * instante exacto. No hay un clip por escena ni cadena de `xfade`, y por eso no
 * hay archivos intermedios de video que sincronizar: la única fuente de verdad
 * del tiempo son las duraciones medidas del audio, y todo lo que se ve se
 * calcula a partir de ellas.
 *
 * Se dibuja con lo que ffmpeg ya trae (libass, `gradients`) en vez de rasterizar
 * HTML: agregar un navegador headless a `packages/tools` para maquetar seis
 * placas de texto es cambiar 150 MB de dependencia por un `<div>`.
 *
 * La paleta sale del logo de la empresa. Un video que no se parece a la marca
 * obliga a quien lo mira a hacer el trabajo de reconocerla.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PAUSA,
  parseGuion,
  ubicarEscenas,
  type Escena,
  type Guion,
  type ImagenGuion,
} from "./guion.js";
import { iconoAss } from "./iconos.js";
import { visualAss, type Tinte } from "./visuales.js";
import { elegirMusica } from "./musica.js";
import { construirSonido } from "./sonido.js";
import { crearNarrador, type Motor } from "./narracion.js";
import type { DocumentMeta } from "./render.js";

const ejecutar = promisify(execFile);

/** ASS ordena el color al revés que el web: &HAABBGGRR, con AA de transparencia. */
const ass = (hex: string): string =>
  `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

/**
 * La paleta sale del **logo**, no del CSS del sitio.
 *
 * El sitio usa un azul plano y un ámbar de botón; el logo es un lazo de
 * turquesa, azul cielo y violeta, y eso es lo que hace reconocible a la marca.
 * Los tres colores están muestreados del archivo: violeta `#5058e8` (40% del
 * logo), turquesa `#40f8c0` (26%) y azul `#40a0f8` (15%).
 *
 * El ámbar quedó afuera a propósito: no está en el logo, y con él la pieza se
 * parecía a cualquier presentación oscura con un botón amarillo.
 */
const FONDO = "#0a0e1a";

const COLOR = {
  fondo: `0x${FONDO.slice(1)}`,
  /** El violeta del logo, apenas insinuado: da profundidad sin pintar nada. */
  fondoAlto: "0x1a1f45",
  tinta: ass("#f8fafc"),
  tintaTenue: ass("#94a3b8"),
  tintaDebil: ass("#64748b"),
  /** Estructura: cejas, reglas, viñetas. */
  acento: ass("#40a0f8"),
  /** Lo que hay que mirar primero. El turquesa del logo. */
  realce: ass("#3ee8b4"),
  /** El violeta del logo. Sirve de masa, nunca de texto. */
  violeta: ass("#5058e8"),
  /** El gris azulado de las tarjetas de un diagrama. */
  panel: ass("#232f4d"),
  // Los tonos de las personas. Cálidos y desaturados: sobre un fondo azul
  // oscuro, una piel muy saturada se lee como plástico.
  piel: ass("#e3b18a"),
  pielAlt: ass("#b8815a"),
  pelo: ass("#3a2b21"),
  ropa: ass("#2f8fb5"),
  ropaAlt: ass("#4a5590"),
  linea: ass("#1e293b"),
} as const;

/**
 * Los colores simbólicos de un visual, resueltos a estilos de ASS.
 *
 * ASS no acepta un color arbitrario en una etiqueta de dibujo sin ensuciar cada
 * evento con `\c`; declarar un estilo por tinte deja los eventos limpios y hace
 * que el archivo se lea.
 */
const ESTILO_DE_TINTE: Record<Tinte, string> = {
  acento: "TinteAcento",
  realce: "TinteRealce",
  violeta: "TinteVioleta",
  tinta: "TinteTinta",
  tenue: "TinteTenue",
  panel: "TintePanel",
  linea: "TinteLinea",
  piel: "TintePiel",
  pielAlt: "TintePielAlt",
  pelo: "TintePelo",
  ropa: "TinteRopa",
  ropaAlt: "TinteRopaAlt",
};

/**
 * Familias con estilo propio, no `Bold=1`.
 *
 * Pedirle negrita a "Avenir Next" hace que libass sintetice o elija la variante
 * oblicua, y el título salía en cursiva sin que nadie la pidiera.
 */
const FUENTE = {
  titulo: "Avenir Next Demi Bold",
  cuerpo: "Avenir Next",
} as const;

const LIENZO = { ancho: 1920, alto: 1080, fps: 30 } as const;
const MARGEN = 180;
const ANCHO_UTIL = LIENZO.ancho - MARGEN * 2;
/** Última fila utilizable: debajo va la barra de progreso. */
const PISO = 940;

/**
 * El recuadro donde va la imagen de una escena, y el ancho que le queda al texto.
 *
 * La imagen no se pone de fondo con el texto encima: una foto detrás de un
 * párrafo lo vuelve ilegible en el peor momento, que es cuando alguien está
 * leyendo. Van al lado, en dos columnas, y cada una respira. La única imagen
 * que sí ocupa todo el cuadro es la de la portada, donde hay tres palabras y un
 * velo oscuro que las sostiene.
 */
const PANEL = { x: 1096, y: 214, ancho: 644, alto: 620 } as const;

/**
 * El hueco de un **clip**, más ancho y en 16:9.
 *
 * Una foto se recorta para llenar el panel, así que le da igual la proporción.
 * Un clip no: se encaja entero, y una grabación de pantalla 16:9 metida en un
 * panel casi cuadrado usaba 644×362 de los 644×620 disponibles — un tercio del
 * alto desperdiciado en barras negras, con la aplicación diminuta. Este hueco
 * tiene la proporción de la grabación, así que la llena, y crece hacia la
 * izquierda porque a la derecha ya toca el margen.
 *
 * El borde derecho coincide con el del panel (1740) para que las dos clases de
 * escena queden alineadas entre sí.
 *
 * Cuánto crece hacia la izquierda es un equilibrio, no un máximo: con el hueco
 * en x=760 el clip se veía enorme, pero a la columna de texto le quedaban 508px
 * y un párrafo de voz en off de treinta y pico de palabras **se desbordaba por
 * abajo del cuadro**. En x=900 el clip sigue teniendo casi el doble de área que
 * el panel de una foto y al texto le quedan 648px, que es lo que necesita.
 */
const PANEL_CLIP = { x: 900, y: 304, ancho: 840, alto: 473 } as const;

const anchoDeTexto = (hueco: { x: number }): number => hueco.x - MARGEN - 72;
const ANCHO_CON_IMAGEN = anchoDeTexto(PANEL);
const ANCHO_CON_CLIP = anchoDeTexto(PANEL_CLIP);

/** Cuánto se agranda la fuente de la imagen antes de moverla, para que no pixele. */
const SOBREMUESTREO = { panel: 1.5, completa: 1.25 } as const;

/** El fundido de entrada y salida de cada imagen, en segundos. */
const FUNDIDO_IMAGEN = 0.55;

/** Ancho medio de un carácter en Avenir Next, como fracción del cuerpo. */
const AVANCE = 0.52;

/**
 * ASS reserva `{`, `}` y `\` para sus propias órdenes de estilo. Se quitan del
 * texto del guion: si pasan, el reproductor los interpreta como formato y la
 * frase desaparece de la pantalla en vez de verse mal.
 */
const escaparAss = (texto: string): string =>
  texto
    .replace(/[{}]/g, "")
    .replace(/\\/g, "/")
    .replace(/\s*\n\s*/g, " ");

/** Corta el texto para que entre en el ancho útil. `\N` es el salto de ASS. */
function envolver(texto: string, cuerpo: number, ancho = ANCHO_UTIL): string[] {
  const maximo = Math.max(12, Math.floor(ancho / (cuerpo * AVANCE)));
  const lineas: string[] = [];
  let actual = "";
  for (const palabra of texto.split(/\s+/).filter(Boolean)) {
    const tentativa = actual ? `${actual} ${palabra}` : palabra;
    if (tentativa.length > maximo && actual) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = tentativa;
    }
  }
  if (actual) lineas.push(actual);
  return lineas.length > 0 ? lineas : [""];
}

const reloj = (segundos: number): string => {
  const t = Math.max(0, segundos);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};

/** Una línea hablada ya ubicada en el tiempo. */
interface LineaMedida {
  personaje: string;
  texto: string;
  archivo: string;
  inicio: number;
  duracion: number;
}

interface EscenaMedida {
  escena: Escena;
  lineas: LineaMedida[];
  /** Rutas ya resueltas de las imágenes de la escena. Vacío = sólo tipografía. */
  imagenes: MedioResuelto[];
  /** Visuales dibujados de la escena. Se pintan en el panel, como una imagen. */
  visuales: string[];
  inicio: number;
  fin: number;
}

/**
 * Reparte los tiempos y le suma a cada escena lo que se ve en el panel.
 *
 * El reloj es el de `guion.ts`, compartido con el render de láminas: acá sólo se
 * agrega el piso que necesitan las imágenes. Una imagen que dura menos de lo que
 * tarda en aparecer y desaparecer es un parpadeo, así que si hay más imágenes
 * que tiempo la escena se estira para que cada una llegue a verse. Vale la pena:
 * el guion pidió mostrarlas.
 */
function ubicar(
  guion: Guion,
  duraciones: number[],
  rutasPorEscena: MedioResuelto[][],
): { escenas: EscenaMedida[]; total: number } {
  // Los visuales no se resuelven contra el disco, pero ocupan el mismo panel y
  // por eso cuentan igual para el tiempo mínimo de la escena.
  const visualesPorEscena = guion.escenas.map((escena) =>
    escena.imagenes.filter((imagen) => imagen.visual).map((imagen) => imagen.visual!),
  );
  const minimos = guion.escenas.map(
    (_, orden) =>
      ((rutasPorEscena[orden]?.length ?? 0) + (visualesPorEscena[orden]?.length ?? 0)) *
      (FUNDIDO_IMAGEN * 2 + 0.9),
  );

  const { escenas, total } = ubicarEscenas(guion, duraciones, minimos);
  return {
    escenas: escenas.map((ubicada, orden) => ({
      escena: ubicada.escena,
      lineas: ubicada.lineas.map((linea) => ({
        personaje: linea.personaje,
        texto: linea.texto,
        archivo: `linea-${linea.indice}`,
        inicio: linea.inicio,
        duracion: linea.duracion,
      })),
      imagenes: rutasPorEscena[orden] ?? [],
      visuales: visualesPorEscena[orden] ?? [],
      inicio: ubicada.inicio,
      fin: ubicada.fin,
    })),
    total,
  };
}

interface Evento {
  desde: number;
  hasta: number;
  estilo: string;
  texto: string;
  x: number;
  y: number;
  entrada?: number;
  /**
   * Qué se dibuja sobre qué. Con imágenes de fondo el orden dejó de ser
   * decorativo: el velo tiene que quedar **debajo** del texto que vuelve
   * legible, y la barra de progreso arriba de todo o la portada se la come.
   */
  capa?: number;
  /** Transparencia extra, en hexadecimal de ASS: `&H00&` opaco, `&HFF&` invisible. */
  alfa?: string;
  /**
   * No se desliza al entrar.
   *
   * Lo que hace de fondo —el velo de la portada, el riel del progreso, las
   * masas de un diagrama— tiene que estar quieto: si el fondo también se mueve,
   * la placa entera tiembla en vez de armarse.
   */
  quieto?: boolean;
}

/**
 * Cuánto sube cada elemento al entrar, en píxeles.
 *
 * Un fundido solo se lee como "apareció algo"; un fundido con desplazamiento se
 * lee como "esto entró", que es lo que hace que una placa quieta parezca una
 * pieza filmada. Son doce píxeles: más que eso ya es un elemento que se mueve y
 * distrae de lo que dice.
 */
const DESLIZ = 12;

const dialogoAss = (evento: Evento): string => {
  const entrada = evento.entrada ?? 420;
  const fundido = `\\fad(${entrada},380)`;
  const alfa = evento.alfa ? `\\alpha${evento.alfa}` : "";
  // `\move` desplaza durante la misma ventana del fundido, así que el elemento
  // termina de subir justo cuando termina de aparecer.
  const posicion = evento.quieto
    ? `\\pos(${evento.x},${evento.y})`
    : `\\move(${evento.x},${evento.y + DESLIZ},${evento.x},${evento.y},0,${entrada})`;
  return (
    `Dialogue: ${evento.capa ?? 1},${reloj(evento.desde)},${reloj(evento.hasta)},` +
    `${evento.estilo},,0,0,0,,` +
    `{${posicion}${alfa}${fundido}}${evento.texto}`
  );
};

/** Rectángulo vectorial: ASS dibuja formas y ahorra un filtro por adorno. */
const barra = (ancho: number, alto: number): string =>
  `{\\p1}m 0 0 l ${ancho} 0 l ${ancho} ${alto} l 0 ${alto}{\\p0}`;

/**
 * Reparte una línea hablada en frases, con el instante en que se dice cada una.
 *
 * Sirve para subtitular la narración cuando la escena no tiene nada más que
 * mostrar. El reparto es proporcional al largo: no sabemos dónde cae cada frase
 * dentro del audio, pero una frase que ocupa un tercio del texto ocupa
 * aproximadamente un tercio del tiempo, y eso alcanza para que lo escrito
 * acompañe a la voz en vez de adelantarse o quedarse atrás.
 */
function frasesDe(linea: LineaMedida): Array<{ texto: string; desde: number; hasta: number }> {
  const partes = linea.texto
    .split(/(?<=[.!?])\s+/)
    .map((frase) => frase.trim())
    .filter(Boolean);
  if (partes.length === 0) return [];

  const total = partes.reduce((suma, frase) => suma + frase.length, 0) || 1;
  const frases: Array<{ texto: string; desde: number; hasta: number }> = [];
  let recorrido = 0;
  for (const texto of partes) {
    const desde = linea.inicio + (recorrido / total) * linea.duracion;
    recorrido += texto.length;
    frases.push({
      texto,
      desde,
      hasta: linea.inicio + (recorrido / total) * linea.duracion,
    });
  }
  return frases;
}

function componerAss(
  escenas: EscenaMedida[],
  total: number,
  guion: Guion,
  meta: DocumentMeta,
): string {
  const eventos: Evento[] = [];

  for (const { escena, lineas, imagenes, visuales, inicio, fin } of escenas) {
    const hasta = fin + 0.35;
    const conImagen = imagenes.length > 0 || visuales.length > 0;
    // Un clip usa un hueco más grande, así que la columna de texto y la línea
    // de apoyo se corren con él: si sólo se agrandara el video, el texto le
    // pasaría por debajo.
    const conClip = imagenes.some((medio) => medio.clip);
    const hueco = conClip ? PANEL_CLIP : PANEL;

    // El visual va en el mismo hueco que una foto, pero se dibuja con formas de
    // ASS en vez de superponerse como video: así entra entero, sin recorte, y
    // sale en los colores de la marca sin depender de ningún archivo.
    for (const nombre of visuales) {
      const lado = Math.min(PANEL.ancho, PANEL.alto);
      const piezas = visualAss(nombre, PANEL.x + (PANEL.ancho - lado) / 2, PANEL.y + (PANEL.alto - lado) / 2, lado);
      for (const pieza of piezas ?? []) {
        if (pieza.tipo === "forma") {
          eventos.push({
            desde: inicio,
            hasta,
            estilo: ESTILO_DE_TINTE[pieza.color],
            texto: `{\\p1}${pieza.trazo}{\\p0}`,
            x: pieza.x,
            y: pieza.y,
            // La opacidad del dibujo se expresa como transparencia de ASS, que
            // va al revés: 0 es opaco.
            ...(pieza.opacidad < 1
              ? { alfa: `&H${Math.round((1 - pieza.opacidad) * 255).toString(16).padStart(2, "0").toUpperCase()}&` }
              : {}),
            entrada: 500,
            capa: 0,
            quieto: true,
          });
        } else {
          eventos.push({
            desde: inicio,
            hasta,
            estilo: pieza.peso ? "VisualFuerte" : "Visual",
            texto: `{\\fs${pieza.cuerpo}${pieza.centrado ? "\\an8" : ""}}${escaparAss(pieza.texto)}`,
            x: pieza.x,
            y: pieza.y,
            entrada: 600,
          });
        }
      }
    }
    // La imagen le come la mitad derecha del cuadro, así que el texto se
    // reencuadra en una columna. No es un ajuste de estilo: con el ancho de
    // siempre, cada renglón pasaba por debajo de la foto.
    const ancho = conImagen && !escena.esPortada
      ? (conClip ? ANCHO_CON_CLIP : ANCHO_CON_IMAGEN)
      : ANCHO_UTIL;

    if (escena.esPortada) {
      // La portada con imagen la usa entera, y el velo es lo que hace que el
      // título se lea sobre cualquier foto: sin él, un cielo claro se llevaba
      // puesto el nombre de la empresa.
      if (conImagen) {
        eventos.push({
          desde: inicio,
          hasta,
          estilo: "Velo",
          texto: barra(LIENZO.ancho, LIENZO.alto),
          x: 0,
          y: 0,
          // Suficiente para que el blanco se lea sobre una foto clara, no tanto
          // como para apagar la foto: a más velo, la imagen deja de aportar.
          alfa: "&H66&",
          entrada: 200,
          capa: 0,
          quieto: true,
        });
      }
      eventos.push({
        desde: inicio,
        hasta,
        estilo: "Regla",
        texto: barra(90, 4),
        x: MARGEN,
        y: 392,
        entrada: 300,
      });
      // Sin empresa no se dibuja una cejilla vacía: quedaba un hueco raro
      // entre la regla y el título.
      if (meta.company) {
        eventos.push({
          desde: inicio,
          hasta,
          estilo: "Ceja",
          texto: escaparAss(meta.company.toUpperCase()),
          x: MARGEN,
          y: 434,
          entrada: 500,
        });
      }
      const titulo = envolver(escena.titulo || guion.titulo, 104);
      eventos.push({
        desde: inicio,
        hasta,
        estilo: "Portada",
        texto: titulo.map(escaparAss).join("\\N"),
        x: MARGEN,
        y: 500,
        entrada: 700,
      });
      continue;
    }

    // Cejilla persistente: ubica la escena dentro del video sin robar atención.
    eventos.push({
      desde: inicio,
      hasta,
      estilo: "Ceja",
      texto: escaparAss(guion.titulo.toUpperCase()),
      x: MARGEN,
      y: 150,
      entrada: 320,
    });
    eventos.push({
      desde: inicio,
      hasta,
      estilo: "Regla",
      texto: barra(56, 3),
      x: MARGEN,
      y: 205,
      entrada: 320,
    });

    let techo = 246;

    // El ícono de la escena va sobre el título, no al lado: al lado obliga a
    // sangrar el texto y una escena con ícono no se alinearía con las demás.
    const marca = escena.icono ? iconoAss(escena.icono, 54) : null;
    if (marca) {
      eventos.push({
        desde: inicio,
        hasta,
        // En ámbar: es la única marca de la placa que compite con el título, y
        // el azul de las viñetas ahí abajo la volvía una viñeta más grande.
        estilo: "Realce",
        texto: `{\\p1}${marca.trazo}{\\p0}`,
        x: MARGEN,
        y: techo,
        entrada: 400,
      });
      techo += marca.tamaño + 30;
    }

    // Una imagen al costado se apoya en una línea de acento: es lo que la ata al
    // resto de la placa en vez de dejarla flotando como un recorte pegado.
    if (conImagen && !escena.esPortada) {
      eventos.push({
        desde: inicio,
        hasta,
        estilo: "Regla",
        texto: barra(hueco.ancho, 3),
        x: hueco.x,
        y: hueco.y + hueco.alto + 22,
        entrada: 700,
      });
    }

    if (escena.titulo) {
      const titulo = envolver(escena.titulo, 62, ancho);
      eventos.push({
        desde: inicio,
        hasta,
        estilo: "Titulo",
        texto: titulo.map(escaparAss).join("\\N"),
        x: MARGEN,
        y: techo,
        entrada: 450,
      });
      techo += titulo.length * 82 + 56;
    }

    // Se mide todo el bloque antes de dibujarlo para poder centrarlo —con el
    // contenido clavado arriba, una escena de dos líneas dejaba media pantalla
    // vacía— y para saber si entra: una conversación de cuatro intervenciones
    // se desbordaba por abajo del cuadro y se comía la barra de progreso.
    const piezas: Array<{ alto: number; desde: number; dibujar: (y: number) => void }> = [];

    const dialogos = lineas.filter((linea) => linea.personaje !== "");

    // Una escena que se narra pero no muestra nada quedaba como un título sobre
    // un cuadro vacío durante veinte segundos. Si no hay viñetas, destacado ni
    // diálogo, se subtitula la narración: una frase a la vez, en su momento.
    if (dialogos.length === 0 && escena.balas.length === 0 && !escena.destacado) {
      const frases = lineas.flatMap(frasesDe);
      if (frases.length > 0) {
        const envueltas = frases.map((frase) => ({
          ...frase,
          cuerpo: envolver(frase.texto, 46, ancho - 60),
        }));
        // Todas las frases arrancan a la misma altura: se reemplazan en el
        // lugar, como un subtítulo, en vez de apilarse hacia abajo.
        const altoMayor = Math.max(...envueltas.map((frase) => frase.cuerpo.length)) * 62;
        const y = Math.max(techo, (techo + PISO) / 2 - altoMayor / 2);
        envueltas.forEach((frase, i) => {
          eventos.push({
            desde: frase.desde,
            // La última se queda hasta el final de la escena para no dejar el
            // cuadro vacío mientras corre la pausa que la separa de la próxima.
            hasta: i === envueltas.length - 1 ? hasta : frase.hasta,
            estilo: "Leyenda",
            texto: frase.cuerpo.map(escaparAss).join("\\N"),
            x: MARGEN,
            y,
            entrada: 260,
          });
        });
        continue;
      }
    }

    if (dialogos.length > 0) {
      for (const linea of dialogos) {
        const cuerpo = envolver(linea.texto, 42, ancho - 40);
        piezas.push({
          alto: 42 + cuerpo.length * 56 + 34,
          desde: linea.inicio,
          // Cada intervención aparece cuando se la escucha: esa es la sincronía.
          dibujar: (y) => {
            eventos.push({
              desde: linea.inicio,
              hasta,
              estilo: "Personaje",
              texto: escaparAss(linea.personaje.toUpperCase()),
              x: MARGEN,
              y,
              entrada: 260,
            });
            eventos.push({
              desde: linea.inicio,
              hasta,
              estilo: "Dialogo",
              texto: cuerpo.map(escaparAss).join("\\N"),
              x: MARGEN,
              y: y + 42,
              entrada: 260,
            });
          },
        });
      }
    } else {
      if (escena.destacado) {
        const cuerpo = envolver(escena.destacado, 54, ancho - 120);
        piezas.push({
          alto: cuerpo.length * 72 + 40,
          desde: inicio,
          dibujar: (y) => {
            eventos.push({
              desde: inicio,
              hasta,
              estilo: "Realce",
              texto: barra(4, cuerpo.length * 72),
              x: MARGEN,
              y: y + 12,
              entrada: 600,
            });
            eventos.push({
              desde: inicio,
              hasta,
              estilo: "Destacado",
              texto: cuerpo.map(escaparAss).join("\\N"),
              x: MARGEN + 44,
              y,
              entrada: 600,
            });
          },
        });
      }

      // Las viñetas se reparten en el tramo hablado: aparecen mientras se explican.
      const util = Math.max(0.1, fin - inicio) * 0.62;
      escena.balas.forEach((bala, i) => {
        const aparece = inicio + (escena.balas.length > 1 ? (i / escena.balas.length) * util : 0);
        // Con ícono la viñeta ocupa más y el texto arranca más a la derecha; sin
        // él sigue siendo el cuadradito de siempre. Un nombre de ícono que no
        // existe cae en ese mismo camino en vez de dejar la fila descolgada.
        const dibujo = bala.icono ? iconoAss(bala.icono, 38) : null;
        const sangria = dibujo ? 68 : 48;
        const cuerpo = envolver(bala.texto, 42, ancho - sangria);
        piezas.push({
          alto: Math.max(cuerpo.length * 56, dibujo ? dibujo.tamaño + 12 : 0) + 26,
          desde: aparece,
          dibujar: (y) => {
            eventos.push({
              desde: aparece,
              hasta,
              estilo: "Vineta",
              texto: dibujo ? `{\\p1}${dibujo.trazo}{\\p0}` : barra(10, 10),
              x: MARGEN + (dibujo ? 0 : 4),
              y: y + (dibujo ? 6 : 18),
              entrada: 300,
            });
            eventos.push({
              desde: aparece,
              hasta,
              estilo: "Bala",
              texto: cuerpo.map(escaparAss).join("\\N"),
              x: MARGEN + sangria,
              y,
              entrada: 300,
            });
          },
        });
      });
    }

    // Lo que no entra pasa de página en vez de desbordarse: cuando llega la
    // intervención que no cabe, las anteriores se van y ésta arranca arriba.
    const paginas: Array<typeof piezas> = [];
    let pagina: typeof piezas = [];
    let usado = 0;
    for (const pieza of piezas) {
      if (pagina.length > 0 && usado + pieza.alto > PISO - techo) {
        paginas.push(pagina);
        pagina = [];
        usado = 0;
      }
      pagina.push(pieza);
      usado += pieza.alto;
    }
    if (pagina.length > 0) paginas.push(pagina);

    paginas.forEach((actual, i) => {
      const alto = actual.reduce((total, pieza) => total + pieza.alto, 0);
      let y = Math.max(techo, (techo + PISO) / 2 - alto / 2);
      // Una página se retira justo cuando entra la primera pieza de la que sigue.
      const cierre = paginas[i + 1]?.[0]?.desde;
      const antes = eventos.length;
      for (const pieza of actual) {
        pieza.dibujar(y);
        y += pieza.alto;
      }
      if (cierre !== undefined) {
        for (let j = antes; j < eventos.length; j++) eventos[j]!.hasta = cierre;
      }
    });
  }

  // Progreso: una línea que cruza el pie durante todo el video.
  const eventosFijos = [
    `Dialogue: 2,${reloj(0)},${reloj(total)},Riel,,0,0,0,,` +
      `{\\pos(${MARGEN},1002)\\alpha&HD0&}${barra(ANCHO_UTIL, 2)}`,
    `Dialogue: 2,${reloj(0)},${reloj(total)},Progreso,,0,0,0,,` +
      `{\\pos(${MARGEN},1002)\\fscx0\\t(0,${Math.round(total * 1000)},\\fscx100)}` +
      barra(ANCHO_UTIL, 2),
  ];

  const estilo = (
    nombre: string,
    fuente: string,
    cuerpo: number,
    color: string,
    espaciado = 0,
  ): string =>
    `Style: ${nombre},${fuente},${cuerpo},${color},&H000000FF,&H00000000,&H00000000,` +
    `0,0,0,0,100,100,${espaciado},0,1,0,0,7,0,0,0,1`;

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${LIENZO.ancho}`,
    `PlayResY: ${LIENZO.alto}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, " +
      "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, " +
      "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    estilo("Portada", FUENTE.titulo, 104, COLOR.tinta),
    estilo("Titulo", FUENTE.titulo, 62, COLOR.tinta),
    estilo("Ceja", FUENTE.titulo, 30, COLOR.acento, 5),
    estilo("Bala", FUENTE.cuerpo, 42, COLOR.tintaTenue),
    estilo("Leyenda", FUENTE.cuerpo, 46, COLOR.tinta),
    estilo("Destacado", FUENTE.titulo, 54, COLOR.tinta),
    estilo("Personaje", FUENTE.titulo, 26, COLOR.acento, 4),
    estilo("Dialogo", FUENTE.cuerpo, 42, COLOR.tinta),
    estilo("Regla", FUENTE.cuerpo, 40, COLOR.acento),
    estilo("Vineta", FUENTE.cuerpo, 40, COLOR.acento),
    estilo("Realce", FUENTE.cuerpo, 40, COLOR.realce),
    estilo("Velo", FUENTE.cuerpo, 40, ass(FONDO)),
    // Un estilo por tinte de los visuales, más los dos de sus rótulos.
    estilo("TinteAcento", FUENTE.cuerpo, 40, COLOR.acento),
    estilo("TinteRealce", FUENTE.cuerpo, 40, COLOR.realce),
    estilo("TinteVioleta", FUENTE.cuerpo, 40, COLOR.violeta),
    estilo("TinteTinta", FUENTE.cuerpo, 40, COLOR.tinta),
    estilo("TinteTenue", FUENTE.cuerpo, 40, COLOR.tintaTenue),
    estilo("TintePanel", FUENTE.cuerpo, 40, COLOR.panel),
    estilo("TinteLinea", FUENTE.cuerpo, 40, COLOR.linea),
    estilo("TintePiel", FUENTE.cuerpo, 40, COLOR.piel),
    estilo("TintePielAlt", FUENTE.cuerpo, 40, COLOR.pielAlt),
    estilo("TintePelo", FUENTE.cuerpo, 40, COLOR.pelo),
    estilo("TinteRopa", FUENTE.cuerpo, 40, COLOR.ropa),
    estilo("TinteRopaAlt", FUENTE.cuerpo, 40, COLOR.ropaAlt),
    estilo("Visual", FUENTE.cuerpo, 26, COLOR.tinta),
    estilo("VisualFuerte", FUENTE.titulo, 26, COLOR.tinta),
    estilo("Riel", FUENTE.cuerpo, 40, COLOR.linea),
    estilo("Progreso", FUENTE.cuerpo, 40, COLOR.acento),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...eventosFijos,
    ...eventos.map(dialogoAss),
    "",
  ].join("\n");
}

export interface OpcionesVideo {
  ffmpeg?: string;
  ffprobe?: string;
  kokoroHome?: string;
  motor?: Motor;
  velocidad?: number;
  /** Todos los personajes con la misma voz. */
  unaSolaVoz?: boolean;
  /** Lo escrito → cómo se dice. Se aplica sólo al audio, nunca a la pantalla. */
  lexico?: Record<string, string>;
  /**
   * El logo de la empresa, ya resuelto a una ruta.
   *
   * Va **chico y en un lugar fijo**, no de fondo: un logo estirado a pantalla
   * completa deja de ser un logo. Grande en la portada, discreto en la esquina
   * del resto, que es como firma una marca un video.
   */
  logo?: string;
  /** Carpeta con las pistas de música. Sin esto el video sale sin cama. */
  musicaHome?: string;
  /** Qué música quiere el guion: un clima, el nombre de una pista, o "ninguna". */
  musica?: string;
  /**
   * Convierte una imagen del guion en una ruta que ffmpeg pueda abrir.
   *
   * Devolver `null` la saltea. Quién puede leer el disco —y quién produce la que
   * todavía no existe— lo decide el servidor: esta habilidad filma, no busca
   * archivos ni habla con un proveedor.
   */
  resolverImagen?: (imagen: ImagenGuion) => Promise<string | null>;
  /** Corta el render si la corrida se detiene. */
  signal?: AbortSignal;
}

export interface ResultadoVideo {
  bytes: Buffer;
  segundos: number;
  escenas: number;
  personajes: string[];
  motor: Motor;
  /** Cuántas imágenes llegaron a verse. */
  imagenes: number;
  /** La pista que quedó de fondo, o `null` si se filmó en silencio. */
  musica: string | null;
  /** Lo que no salió como pedía el guion, para contárselo al agente. */
  avisos: string[];
}

/** Dónde y de qué tamaño se dibuja el logo. */
const MARCA = {
  portada: { x: MARGEN, y: 250, alto: 190 },
  esquina: { x: 1740, y: 128, alto: 62 },
} as const;

/** Una imagen ya ubicada en el tiempo y en el cuadro. */
/**
 * Un medio ya resuelto a una ruta del disco, con lo único que el render
 * necesita saber para tratarlo distinto: si se mira o si se reproduce.
 */
interface MedioResuelto {
  ruta: string;
  clip: boolean;
}

interface ImagenPuesta {
  ruta: string;
  /** Es un clip de video: se reproduce, no se le hace acercamiento. */
  clip?: boolean;
  desde: number;
  hasta: number;
  /** La de la portada ocupa el cuadro entero; las demás van en el panel. */
  completa: boolean;
  /**
   * El logo no se recorta ni se mueve: se escala entero y se queda quieto.
   * Tratarlo como una foto —recorte para llenar, acercamiento lento— lo
   * deforma, y un logo deformado es peor que ningún logo.
   *
   * `x` es una **expresión** de ffmpeg y no un número: así el logo se ancla al
   * borde derecho sin que nadie tenga que medir el ancho del archivo.
   */
  marca?: { alto: number; x: string; y: number };
}

/**
 * Reparte las imágenes de cada escena en el tiempo de esa escena.
 *
 * Dos imágenes en una escena de diez segundos son cinco segundos cada una: el
 * tiempo lo manda el audio, y las imágenes se acomodan adentro. Al revés
 * —estirar la escena para que entren— el video se despega de lo que se escucha.
 */
function ubicarImagenes(escenas: EscenaMedida[], logo?: string): ImagenPuesta[] {
  const puestas: ImagenPuesta[] = [];

  // El logo se pone una vez por escena y no una sola vez para todo el video:
  // cada escena tiene su ventana de `enable`, y un solo overlay que abarcara
  // todo taparía las imágenes que entran después.
  if (logo) {
    for (const medida of escenas) {
      const sitio = medida.escena.esPortada ? MARCA.portada : MARCA.esquina;
      puestas.push({
        ruta: logo,
        desde: medida.inicio,
        hasta: medida.fin + 0.35,
        completa: false,
        marca: {
          alto: sitio.alto,
          // En la portada arranca en el margen; en las escenas se ancla al
          // borde derecho, que es donde no compite con el texto.
          x: medida.escena.esPortada ? String(sitio.x) : `W-w-${LIENZO.ancho - sitio.x}`,
          y: sitio.y,
        },
      });
    }
  }

  for (const medida of escenas) {
    if (medida.imagenes.length === 0) continue;
    const desde = medida.inicio;
    const hasta = medida.fin + 0.35;
    const tramo = (hasta - desde) / medida.imagenes.length;
    medida.imagenes.forEach((medio, i) => {
      puestas.push({
        ruta: medio.ruta,
        clip: medio.clip,
        desde: desde + i * tramo,
        hasta: desde + (i + 1) * tramo,
        completa: medida.escena.esPortada,
      });
    });
  }
  return puestas;
}

/**
 * El filtro que convierte un archivo de imagen en una placa que entra y sale.
 *
 * Tres cosas pasan acá: se recorta a la medida del hueco sin deformar —una foto
 * apaisada estirada a un panel vertical se nota en el primer segundo—, se le da
 * un movimiento de acercamiento apenas perceptible para que no parezca una
 * diapositiva pegada, y se funde por alfa en los bordes. El sobremuestreo no es
 * un lujo: `zoompan` amplía sobre lo que recibe, así que si recibe el tamaño
 * final, el acercamiento es puro reescalado y la imagen se ablanda.
 */
function filtroImagen(indice: number, k: number, puesta: ImagenPuesta): string[] {
  const duracionMarca = puesta.hasta - puesta.desde;
  if (puesta.marca) {
    const salidaMarca = Math.max(0.1, duracionMarca - FUNDIDO_IMAGEN);
    return [
      // `-2` mantiene el ancho par sin tocar la proporción: es lo único que hay
      // que cuidar para que un logo no salga estirado.
      `[${indice}:v]scale=-2:${puesta.marca.alto},format=rgba,` +
        `fade=t=in:st=0:d=${FUNDIDO_IMAGEN}:alpha=1,` +
        `fade=t=out:st=${salidaMarca.toFixed(2)}:d=${FUNDIDO_IMAGEN}:alpha=1,` +
        `setpts=PTS+${puesta.desde.toFixed(2)}/TB[im${k}]`,
    ];
  }

  const destino = puesta.completa
    ? { w: LIENZO.ancho, h: LIENZO.alto, factor: SOBREMUESTREO.completa }
    : puesta.clip
      ? { w: PANEL_CLIP.ancho, h: PANEL_CLIP.alto, factor: SOBREMUESTREO.panel }
      : { w: PANEL.ancho, h: PANEL.alto, factor: SOBREMUESTREO.panel };

  if (puesta.clip) {
    const duracionClip = puesta.hasta - puesta.desde;
    const salidaClip = Math.max(0.1, duracionClip - FUNDIDO_IMAGEN);
    return [
      // Sin `zoompan` y sin sobremuestreo: el clip ya se mueve solo, y encimarle
      // un acercamiento lo marea. Y se **encaja entero**, no se recorta: a una
      // foto le podés cortar los bordes sin perder el tema, pero una captura de
      // pantalla recortada pierde justo lo que se está mostrando — la primera
      // versión le comía los costados a la aplicación y quedaba una franja
      // ilegible. `decrease` + `pad` la mete completa y centrada en el hueco.
      // El fps se fija al del lienzo porque una grabación a 25 y un video a 30
      // se desincronizan al superponerse.
      `[${indice}:v]scale=${destino.w}:${destino.h}:force_original_aspect_ratio=decrease,` +
        `pad=${destino.w}:${destino.h}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,fps=${LIENZO.fps},` +
        // `setpts=PTS-STARTPTS` antes de recortar: el clip trae su propia línea
        // de tiempo y sin reiniciarla el `trim` mide desde el instante
        // equivocado.
        `setpts=PTS-STARTPTS,trim=duration=${duracionClip.toFixed(2)},setpts=PTS-STARTPTS,` +
        `format=rgba,fade=t=in:st=0:d=${FUNDIDO_IMAGEN}:alpha=1,` +
        `fade=t=out:st=${salidaClip.toFixed(2)}:d=${FUNDIDO_IMAGEN}:alpha=1,` +
        `setpts=PTS+${puesta.desde.toFixed(2)}/TB[im${k}]`,
    ];
  }
  const grande = { w: Math.round(destino.w * destino.factor), h: Math.round(destino.h * destino.factor) };
  const duracion = puesta.hasta - puesta.desde;
  const salida = Math.max(0.1, duracion - FUNDIDO_IMAGEN);

  return [
    `[${indice}:v]scale=${grande.w}:${grande.h}:force_original_aspect_ratio=increase,` +
      `crop=${grande.w}:${grande.h},setsar=1,` +
      `zoompan=z='min(1+0.00028*on,1.09)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `d=1:s=${destino.w}x${destino.h}:fps=${LIENZO.fps},` +
      `format=rgba,fade=t=in:st=0:d=${FUNDIDO_IMAGEN}:alpha=1,` +
      `fade=t=out:st=${salida.toFixed(2)}:d=${FUNDIDO_IMAGEN}:alpha=1,` +
      // La imagen se corre a su instante: sin esto el fundido de entrada ocurre
      // al segundo cero del video y la escena la recibe ya entrada.
      `setpts=PTS+${puesta.desde.toFixed(2)}/TB[im${k}]`,
  ];
}

/**
 * Resuelve, escena por escena, qué imágenes se van a poder mostrar.
 *
 * Ninguna falla acá corta el video: una imagen que no aparece deja una escena
 * más pobre, y una excepción deja a la empresa sin entregable. Lo que no salió
 * se junta en `avisos` y vuelve en el resultado de la herramienta, que es lo
 * único que el agente puede leer para corregir el guion.
 */
async function resolverImagenes(
  guion: Guion,
  opciones: OpcionesVideo,
  avisos: string[],
): Promise<MedioResuelto[][]> {
  const rutasPorEscena: MedioResuelto[][] = [];
  const pedidas = guion.escenas.reduce(
    (total, escena) => total + escena.imagenes.filter((imagen) => !imagen.visual).length,
    0,
  );

  if (pedidas > 0 && !opciones.resolverImagen) {
    avisos.push("El guion pide imágenes, pero esta corrida no tiene cómo resolverlas.");
  }

  for (const escena of guion.escenas) {
    const rutas: MedioResuelto[] = [];
    for (const imagen of escena.imagenes) {
      // Un visual no se resuelve: se dibuja. No pasa por acá.
      if (imagen.visual) continue;
      if (!opciones.resolverImagen) continue;
      try {
        const ruta = await opciones.resolverImagen(imagen);
        if (ruta) rutas.push({ ruta, clip: imagen.clip === true });
        else avisos.push(`No se pudo mostrar la imagen "${imagen.alt || imagen.src}".`);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        avisos.push(`No se pudo mostrar "${imagen.alt || imagen.src}": ${detalle}`);
      }
    }
    rutasPorEscena.push(rutas);
  }

  return rutasPorEscena;
}

/**
 * Convierte el guion en un MP4 listo para mirar.
 *
 * Devuelve bytes y no escribe en la salida: dónde va el archivo lo decide el
 * `SkillStorage` que inyecta el servidor, igual que con Word y PDF.
 */
export async function renderVideo(
  markdown: string,
  meta: DocumentMeta,
  opciones: OpcionesVideo = {},
): Promise<ResultadoVideo> {
  const guion = parseGuion(markdown);
  if (guion.escenas.length === 0) {
    throw new Error(
      "El guion no tiene ninguna escena. Un guion es un título con `#`, y después " +
        "una escena por cada `##` con lo que se dice debajo.",
    );
  }

  const ffmpeg = opciones.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "orq-video-"));

  try {
    const narrador = crearNarrador({
      personajes: guion.personajes,
      ...(opciones.velocidad !== undefined ? { velocidad: opciones.velocidad } : {}),
      ...(opciones.kokoroHome !== undefined ? { kokoroHome: opciones.kokoroHome } : {}),
      ...(opciones.motor !== undefined ? { motor: opciones.motor } : {}),
      ...(opciones.ffprobe !== undefined ? { ffprobe: opciones.ffprobe } : {}),
      ...(opciones.unaSolaVoz !== undefined ? { unaSolaVoz: opciones.unaSolaVoz } : {}),
      ...(opciones.lexico !== undefined ? { lexico: opciones.lexico } : {}),
    });

    const extension = narrador.motor === "kokoro" ? "wav" : "aiff";
    const pedidos = guion.escenas
      .flatMap((escena) => escena.lineas)
      .map((linea, i) => ({
        texto: linea.texto,
        personaje: linea.kind === "dialogo" ? linea.personaje : "",
        destino: join(dir, `linea-${i}.${extension}`),
      }));

    const duraciones = pedidos.length > 0 ? await narrador.sintetizar(pedidos) : [];

    const avisos: string[] = [];
    const rutasPorEscena = await resolverImagenes(guion, opciones, avisos);
    const { escenas, total } = ubicar(guion, duraciones, rutasPorEscena);

    // El pedido explícito manda; sin pedido se busca una cama neutra, y si no
    // hay biblioteca el video sale en silencio sin decir nada: no configurar
    // música no es un problema que el agente pueda ni deba resolver.
    const eleccion = await elegirMusica(opciones.musicaHome, opciones.musica ?? "auto");
    if (eleccion.aviso && opciones.musica !== undefined) avisos.push(eleccion.aviso);

    await writeFile(join(dir, "guion.ass"), componerAss(escenas, total, guion, meta), "utf8");

    // El fondo se genera; no hay assets que empaquetar ni rutas que resolver.
    const fondo =
      `gradients=s=${LIENZO.ancho}x${LIENZO.alto}:c0=${COLOR.fondo}:c1=${COLOR.fondoAlto}` +
      `:c2=${COLOR.fondo}:n=3:x0=1650:y0=60:x1=260:y1=1020:speed=0.0016:` +
      `r=${LIENZO.fps}:d=${total.toFixed(2)}`;

    const args = ["-y", "-v", "error", "-f", "lavfi", "-i", fondo];
    for (const pedido of pedidos) args.push("-i", pedido.destino);

    // Los índices de entrada se llevan a mano porque el orden importa: el fondo
    // es 0, después la narración, después la música y al final las imágenes.
    let indice = pedidos.length;

    let indiceMusica = -1;
    if (eleccion.pista) {
      // `-stream_loop -1` es lo que permite que una pista de dos minutos cubra un
      // video de tres sin cortarse; el `atrim` de más abajo la termina.
      args.push("-stream_loop", "-1", "-i", eleccion.pista.ruta);
      indiceMusica = ++indice;
    }

    const puestas = ubicarImagenes(escenas, opciones.logo);
    const indicesImagen = puestas.map((puesta) => {
      const duracion = puesta.hasta - puesta.desde + 0.2;
      if (puesta.clip) {
        // Un clip se reproduce; no se congela con `-loop 1`. `-stream_loop -1`
        // cubre el hueco si el clip es más corto que la escena —igual que con la
        // cama musical— y `-t` lo termina. Sin el bucle, una escena más larga
        // que su clip queda con el último cuadro congelado, que se lee como un
        // video colgado.
        args.push("-stream_loop", "-1", "-t", duracion.toFixed(2), "-i", puesta.ruta);
      } else {
        args.push(
          "-loop",
          "1",
          "-framerate",
          String(LIENZO.fps),
          "-t",
          duracion.toFixed(2),
          "-i",
          puesta.ruta,
        );
      }
      return ++indice;
    });

    // La mezcla vive en `sonido.ts` porque la comparte el render de láminas: si
    // estuviera acá, la próxima corrección de la cama arreglaría un video y
    // dejaría el otro roto.
    const ubicadas = escenas.flatMap((medida) => medida.lineas);
    const mezcla = construirSonido({
      inicios: ubicadas.map((linea) => linea.inicio),
      total,
      indiceMusica,
    });

    // Las imágenes se superponen al fondo una tras otra, cada una sólo durante
    // su ventana. La tipografía va al final: siempre por encima de todo.
    const capasVideo = [`[0:v]setsar=1[bg]`];
    let fondoActual = "bg";
    puestas.forEach((puesta, k) => {
      capasVideo.push(...filtroImagen(indicesImagen[k]!, k, puesta));
      const destino = puesta.marca
        ? { x: puesta.marca.x, y: puesta.marca.y }
        : puesta.completa
          ? { x: 0, y: 0 }
          : puesta.clip
            ? { x: PANEL_CLIP.x, y: PANEL_CLIP.y }
            : { x: PANEL.x, y: PANEL.y };
      capasVideo.push(
        `[${fondoActual}][im${k}]overlay=x=${destino.x}:y=${destino.y}:` +
          `enable='between(t,${puesta.desde.toFixed(2)},${puesta.hasta.toFixed(2)})'[bg${k}]`,
      );
      fondoActual = `bg${k}`;
    });
    capasVideo.push(`[${fondoActual}]ass=guion.ass,format=yuv420p[vid]`);

    args.push(
      "-filter_complex",
      // Sin viñeta: oscurece los bordes, y acá el texto va alineado a la
      // izquierda, así que apagaba justo lo que hay que leer.
      `${capasVideo.join(";")};${mezcla}`,
      "-map",
      "[vid]",
      "-map",
      "[aud]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(LIENZO.fps),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-t",
      total.toFixed(2),
      "salida.mp4",
    );

    await ejecutar(ffmpeg, args, {
      cwd: dir,
      maxBuffer: 8 * 1024 * 1024,
      ...(opciones.signal ? { signal: opciones.signal } : {}),
    });

    return {
      bytes: await readFile(join(dir, "salida.mp4")),
      segundos: total,
      escenas: guion.escenas.length,
      personajes: guion.personajes,
      motor: narrador.motor,
      imagenes: puestas.length,
      musica: eleccion.pista?.nombre ?? null,
      avisos,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
