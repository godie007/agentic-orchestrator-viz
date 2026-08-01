/**
 * Música de fondo para el video.
 *
 * Las pistas **no** viven en el repo ni se descargan: son archivos que vos
 * dejás en una carpeta (`MUSICA_DIR`, por defecto `data/musica/`). Es la única
 * forma honesta de resolverlo — la música tiene licencia, y un orquestador que
 * baja un mp3 de internet y lo pega en el video de una empresa la mete en un
 * problema que no sabe que tiene.
 *
 * El clima se lee del **nombre del archivo**: `corporativo-suave.mp3` responde a
 * `corporativo` y a `suave`. Sin metadatos, sin índice que mantener, y agregar
 * una pista es copiarla a la carpeta.
 *
 * Nada de esto puede hacer fallar un video: si la carpeta no existe, si está
 * vacía o si el clima pedido no aparece, se filma en silencio y se avisa. Un
 * entregable sin música es un entregable; un error a mitad del render, no.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Cuántos niveles de carpeta se recorren.
 *
 * La biblioteca **no** es una bolsa plana: quien compra música la descarga en el
 * paquete del proveedor y la deja tal cual —`Corporate/Corporate Harmonics.mp3`—.
 * Con un `readdir` a secas esas pistas no existían para el sistema, y el video
 * salía en silencio mientras el archivo estaba ahí, a la vista de todos menos
 * del programa.
 */
const NIVELES = 3;

/** Formatos que ffmpeg lee sin pedir nada raro. */
const EXTENSIONES = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"]);

export interface Pista {
  /** Ruta absoluta, lista para ffmpeg. */
  ruta: string;
  /** El nombre del archivo, que es lo que se le muestra al agente. */
  nombre: string;
}

export interface EleccionMusical {
  pista: Pista | null;
  /** Qué pasó, en castellano, para sumarlo al resultado de la herramienta. */
  aviso: string;
  /** Lo que hay en la carpeta, para que el agente sepa qué puede pedir. */
  disponibles: string[];
}

const sinExtension = (nombre: string): string => nombre.replace(/\.[^.]+$/, "");

/**
 * Las pistas que hay, con su ruta relativa a la biblioteca.
 *
 * Se devuelve la ruta y no sólo el nombre porque la carpeta **es** información:
 * quien guarda `Corporate/…` está diciendo el clima, y así un guion que pide
 * "corporate" encuentra la pista aunque el archivo se llame de otra manera.
 */
async function recorrer(raiz: string, relativa: string, quedan: number): Promise<string[]> {
  if (quedan <= 0) return [];
  let entradas;
  try {
    entradas = await readdir(join(raiz, relativa), { withFileTypes: true });
  } catch {
    return [];
  }

  const encontradas: string[] = [];
  for (const entrada of entradas) {
    if (entrada.name.startsWith(".")) continue;
    const ruta = relativa ? `${relativa}/${entrada.name}` : entrada.name;
    if (entrada.isDirectory()) {
      encontradas.push(...(await recorrer(raiz, ruta, quedan - 1)));
      continue;
    }
    const extension = entrada.name.slice(entrada.name.lastIndexOf(".") + 1).toLowerCase();
    if (EXTENSIONES.has(extension)) encontradas.push(ruta);
  }
  return encontradas;
}

const normalizar = (texto: string): string =>
  texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Una pista por obra, aunque venga en varios formatos.
 *
 * Los paquetes de música traen el mismo tema en `.wav` y en `.mp3`. Si entran
 * los dos, la lista que ve el agente muestra todo repetido y una elección por
 * palabras puede terminar en el `.wav` de 19 MB para un video de dos minutos.
 * Gana el comprimido, que suena igual acá abajo.
 */
function sinDuplicados(rutas: string[]): string[] {
  const preferencia = ["mp3", "m4a", "aac", "ogg", "opus", "flac", "wav"];
  const mejores = new Map<string, string>();
  for (const ruta of rutas) {
    const clave = normalizar(sinExtension(ruta));
    const actual = mejores.get(clave);
    if (!actual) {
      mejores.set(clave, ruta);
      continue;
    }
    const puesto = (r: string): number => {
      const indice = preferencia.indexOf(r.slice(r.lastIndexOf(".") + 1).toLowerCase());
      return indice === -1 ? preferencia.length : indice;
    };
    if (puesto(ruta) < puesto(actual)) mejores.set(clave, ruta);
  }
  return [...mejores.values()].sort();
}

/**
 * Entre pistas que empatan, gana la más larga.
 *
 * Un paquete trae la misma obra en varias duraciones —`_0.43`, `_1.49`— y por
 * orden alfabético siempre ganaba la corta. Una cama que se repite cada
 * cuarenta segundos se escucha como una cama que se repite. El tamaño del
 * archivo alcanza como medida: dentro de un mismo formato es proporcional a la
 * duración, y no hace falta abrir el audio para saberlo.
 */
async function masLarga(home: string, candidatas: string[]): Promise<string> {
  if (candidatas.length <= 1) return candidatas[0] ?? "";
  const pesos = await Promise.all(
    candidatas.map(async (nombre) => {
      try {
        return { nombre, peso: (await stat(join(home, nombre))).size };
      } catch {
        return { nombre, peso: 0 };
      }
    }),
  );
  // Ante el mismo peso decide el nombre, para que la elección sea reproducible.
  pesos.sort((a, b) => b.peso - a.peso || a.nombre.localeCompare(b.nombre));
  return pesos[0]!.nombre;
}

/**
 * Elige la pista para un pedido.
 *
 * `""` o `"auto"` dejan que elija el sistema; `"ninguna"` apaga la música. Un
 * pedido concreto se busca por palabras contra el nombre del archivo, y gana la
 * que más palabras comparte: así `"corporativo calmo"` prefiere
 * `corporativo-calmo.mp3` sobre `corporativo-energico.mp3`.
 */
export async function elegirMusica(
  home: string | undefined,
  pedido: string,
): Promise<EleccionMusical> {
  const querido = normalizar(pedido);
  if (querido === "ninguna" || querido === "sin musica" || querido === "no") {
    return { pista: null, aviso: "", disponibles: [] };
  }

  if (!home) {
    return {
      pista: null,
      aviso:
        "Sin música: no hay una carpeta de pistas configurada (MUSICA_DIR). " +
        "Avisale a quien opera la empresa; no es algo que puedas resolver vos.",
      disponibles: [],
    };
  }

  const archivos = sinDuplicados((await recorrer(home, "", NIVELES)).sort());

  if (archivos.length === 0) {
    return {
      pista: null,
      aviso:
        `Sin música: no hay ninguna pista en la biblioteca (${home}). ` +
        `Quien opera la empresa tiene que dejar ahí los archivos de audio.`,
      disponibles: [],
    };
  }

  const disponibles = archivos.map(sinExtension);
  const elegir = (nombre: string): Pista => ({ ruta: join(home, nombre), nombre });

  if (querido === "" || querido === "auto") {
    // Automático: se prefiere lo neutro, que es lo que no compite con la voz.
    // `corporat` cubre "corporativo" y "corporate": los paquetes de música
    // vienen en inglés y una pista comprada le gana a una sintetizada.
    const neutras = archivos.filter((nombre) =>
      /corporat|neutr|suave|ambient|inspirad/.test(normalizar(nombre)),
    );
    return {
      pista: elegir(await masLarga(home, neutras.length > 0 ? neutras : archivos)),
      aviso: "",
      disponibles,
    };
  }

  const palabras = querido.split(" ").filter(Boolean);
  let maximo = 0;
  const puntaje = new Map<string, number>();
  for (const nombre of archivos) {
    const contra = normalizar(sinExtension(nombre));
    const puntos = palabras.filter((palabra) => contra.includes(palabra)).length;
    if (puntos > 0) {
      puntaje.set(nombre, puntos);
      maximo = Math.max(maximo, puntos);
    }
  }

  if (maximo === 0) {
    return {
      pista: null,
      aviso:
        `Sin música: no hay ninguna pista que responda a "${pedido}". ` +
        `Las que hay son: ${disponibles.join(", ")}.`,
      disponibles,
    };
  }

  const empatadas = [...puntaje.entries()].filter(([, p]) => p === maximo).map(([n]) => n);
  return { pista: elegir(await masLarga(home, empatadas)), aviso: "", disponibles };
}
