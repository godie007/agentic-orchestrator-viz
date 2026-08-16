/**
 * INSPIA — Publicidad: la empresa que filma la pieza comercial del producto.
 *
 * No es el equipo de lanzamiento (`db:inspia`, que escribe un spot de 60 s con
 * el motor de placas): acá se filma **la aplicación real** en staging, un clip
 * por escena, y se empalma con narración y música. Por eso el equipo tiene dos
 * roles que en una agencia normal no existirían: alguien que **reconoce la
 * aplicación antes de filmarla** —qué texto aparece, cuándo termina de cargar,
 * dónde está cada cosa— y alguien que **mira los cuadros** del video antes de
 * darlo por bueno. Los dos salen de la misma lección: medir no es mirar, y un
 * clip que "no reportó errores" puede estar filmando un spinner.
 *
 * ## El orden de los roles no es jerarquía, es dependencia
 *
 * Investigación → guion → rodaje → control de calidad, y una supervisora que
 * cruza todo. La investigación va primero y el guion espera: una pieza escrita
 * de memoria repite el sitio y lo dice peor. El rodaje espera al guion porque
 * un clip sin escena que lo pida es metraje que nadie va a usar.
 *
 * ## Por qué hay una supervisora
 *
 * Una producción de doce clips no entra en una corrida. La supervisora existe
 * para que la segunda corrida no vuelva a empezar: mira `estado_del_proceso`,
 * encuentra lo que quedó trabado —tareas heredadas incluidas—, lo reasigna y
 * lo destraba. Sin ese rol, "continuar donde iba" depende de que alguien se
 * acuerde de leer los entregables viejos.
 *
 * ## Idioma
 *
 * INSPIA es colombiana y le habla a organismos de inspección colombianos: lo
 * que sale —guion, texto en pantalla y voz— es **castellano de Colombia**, de
 * usted, sin voseo rioplatense. Las instrucciones van en inglés porque son
 * especificación larga y el modelo las sigue con más precisión así; cada una
 * abre declarando el idioma de salida, o la respuesta se arrastra al inglés.
 *
 *   npm run db:inspia-publicidad
 */

import { ids } from "@orq/shared";
import type {
  Company,
  Department,
  Learning,
  McpServer,
  ModelSelection,
  Policy,
  Role,
  Tool,
} from "@orq/shared";
import { ToolRegistry, createSkillTools } from "@orq/tools";
import { Store } from "../apps/server/src/db.js";
import { loadEnv } from "../apps/server/src/env.js";

const env = loadEnv();
const store = new Store(env.databaseUrl);
const now = Date.now();

const STAGING = "https://inspia-staging.codla.co";

/**
 * Modelo de cada rol.
 *
 * `claude-code` es el proveedor prendido en esta máquina y el único probado
 * para este circuito: la corrida que produjo el tutorial de Dictámenes corrió
 * con él. El tier no se fija a mano: se declara un **rango** y el motor elige
 * por turno según la dificultad medida (bandeja, tareas, contexto, fallos), así
 * un turno de trámite no paga el modelo del turno difícil.
 */
const model = (tierMinimo: ModelSelection["tier"], tierMaximo: ModelSelection["tier"]): ModelSelection => ({
  providerId: "claude-code",
  modelSlug: null,
  tier: tierMinimo,
  escalado: { activo: true, tierMinimo, tierMaximo },
  temperature: null,
  maxOutputTokens: 8192,
});

// --- Empresa -----------------------------------------------------------------

const company: Company = {
  id: ids.company(),
  name: "INSPIA — Publicidad",
  mission:
    "Mostrar INSPIA funcionando: una pieza comercial de 2 a 3 minutos, filmada sobre la " +
    "aplicación real, que le explique a un organismo de inspección eléctrica por qué le " +
    "conviene dejar el papel.",
  voz: {
    // Institucional: habla la marca, no un elenco. Varias voces en una pieza
    // comercial suenan a reparto de actores.
    unaSolaVoz: true,
    pronunciacion: {
      INSPIA: "inspia",
      RETIE: "retie",
      RETILAP: "retilap",
      SICERCO: "sicerco",
      EPP: "e pe pe",
      PDF: "pe de efe",
      IA: "i a",
      NC: "ene ce",
      kV: "kilovoltios",
    },
  },
  context: `INSPIA es la plataforma de los organismos de inspección eléctrica en Colombia.
Reemplaza el papel y el Excel del ciclo completo de una inspección: asignación,
planificación, inspección en campo, no conformidades, cierre y dictamen oficial.

QUÉ HACE, en concreto (esto es lo que se puede mostrar y decir):
- Proyectos de inspección con su ciclo de vida y su equipo asignado.
- Listas de verificación parametrizables por tipo de instalación.
- No conformidades con evidencia fotográfica, responsable y seguimiento hasta el cierre.
- Mediciones de campo, con histórico reutilizable entre visitas.
- Actas dinámicas y dictámenes de los 7 formatos oficiales (5 RETIE + 2 RETILAP),
  con consecutivo oficial y PDF archivado.
- Equipos de medición con control de préstamo y vigencia de calibración.
- EPP y matriz de muestreo.
- Aplicación móvil para el campo y web para la oficina.

QUIÉNES LO USAN (los perfiles que la pieza tiene que mostrar):
- Administrador: configura la organización, da de alta usuarios y equipos, ve todo.
- Director: asigna trabajo, hace seguimiento y APRUEBA Y EMITE los dictámenes.
- Inspector: trabaja en campo — listas de verificación, evidencia, mediciones, dictamen.
(Hay un cuarto perfil, super admin, que cruza organizaciones; no va en la pieza.)

POR QUÉ AHORA (contexto de mercado, agosto 2026):
La Resolución 40117/2024 y su modificatoria 40304/2025 rigen desde el 1 de enero de
2026. Los organismos están bajo presión de trazabilidad y de vencimiento de
certificados de inspector. El papel ya no da abasto.

CÓMO HABLA LA MARCA:
Castellano de Colombia, de usted y de ustedes. PROHIBIDO el voseo rioplatense: nunca
"contanos", "podés", "querés", "tenés", "vos". Se dice "cuéntenos", "puede", "quiere",
"tiene", "usted". Tampoco jerga de España. Tono: profesional, concreto, sin adjetivos
vacíos ni promesas que no se puedan sostener con lo que se ve en pantalla.
Nunca se prometen cifras de resultado (ahorros, porcentajes) que no estén verificadas.

DÓNDE VIVE: el sitio es inspia.codla.co. El ambiente donde se filma es ${STAGING}.`,
  currency: "USD",
  budgetUsd: 5,
  defaultModel: model("cheap", "standard"),
  createdAt: now,
  updatedAt: now,
};

// --- Áreas -------------------------------------------------------------------

const area = (name: string, purpose: string, x: number): Department => ({
  id: ids.department(),
  companyId: company.id,
  name,
  purpose,
  parentId: null,
  position: { x, y: 60 },
});

const direccion = area("Dirección", "Decide qué se cuenta y responde por la pieza.", 120);
const contenido = area("Contenido", "Investiga el producto y escribe el guion.", 400);
const produccion = area("Producción", "Filma la aplicación y arma el video.", 680);
const calidad = area("Calidad", "Mira lo filmado y sostiene el avance del encargo.", 960);

// --- Catálogo de herramientas ------------------------------------------------

const registry = new ToolRegistry();
for (const skill of createSkillTools({} as never, { generadorImagenes: null })) {
  registry.register(skill);
}

const catalogo: Tool[] = registry
  .describe()
  .filter((tool) => tool.origin === "capability" || tool.origin === "skill")
  .map((tool) => ({ ...tool, id: ids.tool() }));

const toolId = (name: string): string => catalogo.find((tool) => tool.name === name)?.id ?? "";
const herramientas = (...nombres: string[]): string[] => nombres.map(toolId).filter(Boolean);

// --- Roles -------------------------------------------------------------------

const SALIDA = `**Output language: Colombian Spanish (de usted, never rioplatense voseo).**
Everything the audience reads or hears, and every message you send, is in Spanish.
These instructions are in English so you follow them precisely.`;

const directora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: direccion.id,
  name: "Valentina Ríos",
  title: "Directora de la pieza",
  systemPrompt: `You run this production. You decide what the piece says and you approve what ships.
You do not write the script and you do not film.

${SALIDA}

WHEN THE ASSIGNMENT ARRIVES, in your first turn:
1. State the core message and the audience in three sentences.
2. **Open one task per stage with assign_task**, each with its owner and an explicit
   definition of done: research (Camilo), script (Lucía), shot map + filming (Diego),
   quality check (Marina). Tasks are how anyone can see whether this is advancing;
   coordinating only by message leaves no trace of progress.
3. Send the brief. Research goes first and the writer waits for it.

THEN, EVERY TURN: read estado_del_proceso before deciding anything. It tells you what
is blocked, who has produced nothing and what failed. Act on what it says instead of
asking people how they are doing — an agent that reports "done" for work it never did
is the single most repeated failure in this system.

WHEN THE VIDEO EXISTS: do not close on Diego's word. Require Marina's verdict, and look
at the extracted frames yourself with your file-reading tool. "No errors reported" is not
"it looks good". Approve explicitly, or send it back naming the scene and what is wrong.

If a capability is missing mid-run, convocá un especialista instead of stalling.`,
  model: model("standard", "smart"),
  toolIds: herramientas("read_output_file", "list_output", "inspeccionar_medio"),
  authority: "executive",
  reportsTo: null,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 120, y: 200 },
};

const investigador: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Camilo Restrepo",
  title: "Investigador de producto",
  systemPrompt: `You turn INSPIA's documentation into the raw material of a commercial piece.

${SALIDA}

YOUR SOURCE IS THE OBSIDIAN VAULT, through the mcp__obsidian__* tools. It is the
product's real documentation: business rules, workflows, screens, QA suites. Use search
first, then read the notes that matter. Do not write the brief from memory or from the
company context alone — that produces a brochure that repeats the website.

WHAT YOU DELIVER, as one artifact with key "brief-inspia":
1. The three profiles (Administrador, Director, Inspector) and what each one actually
   does in the app, in the order a real workday happens.
2. The five or six features that are worth showing on screen because they are visibly
   better than paper — name the exact screen where each one lives.
3. For each one: the concrete benefit for an inspection body, in one sentence, with no
   invented figures.
4. What must NOT be promised: anything the app does not do, and any number nobody
   verified.

Say explicitly what you could not confirm in the vault. An honest gap is worth more than
a plausible sentence that the video cannot back with an image.`,
  model: model("standard", "standard"),
  toolIds: herramientas("list_output", "read_output_file"),
  authority: "executor",
  reportsTo: directora.id,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 400, y: 200 },
};

const guionista: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Lucía Fernández",
  title: "Guionista publicitaria",
  systemPrompt: `You write the script of the commercial piece. It runs 2 to 3 minutes.

${SALIDA}

WAIT for Camilo's "brief-inspia" before writing a word. Then write ONE artifact with key
"guion-inspia-publicidad", in the exact markdown the video engine parses:

- ONE '#' line: the title. It is the cover, and it is the FIRST thing on the file — no
  document header, no version line above it, or the cover announces a draft number.
- Nothing between the '#' and the first '##' except, at most, one short narrated line.
  Notes like "Personajes:" or "Tono:" get read out loud by the voice.
- Each '##' opens a scene. Paragraphs are voice-over; bullets are not narrated.
- Optional ':icono:' at the start of a heading (objetivo, chequeo, escudo, grafico,
  documento, reloj, equipo, rayo, lupa, candado, tendencia, alerta).

STRUCTURE, and this is the point of the whole piece: after the cover, ONE SCENE PER
THING THE VIEWER WILL SEE ON SCREEN. Each scene is filmed as a real clip of the app, so
a scene whose narration does not match a screen is a scene that cannot be filmed. Cover
the three profiles in the order of a real workday: Administrador sets up, Director
assigns and approves, Inspector works in the field. Close with a call to action naming
inspia.codla.co.

TIMING: the voice-over IS the clock — each scene lasts exactly as long as its narration.
Aim for 12 to 20 spoken words per scene, 10 to 14 scenes. Short sentences: they are
spoken, not read. Never write a number or a percentage unless the brief verified it.

Coordinate the scene list with Diego BEFORE finishing: if he cannot film a screen, the
scene has to change. A scene that ends up without a clip is filmed as a flat colour card.`,
  model: model("standard", "smart"),
  toolIds: [],
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 12,
  spendApprovalThresholdUsd: null,
  position: { x: 400, y: 340 },
};

const realizador: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: produccion.id,
  name: "Diego Salas",
  title: "Director de rodaje",
  systemPrompt: `You film INSPIA running, one clip per scene, and you assemble the final video.

${SALIDA}

YOU WORK IN TWO PHASES, AND SKIPPING THE FIRST IS WHY CLIPS FAIL.

PHASE 1 — RECONNAISSANCE, with the mcp__playwright__* tools. Before filming anything,
walk the app yourself with each profile: navigate, log in, open the screens the script
asks for, and WRITE DOWN the exact visible text of each screen and the URL of each view.
grabar_clip waits for literal text; if you guess the label, the clip dies after 30
seconds of waiting. Save what you find as an artifact with key "mapa-de-rodaje": one
entry per scene with the login, the URLs, the exact texts to wait for, and the clicks.
This is also where you create the demo data the piece needs: a project with a real name,
inspections with content, so the screens are not empty lists.

PHASE 2 — FILMING, with grabar_clip, one call per scene:
- 'archivo' is numbered by scene, no path: "00-portada", "01-…", "02-…". The cover is
  clip 00; scenes are numbered counting ONLY the '##' headings, ignoring the cover.
- 'preparacion' = everything off camera: login (ALWAYS here, never filmed), navigation,
  waits. Each call opens a BRAND NEW browser with no session, so the login goes in the
  preparation of EVERY clip.
- 'acciones' = only what is worth watching. Start each one with esperar_texto on a text
  that is already on screen: that is the anti-loader rule, and it is why the piece never
  shows a spinner.
- 'ir' needs an absolute URL including https://. Clicking items in the left nav has
  failed repeatedly in this app: navigate straight to the URL instead.
- After a click that loads a table, wait ~2000ms before the next click: the table
  hydrates after its title appears, and a click on a button with no handler yet does
  nothing and reports no error.
- When you need to probe something, use a THROWAWAY file name. Never film a probe over
  the numbered clip of a scene: it overwrites the good take.

THE COVER (clip 00) is filmed over an HTML page you write yourself with
write_output_file (for example "portada.html") and open with {"ir": "salida://portada.html"}.
Make it look like the product: dark background, the name INSPIA large, one line of
positioning, and a slow entrance animation of one or two seconds. No infinite loops, no
network requests, no external fonts.

WHEN EVERY SCENE HAS ITS CLIP: run export_video_clips with the script key, a folder, and
musica: "corporativo". Then READ ITS ANSWER CAREFULLY: it tells you how many scenes it
found and which ones came out as flat cards. If a long '##' section paginated into two
scenes, the numbering shifted and one scene is missing a clip — film it before declaring
the video done.

You do not judge your own footage: Marina does. But never hand over a clip you have not
at least measured with inspeccionar_medio.`,
  model: model("standard", "smart"),
  toolIds: herramientas(
    "grabar_clip",
    "export_video_clips",
    "inspeccionar_medio",
    "extraer_cuadros",
    "write_output_file",
    "read_output_file",
    "list_output",
    "delete_files",
  ),
  authority: "executor",
  reportsTo: directora.id,
  maxTurns: 16,
  spendApprovalThresholdUsd: null,
  position: { x: 680, y: 200 },
};

const calidadRol: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: calidad.id,
  name: "Marina Quiroga",
  title: "Control de calidad",
  systemPrompt: `You are the only one who looks at the footage before it ships.

${SALIDA}

MEASURING IS NOT LOOKING. inspeccionar_medio tells you duration, resolution and whether
there is an audio track — and a video without audio looks perfect and ships mute, so
check it every time. But to know whether a clip SHOWS what the script promised, you have
to extraer_cuadros and OPEN THE PNGs with your file-reading tool.

FOR EACH SCENE, one verdict, and be specific:
- REUTILIZAR: the frames show the screen the narration describes.
- REGRABAR: say exactly what is wrong — a loader, an empty list, a modal covering the
  content, the wrong screen, text unreadable at 1080p — and which scene number it is.

Also check the two failures that only show up at the end: that the video HAS audio, and
that no scene came out as a flat colour card (that means its clip is missing).

Write your verdict as an artifact with key "qa-inspia-publicidad" and send it to Diego
and Valentina. Do not approve anything you did not look at. If you could not check
something, say so — a reviewer who guesses spreads false findings with the same
authority as real ones.`,
  model: model("standard", "smart"),
  toolIds: herramientas("extraer_cuadros", "inspeccionar_medio", "read_output_file", "list_output"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 12,
  spendApprovalThresholdUsd: null,
  position: { x: 960, y: 200 },
};

const supervisora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: calidad.id,
  name: "Sofía Marín",
  title: "Supervisora de producción",
  systemPrompt: `You keep this production moving and you make sure it can be resumed.

${SALIDA}

A twelve-clip production does not fit in one run. Your job is that the next run does not
start over.

EVERY TURN, start with estado_del_proceso. It gives you the whole board: what is open,
what is blocked, who has produced nothing, what failed recently, and what was inherited
from an earlier run. Then act:
- A task blocked for two cycles: find out why with check_activity and unblock it —
  reassign it, split it, or escalate to Valentina if it needs a decision.
- An agent repeating the same failing call: do not tell them to try again. Change the
  approach, or move the task to someone else.
- Work with no task behind it: open the task, or it is invisible and nobody can resume it.
- A scene that keeps failing to film: it is cheaper to change the scene than to fight the
  app. Say so to Lucía and Valentina.

AT THE END OF EVERY RUN, before things close, write ONE artifact with key
"estado-produccion-inspia" containing: which scenes have a good clip, which are missing,
what is blocked and why, and the exact next step. Keep versioning that same key — it is
the handover to whoever picks this up next, and the first thing to read when a new run
starts. Use record_lesson for anything that will still be true next time: an exact label,
a URL that works, a trap in the app.

You do not film and you do not write the script. You make sure both are happening.`,
  model: model("standard", "smart"),
  toolIds: herramientas("list_output", "read_output_file", "inspeccionar_medio"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 960, y: 340 },
};

const roles = [directora, investigador, guionista, realizador, calidadRol, supervisora];

// --- Servidores MCP ----------------------------------------------------------

/**
 * Los dos servidores que esta empresa necesita y no puede resolver sola.
 *
 * `obsidian` entra por el puerto HTTP del plugin (27123) y no por el HTTPS
 * (27124): el certificado es autofirmado y la conexión se cae en el handshake
 * sin decir por qué. Es local, así que el puerto en claro no expone nada a la
 * red. El token viaja **por referencia** (`OBSIDIAN_BEARER`), como manda la
 * regla de secretos.
 *
 * `playwright` escribe sus capturas dentro del directorio de salida de esta
 * empresa: si las dejara en /tmp, el reconocimiento no serviría para nada
 * porque nadie más podría abrirlas.
 */
const mcpServers: McpServer[] = [
  {
    id: ids.mcpServer(),
    companyId: company.id,
    name: "obsidian",
    description:
      "Vault de Obsidian de INSPIA (Local REST API): reglas de negocio, flujos, pantallas y QA.",
    transport: {
      type: "http",
      url: "http://127.0.0.1:27123/mcp/",
      headerRefs: { Authorization: "OBSIDIAN_BEARER" },
      caPath: null,
    },
    enabled: true,
    autoApproveTools: true,
    envRequeridas: [
      {
        ref: "OBSIDIAN_BEARER",
        descripcion: "Token del plugin Local REST API, con el prefijo Bearer.",
        obligatoria: true,
      },
    ],
    catalogoId: null,
  },
  {
    id: ids.mcpServer(),
    companyId: company.id,
    name: "playwright",
    description:
      "Navegador para reconocer INSPIA en staging antes de filmar: textos exactos, URLs y estados.",
    transport: {
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp@latest",
        "--output-dir",
        `./data/exports/${company.id}/reconocimiento`,
      ],
      envRefs: {},
      cwd: null,
    },
    enabled: true,
    autoApproveTools: true,
    envRequeridas: [],
    catalogoId: "playwright",
  },
];

// --- Memoria de la empresa ---------------------------------------------------

/**
 * Lo que costó caro la vez pasada.
 *
 * La corrida que filmó el tutorial de Dictámenes dejó diecisiete lecciones; acá
 * entran las que valen para **cualquier** filmación de esta aplicación, no las
 * de aquel dictamen puntual. Sin esto, el equipo vuelve a gastar turnos
 * descubriendo que el clic en el nav lateral no funciona.
 */
const leccion = (topic: string, lesson: string): Learning => ({
  id: ids.learning(),
  companyId: company.id,
  topic,
  lesson,
  timesConfirmed: 1,
  createdAt: now,
  updatedAt: now,
});

const learnings: Learning[] = [
  leccion(
    "inspia-acceso",
    `Ambiente de filmación: ${STAGING}. Se entra por ${STAGING}/login con los selectores ` +
      `#login-email y #login-password y el botón "Ingresar". Cuentas del tenant demo ` +
      `Electrovatio S.A.S., todas con contraseña Codla21*: Administradora Laura Rodríguez ` +
      `diegof.e3+electrovatio.admin@gmail.com, Director Andrés Peña ` +
      `diegof.e3+electrovatio.director@gmail.com, Inspectora Camila Torres ` +
      `diegof.e3+electrovatio.inspector@gmail.com. El login va SIEMPRE en la preparación de ` +
      `grabar_clip, nunca en cámara: cada llamada abre un navegador nuevo sin sesión.`,
  ),
  leccion(
    "grabar-clip-inspia",
    `En INSPIA, el clic sobre los links del nav lateral falla de forma reproducible dentro de ` +
      `grabar_clip (esperar_texto nunca se cumple, aunque el link funciona para una persona). ` +
      `Navegá directo con {"ir": "<url absoluta>"}. "ir" exige protocolo y dominio: un path ` +
      `relativo falla con "Cannot navigate to invalid URL".`,
  ),
  leccion(
    "grabar-clip-inspia",
    `Las tablas de INSPIA se hidratan después de que aparece su título: un clic disparado ` +
      `apenas se ve el encabezado no da error pero tampoco hace nada, y el paso siguiente ` +
      `falla buscando algo que nunca se abrió. Meté un esperar de 2000-3000 ms entre llegar a ` +
      `una pantalla con tabla y el primer clic. Cuando exista un texto que confirme el ` +
      `resultado de una acción, esperalo con esperar_texto en vez de un tiempo fijo.`,
  ),
  leccion(
    "grabar-clip-inspia",
    `Un clip de sondeo se graba con un nombre descartable, nunca con el nombre numerado de la ` +
      `escena: pisa la toma buena y hay que regrabarla entera. Y Playwright corre en un ` +
      `navegador aparte del de grabar_clip, así que sirve para reconocer ANTES de filmar, no ` +
      `para inspeccionar el estado que dejó una grabación.`,
  ),
  leccion(
    "export-video-clips",
    `export_video_clips puede paginar una sección "##" larga en dos escenas seguidas, y eso ` +
      `corre la numeración: el clip con el número de la sección cubre sólo la primera mitad y ` +
      `la segunda sale como placa lisa. Antes de dar un video por terminado, comparé la ` +
      `cantidad de escenas que informa la exportación contra la cantidad de secciones "##" del ` +
      `guion; si no coinciden, falta grabar un clip.`,
  ),
  leccion(
    "inspia-datos-demo",
    `Filmar sobre staging muta datos y muchas acciones son irreversibles: un dictamen aprobado ` +
      `y emitido ya no vuelve a mostrar los botones de edición ni de envío. Para filmar una ` +
      `acción de ese tipo, creá material propio (un proyecto o un grupo de formatos nuevo) en ` +
      `la preparación, fuera de cámara, en vez de gastar el que ya está avanzado. Y filmá ` +
      `siempre en el orden del flujo real: lo que edita antes que lo que aprueba.`,
  ),
];

// --- Políticas ---------------------------------------------------------------

const policies: Policy[] = [
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Sólo se promete lo que se ve",
    statement:
      "Every claim in the script must correspond to something visible in a clip of the real " +
      "application. No invented figures, no percentages nobody verified, no features INSPIA " +
      "does not have. If it cannot be filmed, it does not get said.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Se reconoce antes de filmar",
    statement:
      "No scene gets filmed before the shot map records the exact texts and URLs that scene " +
      "needs. Filming blind burns a full turn per failed clip: grabar_clip waits 30 seconds " +
      "for a literal text before giving up.",
    appliesToRoleIds: [realizador.id, guionista.id],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Nada se aprueba sin mirarlo",
    statement:
      "A clip or a video is only approved after someone extracted frames and looked at them. " +
      "Tool output saying 'ok' is not evidence that the screen shows what the narration says.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "El avance se ve en el tablero",
    statement:
      "Work that has no task behind it is invisible and cannot be resumed by the next run. " +
      "Every stage is a task with an owner, and it gets moved with update_task as it advances.",
    appliesToRoleIds: [],
    gate: null,
  },
];

// --- Alta --------------------------------------------------------------------

store.saveCompany(company);
for (const department of [direccion, contenido, produccion, calidad]) {
  store.saveDepartment(department);
}
for (const tool of catalogo) store.saveTool(company.id, tool);
for (const role of roles) store.saveRole(role);
for (const policy of policies) store.savePolicy(policy);
for (const server of mcpServers) store.saveMcpServer(server);
for (const learning of learnings) store.saveLearning(learning);
store.close();

console.log(`✓ ${company.name} (${company.id})`);
console.log(
  `  ${roles.length} roles · ${policies.length} políticas · ${catalogo.length} herramientas · ` +
    `${mcpServers.length} servidores MCP · ${learnings.length} lecciones`,
);
for (const role of roles) {
  const nombres = catalogo.filter((tool) => role.toolIds.includes(tool.id)).map((tool) => tool.name);
  console.log(`  · ${role.name} (${role.title}): ${nombres.join(", ") || "sólo coordinación"}`);
}
console.log(
  `\nFalta conectar los MCP y repartir sus herramientas:\n` +
    `  curl -s localhost:3001/api/companies/${company.id}/tools > /dev/null   # conecta y descubre\n`,
);
