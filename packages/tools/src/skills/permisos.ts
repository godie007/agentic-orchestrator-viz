import type { AuthorityLevel } from "@orq/shared";

/**
 * Quién puede borrar qué.
 *
 * Borrar es la única acción del directorio de salida que no se puede deshacer,
 * así que es la única que mira la jerarquía. Crear y modificar quedan abiertos:
 * un ejecutor tiene que poder producir su trabajo sin pedir permiso.
 *
 * La escala sigue el riesgo de lo que se pierde, no la antigüedad del rol:
 *
 * - **executive** — todo lo que la procedencia permita, entregables incluidos.
 *   Es quien responde por el trabajo de la empresa.
 * - **manager** — archivos de apoyo: multimedia y documentos auxiliares
 *   (notas, csv). No toca un Word ni un PDF: son el entregable.
 * - **executor** — no borra. Produce y corrige, y si algo sobra lo escala.
 *
 * Es deliberado que un `executor` no pueda: es el rol que más turnos gasta y el
 * que más fácil interpreta de más una instrucción de limpieza.
 */

/** Extensiones que son el entregable en sí, no material de apoyo. */
const FORMATOS_ENTREGABLE = new Set(["docx", "pdf", "pptx", "xlsx"]);

export interface ArchivoParaBorrar {
  path: string;
  esMultimedia: boolean;
}

export interface VeredictoBorrado {
  permitido: boolean;
  /** Por qué no, en términos que el agente pueda reenviar a quien sí puede. */
  motivo?: string;
  /** Autoridad mínima que sí podría hacerlo, para que sepa a quién escalar. */
  requiere?: AuthorityLevel;
}

const esEntregable = (path: string): boolean => {
  const nombre = path.split("/").at(-1) ?? "";
  const punto = nombre.lastIndexOf(".");
  return punto >= 0 && FORMATOS_ENTREGABLE.has(nombre.slice(punto + 1).toLowerCase());
};

export function puedeBorrar(
  authority: AuthorityLevel,
  archivo: ArchivoParaBorrar,
): VeredictoBorrado {
  if (authority === "executive") return { permitido: true };

  if (authority === "executor") {
    return {
      permitido: false,
      motivo:
        `No podés borrar archivos: tu rol ejecuta y produce, no da de baja trabajo. ` +
        `Pedíselo a quien dirige tu área con send_message o escalate.`,
      requiere: "manager",
    };
  }

  // manager: apoyo sí, entregable no.
  if (!archivo.esMultimedia && esEntregable(archivo.path)) {
    return {
      permitido: false,
      motivo:
        `"${archivo.path}" es un entregable de la empresa. Solo un rol ejecutivo puede ` +
        `darlo de baja; escalá el pedido en vez de borrarlo.`,
      requiere: "executive",
    };
  }
  return { permitido: true };
}
