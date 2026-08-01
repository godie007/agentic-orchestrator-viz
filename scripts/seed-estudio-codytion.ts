/**
 * El estudio audiovisual de Codytion.
 *
 * No es la empresa entera: es el equipo mínimo que produce **un** video. Siete
 * áreas y nueve roles sirven para simular una consultora; para filmar una pieza
 * institucional son estorbo — cada rol de más es un turno de más, un mensaje de
 * más y una chance más de que el guion se fragmente en tres entregables.
 *
 * Los cuatro roles son los que de verdad hacen falta: alguien que decide qué se
 * cuenta, alguien que lo escribe, alguien que lo produce y alguien que lo revisa
 * antes de que salga. El revisor es el único que sube la calidad de verdad —lo
 * medimos— y por eso no es opcional.
 *
 *   npm run db:estudio
 */

import { ids } from "@orq/shared";
import type { Company, Department, ModelSelection, Policy, Role, Tool } from "@orq/shared";
import { ToolRegistry, createSkillTools } from "@orq/tools";
import { Store } from "../apps/server/src/db.js";
import { loadEnv } from "../apps/server/src/env.js";

/**
 * El tier con el que arranca el estudio.
 *
 * `free` por defecto, no por avaricia: una cuenta de OpenRouter sin crédito
 * rechaza **todas** las llamadas con un 402 y la corrida muere en el tercer
 * ciclo sin producir nada. Con `ORQ_SEED_TIER=standard` el mismo estudio corre
 * con modelos pagos, que escriben bastante mejor.
 */
const TIER = (process.env.ORQ_SEED_TIER ?? "free") as ModelSelection["tier"];

const model = (_tier: ModelSelection["tier"]): ModelSelection => ({
  providerId: "openrouter",
  modelSlug: null, // se resuelve contra el catálogo vivo al arrancar la corrida
  tier: TIER,
  temperature: null,
  maxOutputTokens: 6000,
});

const store = new Store(loadEnv().databaseUrl);
const now = Date.now();

const company: Company = {
  id: ids.company(),
  name: "Codytion",
  mission:
    "Construimos software e IoT potenciados por IA para empresas que necesitan entregar rápido.",
  /**
   * Cómo suena la marca. La `y` de Codytion no es una i latina: se dice
   * "codishon", y el motor de voz jamás lo adivina. Las siglas también entran
   * acá porque un sintetizador las deletrea mal o las lee como palabra.
   */
  voz: {
    unaSolaVoz: true,
    pronunciacion: {
      Codytion: "códishon",
      IA: "i a",
      IoT: "i o té",
      RAG: "rag",
      API: "a pe i",
      APIs: "a pe is",
      cloud: "claud",
      DevOps: "dev ops",
      software: "sóftwer",
    },
  },
  context: `Codytion construye software a medida, IoT y sistemas de IA para empresas.
Lo que ofrecemos hoy, tal como está en codytion.com:
- Aplicaciones web y móviles, integraciones y APIs, cloud y DevOps.
- IA y sistemas inteligentes: RAG y bases de conocimiento, chatbots empresariales,
  Azure OpenAI, fine-tuning, vector DBs y embeddings.
- IoT para automatizar espacios de trabajo y producción.
Números que podemos decir: más de 10 años de experiencia, 3 países, más de 20
proyectos entregados. Trabajamos sobre Azure, GCP y AWS, con React, TypeScript,
Python y n8n.
Cómo hablamos: directo, concreto y sin promesas vagas. Decimos qué hacemos y cómo,
no adjetivos. Nunca prometemos resultados que no podemos medir.
Identidad visual: fondo azul grafito muy oscuro, azul como color de acento y
ámbar para lo que hay que mirar primero.`,
  currency: "USD",
  budgetUsd: 3,
  defaultModel: model("standard"),
  createdAt: now,
  updatedAt: now,
};

const dep = (name: string, purpose: string, x: number, y: number): Department => ({
  id: ids.department(),
  companyId: company.id,
  name,
  purpose,
  parentId: null,
  position: { x, y },
});

const marca = dep("Marca", "Decide qué cuenta la empresa y aprueba lo que sale.", 400, 0);
const contenido = dep("Contenido", "Escribe lo que se dice.", 150, 220);
const produccion = dep("Producción", "Convierte el guion en piezas terminadas.", 650, 220);

// --- Herramientas ------------------------------------------------------------
// Se registran las capacidades **y** las habilidades: `forRole` sólo otorga sin
// preguntar las de coordinación, así que una habilidad que no está en `toolIds`
// simplemente no existe para el rol. El almacenamiento es de mentira porque acá
// sólo se necesitan los metadatos para poder darles un id.
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

const directora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: marca.id,
  name: "Valentina Ríos",
  title: "Directora de marca",
  systemPrompt: `Dirigís la comunicación de Codytion. Tu trabajo es decidir qué se cuenta y
aprobar lo que sale, no escribirlo vos.

Cuando llega un encargo de video:
1. Definís en dos o tres frases el mensaje central y a quién le habla.
2. Se lo delegás a Contenido con ese encargo y un criterio de "terminado".
3. Cuando el guion está revisado, le pedís a Producción que lo filme.
4. Mirás el resultado y cerrás. No pedís una versión más "por las dudas".

Una sola pieza: un guion, un video, una presentación. Si alguien te propone
partirlo en varios entregables, decí que no.`,
  model: model("standard"),
  toolIds: herramientas("read_artifact", "list_artifacts", "check_activity", "list_output"),
  authority: "executive",
  reportsTo: null,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 400, y: 60 },
};

const guionista: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Julián Prieto",
  title: "Guionista",
  systemPrompt: `Escribís el guion del video. Un guion no es un informe sobre el video: es
exactamente lo que se va a decir y a ver, y se filma tal cual.

El formato es markdown y es estricto:
- \`# Título\` arma la portada.
- Cada \`## Título de escena\` abre una escena; ese título es la placa que se ve.
- Los párrafos son la voz en off: lo que se escucha, en frases cortas y dichas en voz alta.
- Las viñetas aparecen escritas en pantalla mientras se habla: menos de siete palabras cada una.
- \`> Una frase\` se muestra grande y sola.
- Podés poner un ícono al empezar una viñeta o un \`##\`, con \`:nombre:\`. Los que hay:
  objetivo, reloj, alerta, chequeo, grafico, tendencia, persona, equipo, engranaje, idea,
  dinero, escudo, cohete, documento, candado, calendario, rayo, lupa, correo, conversacion.

Reglas de este video:
- Entre 6 y 8 escenas. Unas 15 palabras habladas por cada 6 segundos.
- Lo que se dice y lo que se ve **no se repiten**: la viñeta no es la transcripción de la frase.
- Números y hechos: sólo los del contexto de la empresa. No inventes clientes, casos ni cifras.
- Nada de adjetivos sueltos ("innovador", "de vanguardia"). Decí qué hacemos y cómo.
- Lo guardás con write_artifact bajo la clave \`video-codytion\`. Cada corrección es una
  versión nueva de esa misma clave, nunca un entregable aparte.`,
  model: model("standard"),
  toolIds: herramientas("write_artifact", "read_artifact", "list_artifacts", "fetch_url"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 150, y: 280 },
};

const revisora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Mariana Losada",
  title: "Revisora de guion",
  systemPrompt: `Revisás el guion antes de que se filme. Filmar cuesta minutos de máquina y
un error se ve en cada reproducción, así que acá se corrige.

Verificás cuatro cosas, y sólo estas cuatro:
1. **Es verdad**: cada dato del guion aparece en el contexto de la empresa. Si una cifra
   no está ahí, la marcás. No la corrijas inventando otra.
2. **Se puede decir**: leelo en voz alta mentalmente. Frases de más de 25 palabras, siglas
   pegadas o números escritos en dígitos largos no se entienden habladas.
3. **Se puede ver**: ninguna viñeta de más de siete palabras, ninguna escena con más de
   cuatro viñetas, ningún \`##\` sin nada debajo.
4. **Suena a Codytion**: directo y concreto. Sin adjetivos vacíos.

Tu devolución se manda con **reply**, nunca con write_artifact. El guion es un solo
entregable y es del guionista: si guardás tu revisión ahí, el guion deja de existir y lo
que se filma después son tus notas leídas en voz alta.

Devolvés una lista corta de correcciones concretas, con la escena y el reemplazo exacto.
Si algo está bien, no lo comentes. Si no encontrás nada, decilo y no inventes hallazgos:
un guion correcto marcado como incorrecto termina en un cambio que lo empeora.`,
  model: model("standard"),
  toolIds: herramientas("read_artifact", "list_artifacts"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 8,
  spendApprovalThresholdUsd: null,
  position: { x: 150, y: 420 },
};

const realizadora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: produccion.id,
  name: "Nadia Bercovich",
  title: "Realizadora",
  systemPrompt: `Producís las piezas a partir del guion que ya está escrito y revisado.

Tu trabajo son dos llamadas, en este orden:
1. \`export_video\` con la clave del guion, folder "marketing", y musica "corporativo".
2. \`export_slides\` con la misma clave y el mismo folder.

Después mirás lo que devolvieron. Las dos herramientas avisan cuando algo no salió como
pedía el guion: si hay un aviso, lo contás tal cual en tu respuesta. No escribas el guion
vos ni lo corrijas: si está mal, se lo devolvés a Contenido diciendo qué escena falla.

Cuando terminás, informás dónde quedó cada archivo, cuánto dura el video y qué música
tiene. No informes que algo salió bien sin haberlo ejecutado: queda registrado.`,
  model: model("standard"),
  toolIds: herramientas(
    "export_video",
    "export_slides",
    "read_artifact",
    "list_artifacts",
    "list_output",
  ),
  authority: "executor",
  reportsTo: directora.id,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 650, y: 280 },
};

const roles = [directora, guionista, revisora, realizadora];

const policies: Policy[] = [
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Un solo guion",
    statement:
      "El guion del video es un único entregable con la clave 'video-codytion'. Cada " +
      "corrección es una versión nueva de esa clave, no un entregable aparte.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Sólo lo que podemos sostener",
    statement:
      "En una pieza pública sólo entran datos que estén en el contexto de la empresa. " +
      "Ningún rol inventa clientes, casos, premios ni cifras.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Se revisa antes de filmar",
    statement:
      "Ningún guion se filma sin pasar por la revisión de guion. Filmar y después " +
      "corregir cuesta el doble y deja versiones dando vueltas.",
    appliesToRoleIds: [directora.id, realizadora.id],
    gate: null,
  },
];

store.saveCompany(company);
for (const department of [marca, contenido, produccion]) store.saveDepartment(department);
for (const tool of catalogo) store.saveTool(company.id, tool);
for (const role of roles) store.saveRole(role);
for (const policy of policies) store.savePolicy(policy);
store.close();

console.log(`✓ ${company.name} (${company.id})`);
console.log(`  ${roles.length} roles · ${policies.length} políticas · ${catalogo.length} herramientas`);
for (const role of roles) {
  const nombres = catalogo
    .filter((tool) => role.toolIds.includes(tool.id))
    .map((tool) => tool.name);
  console.log(`  · ${role.name} (${role.title}): ${nombres.join(", ") || "sólo coordinación"}`);
}
