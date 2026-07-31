/**
 * Voz para el guion.
 *
 * Dos motores, el mismo contrato: Kokoro —modelo local, gratis e ilimitado—
 * cuando está instalado, y `say` de macOS como respaldo. El respaldo no es un
 * lujo: sin él, una máquina sin el modelo descargado no puede producir un video,
 * y la habilidad quedaría rota sin decir por qué.
 *
 * El reparto de voces es lo que hace posible el diálogo. Cada personaje se queda
 * con una voz distinta la primera vez que habla y la conserva todo el video: una
 * conversación en la que los dos interlocutores suenan igual no es un diálogo,
 * es un monólogo con guiones.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);

export type Motor = "kokoro" | "say";

export interface Narrador {
  motor: Motor;
  /** Cómo se llama la voz de cada personaje, y la del narrador bajo `""`. */
  voces: Map<string, string>;
  /** Sintetiza cada línea en su archivo y devuelve la duración de cada una. */
  sintetizar(
    lineas: Array<{ texto: string; personaje: string; destino: string }>,
  ): Promise<number[]>;
}

/**
 * Voces en orden de reparto. La primera es la del narrador.
 *
 * En Kokoro son las tres del catálogo en español; en `say`, las que trae macOS
 * de fábrica. Si hay más personajes que voces se reparten en ciclo: dos
 * personajes con la misma voz es peor que ninguno, pero mejor que fallar.
 */
const VOCES: Record<Motor, readonly string[]> = {
  kokoro: ["em_alex", "ef_dora", "em_santa"],
  say: ["Paulina", "Mónica", "Eddy (Español (México))"],
};

/** Instalaciones conocidas del modelo, en orden de preferencia. */
function buscarKokoro(explicito?: string): string | null {
  const candidatos = [
    explicito,
    process.env.ORQ_KOKORO_HOME,
    join(homedir(), ".cache", "orq-kokoro"),
    join(homedir(), ".cache", "inspia-kokoro"),
  ].filter((ruta): ruta is string => typeof ruta === "string" && ruta !== "");

  for (const home of candidatos) {
    const completo =
      existsSync(join(home, "kokoro-v1.0.onnx")) &&
      existsSync(join(home, "voices-v1.0.bin")) &&
      existsSync(join(home, "venv", "bin", "python"));
    if (completo) return home;
  }
  return null;
}

/**
 * Un solo proceso para todo el guion.
 *
 * Cargar el modelo cuesta segundos; hacerlo una vez por línea multiplicaba ese
 * costo por cada frase del video. Las líneas entran por stdin y salen medidas.
 */
const PYTHON_KOKORO = `
import json, os, sys

for lib in ("/opt/homebrew/lib/libespeak-ng.dylib", "/usr/local/lib/libespeak-ng.dylib"):
    if os.path.exists(lib):
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = lib
        break
for datos in ("/opt/homebrew/share/espeak-ng-data", "/usr/local/share/espeak-ng-data"):
    if os.path.isdir(datos):
        os.environ["ESPEAK_DATA_PATH"] = datos
        break

import soundfile as sf
from kokoro_onnx import Kokoro

cfg = json.load(sys.stdin)
kokoro = Kokoro(cfg["model"], cfg["voces"])
salida = []
for item in cfg["items"]:
    muestras, sr = kokoro.create(
        item["texto"], voice=item["voz"], speed=cfg["velocidad"], lang=cfg["lang"]
    )
    sf.write(item["destino"], muestras, sr)
    salida.append(len(muestras) / sr)
print(json.dumps(salida))
`;

function repartir(motor: Motor, personajes: readonly string[]): Map<string, string> {
  const disponibles = VOCES[motor];
  const voces = new Map<string, string>();
  voces.set("", disponibles[0]!);
  personajes.forEach((personaje, i) => {
    // El narrador ya se quedó con la primera: los personajes arrancan en la
    // segunda para que nunca suenen igual que la voz en off.
    voces.set(personaje, disponibles[(i + 1) % disponibles.length]!);
  });
  return voces;
}

/** Duración real del audio generado, en segundos. */
async function duracionDe(ffprobe: string, archivo: string): Promise<number> {
  const { stdout } = await ejecutar(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    archivo,
  ]);
  const segundos = Number.parseFloat(stdout.trim());
  return Number.isFinite(segundos) ? segundos : 0;
}

export interface OpcionesNarrador {
  personajes: readonly string[];
  velocidad?: number;
  kokoroHome?: string;
  ffprobe?: string;
  /** Fuerza un motor. Sin esto se elige el mejor disponible. */
  motor?: Motor;
}

export function crearNarrador(opciones: OpcionesNarrador): Narrador {
  const ffprobe = opciones.ffprobe ?? "ffprobe";
  const velocidad = opciones.velocidad ?? 1;
  const kokoroHome = opciones.motor === "say" ? null : buscarKokoro(opciones.kokoroHome);

  if (kokoroHome) {
    return {
      motor: "kokoro",
      voces: repartir("kokoro", opciones.personajes),
      sintetizar: async (lineas) => {
        const voces = repartir("kokoro", opciones.personajes);
        const entrada = {
          model: join(kokoroHome, "kokoro-v1.0.onnx"),
          voces: join(kokoroHome, "voices-v1.0.bin"),
          velocidad,
          lang: "es-419",
          items: lineas.map((linea) => ({
            texto: linea.texto,
            voz: voces.get(linea.personaje) ?? VOCES.kokoro[0]!,
            destino: linea.destino,
          })),
        };
        const proceso = ejecutar(join(kokoroHome, "venv", "bin", "python"), ["-c", PYTHON_KOKORO], {
          maxBuffer: 8 * 1024 * 1024,
        });
        proceso.child.stdin?.end(JSON.stringify(entrada));
        const { stdout } = await proceso;
        // La última línea es el JSON; antes puede haber avisos del runtime ONNX.
        const ultima = stdout.trim().split("\n").at(-1) ?? "[]";
        return JSON.parse(ultima) as number[];
      },
    };
  }

  return {
    motor: "say",
    voces: repartir("say", opciones.personajes),
    sintetizar: async (lineas) => {
      const voces = repartir("say", opciones.personajes);
      const duraciones: number[] = [];
      for (const linea of lineas) {
        await ejecutar("say", [
          "-v",
          voces.get(linea.personaje) ?? VOCES.say[0]!,
          "-r",
          String(Math.round(180 * velocidad)),
          "-o",
          linea.destino,
          linea.texto,
        ]);
        duraciones.push(await duracionDe(ffprobe, linea.destino));
      }
      return duraciones;
    },
  };
}

/** Qué motor se usaría, sin sintetizar nada. Para diagnóstico y tests. */
export const motorDisponible = (kokoroHome?: string): Motor =>
  buscarKokoro(kokoroHome) ? "kokoro" : "say";
