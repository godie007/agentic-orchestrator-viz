import { mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { SkillStorage } from "@orq/tools";

/**
 * El directorio de salida de la empresa.
 *
 * Los entregables se guardan en SQLite como texto, pero un Word o un PDF son
 * bytes que alguien descarga: van a disco, en un árbol propio por empresa y
 * organizado en carpetas, no en una bolsa plana de archivos.
 *
 * Las rutas las propone el agente, así que se sanean acá segmento por segmento
 * y no se confía en ellas: una clave de entregable como `../../.env` escribiría
 * fuera del directorio, y el agente elige ese texto —un prompt puede influirlo—.
 */

/**
 * Extensiones que se consideran multimedia.
 *
 * Ya **no** definen qué se puede borrar —se borra cualquier archivo, por
 * decisión explícita— pero siguen distinguiendo un entregable de un archivo de
 * apoyo: la UI los marca distinto y pide confirmación antes de borrar trabajo.
 */
const EXTENSIONES_MULTIMEDIA = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "mp4",
  "mov",
  "avi",
  "webm",
  "mkv",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
]);

export interface TreeFile {
  kind: "file";
  name: string;
  /** Ruta relativa al directorio de la empresa, con `/`. */
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  /** Imagen, audio o video. Distingue apoyo de entregable en la UI. */
  esMultimedia: boolean;
  /** Lo escribió un agente. Los que no, son tuyos y el agente no los toca. */
  generadoPorAgente: boolean;
}

/**
 * Registro de qué archivos escribió la empresa.
 *
 * Vive en un archivo oculto dentro del directorio de cada empresa —el árbol
 * ignora los que empiezan con punto— y no en la base, para que `ExportStore`
 * siga sin depender de SQLite y el registro viaje junto con los archivos.
 */
const MANIFIESTO = ".orq-generado.json";

export interface TreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: Array<TreeFolder | TreeFile>;
}

export const esMultimedia = (nombre: string): boolean => {
  const punto = nombre.lastIndexOf(".");
  if (punto < 0) return false;
  return EXTENSIONES_MULTIMEDIA.has(nombre.slice(punto + 1).toLowerCase());
};

export class ExportStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  // --- Procedencia ---------------------------------------------------------

  private async leerManifiesto(companyId: string): Promise<Set<string>> {
    try {
      const crudo = await readFile(join(this.dirFor(companyId), MANIFIESTO), "utf8");
      const datos = JSON.parse(crudo) as { paths?: string[] };
      return new Set(datos.paths ?? []);
    } catch {
      // Sin manifiesto todavía: nada fue generado por un agente.
      return new Set();
    }
  }

  private async guardarManifiesto(companyId: string, paths: Set<string>): Promise<void> {
    await writeFile(
      join(this.dirFor(companyId), MANIFIESTO),
      JSON.stringify({ paths: [...paths].sort() }, null, 2),
      "utf8",
    );
  }

  private async marcarGenerado(companyId: string, path: string): Promise<void> {
    const paths = await this.leerManifiesto(companyId);
    paths.add(path);
    await this.guardarManifiesto(companyId, paths);
  }

  private async olvidar(companyId: string, path: string): Promise<void> {
    const paths = await this.leerManifiesto(companyId);
    if (paths.delete(path)) await this.guardarManifiesto(companyId, paths);
  }

  /**
   * Deja solo lo que puede ser el nombre de **un** segmento de ruta.
   *
   * Se descartan los separadores y los puntos iniciales, así que de acá no
   * puede salir un `..` ni una ruta absoluta.
   */
  static safeSegment(raw: string): string {
    const base = raw
      .normalize("NFKD")
      // Las tildes se descartan, no se reemplazan por un guion: sin esto
      // "Área" quedaba como "A-rea", porque NFKD separa la tilde en un
      // carácter propio que el paso siguiente tomaba por basura.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+/, "")
      .replace(/-+/g, "-")
      .replace(/-+$/, "")
      .slice(0, 80);
    return base || "sin-nombre";
  }

  /**
   * Sanea una ruta completa segmento por segmento y descarta los vacíos.
   *
   * Devuelve los segmentos, nunca una cadena con separadores: quien la usa
   * arma la ruta con `join`, y así no hay forma de reintroducir un `..`.
   */
  static safePath(raw: string): string[] {
    return raw
      .split(/[/\\]+/)
      .map((segmento) => segmento.trim())
      .filter((segmento) => segmento !== "" && segmento !== "." && segmento !== "..")
      .map(ExportStore.safeSegment)
      .slice(0, 6); // más profundidad que esto no organiza nada, esconde
  }

  private dirFor(companyId: string): string {
    const dir = join(this.rootDir, ExportStore.safeSegment(companyId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Resuelve una ruta pedida dentro del directorio de la empresa.
   *
   * La verificación final es sobre la ruta ya resuelta, que es lo único que no
   * se puede engañar con codificaciones ni enlaces.
   */
  private resolveDentro(companyId: string, relativa: string): { dir: string; destino: string } | null {
    const dir = this.dirFor(companyId);
    const segmentos = ExportStore.safePath(relativa);
    if (segmentos.length === 0) return null;

    const destino = resolve(dir, ...segmentos);
    if (destino !== resolve(dir) && !destino.startsWith(resolve(dir) + sep)) return null;
    return { dir, destino };
  }

  /** Almacenamiento que se le inyecta a las habilidades de una empresa. */
  forCompany(companyId: string): SkillStorage {
    return {
      save: async ({ filename, folder, bytes }) => {
        // La carpeta se crea sola: pedirle al agente un paso aparte para
        // crearla solo agrega una llamada que a veces olvida.
        const segmentos = [...ExportStore.safePath(folder ?? ""), ExportStore.safeSegment(filename)];
        const ubicacion = this.resolveDentro(companyId, segmentos.join("/"));
        if (!ubicacion) throw new Error(`Ruta de salida inválida: "${folder ?? ""}/${filename}"`);

        await mkdir(dirname(ubicacion.destino), { recursive: true });
        await writeFile(ubicacion.destino, bytes);

        const relativa = segmentos.join("/");
        await this.marcarGenerado(companyId, relativa);
        return {
          url: `/api/companies/${companyId}/exports/${relativa}`,
          path: relativa,
          sizeBytes: bytes.length,
        };
      },

      list: async () => this.flatList(companyId),

      // El agente llama, pero la regla la aplica el store: el límite no depende
      // de que el modelo la haya entendido.
      remove: (path) => this.removeComoAgente(companyId, path),

      removeMany: (criterio) => this.removeMany(companyId, criterio),

      writeText: (path, content) => this.writeText(companyId, path, content),
    };
  }

  /**
   * Borra en lote por criterio.
   *
   * "Borrá toda la multimedia" tiene que ser **una** instrucción, no una llamada
   * por archivo: pedirle al agente que las encadene lo hace fallar a la mitad y
   * deja el directorio en un estado intermedio que nadie pidió.
   */
  async removeMany(
    companyId: string,
    criterio: {
      kind: "multimedia" | "documents" | "all";
      folder?: string;
      /** Rutas que quien llama ya descartó, típicamente por permisos. */
      excluir?: string[];
    },
  ): Promise<{ borrados: string[]; fallidos: Array<{ path: string; motivo: string }> }> {
    const alcance = criterio.folder ? ExportStore.safePath(criterio.folder).join("/") : "";
    const excluidos = new Set(criterio.excluir ?? []);
    const candidatos = (await this.flatList(companyId)).filter((archivo) => {
      if (excluidos.has(archivo.path)) return false;
      if (alcance && !archivo.path.startsWith(`${alcance}/`)) return false;
      if (criterio.kind === "all") return true;
      return criterio.kind === "multimedia" ? archivo.esMultimedia : !archivo.esMultimedia;
    });

    const borrados: string[] = [];
    const fallidos: Array<{ path: string; motivo: string }> = [];
    for (const archivo of candidatos) {
      // Cada uno pasa por la regla del agente: un lote no es una excusa para
      // llevarse un archivo que la empresa no generó.
      const resultado = await this.removeComoAgente(companyId, archivo.path);
      if (resultado.ok) borrados.push(archivo.path);
      else fallidos.push({ path: archivo.path, motivo: resultado.motivo });
    }
    return { borrados, fallidos };
  }

  /**
   * Borrado pedido por un agente.
   *
   * Un agente limpia **lo suyo**: multimedia, o archivos que la propia empresa
   * generó. Lo que pusiste vos a mano no lo toca — no lo produjo, no sabe qué
   * es, y "eliminá lo que sobra" no puede llevarse un archivo que trajiste.
   *
   * El borrado desde la UI no pasa por acá: ahí decidís vos, con confirmación.
   */
  async removeComoAgente(
    companyId: string,
    ruta: string,
  ): Promise<{ ok: true } | { ok: false; motivo: string }> {
    const relativa = ExportStore.safePath(ruta).join("/");
    if (!relativa) return { ok: false, motivo: "Ruta inválida." };

    const nombre = relativa.split("/").at(-1) ?? "";
    const generados = await this.leerManifiesto(companyId);
    if (!esMultimedia(nombre) && !generados.has(relativa)) {
      return {
        ok: false,
        motivo:
          `"${relativa}" no lo generó la empresa y no es multimedia, así que no se borra ` +
          `desde un agente. Si hay que sacarlo, lo hace una persona desde el panel de salida.`,
      };
    }
    return this.remove(companyId, relativa);
  }

  /**
   * Crea o reemplaza un archivo de texto del directorio de salida.
   *
   * Es lo que permite que un agente *modifique* un documento y no solo produzca
   * uno nuevo. Sobrescribe a propósito: versionar acá duplicaría lo que ya hace
   * `write_artifact`, que es donde vive el historial.
   */
  async writeText(
    companyId: string,
    ruta: string,
    content: string,
  ): Promise<{ ok: true; path: string; sizeBytes: number } | { ok: false; motivo: string }> {
    const segmentos = ExportStore.safePath(ruta);
    if (segmentos.length === 0) return { ok: false, motivo: "Ruta inválida." };

    const ubicacion = this.resolveDentro(companyId, segmentos.join("/"));
    if (!ubicacion) return { ok: false, motivo: "Ruta inválida." };

    const bytes = Buffer.from(content, "utf8");
    await mkdir(dirname(ubicacion.destino), { recursive: true });
    await writeFile(ubicacion.destino, bytes);

    const relativa = segmentos.join("/");
    await this.marcarGenerado(companyId, relativa);
    return { ok: true, path: relativa, sizeBytes: bytes.length };
  }

  /** Archivos del árbol sin la estructura, para el agente y para la UI. */
  async flatList(
    companyId: string,
  ): Promise<
    Array<{ path: string; sizeBytes: number; esMultimedia: boolean; generadoPorAgente: boolean }>
  > {
    const aplanar = (nodo: TreeFolder): TreeFile[] =>
      nodo.children.flatMap((hijo) => (hijo.kind === "folder" ? aplanar(hijo) : [hijo]));
    return aplanar(await this.tree(companyId)).map(
      ({ path, sizeBytes, esMultimedia, generadoPorAgente }) => ({
        path,
        sizeBytes,
        esMultimedia,
        generadoPorAgente,
      }),
    );
  }

  /** Árbol completo del directorio de salida, carpetas primero. */
  async tree(companyId: string): Promise<TreeFolder> {
    const raiz = this.dirFor(companyId);
    const generados = await this.leerManifiesto(companyId);

    const leer = async (absoluta: string, relativa: string): Promise<Array<TreeFolder | TreeFile>> => {
      const entradas = await readdir(absoluta, { withFileTypes: true });
      const hijos = await Promise.all(
        entradas
          // Los que empiezan con punto no se muestran: ahí vive el manifiesto.
          .filter((entrada) => !entrada.name.startsWith("."))
          .map(async (entrada): Promise<TreeFolder | TreeFile> => {
            const rutaAbs = join(absoluta, entrada.name);
            const rutaRel = relativa ? `${relativa}/${entrada.name}` : entrada.name;
            if (entrada.isDirectory()) {
              return {
                kind: "folder",
                name: entrada.name,
                path: rutaRel,
                children: await leer(rutaAbs, rutaRel),
              };
            }
            const info = await stat(rutaAbs);
            return {
              kind: "file",
              name: entrada.name,
              path: rutaRel,
              sizeBytes: info.size,
              modifiedAt: info.mtimeMs,
              esMultimedia: esMultimedia(entrada.name),
              generadoPorAgente: generados.has(rutaRel),
            };
          }),
      );

      // Carpetas antes que archivos, y cada grupo alfabético: es cómo se lee
      // un árbol de archivos en cualquier herramienta.
      return hijos.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
      );
    };

    return { kind: "folder", name: "salida", path: "", children: await leer(raiz, "") };
  }

  /** Crea una carpeta vacía. Devuelve su ruta saneada. */
  async createFolder(companyId: string, ruta: string): Promise<string | null> {
    const ubicacion = this.resolveDentro(companyId, ruta);
    if (!ubicacion) return null;
    await mkdir(ubicacion.destino, { recursive: true });
    return ExportStore.safePath(ruta).join("/");
  }

  /**
   * Borra un archivo del directorio de salida.
   *
   * Borra cualquier archivo, incluidos los entregables: es una decisión
   * explícita de quien opera la herramienta. **No hay papelera**, así que lo
   * borrado se pierde; la UI pide confirmación antes de tocar un entregable y
   * el agente recibe esa advertencia en la descripción de la herramienta.
   *
   * Lo que sigue en pie es el saneo de la ruta: se borra dentro del directorio
   * de la empresa y en ningún otro lado.
   */
  async remove(
    companyId: string,
    ruta: string,
  ): Promise<{ ok: true } | { ok: false; motivo: string }> {
    const ubicacion = this.resolveDentro(companyId, ruta);
    if (!ubicacion) return { ok: false, motivo: "Ruta inválida." };

    try {
      const info = await stat(ubicacion.destino);
      if (info.isDirectory()) return { ok: false, motivo: "Es una carpeta, no un archivo." };
      await rm(ubicacion.destino);
      await this.olvidar(companyId, ExportStore.safePath(ruta).join("/"));
      return { ok: true };
    } catch {
      return { ok: false, motivo: "El archivo no existe." };
    }
  }

  /**
   * Lee un archivo del directorio de salida. `null` si no existe o si la ruta
   * pedida se sale del directorio de la empresa.
   */
  async read(companyId: string, ruta: string): Promise<Buffer | null> {
    const ubicacion = this.resolveDentro(companyId, ruta);
    if (!ubicacion) return null;
    try {
      return await readFile(ubicacion.destino);
    } catch {
      return null;
    }
  }
}

/** Tipo de contenido según la extensión, para que el navegador sepa qué abrir. */
export function contentTypeOf(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const tipos: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
  };
  return tipos[ext] ?? "application/octet-stream";
}
