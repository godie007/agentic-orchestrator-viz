import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fail, ok, type RegisteredTool, type ToolContext, type ToolResult } from "../types.js";
import { abrirRevelado, buscarChrome } from "./chrome.js";
import { renderEstudio } from "./estudio.js";
import { CARPETA_ESCENAS, GUIA_ESTUDIO, PALETA, RUTA_GUIA, RUTA_TEMA, TEMA_CSS } from "./tema.js";
import { describirFicha, inspeccionarMedio } from "./medios.js";
import { renderDocx, renderPdf } from "./render.js";
import { puedeBorrar } from "./permisos.js";
import { ICONOS_DISPONIBLES } from "./iconos.js";
import { crearGeneradorImagenes, type GeneradorImagenes } from "./imagenes.js";
import type { ImagenGuion } from "./guion.js";
import { renderSlides } from "./slides.js";
import { renderVideo } from "./video.js";

export { parseMarkdown, parseSpans, spansToText } from "./markdown.js";
export type { Block, Span } from "./markdown.js";
export { renderDocx, renderPdf, cuerpoSinTituloRepetido } from "./render.js";
export type { DocumentMeta } from "./render.js";
export { puedeBorrar } from "./permisos.js";
export type { ArchivoParaBorrar, VeredictoBorrado } from "./permisos.js";
export { parseGuion, caracteresHablados } from "./guion.js";
export type { Guion, Escena, Linea } from "./guion.js";
export { renderVideo } from "./video.js";
export type { OpcionesVideo, ResultadoVideo } from "./video.js";
export { renderSlides } from "./slides.js";
export type { OpcionesSlides, ResultadoSlides } from "./slides.js";
export { renderEstudio, atarLaminas, planificar } from "./estudio.js";
export type { OpcionesEstudio, ResultadoEstudio, Plano } from "./estudio.js";
export { laminaDeEscena, TEMA_CSS, GUIA_ESTUDIO, CARPETA_ESCENAS } from "./tema.js";
export { buscarChrome } from "./chrome.js";
export { construirSonido } from "./sonido.js";
export { inspeccionarMedio, describirFicha, leerFicha, cuadrosPorSegundo } from "./medios.js";
export type { FichaMedio } from "./medios.js";
export { iconoAss, iconoSvg, separarIcono, ICONOS_DISPONIBLES } from "./iconos.js";
export { elegirMusica } from "./musica.js";
export type { Pista, EleccionMusical } from "./musica.js";
export { crearGeneradorImagenes } from "./imagenes.js";
export type { GeneradorImagenes, PedidoImagen } from "./imagenes.js";
export { crearNarrador, motorDisponible } from "./narracion.js";
export type { Narrador, Motor, OpcionesNarrador } from "./narracion.js";

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

  /**
   * La ruta real de un archivo del directorio de salida, o `null` si no está.
   *
   * Existe para el video, que necesita **abrir** una imagen y no puede recibirla
   * como texto. Devuelve una ruta absoluta ya saneada: la ruta la propone un
   * agente, así que quien resuelve sigue siendo el servidor.
   */
  resolve(path: string): Promise<string | null>;
}

/** Lo que el servidor le presta a las habilidades además del almacenamiento. */
export interface OpcionesHabilidades {
  /** Carpeta con las pistas de música de fondo. */
  musicaHome?: string;
  /**
   * Quién produce las imágenes que el guion describe pero nadie preparó.
   *
   * `null` es una configuración válida —una empresa sin proveedor de imágenes—
   * y entonces el video se filma con lo que ya existe en el directorio.
   */
  generadorImagenes?: GeneradorImagenes | null;
}

/** Escapa una clave para usarla dentro de una expresión regular. */
const escaparRegex = (texto: string): string => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FORMATOS = {
  docx: { etiqueta: "Word", extension: "docx", render: renderDocx },
  pdf: { etiqueta: "PDF", extension: "pdf", render: renderPdf },
} as const;

type Formato = keyof typeof FORMATOS;

type Entregable = NonNullable<Awaited<ReturnType<ToolContext["workspace"]["readArtifact"]>>>;

/**
 * Resuelve la clave a un entregable, o explica qué claves sí existen.
 *
 * Lo comparten todas las habilidades que exportan: el error importa tanto como
 * el camino feliz, porque un agente que recibe "no existe" a secas vuelve a
 * intentar con la misma clave inventada.
 */
async function buscarEntregable(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ artifact: Entregable } | { error: ToolResult }> {
  const key = String(args.artifact_key ?? "").trim();
  if (!key) {
    return {
      error: fail(
        `Falta artifact_key. Es la clave del entregable que querés exportar; ` +
          `si todavía no lo escribiste, usá write_artifact primero.`,
      ),
    };
  }

  const artifact = await ctx.workspace.readArtifact(key);
  if (!artifact) {
    const existentes = await ctx.workspace.listArtifacts();
    return {
      error: fail(
        existentes.length === 0
          ? `No existe ningún entregable todavía. Escribí el contenido con write_artifact ` +
              `y después exportalo.`
          : `No existe el entregable "${key}". Los que hay son: ` +
              `${existentes.map((a) => a.key).join(", ")}.`,
      ),
    };
  }

  return { artifact };
}

/**
 * Nada con plata sale sin que alguien haya verificado las cuentas.
 *
 * Es el mismo principio que el resto de las guardias: se verifica en el
 * ejecutor y no en el prompt. Le pedimos exhaustividad al auditor de cinco
 * maneras distintas —la herramienta, el prompt, la versión en lote, abaratar la
 * lectura, más iteraciones— y verificó una cifra de seis y se dio por
 * satisfecho. Acá deja de ser algo que *debería* hacer.
 *
 * Sólo aplica a documentos con cifras: un instructivo sin números no tiene nada
 * que verificar. Devuelve el rechazo, o `null` si puede salir.
 */
function revisarCifras(artifact: Entregable, ctx: ToolContext): ToolResult | null {
  const tieneCifras = /(\$\s?[\d.,]{4,})|(\d[\d.,]*\s?%)/.test(artifact.content);
  if (!tieneCifras) return null;

  const verificacion = ctx.workspace.verificacionDe(artifact.key);
  if (!verificacion) {
    return fail(
      `"${artifact.key}" tiene cifras de plata o porcentajes y nadie las verificó, así que ` +
        `no sale. Corré verificar_cifras con entregable: "${artifact.key}" y una fila por ` +
        `cada número que el documento afirma. Si no es tu tarea, pedísela a Control de ` +
        `Calidad y exportá cuando te confirme.`,
    );
  }
  if (verificacion.version !== artifact.version) {
    return fail(
      `La verificación de "${artifact.key}" es de la v${verificacion.version} y el ` +
        `documento ya va por la v${artifact.version}: se reescribió después de revisarlo. ` +
        `Volvé a correr verificar_cifras sobre la versión actual.`,
    );
  }
  if (verificacion.malas > 0) {
    return fail(
      `"${artifact.key}" no sale: la verificación encontró ${verificacion.malas} de ` +
        `${verificacion.total} cifras que no coinciden con su cuenta. Corregilas en el ` +
        `documento, volvé a verificar y después exportá.`,
    );
  }
  return null;
}

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
      const entregable = await buscarEntregable(args, ctx);
      if ("error" in entregable) return entregable.error;
      const { artifact } = entregable;

      const bloqueo = revisarCifras(artifact, ctx);
      if (bloqueo) return bloqueo;

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

/**
 * Cuánto texto se devuelve de un archivo del directorio de salida.
 *
 * Un tope y no "el archivo entero": lo que devuelve una herramienta se reenvía
 * en cada iteración del turno, así que un archivo grande leído dos veces sale
 * más caro que el trabajo que habilita. Con esto entra una lámina holgada.
 */
const TOPE_LECTURA = 24_000;

/**
 * Leer un archivo de texto del directorio de salida.
 *
 * Existe porque un agente podía **escribir** ahí y no volver a leerlo: quien
 * programa una lámina necesita releer la que hizo para corregirla, y leer la
 * guía del kit que el sistema le deja. Sin esto, la única forma de arreglar una
 * lámina era reescribirla entera de memoria.
 */
function crearLectura(storage: SkillStorage): RegisteredTool {
  return {
    name: "read_output_file",
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    description:
      "Devuelve el contenido de un archivo de texto del directorio de salida —una lámina " +
      "HTML, un markdown, un csv, la guía del kit de diseño—. Usalo para releer y corregir " +
      "lo que ya escribiste, en vez de reescribirlo entero de memoria. Los archivos " +
      "binarios (imágenes, video, Word, PDF) no se pueden leer así: para esos, list_output " +
      "te dice que están y la pestaña Salida los muestra.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Ruta del archivo, ej. escenas/02-lo-que-hacemos.html",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },

    async execute(args) {
      const ruta = String(args.path ?? "").trim();
      if (!ruta) return fail("Falta path: la ruta del archivo que querés leer.");

      const absoluta = await storage.resolve(ruta);
      if (!absoluta) {
        const existentes = (await storage.list()).map((archivo) => archivo.path);
        return fail(
          existentes.length === 0
            ? `No hay ningún archivo en el directorio de salida todavía.`
            : `No existe "${ruta}". Los que hay son: ${existentes.slice(0, 40).join(", ")}.`,
        );
      }

      let contenido: string;
      try {
        contenido = await readFile(absoluta, "utf8");
      } catch {
        return fail(
          `No se pudo leer "${ruta}" como texto. Si es una imagen, un video, un Word o un ` +
            `PDF, no se lee así: se mira desde la pestaña Salida.`,
        );
      }

      // Un binario leído como utf8 no falla: vuelve con bytes nulos y caracteres
      // de reemplazo, y le mete esa basura al contexto del agente sin decir por qué.
      if (contenido.includes("\u0000") || contenido.includes("\uFFFD")) {
        return fail(`"${ruta}" no es un archivo de texto: se mira desde la pestaña Salida.`);
      }

      if (contenido.length > TOPE_LECTURA) {
        return ok(
          `${contenido.slice(0, TOPE_LECTURA)}\n\n[…] El archivo sigue: son ` +
            `${contenido.length} caracteres y acá entran ${TOPE_LECTURA}.`,
          `${ruta} (recortado)`,
        );
      }
      return ok(contenido, ruta);
    },
  };
}

/**
 * Medir un archivo producido, en vez de confiar en lo que dijo quien lo produjo.
 *
 * Es `check_activity` aplicado al disco: la organización sabía que el video
 * duraba 76 segundos porque lo decía el mensaje de la herramienta, y cuando el
 * motor leía de más el video salía de 131 y nadie podía notarlo hasta que una
 * persona lo abría. Un dato que sólo se puede repetir no es una verificación.
 */
function crearInspeccion(storage: SkillStorage): RegisteredTool {
  return {
    name: "inspeccionar_medio",
    origin: "skill",
    readOnly: true,
    requiresApproval: false,
    description:
      "Mide un archivo del directorio de salida y te devuelve los hechos: cuánto dura, " +
      "a qué resolución, con qué códecs, si tiene pista de audio y cuánto pesa. Usalo " +
      "para **verificar** lo que produjiste antes de darlo por bueno —que el video entre " +
      "en la duración pedida, que no haya salido mudo— en vez de repetir lo que dijo la " +
      "herramienta que lo generó. Un archivo que no es audio ni video igual devuelve su " +
      "tamaño.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Ruta del archivo, ej. "marketing/video-codytion.mp4"',
        },
      },
      required: ["path"],
      additionalProperties: false,
    },

    async execute(args) {
      const ruta = String(args.path ?? "").trim();
      if (!ruta) return fail("Falta path: la ruta del archivo que querés medir.");

      const absoluta = await storage.resolve(ruta);
      if (!absoluta) {
        const existentes = (await storage.list()).map((archivo) => archivo.path);
        return fail(
          existentes.length === 0
            ? "No hay ningún archivo en el directorio de salida todavía."
            : `No existe "${ruta}". Los que hay son: ${existentes.slice(0, 40).join(", ")}.`,
        );
      }

      try {
        const ficha = await inspeccionarMedio(absoluta);
        return ok(`${ruta}: ${describirFicha(ficha)}.`, ruta);
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(
          `No se pudo medir "${ruta}": ${detalle.split("\n")[0]}. Si falta ffprobe en el ` +
            `sistema, avisale a quien opera la empresa: no es algo que puedas resolver vos.`,
        );
      }
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

      // La versión no va en el nombre del archivo. Es la misma regla que ya
      // aplican export_docx y export_pdf, y por acá volvía a entrar: esta
      // corrida dejó "paquete-comercial-v25.md" al lado del PDF sin versión.
      // Con la versión en el nombre, cada corrección deja otro archivo y el
      // directorio termina con v22, v23 y v25 conviviendo, sin saber cuál vale.
      const limpio = sinVersionEnNombre(path);
      const resultado = await storage.writeText(limpio, content);
      if (resultado.ok && limpio !== path) {
        return ok(
          `Escrito ${resultado.path}. Le saqué la versión al nombre: el archivo es uno solo y ` +
            `se pisa con la corrección siguiente. La versión vive en el entregable ` +
            `(write_artifact) y sale impresa en la portada.`,
          resultado.path,
        );
      }
      return resultado.ok
        ? ok(
            `Escrito ${resultado.path} (${Math.max(1, Math.round(resultado.sizeBytes / 1024))} KB).`,
            resultado.path,
          )
        : fail(resultado.motivo);
    },
  };
}

/** Quita el `-v12` del nombre, conservando carpeta y extensión. */
export function sinVersionEnNombre(path: string): string {
  const barra = path.lastIndexOf("/");
  const carpeta = barra === -1 ? "" : path.slice(0, barra + 1);
  const archivo = path.slice(barra + 1);
  const punto = archivo.lastIndexOf(".");
  const base = punto === -1 ? archivo : archivo.slice(0, punto);
  const extension = punto === -1 ? "" : archivo.slice(punto);
  const limpia = base.replace(/[-_\s]*[vV]\d+$/, "");
  // Si el nombre era sólo la versión no queda nada útil: se deja como estaba.
  return limpia ? `${carpeta}${limpia}${extension}` : path;
}

/**
 * Video narrado a partir de un guion.
 *
 * No comparte el factory de Word y PDF porque no comparte el contrato: aquellos
 * maquetan un documento, éste interpreta el markdown como una línea de tiempo.
 * El resto —clave del entregable, guardia de cifras, carpeta de salida, un
 * archivo por entregable— sí es igual, y por eso reusa los mismos ayudantes.
 */
/**
 * Nombre estable para una imagen generada.
 *
 * El mismo prompt tiene que dar el mismo archivo: sin eso, re-exportar un guion
 * paga otra vez todas las imágenes y el video cambia de aspecto entre una
 * versión y la siguiente sin que nadie haya tocado el guion.
 */
const nombreDeImagen = (prompt: string, extension: string): string => {
  const base =
    prompt
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 44) || "imagen";
  return `${base}-${createHash("sha1").update(prompt).digest("hex").slice(0, 8)}.${extension}`;
};

/**
 * Dónde busca el sistema el logo de la empresa.
 *
 * Una ruta fija dentro del directorio de salida y no una opción de
 * configuración: el logo es un archivo de la empresa como cualquier otro, se
 * sube por la misma pestaña y quien lo cambia no necesita tocar un `.env`.
 */
const LOGO = "marca/logo.png";

/** JPEG y PNG se distinguen por sus primeros bytes, no por lo que diga nadie. */
const extensionDe = (bytes: Buffer): string =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : "png";

/**
 * Cómo el video consigue cada imagen que pide el guion.
 *
 * Un archivo del directorio se resuelve y listo. Una imagen descrita —`(generar)`—
 * se busca primero en disco por su nombre derivado del prompt y sólo se produce
 * si no está: así una segunda exportación no vuelve a pagarla.
 *
 * Las generadas quedan en `imagenes/` **dentro del directorio de salida**, no en
 * un temporal: alguien tiene que poder verlas, reemplazar la que no le gustó y
 * volver a exportar.
 */
export function crearResolutorImagenes(
  storage: SkillStorage,
  generador: GeneradorImagenes | null | undefined,
  carpeta: string,
  ctx: ToolContext,
): (imagen: ImagenGuion) => Promise<string | null> {
  const destino = [carpeta, "imagenes"].filter(Boolean).join("/");

  return async (imagen) => {
    if (!imagen.generar) return storage.resolve(imagen.src);

    const prompt = imagen.alt.trim();
    if (!prompt) {
      throw new Error(
        "una imagen con (generar) necesita entre corchetes la descripción de lo que se ve",
      );
    }

    for (const extension of ["png", "jpg"]) {
      const ruta = await storage.resolve(`${destino}/${nombreDeImagen(prompt, extension)}`);
      if (ruta) return ruta;
    }

    if (!generador) {
      throw new Error(
        "no hay ningún proveedor de imágenes configurado. Poné la ruta de un archivo " +
          "del directorio de salida en vez de (generar), o pedile a quien opera la " +
          "empresa que configure una API key de imágenes",
      );
    }

    const bytes = await generador.generar({
      prompt,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const guardado = await storage.save({
      filename: nombreDeImagen(prompt, extensionDe(bytes)),
      folder: destino,
      bytes,
    });
    return storage.resolve(guardado.path);
  };
}

function crearVideo(storage: SkillStorage, opciones: OpcionesHabilidades): RegisteredTool {
  return {
    name: "export_video",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Convierte un guion ya escrito en un video MP4 narrado con voz. Primero guardá el " +
      "guion con write_artifact y después pasá su clave acá. Lo que va bajo esa clave es " +
      "el guion mismo —lo que se va a decir y ver—, nunca un informe sobre el video ni " +
      "una lista de requisitos cumplidos: eso se filma tal cual y sale un video leyendo " +
      "una checklist en voz alta. Un guion se ve así:\n" +
      "```\n" +
      "# Título del video\n\n" +
      "## Lo que hacemos\n" +
      "Esto lo dice la voz en off, en una o dos frases.\n" +
      "- Aparece escrito en pantalla\n" +
      "- Corto, menos de siete palabras\n\n" +
      "## :grafico: Lo que medimos\n" +
      "![Un taller eléctrico al amanecer, con la luz entrando de costado](generar)\n" +
      "- :chequeo: Ya está resuelto\n" +
      "- :reloj: Entrega en 48 horas\n\n" +
      "## Una conversación\n" +
      "**Cliente:** Lo que pregunta el cliente.\n" +
      "**Asesora:** Lo que le responde.\n\n" +
      "## Cierre\n" +
      "> Una frase que se muestra grande.\n" +
      "```\n" +
      "El `#` arma la portada; cada `##` abre una escena y su texto es la placa que se ve; " +
      "los párrafos son la voz en off; las viñetas aparecen mientras se habla; `>` se " +
      "muestra destacado. En el diálogo, **cada personaje recibe una voz distinta** y su " +
      "línea aparece en pantalla cuando le toca hablar. Calculá unas 15 palabras habladas " +
      "por cada 6 segundos de video.\n" +
      "**Imágenes:** `![lo que se ve](generar)` describe una imagen y el sistema la produce; " +
      "`![epígrafe](marketing/foto.jpg)` muestra un archivo que ya está en el directorio de " +
      "salida. Va una por escena —dos o tres si la escena es larga—; en la portada ocupa " +
      "todo el cuadro y en el resto, la mitad derecha. La descripción tiene que ser una " +
      "escena concreta, no un concepto: \"un tablero eléctrico abierto con las manos de un " +
      "técnico\" da una foto, \"eficiencia\" no.\n" +
      `**Íconos:** poné \`:nombre:\` al empezar una viñeta o un \`##\` para que aparezca ` +
      `el ícono. Los que hay: ${ICONOS_DISPONIBLES.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: {
        artifact_key: {
          type: "string",
          description: "Clave del guion a filmar, tal como la usaste en write_artifact",
        },
        folder: {
          type: "string",
          description:
            'Carpeta del directorio de salida donde dejarlo, por ejemplo "marketing/videos". ' +
            "Se crea sola si no existe.",
        },
        musica: {
          type: "string",
          description:
            'Clima o nombre de la pista de fondo, por ejemplo "corporativo" o "calmo". ' +
            'Sin esto se elige una neutra; poné "ninguna" para filmar en silencio.',
        },
      },
      required: ["artifact_key"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const entregable = await buscarEntregable(args, ctx);
      if ("error" in entregable) return entregable.error;
      const { artifact } = entregable;

      const bloqueo = revisarCifras(artifact, ctx);
      if (bloqueo) return bloqueo;

      const carpeta = String(args.folder ?? "").trim();
      // El logo vive en el directorio de la empresa, como cualquier otro
      // archivo suyo. Sin configuración: si está, firma la pieza; si no, no.
      const logo = await storage.resolve(LOGO);

      let resultado;
      try {
        resultado = await renderVideo(
          artifact.content,
          {
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
          },
          {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            // Cómo suena la marca lo decide la empresa, no el guion ni el
            // agente: el nombre se pronuncia igual en todos sus videos.
            unaSolaVoz: ctx.workspace.company.voz.unaSolaVoz,
            ...(logo ? { logo } : {}),
            lexico: ctx.workspace.company.voz.pronunciacion,
            ...(opciones.musicaHome !== undefined ? { musicaHome: opciones.musicaHome } : {}),
            ...(args.musica !== undefined ? { musica: String(args.musica) } : {}),
            resolverImagen: crearResolutorImagenes(
              storage,
              opciones.generadorImagenes,
              carpeta,
              ctx,
            ),
          },
        );
      } catch (error) {
        // Filmar depende de programas del sistema: si falta ffmpeg o no hay
        // voz, el agente tiene que enterarse de eso y no de un stack trace.
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(
          `No se pudo filmar "${artifact.key}": ${detalle.split("\n")[0]}. ` +
            `Si el guion no tiene escenas, revisá que tenga títulos con "##". Si falta ` +
            `ffmpeg en el sistema, avisale a quien opera la empresa: no es algo que puedas ` +
            `resolver vos.`,
        );
      }

      const guardado = await storage.save({
        filename: `${artifact.key}.mp4`,
        ...(carpeta ? { folder: carpeta } : {}),
        bytes: resultado.bytes,
      });

      const reparto =
        resultado.personajes.length > 0
          ? ` Habla ${resultado.personajes.join(", ")}, cada uno con su voz.`
          : "";
      const visual = resultado.imagenes > 0 ? ` ${resultado.imagenes} imágenes en pantalla.` : "";
      const cama = resultado.musica ? ` Música de fondo: ${resultado.musica}.` : "";
      // Los avisos van en el mismo resultado y no en un log: lo único que el
      // agente puede leer para corregir el guion es lo que devuelve la
      // herramienta, y una imagen que no apareció es exactamente eso.
      const problemas =
        resultado.avisos.length > 0 ? ` Atención: ${resultado.avisos.join(" ")}` : "";
      return ok(
        `Video generado en ${guardado.path}: "${artifact.title}", ` +
          `${resultado.escenas} escenas, ${Math.round(resultado.segundos)} segundos, ` +
          `${Math.max(1, Math.round(guardado.sizeBytes / 1024))} KB.${reparto}${visual}${cama} ` +
          `Queda en el directorio de salida y se puede mirar desde la pestaña Salida.` +
          problemas,
        guardado.path,
      );
    },
  };
}

/**
 * Producir una imagen suelta, fuera de un video.
 *
 * Es la misma capacidad que usa `export_video` por dentro, expuesta aparte
 * porque una imagen sirve para más que una escena: la portada de un informe, el
 * adjunto de un correo, una pieza para redes. Se registra sólo si hay proveedor:
 * ofrecerle al agente una herramienta que siempre falla le hace gastar turnos
 * intentándola.
 */
function crearImagen(storage: SkillStorage, generador: GeneradorImagenes): RegisteredTool {
  return {
    name: "generar_imagen",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Produce una imagen a partir de una descripción y la deja en el directorio de " +
      "salida. Describí una escena concreta y visible —qué se ve, con qué luz, desde " +
      "dónde—, no un concepto: \"dos técnicas revisando un tablero eléctrico, luz de " +
      "mañana entrando por una ventana lateral\" da una foto; \"innovación\" no. El " +
      "estilo y la paleta los pone el sistema, y la imagen sale sin texto adentro: si " +
      "necesitás una palabra en pantalla, va en el documento o en el guion del video.",
    inputSchema: {
      type: "object",
      properties: {
        descripcion: { type: "string", description: "Lo que se tiene que ver en la imagen" },
        folder: {
          type: "string",
          description: 'Carpeta del directorio de salida, por ejemplo "marketing/imagenes".',
        },
        orientacion: {
          type: "string",
          enum: ["apaisada", "vertical"],
          description: "Apaisada por defecto, que es lo que entra en un video o una portada.",
        },
      },
      required: ["descripcion"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const descripcion = String(args.descripcion ?? "").trim();
      if (!descripcion) {
        return fail("Falta la descripción: es lo que se tiene que ver en la imagen.");
      }

      const vertical = String(args.orientacion ?? "") === "vertical";
      let bytes: Buffer;
      try {
        bytes = await generador.generar({
          prompt: descripcion,
          ancho: vertical ? 1024 : 1344,
          alto: vertical ? 1344 : 768,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(`No se pudo generar la imagen: ${detalle.split("\n")[0]}`);
      }

      const carpeta = String(args.folder ?? "").trim() || "imagenes";
      const guardado = await storage.save({
        filename: nombreDeImagen(descripcion, extensionDe(bytes)),
        folder: carpeta,
        bytes,
      });
      return ok(
        `Imagen generada en ${guardado.path} ` +
          `(${Math.max(1, Math.round(guardado.sizeBytes / 1024))} KB, ${generador.modelo}). ` +
          `Para usarla en un video, referenciala en el guion como ` +
          `![lo que se ve](${guardado.path}).`,
        guardado.path,
      );
    },
  };
}

/**
 * El mismo guion, como presentación.
 *
 * Comparte con el video la clave del entregable y el resolutor de imágenes, y
 * por eso las dos salidas no pueden contradecirse. Lo que cambia es para qué
 * sirve cada una: el video se mira, el deck se cita, se saltea y se adjunta.
 */
function crearSlides(storage: SkillStorage, opciones: OpcionesHabilidades): RegisteredTool {
  return {
    name: "export_slides",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Convierte un guion ya escrito en una presentación HTML que se abre en cualquier " +
      "navegador y se imprime a PDF. Usa exactamente el mismo guion que export_video y la " +
      "misma clave: cada `##` es una lámina, las viñetas y sus `:iconos:` se ven igual, `>` " +
      "sale destacado, y los párrafos —que en el video son la voz en off— quedan como nota " +
      "al pie de cada lámina. Las imágenes viajan adentro del archivo, así que es un solo " +
      "archivo que se puede adjuntar. Sirve para lo que un video no puede: citar una frase, " +
      "saltar a una lámina o mandarle a alguien sólo la parte que le toca.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_key: {
          type: "string",
          description: "Clave del guion, la misma que le pasás a export_video",
        },
        folder: {
          type: "string",
          description: 'Carpeta del directorio de salida, por ejemplo "marketing/videos".',
        },
      },
      required: ["artifact_key"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const entregable = await buscarEntregable(args, ctx);
      if ("error" in entregable) return entregable.error;
      const { artifact } = entregable;

      const bloqueo = revisarCifras(artifact, ctx);
      if (bloqueo) return bloqueo;

      const carpeta = String(args.folder ?? "").trim();
      const logoSlides = await storage.resolve(LOGO);

      let resultado;
      try {
        resultado = await renderSlides(
          artifact.content,
          {
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
          },
          {
            resolverImagen: crearResolutorImagenes(
              storage,
              opciones.generadorImagenes,
              carpeta,
              ctx,
            ),
            ...(logoSlides ? { logo: logoSlides } : {}),
          },
        );
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(`No se pudo armar la presentación de "${artifact.key}": ${detalle.split("\n")[0]}`);
      }

      const guardado = await storage.save({
        filename: `${artifact.key}.html`,
        ...(carpeta ? { folder: carpeta } : {}),
        bytes: Buffer.from(resultado.html, "utf8"),
      });

      const problemas =
        resultado.avisos.length > 0 ? ` Atención: ${resultado.avisos.join(" ")}` : "";
      return ok(
        `Presentación generada en ${guardado.path}: ${resultado.laminas} láminas, ` +
          `${resultado.imagenes} imágenes incrustadas, ` +
          `${Math.max(1, Math.round(guardado.sizeBytes / 1024))} KB. ` +
          `Se abre en el navegador desde la pestaña Salida.` +
          problemas,
        guardado.path,
      );
    },
  };
}

/**
 * Filmar con láminas programadas.
 *
 * Es la misma escritura que `export_video` —el guion sigue siendo el entregable
 * y sigue mandando el reloj— con otro motor de dibujo: cada escena puede tener
 * su propia lámina HTML, escrita por un rol con capacidad de programar. La
 * escena que no tiene la suya sale con la plantilla del sistema, así que la
 * habilidad sirve desde la primera corrida y mejora a medida que se programan
 * láminas.
 */
function crearVideoEstudio(
  storage: SkillStorage,
  opciones: OpcionesHabilidades,
): RegisteredTool {
  return {
    name: "export_video_estudio",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Filma un guion ya escrito como video MP4 de calidad de estudio: cada escena se " +
      "compone como una lámina HTML —tipografía real, SVG, tarjetas, cifras, entradas " +
      "escalonadas— y se revela con el navegador. Se usa igual que export_video: primero " +
      "guardá el guion con write_artifact y después pasá su clave acá.\n" +
      `**Las láminas van en \`${CARPETA_ESCENAS}/\`, numeradas por escena** ` +
      "(`01-portada.html`, `02-lo-que-hacemos.html`, …): el número es lo que ata cada una " +
      "a su escena. Se escriben con write_output_file. La escena sin lámina propia se " +
      `maqueta con la plantilla del sistema. El kit de diseño y su guía quedan en ` +
      `\`${RUTA_GUIA}\` cada vez que se filma; leelo antes de programar, y probá cada ` +
      "lámina con revisar_lamina, que cuesta segundos, en vez de filmar el video entero.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_key: {
          type: "string",
          description: "Clave del guion a filmar, tal como la usaste en write_artifact",
        },
        folder: {
          type: "string",
          description:
            'Carpeta del directorio de salida donde dejarlo, por ejemplo "marketing". ' +
            "Se crea sola si no existe.",
        },
        musica: {
          type: "string",
          description:
            'Clima o nombre de la pista de fondo, por ejemplo "corporativo". Sin esto se ' +
            'elige una neutra; poné "ninguna" para filmar en silencio.',
        },
      },
      required: ["artifact_key"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const entregable = await buscarEntregable(args, ctx);
      if ("error" in entregable) return entregable.error;
      const { artifact } = entregable;

      const bloqueo = revisarCifras(artifact, ctx);
      if (bloqueo) return bloqueo;

      const carpeta = String(args.folder ?? "").trim();
      const laminas = (await storage.list())
        .map((archivo) => archivo.path)
        .filter((ruta) => ruta.startsWith(`${CARPETA_ESCENAS}/`))
        .sort();

      let resultado;
      try {
        resultado = await renderEstudio(
          artifact.content,
          {
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
          },
          {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            empresa: ctx.workspace.company.name,
            unaSolaVoz: ctx.workspace.company.voz.unaSolaVoz,
            lexico: ctx.workspace.company.voz.pronunciacion,
            ...(opciones.musicaHome !== undefined ? { musicaHome: opciones.musicaHome } : {}),
            ...(args.musica !== undefined ? { musica: String(args.musica) } : {}),
            laminas,
            resolver: (ruta) => storage.resolve(ruta),
            escribir: async (ruta, contenido) => {
              await storage.writeText(ruta, contenido);
            },
          },
        );
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(
          `No se pudo filmar "${artifact.key}" con el motor de estudio: ` +
            `${detalle.split("\n")[0]}. Si el guion no tiene escenas, revisá que tenga ` +
            `títulos con "##". Si el problema es el navegador o ffmpeg, avisale a quien ` +
            `opera la empresa: no es algo que puedas resolver vos. Mientras tanto, ` +
            `export_video filma el mismo guion sin navegador.`,
        );
      }

      const guardado = await storage.save({
        filename: `${artifact.key}.mp4`,
        ...(carpeta ? { folder: carpeta } : {}),
        bytes: resultado.bytes,
      });

      const propias =
        resultado.programadas > 0
          ? ` ${resultado.programadas} de ${resultado.escenas} escenas con lámina programada.`
          : ` Ninguna escena tenía lámina propia: salieron todas con la plantilla del sistema.`;
      const cama = resultado.musica ? ` Música de fondo: ${resultado.musica}.` : "";
      const problemas =
        resultado.avisos.length > 0 ? ` Atención: ${resultado.avisos.join(" ")}` : "";
      return ok(
        `Video de estudio generado en ${guardado.path}: "${artifact.title}", ` +
          `${resultado.escenas} escenas, ${Math.round(resultado.segundos)} segundos, ` +
          `${Math.max(1, Math.round(guardado.sizeBytes / 1024))} KB.${propias}${cama} ` +
          `Se mira desde la pestaña Salida.` +
          problemas,
        guardado.path,
      );
    },
  };
}

/**
 * Revelar **una** lámina y mirarla.
 *
 * Sin esto, la única forma de saber si una lámina quedó bien es filmar el video
 * entero: un minuto de render y una corrida gastada para descubrir que el
 * título se desbordaba. Es el bucle de trabajo de quien programa las láminas, y
 * por eso devuelve los errores de carga y los desbordes en vez de un "listo".
 */
function crearRevisarLamina(storage: SkillStorage): RegisteredTool {
  return {
    name: "revisar_lamina",
    origin: "skill",
    readOnly: false,
    requiresApproval: false,
    description:
      "Revela una sola lámina HTML a imagen y te devuelve qué salió mal: si se desborda " +
      "del cuadro de 1920×1080, si la hoja de estilo no cargó, si tiró un error. Usala " +
      "después de escribir cada lámina y antes de filmar el video: cuesta segundos. " +
      "La imagen queda en el directorio de salida para que una persona también la mire.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: `Ruta de la lámina, por ejemplo "${CARPETA_ESCENAS}/02-lo-que-hacemos.html"`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },

    async execute(args, ctx) {
      const ruta = String(args.path ?? "").trim();
      if (!ruta) return fail("Falta path: la ruta de la lámina que querés revisar.");

      // El kit se escribe también acá y no sólo al filmar: si no, el diseñador
      // tiene que pedirle a alguien que renderice un video entero antes de poder
      // leer la guía o de que su primera lámina encuentre la hoja de estilo.
      await storage.writeText(RUTA_TEMA, TEMA_CSS);
      await storage.writeText(RUTA_GUIA, GUIA_ESTUDIO);

      const absoluta = await storage.resolve(ruta);
      if (!absoluta) {
        return fail(
          `No existe "${ruta}" en el directorio de salida. Escribí la lámina con ` +
            `write_output_file y después revisala. El kit de diseño y su guía ` +
            `(${RUTA_GUIA}) ya quedaron escritos: leelos antes de programar.`,
        );
      }

      const temporal = await mkdtemp(join(tmpdir(), "orq-lamina-"));
      try {
        // Con el fondo de la marca y no transparente: la previsualización tiene
        // que mostrar lo que se va a filmar, no la lámina sobre el blanco del
        // visor, donde el texto claro desaparece y parece rota.
        const revelado = await abrirRevelado({
          fondo: PALETA.fondo,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        let captura;
        try {
          captura = await revelado.revelar(pathToFileURL(absoluta).href, temporal, "lamina");
        } finally {
          await revelado.cerrar();
        }

        // El último cuadro es la lámina ya acomodada, que es lo que se quiere
        // mirar: el primero es la entrada a mitad de camino.
        const ultimo = captura.cuadros.at(-1);
        if (!ultimo) return fail(`No se pudo revelar "${ruta}": no salió ningún cuadro.`);

        const nombre = (ruta.split("/").pop() ?? "lamina").replace(/\.html?$/i, "");
        const guardado = await storage.save({
          filename: `${nombre}.png`,
          folder: `${CARPETA_ESCENAS}/previsualizacion`,
          bytes: await readFile(ultimo),
        });

        const problemas =
          captura.avisos.length > 0
            ? ` Hay que corregir: ${captura.avisos.join(" ")}`
            : " Entra en el cuadro y no tiró ningún error.";
        return ok(
          `Lámina "${ruta}" revelada en ${guardado.path}: la entrada dura ` +
            `${captura.animacion.toFixed(1)} segundos.${problemas}`,
          guardado.path,
        );
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return fail(`No se pudo revelar "${ruta}": ${detalle.split("\n")[0]}`);
      } finally {
        await rm(temporal, { recursive: true, force: true });
      }
    },
  };
}

export function createSkillTools(
  storage: SkillStorage,
  opciones: OpcionesHabilidades = {},
): RegisteredTool[] {
  // Sin proveedor configurado, `crearGeneradorImagenes` devuelve `null` y no se
  // registra la herramienta: el resto de las habilidades funciona igual.
  const generador =
    opciones.generadorImagenes === undefined
      ? crearGeneradorImagenes()
      : opciones.generadorImagenes;

  // El motor de estudio necesita un navegador en la máquina. Si no está, no se
  // registra: ofrecerle al agente una herramienta que siempre falla le hace
  // gastar turnos intentándola, y `export_video` filma el mismo guion sin él.
  const hayNavegador = buscarChrome() !== null;

  return [
    ...(Object.keys(FORMATOS) as Formato[]).map((formato) => crearSkill(formato, storage)),
    crearVideo(storage, { ...opciones, generadorImagenes: generador }),
    ...(hayNavegador
      ? [crearVideoEstudio(storage, { ...opciones, generadorImagenes: generador }), crearRevisarLamina(storage)]
      : []),
    crearSlides(storage, { ...opciones, generadorImagenes: generador }),
    ...(generador ? [crearImagen(storage, generador)] : []),
    crearListado(storage),
    crearLectura(storage),
    crearInspeccion(storage),
    crearEscritura(storage),
    crearBorrado(storage),
  ];
}
