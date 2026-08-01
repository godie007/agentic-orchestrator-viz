/**
 * Correo saliente.
 *
 * El orquestador no habla SMTP: le pasa el mensaje a un flujo de n8n por
 * webhook y ese flujo decide con qué cuenta sale. Es deliberado. Un cliente ya
 * tiene su n8n con las credenciales puestas y sus reglas de envío; duplicar eso
 * acá significaría pedirle una contraseña de aplicación, guardarla y mantener un
 * cliente SMTP, para terminar mandando el mismo mail.
 *
 * El contrato del webhook usa nombres en inglés a propósito: son los campos que
 * el nodo Send Email de n8n espera, así el flujo del otro lado es un mapeo
 * directo y no una traducción.
 *
 *   POST <webhook>
 *   { to: ["x@y.com"], subject: "...", text: "...",
 *     attachments: [{ filename: "video.mp4", url: "https://..." }],
 *     source: "orquestador-agentico" }
 */

import { fail, ok, type RegisteredTool } from "./types.js";

export interface Adjunto {
  filename: string;
  /** Enlace de descarga. No se mandan bytes: el flujo los baja si los necesita. */
  url: string;
}

export interface Mensaje {
  to: string[];
  subject: string;
  text: string;
  attachments?: Adjunto[];
}

export type ResultadoEnvio = { ok: true } | { ok: false; motivo: string };

export interface Correo {
  /** `false` cuando no hay webhook configurado: quien llama avisa, no adivina. */
  configurado: boolean;
  enviar(mensaje: Mensaje): Promise<ResultadoEnvio>;
}

export interface OpcionesCorreo {
  webhookUrl: string | null;
  /** Corta el envío si la corrida se detiene. */
  timeoutMs?: number;
}

export function crearCorreo(opciones: OpcionesCorreo): Correo {
  const { webhookUrl } = opciones;
  const timeoutMs = opciones.timeoutMs ?? 15_000;

  return {
    configurado: webhookUrl != null,

    async enviar(mensaje) {
      if (!webhookUrl) {
        return {
          ok: false,
          motivo:
            "No hay salida de correo configurada: falta N8N_EMAIL_WEBHOOK_URL en el .env del " +
            "servidor. Es algo que resuelve quien opera la empresa, no un agente.",
        };
      }
      if (mensaje.to.length === 0) {
        return { ok: false, motivo: "Falta el destinatario." };
      }

      try {
        const respuesta = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...mensaje, source: "orquestador-agentico" }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!respuesta.ok) {
          const detalle = (await respuesta.text().catch(() => "")).slice(0, 200);
          return {
            ok: false,
            motivo: `El flujo de correo respondió ${respuesta.status}${detalle ? `: ${detalle}` : ""}.`,
          };
        }
        return { ok: true };
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);
        return { ok: false, motivo: `No se pudo llegar al flujo de correo: ${detalle}.` };
      }
    },
  };
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Mandar un correo es una capacidad del rol, como buscar en la web: una acción
 * hacia afuera, no un entregable que se produce. Por eso `origin: "capability"`
 * y no `"skill"`.
 *
 * `urlDeSalida` la inyecta el servidor, que es el único que sabe en qué
 * dirección se sirve el directorio de salida de cada empresa. **Ojo**: esa
 * dirección apunta al servidor local, así que el enlace se abre desde la misma
 * máquina o red donde corre el orquestador, no desde cualquier lado.
 */
export function createEmailTools(
  correo: Correo,
  urlDeSalida: (ruta: string) => string,
): RegisteredTool[] {
  return [
    {
      name: "send_email",
      origin: "capability",
      readOnly: false,
      requiresApproval: false,
      description:
        "Manda un correo. Usalo para avisarle a una persona de afuera de la empresa —un " +
        "cliente, alguien que tiene que revisar algo— cuando el trabajo ya está hecho. Para " +
        "hablar con otro agente usá send_message, no esto. Si querés que revisen un archivo " +
        "que produjo la empresa, pasá su ruta del directorio de salida en `adjuntos` y el " +
        "correo va a llevar el enlace para abrirlo.",
      inputSchema: {
        type: "object",
        properties: {
          para: {
            type: "array",
            items: { type: "string" },
            description: "Direcciones de destino.",
          },
          asunto: { type: "string", description: "Asunto, en una línea." },
          cuerpo: {
            type: "string",
            description:
              "El mensaje en texto plano. Escribí para alguien que no vio la corrida: qué se " +
              "hizo, qué tiene que decidir y qué pasa si no contesta.",
          },
          adjuntos: {
            type: "array",
            items: { type: "string" },
            description:
              'Rutas de archivos del directorio de salida, por ejemplo "marketing/videos/x.mp4". ' +
              "Viajan como enlace, no como archivo pegado.",
          },
        },
        required: ["para", "asunto", "cuerpo"],
        additionalProperties: false,
      },

      async execute(args) {
        const para = Array.isArray(args.para) ? args.para.map(String).map((x) => x.trim()) : [];
        const validas = para.filter((direccion) => CORREO.test(direccion));
        const invalidas = para.filter((direccion) => !CORREO.test(direccion));
        if (validas.length === 0) {
          return fail(
            invalidas.length > 0
              ? `Ninguna dirección es válida: ${invalidas.join(", ")}.`
              : "Falta para: al menos una dirección de correo.",
          );
        }

        const asunto = String(args.asunto ?? "").trim();
        const cuerpo = String(args.cuerpo ?? "").trim();
        if (!asunto) return fail("Falta asunto.");
        if (!cuerpo) return fail("Falta cuerpo: un correo vacío no le sirve a nadie.");

        const rutas = Array.isArray(args.adjuntos) ? args.adjuntos.map(String) : [];
        const attachments = rutas.map((ruta) => ({
          filename: ruta.split("/").at(-1) ?? ruta,
          url: urlDeSalida(ruta),
        }));

        const resultado = await correo.enviar({
          to: validas,
          subject: asunto,
          text: cuerpo,
          ...(attachments.length > 0 ? { attachments } : {}),
        });

        if (!resultado.ok) return fail(resultado.motivo);

        const conAdjuntos = attachments.length > 0 ? ` con ${attachments.length} enlace(s)` : "";
        const omitidas = invalidas.length > 0 ? ` No se mandó a ${invalidas.join(", ")}.` : "";
        return ok(`Correo enviado a ${validas.join(", ")}${conAdjuntos}.${omitidas}`);
      },
    },
  ];
}
