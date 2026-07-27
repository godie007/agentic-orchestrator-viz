import { fail, ok, type RegisteredTool } from "../types.js";
import { renderDocx, renderPdf } from "./render.js";
import { puedeBorrar } from "./permisos.js";

export { parseMarkdown, parseSpans, spansToText } from "./markdown.js";
export type { Block, Span } from "./markdown.js";
export { renderDocx, renderPdf, cuerpoSinTituloRepetido } from "./render.js";
export type { DocumentMeta } from "./render.js";
export { puedeBorrar } from "./permisos.js";
export type { ArchivoParaBorrar, VeredictoBorrado } from "./permisos.js";

/**
 * Habilidades: lo que un agente sabe *producir*, no con quién habla ni de dónde
 * lee.
 *
 * Se registran como un origen aparte (`skill`) para que se asignen y se vean
 * como cualquier otra herramienta, pero se distingan en la UI: "puede entregar
 * un Word" es una capacidad del rol, igual que en una empresa real.
 *
 * Trabajan sobre un entregable que ya existe (`write_artifact`) en vez de
 * recibir el contenido por argumento. Es deliberado: un documento largo pasado
 * como argumento se trunca cuando el modelo agota `max_tokens` a mitad del
 * JSON, y perdés el documento entero. Así el contenido ya está guardado y la
 * exportación no puede romperlo.
 */

/** Guarda los bytes y devuelve cómo llegar al archivo. Lo inyecta el servidor. */
export interface SkillStorage {
  save(input: {
    /** Nombre sugerido, sin ruta. Quien implementa esto lo sanea. */
    filename: string;
    /** Carpeta destino, con `/`. Se crea sola si no existe. */
    folder?: string;
    bytes: Buffer;
  }): Promise<{ url: string; path: string; sizeBytes: number }>;

  /** Todo lo que hay en el directorio de salida, sin la estructura de carpetas. */
  list(): Promise<
    Array<{ path: string; sizeBytes: number; esMultimedia: boolean; generadoPorAgente: boolean }>
  >;

  /** Borra un archivo del directorio de salida. Devuelve el motivo si falla. */
  remove(path: string): Promise<{ ok: true } | { ok: false; motivo: string }>;

  /** Borra en lote por criterio: "toda la multimedia" es una sola operación. */
  removeMany(criterio: {
    kind: "multimedia" | "documents" | "all";
    folder?: string;
    /** Rutas que quien llama ya decidió no borrar, por permisos. */
    excluir?: string[];
  }): Promise<{ borrados: string[]; fallidos: Array<{ path: string; motivo: string }> }>;

  /** Crea o reemplaza un archivo de texto. Es cómo un agente *modifica*. */
  writeText(
    path: string,
    content: string,
  ): Promise<{ ok: true; path: string; sizeBytes: number } | { ok: false; motivo: string }>;
}

/** Escapa una clave para usarla dentro de una expresión regular. */
const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FORMATOS = {
  docx: { etiqueta: "Word", extension: "docx", render: renderDocx },
  pdf: { etiqueta: "PDF", extension: "pdf", render: renderPdf },
} as const;

type Formato = keyof typeof FORMATOS;

function crearSkill(formato: Formato, storage: SkillStorage): RegisteredTool {
  const { etiqueta, extension, render } = FORMATOS[formato];

  return {
    name: `export_${formato}`,
    origin: "skill",
    // Escribe un archivo: no puede correr en paralelo con otras a ciegas.
    readOnly: false,
    requiresApproval: false,
    description:
      `Convierte un entregable ya escrito en un documento ${etiqueta} (.${extension}) ` +
      `descargable. Primero guardá el contenido con write_artifact y después pasá su ` +
      `clave acá. El documento respeta títulos, listas, tablas y negritas del markdown.`,
    inputSchema: {
      type: "object",
      properties: {
        artifact_key: {
          type: "string",
          description: "Clave del entregable a exportar, tal como la usaste en write_artifact",
        },
        folder: {
          type: "string",
          description:
            "Carpeta del directorio de salida donde dejarlo, por ejemplo " +
            "\"comercial/propuestas\" o \"tecnico\". Se crea sola si no existe. " +
            "Usala para que la salida quede ordenada por tema, no todo suelto en la raíz.",
        },
      },
      required: ["artifact_key"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const key = String(args.artifact_key ?? "").trim();
      if (!key) {
        return fail(
          `Falta artifact_key. Es la clave del entregable que querés exportar; ` +
            `si todavía no lo escribiste, usá write_artifact primero.`,
        );
      }

      const artifact = await ctx.workspace.readArtifact(key);
      if (!artifact) {
        const existentes = await ctx.workspace.listArtifacts();
        return fail(
          existentes.length === 0
            ? `No existe ningún entregable todavía. Escribí el contenido con write_artifact ` +
                `y después exportalo.`
            : `No existe el entregable "${key}". Los que hay son: ` +
                `${existentes.map((a) => a.key).join(", ")}.`,
        );
      }

      const carpeta = String(args.folder ?? "").trim();

      // Un archivo por entregable y formato, no uno por versión. Antes el
      // nombre llevaba `-vN`, así que cada re-exportación dejaba otro archivo:
      // pedías un PDF y terminabas con v1, v2 y v3 conviviendo, más el Word.
      // La versión va en la portada, que es donde se lee.
      const anteriores = (await storage.list())
        .map((archivo) => archivo.path)
        .filter((ruta) => {
          const nombre = ruta.split("/").at(-1) ?? "";
          return new RegExp(`^${escaparRegex(artifact.key)}-v\\d+\\.${extension}$`).test(nombre);
        });
      // La portada la arma el sistema, no el modelo: quién firma y de qué
      // empresa es información que ya tenemos y que un agente puede escribir
      // mal. La fecha entra formateada desde acá porque el render no tiene
      // reloj —así los tests son deterministas—.
      for (const vieja of anteriores) await storage.remove(vieja);

      const bytes = await render(artifact.content, {
        title: artifact.title,
        company: ctx.workspace.company.name,
        author: ctx.actor.name,
        authorTitle: ctx.actor.title,
        version: artifact.version,
        date: new Date(artifact.createdAt).toLocaleDateString("es-AR", {
          day: "2-digit",
          month: "long",
          year: "numeric",
        }),
      });
      const guardado = await storage.save({
        filename: `${artifact.key}.${extension}`,
        ...(carpeta ? { folder: carpeta } : {}),
        bytes,
      });

      const reemplazo = anteriores.length
        ? ` Reemplaza la versión anterior del mismo documento.`
        : "";
      return ok(
        `Documento ${etiqueta} generado en ${guardado.path}: "${artifact.title}" ` +
          `(v${artifact.version}), ${Math.max(1, Math.round(guardado.sizeBytes / 1024))} KB.` +
          `${reemplazo} Queda en el directorio de salida; no hace falta exportarlo de nuevo ` +
          `salvo que cambies el contenido.`,
        guardado.path,
      );
    },
  };
}

/** Ver qué hay en el directorio de salida, con lo que se puede borrar marcado. */
function crearListado(storage: SkillStorage): RegisteredTool {
  return {
    name: "list_output",
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    description:
      "Lista los archivos del directorio de salida con su tamaño, e indica cuáles son " +
      "multimedia, cuáles los generó la empresa y cuáles no. Usalo antes de borrar: solo " +
      "podés borrar multimedia o lo que la empresa haya generado.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },

    async execute() {
      const archivos = await storage.list();
      if (archivos.length === 0) return ok("El directorio de salida está vacío.");

      const multimedia = archivos.filter((archivo) => archivo.esMultimedia);
      // La etiqueta dice si se puede borrar, no solo de dónde vino: decir
      // "externo" de un multimedia hacía que el agente lo saltara, aunque la
      // regla sí permite borrarlo.
      const linea = (archivo: (typeof archivos)[number]): string => {
        const tipo = archivo.esMultimedia ? "multimedia" : "documento";
        const origen = archivo.generadoPorAgente ? "de la empresa" : "externo";
        const permiso =
          archivo.esMultimedia || archivo.generadoPorAgente
            ? "SE PUEDE BORRAR"
            : "NO SE PUEDE BORRAR: lo trajo una persona";
        return (
          `- ${archivo.path} (${Math.max(1, Math.round(archivo.sizeBytes / 1024))} KB) ` +
          `— ${tipo}, ${origen} · ${permiso}`
        );
      };

      return ok(
        `${archivos.length} archivos, ${multimedia.length} multimedia:\n` +
          archivos.map(linea).join("\n"),
        `${archivos.length} archivos`,
      );
    },
  };
}

/** Limpiar multimedia del directorio de salida. */
function crearBorrado(storage: SkillStorage): RegisteredTool {
  return {
    name: "delete_files",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Borra archivos del directorio de salida. Pasá `path` para uno solo, o `kind` para " +
      "borrar un grupo entero de una vez: \"multimedia\" (imágenes, audio, video), " +
      "\"documents\" (Word, PDF y demás) o \"all\". Con `folder` limitás el alcance a una " +
      "carpeta. Borrar depende de tu autoridad: un ejecutivo puede dar de baja cualquier " +
      "cosa, quien dirige un área solo material de apoyo, y un ejecutor no borra —escala el " +
      "pedido—. Además nadie borra archivos que trajo una persona: solo multimedia o lo que " +
      "generó la empresa. NO HAY PAPELERA: lo que borres se pierde.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Un archivo concreto, ej. media/captura.png. Excluyente con kind.",
        },
        kind: {
          type: "string",
          enum: ["multimedia", "documents", "all"],
          description: "Borrar todo el grupo. Usalo cuando te pidan 'borrá toda la multimedia'.",
        },
        folder: {
          type: "string",
          description: "Limita el borrado a esta carpeta. Vacío = todo el directorio.",
        },
      },
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const path = String(args.path ?? "").trim();
      const kind = String(args.kind ?? "").trim();
      const folder = String(args.folder ?? "").trim();

      // `path` gana sobre `kind`. Los modelos completan todos los campos del
      // esquema aunque solo uno aplique: rechazar la llamada por eso volvía la
      // herramienta inusable —28 llamadas seguidas rechazadas, cero borrados—.
      if (path) {
        // La autoridad se mira antes de tocar el disco, y el motivo nombra a
        // quién escalarle: así el rechazo produce una acción, no un bloqueo.
        const veredicto = puedeBorrar(ctx.actor.authority, {
          path,
          esMultimedia: (await storage.list()).find((a) => a.path === path)?.esMultimedia ?? false,
        });
        if (!veredicto.permitido) return fail(veredicto.motivo!);

        const resultado = await storage.remove(path);
        const aclaracion = kind
          ? ` (se ignoró kind="${kind}": mandaste una ruta concreta, que es más específica)`
          : "";
        // El motivo se devuelve tal cual para que el agente pueda informarlo
        // en vez de reintentar contra un error que no va a cambiar.
        return resultado.ok
          ? ok(`Borrado: ${path}${aclaracion}`, path)
          : fail(resultado.motivo);
      }

      if (kind !== "multimedia" && kind !== "documents" && kind !== "all") {
        return fail(
          "Falta qué borrar: pasá `path` con una ruta concreta, o `kind` con " +
            "\"multimedia\", \"documents\" o \"all\". Corré list_output si no sabés qué hay.",
        );
      }

      // En lote se filtra por autoridad antes de borrar: un `kind` amplio no
      // puede ser la vía para saltear la jerarquía.
      const candidatos = (await storage.list()).filter((archivo) => {
        if (folder && !archivo.path.startsWith(`${folder}/`)) return false;
        if (kind === "all") return true;
        return kind === "multimedia" ? archivo.esMultimedia : !archivo.esMultimedia;
      });
      const sinPermiso = candidatos
        .map((archivo) => ({ archivo, veredicto: puedeBorrar(ctx.actor.authority, archivo) }))
        .filter((entrada) => !entrada.veredicto.permitido);

      if (sinPermiso.length === candidatos.length && candidatos.length > 0) {
        return fail(sinPermiso[0]!.veredicto.motivo!);
      }

      const { borrados, fallidos } = await storage.removeMany({
        kind,
        ...(folder ? { folder } : {}),
        excluir: sinPermiso.map((entrada) => entrada.archivo.path),
      });

      if (borrados.length === 0 && fallidos.length === 0) {
        return ok(`No había nada que borrar${folder ? ` en ${folder}` : ""}.`, "0 borrados");
      }

      const omitidos = sinPermiso.map((entrada) => ({
        path: entrada.archivo.path,
        motivo: entrada.veredicto.motivo!,
      }));
      const noBorrados = [...fallidos, ...omitidos];
      const detalle = noBorrados.length
        ? `\nNo se pudieron borrar ${noBorrados.length}: ` +
          noBorrados.map((f) => `${f.path} (${f.motivo})`).join("; ")
        : "";

      return ok(
        `Borrados ${borrados.length} archivos${folder ? ` de ${folder}` : ""}:\n` +
          borrados.map((p) => `- ${p}`).join("\n") +
          detalle,
        `${borrados.length} borrados`,
      );
    },
  };
}

/** Crear o modificar un documento del directorio de salida. */
function crearEscritura(storage: SkillStorage): RegisteredTool {
  return {
    name: "write_output_file",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Crea o reemplaza un archivo de texto en el directorio de salida —markdown, csv, " +
      "notas—. Usalo para modificar un documento que ya está ahí o para dejar uno que no " +
      "necesita ser Word ni PDF. Sobrescribe sin avisar: si querés conservar lo anterior, " +
      "el historial va en write_artifact, no acá. Para Word o PDF usá export_docx/export_pdf.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta destino, ej. informes/notas-reunion.md. La carpeta se crea sola.",
        },
        content: { type: "string", description: "Contenido completo del archivo." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },

    async execute(args) {
      const path = String(args.path ?? "").trim();
      const content = typeof args.content === "string" ? args.content : "";
      if (!path) return fail("Falta path: la ruta del archivo dentro del directorio de salida.");
      if (!content.trim()) {
        return fail("Falta content. Escribir un archivo vacío no le sirve a nadie.");
      }

      const resultado = await storage.writeText(path, content);
      return resultado.ok
        ? ok(
            `Escrito ${resultado.path} (${Math.max(1, Math.round(resultado.sizeBytes / 1024))} KB).`,
            resultado.path,
          )
        : fail(resultado.motivo);
    },
  };
}

export function createSkillTools(storage: SkillStorage): RegisteredTool[] {
  return [
    ...(Object.keys(FORMATOS) as Formato[]).map((formato) => crearSkill(formato, storage)),
    crearListado(storage),
    crearEscritura(storage),
    crearBorrado(storage),
  ];
}
