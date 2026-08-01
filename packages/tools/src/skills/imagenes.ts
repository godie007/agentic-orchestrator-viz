/**
 * Imágenes generadas por modelo.
 *
 * Un video de empresa necesita imágenes, y esperar a que alguien las prepare
 * antes de cada corrida convierte una habilidad automática en un trámite. Acá
 * el guion describe lo que quiere ver —`![un taller eléctrico al amanecer](generar)`—
 * y esto lo produce.
 *
 * Mismo criterio que `packages/llm`: una interfaz y adaptadores. Se elige el
 * primer proveedor con credencial, en orden de calidad por peso: Gemini (la
 * imagen sale en la misma familia que ya se usa para texto y cuesta centavos),
 * OpenAI, y NVIDIA al final porque su nivel gratuito es el que permite que esto
 * funcione en una máquina sin tarjeta. Sin ninguna key, no hay generador y el
 * video se filma igual, sin las imágenes que había que inventar: eso se avisa,
 * no se falla.
 *
 * **El estilo lo fija el sistema, no el guion.** Se le agrega al prompt una
 * indicación de paleta y de encuadre para que doce imágenes de un mismo video se
 * parezcan entre sí, y sobre todo **se le prohíbe el texto**: los modelos de
 * imagen escriben palabras deformes, y una placa con un cartel ilegible de
 * fondo es peor que la placa sola.
 */

export interface PedidoImagen {
  /** Lo que se quiere ver, en castellano o en inglés: da igual. */
  prompt: string;
  ancho?: number;
  alto?: number;
  signal?: AbortSignal;
}

export interface GeneradorImagenes {
  /** Cómo se llama el proveedor, para poder decirlo en el resultado. */
  proveedor: string;
  modelo: string;
  /** Los bytes de un PNG o JPEG. Quién lo guarda lo decide quien llama. */
  generar(pedido: PedidoImagen): Promise<Buffer>;
}

/**
 * El estilo de la casa.
 *
 * Sobrio y fotográfico, sin la estética de banco de imágenes con gente
 * sonriendo a cámara. Va en inglés porque es donde estos modelos entienden
 * mejor los términos de fotografía, aunque el prompt del guion venga en
 * castellano — mezclarlos funciona bien y ahorra una traducción.
 */
const ESTILO =
  "Cinematic editorial photography, soft directional lighting, shallow depth of field, " +
  "muted palette of deep graphite blue and warm neutrals, calm professional mood, " +
  "wide composition with empty space on one side. " +
  "Absolutely no text, no words, no letters, no logos, no watermarks, no UI overlays.";

const componer = (prompt: string): string => `${prompt.trim()}. ${ESTILO}`;

/**
 * Ninguna imagen justifica dejar una corrida colgada.
 *
 * Un endpoint que acepta la conexión y no contesta nunca —lo medimos con el de
 * NVIDIA— deja el turno esperando para siempre: el agente no falla, no sigue y
 * no se le puede decir que cambie de enfoque. Con un corte, la habilidad
 * devuelve un error que el agente puede leer y el video sale sin esa imagen.
 */
const CORTE_MS = 90_000;

/** Combina el corte por tiempo con la señal de "se detuvo la corrida". */
function conCorte(signal?: AbortSignal): AbortSignal {
  const reloj = AbortSignal.timeout(CORTE_MS);
  return signal ? AbortSignal.any([signal, reloj]) : reloj;
}

/** El cuerpo del error del proveedor, recortado: un HTML entero no ayuda. */
async function detalleDelError(respuesta: Response): Promise<string> {
  const cuerpo = await respuesta.text().catch(() => "");
  return `${respuesta.status} ${respuesta.statusText}${cuerpo ? ` — ${cuerpo.slice(0, 300)}` : ""}`;
}

/** Google Gemini: la imagen vuelve como `inlineData` dentro de la respuesta. */
function gemini(apiKey: string): GeneradorImagenes {
  const modelo = "gemini-2.5-flash-image";
  return {
    proveedor: "google",
    modelo,
    async generar({ prompt, signal }) {
      const respuesta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: componer(prompt) }] }] }),
          signal: conCorte(signal),
        },
      );
      if (!respuesta.ok) throw new Error(`Gemini rechazó la imagen: ${await detalleDelError(respuesta)}`);

      const datos = (await respuesta.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
      };
      const base64 = datos.candidates?.[0]?.content?.parts?.find((parte) => parte.inlineData)
        ?.inlineData?.data;
      // Un modelo de imagen que contesta sólo texto casi siempre está diciendo
      // que no quiso hacer el pedido; el prompt es lo único que se puede tocar.
      if (!base64) throw new Error("Gemini contestó sin imagen. Probá describir la escena de otra manera.");
      return Buffer.from(base64, "base64");
    },
  };
}

/** OpenAI: `gpt-image-1` devuelve el PNG en base64. */
function openai(apiKey: string): GeneradorImagenes {
  const modelo = "gpt-image-1";
  return {
    proveedor: "openai",
    modelo,
    async generar({ prompt, ancho, alto, signal }) {
      // Sólo acepta tamaños de su catálogo: se elige el que respeta la
      // orientación pedida en vez de mandar un ancho arbitrario que rebota.
      const size = (ancho ?? 1536) >= (alto ?? 1024) ? "1536x1024" : "1024x1536";
      const respuesta = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelo, prompt: componer(prompt), size, n: 1 }),
        signal: conCorte(signal),
      });
      if (!respuesta.ok) throw new Error(`OpenAI rechazó la imagen: ${await detalleDelError(respuesta)}`);

      const datos = (await respuesta.json()) as { data?: Array<{ b64_json?: string }> };
      const base64 = datos.data?.[0]?.b64_json;
      if (!base64) throw new Error("OpenAI contestó sin imagen.");
      return Buffer.from(base64, "base64");
    },
  };
}

/** NVIDIA (build.nvidia.com): FLUX, con límites de tasa pero sin costo. */
function nvidia(apiKey: string): GeneradorImagenes {
  const modelo = "black-forest-labs/flux.1-schnell";
  return {
    proveedor: "nvidia",
    modelo,
    async generar({ prompt, ancho, alto, signal }) {
      const respuesta = await fetch(`https://ai.api.nvidia.com/v1/genai/${modelo}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt: componer(prompt),
          // Múltiplos de 64: con otro valor el servicio contesta 400.
          width: Math.round((ancho ?? 1344) / 64) * 64,
          height: Math.round((alto ?? 768) / 64) * 64,
          steps: 4,
          cfg_scale: 0,
          mode: "base",
        }),
        signal: conCorte(signal),
      });
      if (!respuesta.ok) throw new Error(`NVIDIA rechazó la imagen: ${await detalleDelError(respuesta)}`);

      const datos = (await respuesta.json()) as {
        artifacts?: Array<{ base64?: string }>;
        image?: string;
      };
      const base64 = datos.artifacts?.[0]?.base64 ?? datos.image;
      if (!base64) throw new Error("NVIDIA contestó sin imagen.");
      return Buffer.from(base64, "base64");
    },
  };
}

/**
 * El generador que corresponde a las credenciales que hay, o `null`.
 *
 * `null` no es un error: es una empresa que todavía no configuró un proveedor de
 * imágenes, y todo lo demás sigue funcionando.
 */
export function crearGeneradorImagenes(
  env: NodeJS.ProcessEnv = process.env,
): GeneradorImagenes | null {
  const google = (env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY)?.trim();
  if (google) return gemini(google);

  const abierta = env.OPENAI_API_KEY?.trim();
  if (abierta) return openai(abierta);

  const verde = env.NVIDIA_API_KEY?.trim();
  if (verde) return nvidia(verde);

  return null;
}
