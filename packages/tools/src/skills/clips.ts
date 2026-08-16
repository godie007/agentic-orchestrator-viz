/**
 * Guion + clips grabados → MP4 empalmado.
 *
 * Es el tercer motor de video, y como el segundo, no reemplaza a nadie:
 * `video.ts` maqueta texto, `estudio.ts` filma láminas HTML, y éste **empalma
 * grabaciones reales de una aplicación** a pantalla completa. Existe porque un
 * tutorial de software se mira mejor viendo el software: una captura quieta a
 * un costado cuenta menos que el clic ocurriendo.
 *
 * Comparte con los otros dos lo que no puede divergir: el reloj
 * (`ubicarEscenas`), la voz (`narracion.ts`) y la mezcla con la cama musical
 * (`sonido.ts`). La sincronía voz↔pantalla queda garantizada **por
 * construcción**: la duración de cada escena la manda su narración, y el clip
 * se recorta a esa duración si sobra o sostiene su último cuadro si falta.
 * No hay nada que alinear a mano, así que no se puede desalinear.
 *
 * Los clips van a pantalla completa (1920×1080, con barras del color de la
 * marca si la proporción no da) y el pasaje entre escenas es un corte: en un
 * tutorial el corte es el lenguaje, el encadenado es de las láminas.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseGuion, ubicarEscenas, type EscenaUbicada } from "./guion.js";
import { elegirMusica } from "./musica.js";
import { crearNarrador, type Motor } from "./narracion.js";
import { construirSonido } from "./sonido.js";
import { LIENZO, type CuadroDeClip } from "./chrome.js";
import { PALETA } from "./tema.js";

const ejecutar = promisify(execFile);

/** La carpeta del directorio de salida donde viven los clips grabados. */
export const CARPETA_CLIPS = "clips";

const hex = (color: string): string => `0x${color.slice(1)}`;

/**
 * Qué clip le toca a cada escena: el **número al principio del nombre**, la
 * misma convención que las láminas del estudio (`03-mediciones.mp4` es la
 * tercera escena). El guion ya dice el orden; el archivo sólo dice cuál es.
 */
export function atarClips(rutas: readonly string[], escenas: number): Array<string | null> {
  const porNumero = new Map<number, string>();
  for (const ruta of rutas) {
    const nombre = ruta.split("/").pop() ?? "";
    if (!/\.(mp4|webm|mov)$/i.test(nombre)) continue;
    const marca = /^(?:escena-)?(\d{1,3})\b/.exec(nombre);
    if (!marca) continue;
    const numero = Number(marca[1]);
    if (numero < 1 || numero > escenas) continue;
    if (!porNumero.has(numero)) porNumero.set(numero, ruta);
  }
  return Array.from({ length: escenas }, (_, i) => porNumero.get(i + 1) ?? null);
}

/**
 * El clip de portada, si existe: `00-….mp4` en la carpeta de clips.
 *
 * La portada es la escena del `#` y su visual es este clip: la duración la da
 * el reloj compartido (3,8 s de aire si no narra), no un offset aparte. Sin
 * esto la portada que la empresa produjo quedaba huérfana: existía en el disco
 * y el video arrancaba sin ella.
 */
export function clipDePortada(rutas: readonly string[]): string | null {
  for (const ruta of [...rutas].sort()) {
    const nombre = ruta.split("/").pop() ?? "";
    if (/^(?:escena-)?0{1,2}\b.*\.(mp4|webm|mov)$/i.test(nombre)) return ruta;
  }
  return null;
}

/** El corte de cada escena: desde cuándo y cuánto dura. Puro, para fijarlo con tests. */
export interface Corte {
  inicio: number;
  duracion: number;
}

export function planificarCortes(escenas: readonly EscenaUbicada[], total: number): Corte[] {
  return escenas.map((escena, i) => {
    const fin = escenas[i + 1]?.inicio ?? total;
    return { inicio: escena.inicio, duracion: Math.max(0.5, fin - escena.inicio) };
  });
}

/**
 * El filtro de video de una escena: pantalla completa exacta y duración exacta.
 *
 * `scale` a la caja conservando proporción, `pad` con el fondo de la marca,
 * `tpad` clona el último cuadro si el clip es más corto que su narración, y
 * `trim` corta si es más largo. El orden importa: primero estirar, después
 * cortar, así la salida dura **exactamente** lo que el reloj dice.
 */
export function filtroDeEscena(entrada: number, corte: Corte, etiqueta: string): string {
  const d = corte.duracion.toFixed(3);
  return (
    `[${entrada}:v]fps=${LIENZO.fps},` +
    `scale=${LIENZO.ancho}:${LIENZO.alto}:force_original_aspect_ratio=decrease,` +
    `pad=${LIENZO.ancho}:${LIENZO.alto}:(ow-iw)/2:(oh-ih)/2:color=${hex(PALETA.fondo)},` +
    `setsar=1,tpad=stop_mode=clone:stop_duration=600,trim=duration=${d},` +
    `setpts=PTS-STARTPTS[${etiqueta}]`
  );
}

/**
 * Arma un clip MP4 desde los cuadros capturados por `abrirGrabacion`.
 *
 * Los cuadros llegan con su duración real —el screencast entrega repintados,
 * no una cadencia fija— y el demuxer `concat` respeta esos tiempos: el clip
 * dura lo que duró la grabación, sin acelerones.
 */
export async function armarClip(
  cuadros: readonly CuadroDeClip[],
  opciones: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<Buffer> {
  if (cuadros.length === 0) throw new Error("No hay cuadros para armar el clip.");
  const dir = await mkdtemp(join(tmpdir(), "orq-clip-"));
  try {
    const lista = cuadros
      .map((cuadro) => `file '${cuadro.ruta}'\nduration ${cuadro.duracion.toFixed(4)}`)
      .join("\n");
    // El demuxer ignora la duración del último archivo: se repite para cerrarla.
    const listado = `${lista}\nfile '${cuadros.at(-1)!.ruta}'\n`;
    await writeFile(join(dir, "cuadros.txt"), listado, "utf8");
    await ejecutar(
      opciones.ffmpeg ?? "ffmpeg",
      [
        "-y", "-v", "error",
        "-f", "concat", "-safe", "0", "-i", "cuadros.txt",
        "-vf", `fps=${LIENZO.fps},scale=${LIENZO.ancho}:${LIENZO.alto}:force_original_aspect_ratio=decrease,pad=${LIENZO.ancho}:${LIENZO.alto}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "clip.mp4",
      ],
      { cwd: dir, maxBuffer: 8 * 1024 * 1024, ...(opciones.signal ? { signal: opciones.signal } : {}) },
    );
    return await readFile(join(dir, "clip.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface OpcionesClips {
  ffmpeg?: string;
  ffprobe?: string;
  kokoroHome?: string;
  motor?: Motor;
  velocidad?: number;
  unaSolaVoz?: boolean;
  lexico?: Record<string, string>;
  musicaHome?: string;
  musica?: string;
  /** Los clips que ya existen en el directorio de salida, con su ruta relativa. */
  clips: readonly string[];
  /** Ruta relativa del directorio de salida → ruta absoluta, o `null`. */
  resolver: (ruta: string) => Promise<string | null>;
  signal?: AbortSignal;
}

export interface ResultadoClips {
  bytes: Buffer;
  segundos: number;
  escenas: number;
  /** Cuántas escenas tenían clip grabado; el resto salió con placa lisa. */
  conClip: number;
  /** Si el video abre con el clip de portada (`00-…`). */
  portada: boolean;
  motor: Motor;
  musica: string | null;
  avisos: string[];
}

export async function renderClips(
  markdown: string,
  opciones: OpcionesClips,
): Promise<ResultadoClips> {
  const guion = parseGuion(markdown);
  if (guion.escenas.length === 0) {
    throw new Error(
      "El guion no tiene ninguna escena. Un guion es un título con `#`, y después " +
        "una escena por cada `##` con lo que se dice debajo.",
    );
  }

  const ffmpeg = opciones.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "orq-clips-"));

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

    const { escenas, total } = ubicarEscenas(guion, duraciones);
    const cortes = planificarCortes(escenas, total);
    const avisos: string[] = [];

    // En este motor la portada no narra: su visual es el clip 00 y su duración
    // la da el reloj compartido (3,8 s de aire si no tiene voz). Texto suelto
    // entre el `#` y la primera `##` —"Personajes:", "Tono:", notas de
    // producción— se convierte en narración de portada, y lo pagamos con un
    // video que arrancaba leyendo los metadatos en voz alta.
    const portadaHabla = guion.escenas[0]?.esPortada && guion.escenas[0].lineas.length > 0;
    if (portadaHabla) {
      avisos.push(
        `ATENCIÓN: la portada tiene texto narrado ` +
          `("${guion.escenas[0]!.lineas[0]!.texto.slice(0, 60)}…"). Si son notas de producción ` +
          `(personajes, tono), borralas con edit_artifact y re-exportá: la voz las está ` +
          `leyendo al abrir el video. El tono ya vive en la configuración de voz de la empresa.`,
      );
    }

    const rutaPortada = clipDePortada(opciones.clips);
    const absPortada = rutaPortada ? await opciones.resolver(rutaPortada) : null;
    if (rutaPortada && !absPortada) {
      avisos.push(`La portada ${rutaPortada} no se pudo abrir: esa escena salió como placa lisa.`);
    }

    // --- Resolver los clips ------------------------------------------------
    //
    // Los clips se numeran por el ordinal de las escenas `##`: "01-….mp4" es la
    // primera `##`, sin contar la portada. La portada (el `#`) toma el clip 00.
    // Numerarlas juntas fue el error que corrió un video entero una escena.

    const sinPortada = escenas.filter((ubicada) => !ubicada.escena.esPortada).length;
    const atados = atarClips(opciones.clips, sinPortada);
    const absolutos: Array<string | null> = [];
    let ordinal = 0;
    for (const ubicada of escenas) {
      if (ubicada.escena.esPortada) {
        absolutos.push(absPortada);
        if (!rutaPortada) {
          avisos.push(
            `La portada no tiene clip en ${CARPETA_CLIPS}/ (se esperaba "${CARPETA_CLIPS}/00-….mp4"): ` +
              `salió como placa lisa. Grabala con grabar_clip sobre el HTML de la empresa (salida://…).`,
          );
        }
        continue;
      }
      const numero = ++ordinal;
      const ruta = atados[numero - 1] ?? null;
      if (!ruta) {
        absolutos.push(null);
        avisos.push(
          `La escena ${numero} no tiene clip en ${CARPETA_CLIPS}/ (se esperaba ` +
            `"${CARPETA_CLIPS}/${String(numero).padStart(2, "0")}-….mp4"): salió con una placa lisa. ` +
            `Grabala con grabar_clip y re-exportá.`,
        );
        continue;
      }
      const absoluta = await opciones.resolver(ruta);
      if (!absoluta) {
        absolutos.push(null);
        avisos.push(`El clip ${ruta} no se pudo abrir: la escena ${numero} salió con una placa lisa.`);
        continue;
      }
      absolutos.push(absoluta);
    }

    const conClip = absolutos.filter((ruta) => ruta != null).length - (absPortada ? 1 : 0);

    // --- Armado ------------------------------------------------------------

    // Entradas: primero las voces (0..n-1), después la música, después una
    // entrada por escena — el clip real o una placa lisa del color de la marca.
    const args = ["-y", "-v", "error"];
    for (const pedido of pedidos) args.push("-i", pedido.destino);

    let indice = pedidos.length - 1;
    const eleccion = await elegirMusica(opciones.musicaHome, opciones.musica ?? "auto");
    if (eleccion.aviso && opciones.musica !== undefined) avisos.push(eleccion.aviso);
    let indiceMusica = -1;
    if (eleccion.pista) {
      args.push("-stream_loop", "-1", "-i", eleccion.pista.ruta);
      indiceMusica = ++indice;
    }

    const filtros: string[] = [];
    const etiquetas: string[] = [];
    cortes.forEach((corte, i) => {
      const absoluta = absolutos[i];
      if (absoluta) {
        args.push("-i", absoluta);
      } else {
        args.push(
          "-f", "lavfi",
          "-i", `color=c=${hex(PALETA.fondo)}:s=${LIENZO.ancho}x${LIENZO.alto}:d=${corte.duracion.toFixed(2)}:r=${LIENZO.fps}`,
        );
      }
      const entrada = ++indice;
      filtros.push(filtroDeEscena(entrada, corte, `e${i}`));
      etiquetas.push(`[e${i}]`);
    });

    filtros.push(`${etiquetas.join("")}concat=n=${etiquetas.length}:v=1:a=0,format=yuv420p[vid]`);

    const mezcla = construirSonido({
      inicios: escenas.flatMap((ubicada) => ubicada.lineas).map((linea) => linea.inicio),
      total,
      indiceMusica,
      primeraVoz: 0,
    });

    args.push(
      "-filter_complex", `${filtros.join(";")};${mezcla}`,
      "-map", "[vid]", "-map", "[aud]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
      "-r", String(LIENZO.fps),
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", total.toFixed(2),
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
      // Las numeradas: la portada se informa aparte, con su propio campo.
      escenas: sinPortada,
      conClip,
      portada: absPortada != null,
      motor: narrador.motor,
      musica: eleccion.pista?.nombre ?? null,
      avisos,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
