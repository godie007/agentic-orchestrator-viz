import type { RegisteredTool } from "./types.js";

/**
 * El árbol de contexto de la empresa, escrito como un vault de Obsidian.
 *
 * Es la mitad "larga" de la memoria. La corta —una lección de un párrafo— viaja
 * en el prompt de cada turno porque mandarla sale más barato que ir a buscarla:
 * medido acá, una llamada a herramienta dentro de un turno delegado cuesta una
 * iteración entera, o sea 20.000 a 28.000 tokens de prefijo reenviado. Por
 * encima de unos 800 caracteres la cuenta se da vuelta y conviene apuntar en vez
 * de mandar. Esto es para eso: dossiers, mapas de pantalla, decisiones con su
 * porqué, todo lo que se consulta cuando hace falta y no en cada vuelta.
 *
 * El **mapa** del árbol viaja solo en el prompt, así que un agente sabe qué hay
 * sin gastar una llamada en averiguarlo. Estas herramientas son para abrir una
 * nota concreta, buscar en el árbol y escribir lo que se aprendió.
 *
 * `packages/tools` no decide dónde vive el vault: lo inyecta el servidor, igual
 * que con las habilidades. Acá sólo se define qué se puede hacer con él.
 */

export interface ContextoStorage {
  escribir(
    ruta: string,
    contenido: string,
  ): Promise<{ ok: true; ruta: string; caracteres: number } | { ok: false; motivo: string }>;
  leer(ruta: string): Promise<string | null>;
  buscar(texto: string): Promise<Array<{ ruta: string; linea: string }>>;
  mapa(): Promise<Array<{ ruta: string; titulo: string; caracteres: number }>>;
}

const ok = (content: string): { ok: true; content: string } => ({ ok: true, content });
const fail = (content: string): { ok: false; content: string } => ({ ok: false, content });

export function crearHerramientasDeContexto(storage: ContextoStorage): RegisteredTool[] {
  return [
    {
      name: "leer_contexto",
      origin: "coordination",
      readOnly: true,
      requiresApproval: false,
      description:
        "Abre una nota del árbol de contexto de la empresa. El mapa del árbol ya lo tenés en " +
        "tu prompt, con la ruta de cada nota: usá esto para abrir la que necesitás en vez de " +
        "adivinar o volver a averiguar algo que la empresa ya sabe.",
      inputSchema: {
        type: "object",
        properties: {
          ruta: { type: "string", description: 'Ruta de la nota, como "rodaje/pantallas-nc.md"' },
        },
        required: ["ruta"],
        additionalProperties: false,
      },
      async execute(args) {
        const ruta = String(args.ruta ?? "").trim();
        const contenido = await storage.leer(ruta);
        if (contenido == null) {
          return fail(
            `No existe la nota "${ruta}" en el árbol de contexto. Mirá el mapa que tenés en el ` +
              `prompt para ver las rutas reales, o buscá con buscar_contexto.`,
          );
        }
        return ok(`📗 ${ruta}\n\n${contenido}`);
      },
    },

    {
      name: "buscar_contexto",
      origin: "coordination",
      readOnly: true,
      requiresApproval: false,
      description:
        "Busca un texto en el árbol de contexto y devuelve en qué notas aparece, con la línea " +
        "donde apareció. Devuelve dónde mirar, no el contenido: abrí con leer_contexto la que " +
        "sirva.",
      inputSchema: {
        type: "object",
        properties: { texto: { type: "string", description: "Qué buscar." } },
        required: ["texto"],
        additionalProperties: false,
      },
      async execute(args) {
        const texto = String(args.texto ?? "").trim();
        const hallazgos = await storage.buscar(texto);
        if (hallazgos.length === 0) {
          return ok(
            `No hay ninguna nota que mencione "${texto}". Si lo averiguás en este turno, ` +
              `guardalo con escribir_contexto para que la próxima corrida no lo vuelva a buscar.`,
          );
        }
        return ok(
          `${hallazgos.length} nota(s) mencionan "${texto}":\n` +
            hallazgos.map((h) => `- ${h.ruta} → ${h.linea}`).join("\n"),
        );
      },
    },

    {
      name: "escribir_contexto",
      origin: "coordination",
      readOnly: false,
      requiresApproval: false,
      description:
        "Guarda en el árbol de contexto algo que la empresa aprendió y va a necesitar de nuevo: " +
        "un dossier, el mapa de una pantalla, una decisión con su porqué. Es markdown y vive en " +
        "un vault de Obsidian, así que podés enlazar otras notas con [[nombre]]. Guardá acá lo " +
        "LARGO; lo que entra en un párrafo va con record_lesson, que viaja en el prompt de todos. " +
        "Reemplaza la nota entera si ya existía.",
      inputSchema: {
        type: "object",
        properties: {
          ruta: {
            type: "string",
            description: 'Ruta con carpeta y nombre, como "rodaje/pantallas-nc.md"',
          },
          contenido: {
            type: "string",
            description: "El markdown completo de la nota, empezando por un título con #.",
          },
        },
        required: ["ruta", "contenido"],
        additionalProperties: false,
      },
      async execute(args) {
        const ruta = String(args.ruta ?? "").trim();
        const contenido = String(args.contenido ?? "");
        if (contenido.trim().length < 40) {
          return fail(
            "escribir_contexto: la nota está prácticamente vacía. Si es una sola línea, no es " +
              "una nota: usá record_lesson, que la pone en el prompt de todos los agentes.",
          );
        }
        const guardada = await storage.escribir(ruta, contenido);
        if (!guardada.ok) return fail(`escribir_contexto: ${guardada.motivo}`);
        return ok(
          `Nota guardada en ${guardada.ruta} (${guardada.caracteres} caracteres). Aparece en el ` +
            `mapa de contexto del próximo turno de todos, así que no hace falta que se la mandes ` +
            `a nadie por mensaje.`,
        );
      },
    },
  ];
}

/**
 * El mapa del árbol, tal como se pega en el prompt del sistema.
 *
 * Va el título y el tamaño de cada nota, nunca el contenido: el mapa se reenvía
 * en cada vuelta del turno y el contenido no tiene por qué. Con esto, un agente
 * sabe qué sabe la empresa y qué le falta averiguar sin gastar una llamada.
 */
export function mapaDeContextoEnPrompt(
  notas: Array<{ ruta: string; titulo: string; caracteres: number }>,
): string {
  if (notas.length === 0) return "";
  const lineas = notas.map((n) => `- \`${n.ruta}\` — ${n.titulo} (${n.caracteres} car.)`);
  return [
    "## Lo que la empresa tiene documentado",
    "Este es el mapa del árbol de contexto, no su contenido. Abrí con `leer_contexto` sólo lo",
    "que necesites para este turno, y guardá con `escribir_contexto` lo que averigües y sirva",
    "después. Lo que ya está acá no hace falta volver a averiguarlo.",
    "",
    ...lineas,
  ].join("\n");
}
