/**
 * Genera las camas musicales de la casa.
 *
 * La biblioteca (`MUSICA_DIR`) está pensada para pistas que dejás vos, porque la
 * música tiene licencia y el orquestador no puede saber cuál. Pero una
 * instalación recién hecha no tiene ninguna, y un video institucional en
 * silencio se nota. Esto resuelve ese arranque: camas **sintetizadas por
 * ffmpeg**, sin samples ni descargas, así que son contenido propio y no hay nada
 * que licenciar.
 *
 * No pretenden ser pistas producidas. Son lo que tiene que ser una cama: acordes
 * lentos, graves, sin melodía —nada que compita con la voz—.
 *
 * **El clima no es decoración.** Un video institucional y una campaña de venta
 * no piden lo mismo: el modo menor suena a reflexión y sirve para "así
 * trabajamos"; para que alguien sienta ganas de poner plata hace falta modo
 * mayor, registro más brillante y un pulso audible, que es lo que da sensación
 * de que algo avanza. La misma pieza con una cama equivocada vende la mitad.
 *
 * El bucle es **exacto** en las dos: cada acorde entra y sale desde el silencio,
 * y el ciclo dura un número entero de acordes. Así `-stream_loop -1` lo repite
 * sin un clic en la costura, que es lo primero que se escucha en una cama mal
 * armada.
 *
 *   npm run musica:cama
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { fromRoot } from "../apps/server/src/env.js";

const ejecutar = promisify(execFile);

interface Acorde {
  nombre: string;
  /** Las notas, de la más grave a la más aguda, en hercios. */
  notas: number[];
}

interface Cama {
  /** El nombre del archivo es lo que el guion pide: `musica: "inspirador"`. */
  archivo: string;
  descripcion: string;
  /** Segundos por acorde. Más corto = más movimiento. */
  compas: number;
  progresion: Acorde[];
  /**
   * Pulso de la nota grave, en hercios. `0` la deja quieta.
   *
   * Es lo único que separa una cama contemplativa de una que empuja. Sin
   * percusión —que sonaría a plantilla barata— el pulso lo hace el trémolo.
   */
  pulso: number;
  /** Corte del pasa-bajos. Más alto = más brillo, y más presencia. */
  brillo: number;
}

const CAMAS: Cama[] = [
  {
    archivo: "corporativo-calmo",
    descripcion: "La menor. Sobria, para institucional y explicativo.",
    compas: 8,
    // Registro grave —segunda y tercera octava— porque ahí no pisa la voz, que
    // vive más arriba. Un acorde brillante obliga a bajarle tanto el volumen
    // que deja de escucharse.
    progresion: [
      { nombre: "Am", notas: [110.0, 130.81, 164.81] },
      { nombre: "F", notas: [87.31, 130.81, 174.61] },
      { nombre: "C", notas: [130.81, 164.81, 196.0] },
      { nombre: "G", notas: [98.0, 123.47, 146.83] },
    ],
    pulso: 0,
    brillo: 1100,
  },
  {
    archivo: "inspirador-crecimiento",
    descripcion: "Do mayor con pulso. Para campañas: algo que avanza y crece.",
    // Acordes más cortos: la armonía cambia más seguido y eso solo ya se
    // escucha como movimiento.
    compas: 6,
    // Do–Sol–La menor–Fa, la progresión que sostiene la mitad de la publicidad
    // que existe, con una voz una octava arriba para que tenga aire.
    progresion: [
      { nombre: "C", notas: [130.81, 196.0, 261.63] },
      { nombre: "G", notas: [98.0, 196.0, 293.66] },
      { nombre: "Am", notas: [110.0, 164.81, 261.63] },
      { nombre: "F", notas: [87.31, 174.61, 261.63] },
    ],
    pulso: 1.7,
    brillo: 1700,
  },
];

async function generar(cama: Cama, destino: string): Promise<string> {
  const entradas: string[] = [];
  const filtros: string[] = [];
  const etiquetas: string[] = [];
  let indice = 0;

  cama.progresion.forEach((acorde, compas) => {
    acorde.notas.forEach((frecuencia, voz) => {
      entradas.push("-f", "lavfi", "-i", `sine=frequency=${frecuencia}:duration=${cama.compas}`);
      const etiqueta = `n${indice}`;
      // La grave lleva el pulso; las de arriba quedan sostenidas. Al revés
      // —pulsando el acorde entero— suena a alarma de reloj, no a música.
      const esGrave = voz === 0;
      const pulsa = cama.pulso > 0 && esGrave;
      const tremolo = pulsa
        ? `tremolo=f=${cama.pulso}:d=0.95`
        : `tremolo=f=${(0.16 + voz * 0.05).toFixed(2)}:d=0.28`;
      // La nota que pulsa va más fuerte que las sostenidas: si queda al mismo
      // nivel, el pulso se pierde bajo el acorde y la cama vuelve a ser quieta.
      // Medido: con la grave pareja, la modulación cae de 8 dB a 4.
      const nivel = pulsa ? 0.5 : 0.34 - voz * 0.06;
      filtros.push(
        // La envolvente larga es la que convierte un tono de test en un pad: el
        // ataque de un oscilador puro suena a alarma.
        `[${indice}:a]volume=${nivel.toFixed(2)},${tremolo},` +
          `afade=t=in:st=0:d=${(cama.compas * 0.32).toFixed(2)}:curve=qsin,` +
          `afade=t=out:st=${(cama.compas * 0.65).toFixed(2)}:d=${(cama.compas * 0.35).toFixed(2)}:curve=qsin,` +
          `adelay=delays=${compas * cama.compas * 1000}:all=1[${etiqueta}]`,
      );
      etiquetas.push(`[${etiqueta}]`);
      indice++;
    });
  });

  const total = cama.progresion.length * cama.compas;
  const cadena =
    `${filtros.join(";")};${etiquetas.join("")}` +
    `amix=inputs=${etiquetas.length}:duration=longest:normalize=0,` +
    // El pasa-bajos le saca el filo metálico al oscilador; el eco corto hace de
    // sala. Sin los dos, esto suena a sintetizador de juguete.
    `lowpass=f=${cama.brillo},aecho=0.7:0.62:340|520:0.28|0.2,` +
    `apad,atrim=0:${total},` +
    `loudnorm=I=-24:TP=-3:LRA=9,` +
    `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[cama]`;

  const archivo = `${destino}/${cama.archivo}.mp3`;
  await ejecutar(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      ...entradas,
      "-filter_complex",
      cadena,
      "-map",
      "[cama]",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "3",
      "-t",
      String(total),
      archivo,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  console.log(
    `✓ ${cama.archivo}.mp3 — ${total}s, ${cama.progresion.map((a) => a.nombre).join(" – ")}` +
      `${cama.pulso ? `, con pulso` : ""}\n  ${cama.descripcion}`,
  );
  return archivo;
}

async function main(): Promise<void> {
  const destino = fromRoot(process.env.MUSICA_DIR?.trim() || "./data/musica");
  await mkdir(destino, { recursive: true });

  for (const cama of CAMAS) await generar(cama, destino);

  console.log(
    `\nEn ${destino}. El guion elige por nombre: musica: "corporativo" o "inspirador".`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
