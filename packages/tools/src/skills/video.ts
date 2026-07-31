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
 * La paleta es la de la aplicación (`apps/web/src/styles.css`), convertida a
 * hexadecimal: el video de una empresa tiene que parecerse al producto.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseGuion, type Escena, type Guion } from "./guion.js";
import { crearNarrador, type Motor } from "./narracion.js";
import type { DocumentMeta } from "./render.js";

const ejecutar = promisify(execFile);

/** ASS ordena el color al revés que el web: &HAABBGGRR, con AA de transparencia. */
const ass = (hex: string): string =>
  `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

const COLOR = {
  fondo: "0x0c0d0f",
  fondoAlto: "0x151d26",
  tinta: ass("#edeef0"),
  tintaTenue: ass("#a2a5a8"),
  tintaDebil: ass("#6f7275"),
  acento: ass("#12b2f4"),
  linea: ass("#303337"),
} as const;

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

/** Pausas que separan lo que se escucha. Sin ellas el diálogo se atropella. */
const PAUSA = { entreEscenas: 0.5, entreDialogos: 0.34, entreLineas: 0.24, cola: 1.4 } as const;

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
  inicio: number;
  fin: number;
}

/** Reparte los tiempos: cada línea arranca cuando termina la anterior. */
function ubicar(guion: Guion, duraciones: number[]): { escenas: EscenaMedida[]; total: number } {
  const escenas: EscenaMedida[] = [];
  let cursor = 0;
  let indice = 0;

  for (const escena of guion.escenas) {
    const inicio = cursor;
    const lineas: LineaMedida[] = [];
    for (let i = 0; i < escena.lineas.length; i++) {
      const linea = escena.lineas[i]!;
      const duracion = duraciones[indice] ?? 0;
      lineas.push({
        personaje: linea.kind === "dialogo" ? linea.personaje : "",
        texto: linea.texto,
        archivo: `linea-${indice}`,
        inicio: cursor,
        duracion,
      });
      cursor += duracion;
      if (i < escena.lineas.length - 1) {
        cursor += linea.kind === "dialogo" ? PAUSA.entreDialogos : PAUSA.entreLineas;
      }
      indice++;
    }
    // Una escena sin nada hablado igual tiene que verse: se le da aire propio.
    // La portada necesita más, porque suele no tener narración y con dos
    // segundos el nombre de la empresa pasaba antes de poder leerlo.
    if (lineas.length === 0) cursor += escena.esPortada ? 3.8 : 2.4;
    escenas.push({ escena, lineas, inicio, fin: cursor });
    cursor += PAUSA.entreEscenas;
  }

  return { escenas, total: cursor - PAUSA.entreEscenas + PAUSA.cola };
}

interface Evento {
  desde: number;
  hasta: number;
  estilo: string;
  texto: string;
  x: number;
  y: number;
  entrada?: number;
}

const dialogoAss = (evento: Evento): string => {
  const fundido = `\\fad(${evento.entrada ?? 420},380)`;
  return (
    `Dialogue: 0,${reloj(evento.desde)},${reloj(evento.hasta)},${evento.estilo},,0,0,0,,` +
    `{\\pos(${evento.x},${evento.y})${fundido}}${evento.texto}`
  );
};

/** Rectángulo vectorial: ASS dibuja formas y ahorra un filtro por adorno. */
const barra = (ancho: number, alto: number): string =>
  `{\\p1}m 0 0 l ${ancho} 0 l ${ancho} ${alto} l 0 ${alto}{\\p0}`;

function componerAss(
  escenas: EscenaMedida[],
  total: number,
  guion: Guion,
  meta: DocumentMeta,
): string {
  const eventos: Evento[] = [];

  for (const { escena, lineas, inicio, fin } of escenas) {
    const hasta = fin + 0.35;

    if (escena.esPortada) {
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
    if (escena.titulo) {
      const titulo = envolver(escena.titulo, 62);
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
    if (dialogos.length > 0) {
      for (const linea of dialogos) {
        const cuerpo = envolver(linea.texto, 42, ANCHO_UTIL - 40);
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
        const cuerpo = envolver(escena.destacado, 54, ANCHO_UTIL - 120);
        piezas.push({
          alto: cuerpo.length * 72 + 40,
          desde: inicio,
          dibujar: (y) => {
            eventos.push({
              desde: inicio,
              hasta,
              estilo: "Regla",
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
        const cuerpo = envolver(bala, 42, ANCHO_UTIL - 48);
        piezas.push({
          alto: cuerpo.length * 56 + 26,
          desde: aparece,
          dibujar: (y) => {
            eventos.push({
              desde: aparece,
              hasta,
              estilo: "Vineta",
              texto: barra(10, 10),
              x: MARGEN + 4,
              y: y + 18,
              entrada: 300,
            });
            eventos.push({
              desde: aparece,
              hasta,
              estilo: "Bala",
              texto: cuerpo.map(escaparAss).join("\\N"),
              x: MARGEN + 48,
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
    `Dialogue: 0,${reloj(0)},${reloj(total)},Riel,,0,0,0,,` +
      `{\\pos(${MARGEN},1002)\\alpha&HD0&}${barra(ANCHO_UTIL, 2)}`,
    `Dialogue: 0,${reloj(0)},${reloj(total)},Progreso,,0,0,0,,` +
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
    estilo("Destacado", FUENTE.titulo, 54, COLOR.tinta),
    estilo("Personaje", FUENTE.titulo, 26, COLOR.acento, 4),
    estilo("Dialogo", FUENTE.cuerpo, 42, COLOR.tinta),
    estilo("Regla", FUENTE.cuerpo, 40, COLOR.acento),
    estilo("Vineta", FUENTE.cuerpo, 40, COLOR.acento),
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
  /** Corta el render si la corrida se detiene. */
  signal?: AbortSignal;
}

export interface ResultadoVideo {
  bytes: Buffer;
  segundos: number;
  escenas: number;
  personajes: string[];
  motor: Motor;
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
    const { escenas, total } = ubicar(guion, duraciones);

    await writeFile(join(dir, "guion.ass"), componerAss(escenas, total, guion, meta), "utf8");

    // El fondo se genera; no hay assets que empaquetar ni rutas que resolver.
    const fondo =
      `gradients=s=${LIENZO.ancho}x${LIENZO.alto}:c0=${COLOR.fondo}:c1=${COLOR.fondoAlto}` +
      `:c2=${COLOR.fondo}:n=3:x0=1650:y0=60:x1=260:y1=1020:speed=0.0016:` +
      `r=${LIENZO.fps}:d=${total.toFixed(2)}`;

    const args = ["-y", "-v", "error", "-f", "lavfi", "-i", fondo];
    for (const pedido of pedidos) args.push("-i", pedido.destino);

    // Cada voz se coloca en su instante exacto y se suman las pistas: no hay
    // concatenación, así que un error de milisegundos no arrastra al resto.
    const ubicadas = escenas.flatMap((medida) => medida.lineas);
    const pistas = ubicadas.map(
      (linea, i) =>
        `[${i + 1}:a]aresample=44100,adelay=delays=${Math.round(linea.inicio * 1000)}:all=1[v${i}]`,
    );
    const mezcla =
      pedidos.length > 0
        ? `${pistas.join(";")};${pedidos.map((_, i) => `[v${i}]`).join("")}` +
          `amix=inputs=${pedidos.length}:duration=longest:normalize=0,` +
          `apad,atrim=0:${total.toFixed(2)},alimiter=level_in=1:level_out=0.92[aud]`
        : `anullsrc=r=44100:cl=stereo,atrim=0:${total.toFixed(2)}[aud]`;

    args.push(
      "-filter_complex",
      // Sin viñeta: oscurece los bordes, y acá el texto va alineado a la
      // izquierda, así que apagaba justo lo que hay que leer.
      `[0:v]format=yuv420p,ass=guion.ass[vid];${mezcla}`,
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
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
