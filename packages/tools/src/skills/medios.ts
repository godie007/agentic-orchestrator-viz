/**
 * Los hechos de un archivo producido: cuánto dura, de qué tamaño, con qué códec.
 *
 * Existe por la misma razón que `check_activity`: **auditar lo que se hizo, no
 * lo que se contó**. Una realizadora informaba "76 segundos" porque eso decía el
 * mensaje de la herramienta que ella misma había llamado; cuando el motor leía
 * de más —las notas del guion terminaban en la voz en off— el video salía de 131
 * segundos y nadie de la organización podía notarlo hasta que una persona lo
 * abría. Un dato que sólo se puede repetir no es una verificación.
 *
 * Mide con `ffprobe`, que ya hace falta para filmar: no se agrega ninguna
 * dependencia. Y no opina — devuelve los números y deja el juicio al agente, que
 * es el que conoce el encargo.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);

/** Un archivo que ffprobe no entiende igual tiene tamaño, y eso ya es un dato. */
export type TipoMedio = "video" | "audio" | "imagen" | "otro";

export interface FichaMedio {
  tipo: TipoMedio;
  bytes: number;
  /** Duración en segundos. Sólo video y audio. */
  segundos?: number;
  ancho?: number;
  alto?: number;
  /** Cuadros por segundo, redondeado. */
  fps?: number;
  codecVideo?: string;
  codecAudio?: string;
  /** 1 mono, 2 estéreo. Sirve para detectar una mezcla que quedó en un canal. */
  canales?: number;
}

interface StreamFfprobe {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface SalidaFfprobe {
  streams?: StreamFfprobe[];
  format?: { duration?: string; size?: string };
}

/** `30000/1001` → 30. Un `0/0` —imagen fija— no es una velocidad. */
export function cuadrosPorSegundo(fraccion: string | undefined): number | undefined {
  if (!fraccion) return undefined;
  const [arriba, abajo] = fraccion.split("/").map(Number);
  if (!arriba || !abajo) return undefined;
  const valor = arriba / abajo;
  return Number.isFinite(valor) && valor > 0 ? Math.round(valor) : undefined;
}

/**
 * Interpreta la salida de ffprobe. Está separada del proceso para poder fijarla
 * con tests sin depender de que la máquina tenga ffprobe instalado.
 */
export function leerFicha(salida: SalidaFfprobe, bytes: number): FichaMedio {
  const streams = salida.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const segundos = Number.parseFloat(salida.format?.duration ?? "");
  const fps = cuadrosPorSegundo(video?.avg_frame_rate);

  // Una imagen fija también trae un stream de "video" para ffprobe. Lo que la
  // distingue es que no avanza: sin velocidad de cuadros y sin duración.
  const esImagen = Boolean(video) && !audio && (fps === undefined || !Number.isFinite(segundos));

  const tipo: TipoMedio = esImagen ? "imagen" : video ? "video" : audio ? "audio" : "otro";

  return {
    tipo,
    bytes,
    ...(Number.isFinite(segundos) && segundos > 0 && !esImagen ? { segundos } : {}),
    ...(video?.width ? { ancho: video.width } : {}),
    ...(video?.height ? { alto: video.height } : {}),
    ...(fps !== undefined && !esImagen ? { fps } : {}),
    ...(video?.codec_name ? { codecVideo: video.codec_name } : {}),
    ...(audio?.codec_name ? { codecAudio: audio.codec_name } : {}),
    ...(audio?.channels ? { canales: audio.channels } : {}),
  };
}

/** Los hechos del archivo. Un formato que ffprobe no lee degrada a tamaño. */
export async function inspeccionarMedio(
  ruta: string,
  ffprobe = "ffprobe",
): Promise<FichaMedio> {
  const bytes = (await stat(ruta)).size;
  try {
    const { stdout } = await ejecutar(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ruta],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return leerFicha(JSON.parse(stdout) as SalidaFfprobe, bytes);
  } catch {
    // Un .docx o un .pdf no son medios: que no se puedan medir no es un error
    // del que haya que informar, es la respuesta.
    return { tipo: "otro", bytes };
  }
}

const peso = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const reloj = (segundos: number): string => {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  return m > 0 ? `${m} min ${String(s).padStart(2, "0")} s` : `${segundos.toFixed(1)} s`;
};

/** La ficha en castellano, para que la lea un agente. */
export function describirFicha(ficha: FichaMedio): string {
  const partes: string[] = [];
  if (ficha.segundos !== undefined) {
    partes.push(`dura ${reloj(ficha.segundos)} (${ficha.segundos.toFixed(2)} segundos exactos)`);
  }
  if (ficha.ancho && ficha.alto) partes.push(`${ficha.ancho}×${ficha.alto}`);
  if (ficha.fps !== undefined) partes.push(`${ficha.fps} cuadros por segundo`);
  if (ficha.codecVideo) partes.push(`video ${ficha.codecVideo}`);
  if (ficha.codecAudio) {
    const canal = ficha.canales === 1 ? " mono" : ficha.canales === 2 ? " estéreo" : "";
    partes.push(`audio ${ficha.codecAudio}${canal}`);
  }
  // Un video **sin** pista de audio es la falla que más cuesta notar: se ve
  // perfecto y se manda mudo. Se dice explícitamente en vez de omitirlo.
  if (ficha.tipo === "video" && !ficha.codecAudio) partes.push("SIN PISTA DE AUDIO");
  partes.push(`pesa ${peso(ficha.bytes)}`);
  return partes.join(", ");
}
