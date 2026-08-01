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
 *
 * Lo que **se dice** y lo que **se escribe** son dos textos distintos. Un motor
 * de voz lee una marca comercial con las reglas del castellano y la pronuncia
 * mal —"Codytion" sale "codi-ti-ón"—, y corregirlo escribiendo mal el nombre en
 * el guion lo rompería en pantalla, que es donde tiene que estar bien escrito.
 * Por eso el léxico se aplica **sólo al texto que va al sintetizador**.
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

function repartir(
  motor: Motor,
  personajes: readonly string[],
  unaSolaVoz = false,
): Map<string, string> {
  const disponibles = VOCES[motor];
  const voces = new Map<string, string>();
  voces.set("", disponibles[0]!);
  personajes.forEach((personaje, i) => {
    // El narrador ya se quedó con la primera: los personajes arrancan en la
    // segunda para que nunca suenen igual que la voz en off. Salvo que se pida
    // una sola voz, que es lo que corresponde cuando el video no es una
    // conversación sino una empresa hablando: ahí varias voces suenan a
    // reparto de actores, no a marca.
    voces.set(personaje, unaSolaVoz ? disponibles[0]! : disponibles[(i + 1) % disponibles.length]!);
  });
  return voces;
}

/**
 * Cómo se pronuncia lo que no se lee como se escribe.
 *
 * Se aplica sobre el texto que va al sintetizador, nunca sobre el que se ve.
 * Las claves se comparan sin distinguir mayúsculas y sólo como palabra entera:
 * sin eso, una regla para "IA" reescribe "familia" por dentro.
 */
export type Lexico = Record<string, string>;

const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pronunciar(texto: string, lexico: Lexico | undefined): string {
  if (!lexico) return texto;
  let salida = texto;
  for (const [escrito, dicho] of Object.entries(lexico)) {
    if (!escrito.trim()) continue;
    // `\b` no sirve con acentos ni con siglas pegadas a un signo: se delimita a
    // mano con lo que no es letra ni dígito.
    const patron = new RegExp(
      `(^|[^\\p{L}\\p{N}])(${escaparRegex(escrito)})(?=[^\\p{L}\\p{N}]|$)`,
      "giu",
    );
    salida = salida.replace(patron, (_, antes: string) => `${antes}${dicho}`);
  }
  return salida;
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
  /** Todos los personajes con la misma voz: la empresa habla, no un elenco. */
  unaSolaVoz?: boolean;
  /** Cómo se pronuncia lo que no se lee como se escribe. */
  lexico?: Lexico;
}

export function crearNarrador(opciones: OpcionesNarrador): Narrador {
  const ffprobe = opciones.ffprobe ?? "ffprobe";
  const velocidad = opciones.velocidad ?? 1;
  const kokoroHome = opciones.motor === "say" ? null : buscarKokoro(opciones.kokoroHome);
  const solaVoz = opciones.unaSolaVoz ?? false;
  const decir = (texto: string): string => pronunciar(texto, opciones.lexico);

  if (kokoroHome) {
    return {
      motor: "kokoro",
      voces: repartir("kokoro", opciones.personajes, solaVoz),
      sintetizar: async (lineas) => {
        const voces = repartir("kokoro", opciones.personajes, solaVoz);
        const entrada = {
          model: join(kokoroHome, "kokoro-v1.0.onnx"),
          voces: join(kokoroHome, "voices-v1.0.bin"),
          velocidad,
          lang: "es-419",
          items: lineas.map((linea) => ({
            texto: decir(linea.texto),
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
    voces: repartir("say", opciones.personajes, solaVoz),
    sintetizar: async (lineas) => {
      const voces = repartir("say", opciones.personajes, solaVoz);
      const duraciones: number[] = [];
      for (const linea of lineas) {
        await ejecutar("say", [
          "-v",
          voces.get(linea.personaje) ?? VOCES.say[0]!,
          "-r",
          String(Math.round(180 * velocidad)),
          "-o",
          linea.destino,
          decir(linea.texto),
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
