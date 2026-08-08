/**
 * Guion + láminas HTML → MP4.
 *
 * Es el segundo motor de video del sistema, no un reemplazo del primero.
 * `video.ts` dibuja todo con ffmpeg y no necesita nada instalado: sigue siendo
 * lo correcto para un guion que es texto y viñetas. Este motor existe para lo
 * que ahí no entra —un diagrama que se dibuja solo, una tarjeta de vidrio, una
 * cifra que crece, una retícula de tres columnas— y sobre todo porque **HTML es
 * el lenguaje que un agente sabe programar**: una lámina se le puede pedir a un
 * rol con capacidad de escribir código, y el resultado se revisa, se corrige y
 * se vuelve a filmar.
 *
 * Las dos salidas comparten lo que no puede divergir: el reloj (`ubicarEscenas`),
 * la voz (`narracion.ts`), la mezcla y la cama musical (`sonido.ts`) y el
 * catálogo de íconos. Lo único distinto es cómo se dibuja el cuadro.
 *
 * ## Qué se filma y qué se sostiene
 *
 * De cada lámina se captura **sólo su entrada** —lo que se mueve— y el render
 * sostiene el último cuadro por el resto de la escena. Un video de 90 segundos
 * son 2700 cuadros; sus ocho entradas, unos 500. Lo que evita que la pantalla
 * se vea muerta durante lo sostenido es que el fondo lo sigue generando ffmpeg
 * y se mueve todo el tiempo por detrás de las láminas, que son transparentes.
 *
 * El pasaje de una escena a la otra es un encadenado y no un corte: las
 * ventanas se pisan, la que entra se funde encima de la que sale.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseGuion, ubicarEscenas, type EscenaUbicada, type Guion } from "./guion.js";
import { elegirMusica } from "./musica.js";
import { crearNarrador, type Motor } from "./narracion.js";
import { construirSonido } from "./sonido.js";
import { abrirRevelado, LIENZO, type Revelado } from "./chrome.js";
import {
  CARPETA_ESCENAS,
  GUIA_ESTUDIO,
  laminaDeEscena,
  PALETA,
  RUTA_GUIA,
  RUTA_TEMA,
  TEMA_CSS,
} from "./tema.js";
import type { DocumentMeta } from "./render.js";

const ejecutar = promisify(execFile);

/** Cuánto dura el encadenado entre escenas, en segundos. */
const ENCADENADO = 0.45;

/** El fondo que se mueve por detrás de las láminas, en formato de ffmpeg. */
const hex = (color: string): string => `0x${color.slice(1)}`;

export interface OpcionesEstudio {
  ffmpeg?: string;
  ffprobe?: string;
  kokoroHome?: string;
  motor?: Motor;
  velocidad?: number;
  unaSolaVoz?: boolean;
  /** Lo escrito → cómo se dice. Se aplica sólo al audio, nunca a la pantalla. */
  lexico?: Record<string, string>;
  musicaHome?: string;
  musica?: string;
  /** Ruta del binario de Chrome, si no está donde se lo espera. */
  chrome?: string;
  /** Nombre de la empresa: firma la lámina de respaldo. */
  empresa: string;
  /**
   * Las láminas que ya existen en el directorio de salida, con su ruta relativa.
   *
   * Se pasan resueltas en vez de dejar que esta habilidad lea el disco: quién
   * puede mirar qué carpeta lo decide el servidor, igual que con las imágenes.
   */
  laminas: readonly string[];
  /** Ruta relativa del directorio de salida → ruta absoluta, o `null`. */
  resolver: (ruta: string) => Promise<string | null>;
  /** Escribe un archivo de texto en el directorio de salida. Se usa para el kit. */
  escribir: (ruta: string, contenido: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface ResultadoEstudio {
  bytes: Buffer;
  segundos: number;
  escenas: number;
  /** Cuántas escenas usaron una lámina programada, y no la de respaldo. */
  programadas: number;
  personajes: string[];
  motor: Motor;
  musica: string | null;
  avisos: string[];
}

/**
 * Qué lámina le toca a cada escena.
 *
 * La atadura es el **número al principio del nombre**: `03-lo-que-medimos.html`
 * es la tercera escena. Es una convención y no un campo del guion a propósito —
 * el guion ya dice el orden, y pedirle además que nombre archivos es pedirle que
 * mantenga dos listas sincronizadas—. La escena que no tiene lámina propia se
 * maqueta con la plantilla del sistema, así que un guion sin una sola línea de
 * HTML igual sale filmado.
 */
export function atarLaminas(
  laminas: readonly string[],
  escenas: number,
): Array<string | null> {
  const porNumero = new Map<number, string>();
  for (const ruta of laminas) {
    const nombre = ruta.split("/").pop() ?? "";
    if (!/\.html?$/i.test(nombre)) continue;
    const marca = /^(\d{1,3})\b/.exec(nombre);
    if (!marca) continue;
    const numero = Number(marca[1]);
    if (numero < 1 || numero > escenas) continue;
    // Ante dos láminas con el mismo número gana la primera en orden alfabético,
    // que es el orden en que las lista el directorio: reproducible.
    if (!porNumero.has(numero)) porNumero.set(numero, ruta);
  }
  return Array.from({ length: escenas }, (_, i) => porNumero.get(i + 1) ?? null);
}

/**
 * El plan de una escena en el tiempo del video.
 *
 * `sostener` es cuánto se queda quieta después de la entrada; se calcula acá y
 * no en el filtro porque es la única cuenta con la que se puede equivocar todo
 * el render, y así se puede fijar con un test sin abrir un navegador.
 */
export interface Plano {
  inicio: number;
  /** Hasta cuándo se ve. Se pisa con la escena siguiente para el encadenado. */
  fin: number;
  animacion: number;
  sostener: number;
}

export function planificar(escenas: readonly EscenaUbicada[], total: number, animaciones: readonly number[]): Plano[] {
  return escenas.map((escena, i) => {
    const siguiente = escenas[i + 1];
    // La última se estira hasta el final del video: si terminara con su escena,
    // la cola de silencio quedaría con el fondo pelado.
    const fin = siguiente ? siguiente.inicio + ENCADENADO : total;
    const animacion = animaciones[i] ?? 0;
    return {
      inicio: escena.inicio,
      fin,
      animacion,
      // Un pelo de más: el último cuadro clonado tiene que llegar al encadenado
      // siguiente, no terminar justo antes y dejar un parpadeo del fondo.
      sostener: Math.max(0, fin - escena.inicio - animacion + 0.5),
    };
  });
}

export async function renderEstudio(
  markdown: string,
  meta: DocumentMeta,
  opciones: OpcionesEstudio,
): Promise<ResultadoEstudio> {
  const guion = parseGuion(markdown);
  if (guion.escenas.length === 0) {
    throw new Error(
      "El guion no tiene ninguna escena. Un guion es un título con `#`, y después " +
        "una escena por cada `##` con lo que se dice debajo.",
    );
  }

  const ffmpeg = opciones.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "orq-estudio-"));
  let revelado: Revelado | null = null;

  try {
    // El kit se reescribe en cada render: así una lámina siempre se maqueta con
    // la hoja de esta versión del sistema, y la guía que lee el agente no puede
    // quedar describiendo clases que ya no existen.
    await opciones.escribir(RUTA_TEMA, TEMA_CSS);
    await opciones.escribir(RUTA_GUIA, GUIA_ESTUDIO);

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

    const { escenas, total } = ubicarEscenas(guion, duraciones);
    const avisos: string[] = [];

    // --- Revelado de las láminas -----------------------------------------

    const atadas = atarLaminas(opciones.laminas, guion.escenas.length);
    const logo = await opciones.resolver("marca/logo.png");
    revelado = await abrirRevelado({
      ...(opciones.chrome !== undefined ? { chrome: opciones.chrome } : {}),
      ...(opciones.signal ? { signal: opciones.signal } : {}),
    });

    const capturas: string[][] = [];
    const animaciones: number[] = [];
    let programadas = 0;

    for (const [i, ubicada] of escenas.entries()) {
      const propia = atadas[i];
      let url: string;
      if (propia) {
        const absoluta = await opciones.resolver(propia);
        if (absoluta) {
          url = pathToFileURL(absoluta).href;
          programadas++;
        } else {
          avisos.push(`No se encontró la lámina ${propia}: esa escena salió con la plantilla.`);
          url = await respaldo(dir, ubicada, i, escenas.length, opciones.empresa, logo);
        }
      } else {
        url = await respaldo(dir, ubicada, i, escenas.length, opciones.empresa, logo);
      }

      const captura = await revelado.revelar(url, dir, `esc${String(i).padStart(2, "0")}`);
      capturas.push(captura.cuadros);
      animaciones.push(captura.animacion);
      avisos.push(...captura.avisos);
    }

    await revelado.cerrar();
    revelado = null;

    const planos = planificar(escenas, total, animaciones);

    // --- Armado -----------------------------------------------------------

    const eleccion = await elegirMusica(opciones.musicaHome, opciones.musica ?? "auto");
    if (eleccion.aviso && opciones.musica !== undefined) avisos.push(eleccion.aviso);

    const fondo =
      `gradients=s=${LIENZO.ancho}x${LIENZO.alto}:c0=${hex(PALETA.fondo)}:c1=0x1a1f45` +
      `:c2=${hex(PALETA.fondo)}:n=3:x0=1650:y0=60:x1=260:y1=1020:speed=0.0016:` +
      `r=${LIENZO.fps}:d=${total.toFixed(2)}`;

    const args = ["-y", "-v", "error", "-f", "lavfi", "-i", fondo];
    for (const pedido of pedidos) args.push("-i", pedido.destino);

    let indice = pedidos.length;
    let indiceMusica = -1;
    if (eleccion.pista) {
      args.push("-stream_loop", "-1", "-i", eleccion.pista.ruta);
      indiceMusica = ++indice;
    }

    const indicesLamina = capturas.map((cuadros, i) => {
      // Una secuencia de PNG, no un archivo por cuadro: ffmpeg la lee entera con
      // un patrón y no hay que encadenar nada.
      args.push(
        "-framerate",
        String(LIENZO.fps),
        "-start_number",
        "0",
        "-i",
        join(dir, `esc${String(i).padStart(2, "0")}-%04d.png`),
      );
      void cuadros;
      return ++indice;
    });

    const capas = [`[0:v]setsar=1[bg]`];
    let fondoActual = "bg";
    planos.forEach((plano, i) => {
      capas.push(
        `[${indicesLamina[i]!}:v]format=rgba,` +
          // Sostener es clonar el último cuadro: la entrada ya terminó y lo que
          // sigue moviéndose es el fondo, por detrás.
          `tpad=stop_mode=clone:stop_duration=${plano.sostener.toFixed(2)},` +
          `fade=t=in:st=0:d=${ENCADENADO}:alpha=1,` +
          `setpts=PTS+${plano.inicio.toFixed(3)}/TB[s${i}]`,
      );
      capas.push(
        `[${fondoActual}][s${i}]overlay=x=0:y=0:format=auto:` +
          `enable='between(t,${plano.inicio.toFixed(2)},${plano.fin.toFixed(2)})'[bg${i}]`,
      );
      fondoActual = `bg${i}`;
    });
    capas.push(`[${fondoActual}]format=yuv420p[vid]`);

    const mezcla = construirSonido({
      inicios: escenas.flatMap((ubicada) => ubicada.lineas).map((linea) => linea.inicio),
      total,
      indiceMusica,
    });

    args.push(
      "-filter_complex",
      `${capas.join(";")};${mezcla}`,
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
      programadas,
      personajes: guion.personajes,
      motor: narrador.motor,
      musica: eleccion.pista?.nombre ?? null,
      avisos,
    };
  } finally {
    await revelado?.cerrar().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * La lámina de respaldo, escrita al directorio temporal.
 *
 * Lleva la hoja de estilo **adentro** en vez de enlazarla: vive fuera del
 * directorio de la empresa, así que un `../estudio/tema.css` no resolvería. La
 * que programa el agente sí la enlaza, que es lo que le permite cambiarla de
 * una vez para todas sus láminas.
 */
async function respaldo(
  dir: string,
  ubicada: EscenaUbicada,
  indice: number,
  total: number,
  empresa: string,
  logo: string | null,
): Promise<string> {
  const html = laminaDeEscena(ubicada.escena, {
    empresa,
    indice,
    total,
    ...(logo ? { logo: pathToFileURL(logo).href } : {}),
  }).replace(
    `<link rel="stylesheet" href="../${RUTA_TEMA}">`,
    `<style>${TEMA_CSS}</style>`,
  );
  const archivo = join(dir, `respaldo-${String(indice).padStart(2, "0")}.html`);
  await writeFile(archivo, html, "utf8");
  return pathToFileURL(archivo).href;
}

/** El guion ya parseado, para que quien llame pueda contar escenas sin filmar. */
export const escenasDe = (markdown: string): Guion => parseGuion(markdown);

/** La carpeta donde el agente deja sus láminas. Se reexporta para el registro. */
export { CARPETA_ESCENAS };
