/**
 * El estudio de lanzamiento de INSPIA.
 *
 * Cuatro roles y **tres modelos distintos**, todos por la sesión de Anthropic.
 * El reparto no es decorativo: quien decide la estrategia corre con Opus 5,
 * quien escribe y revisa con Sonnet 5, y quien ejecuta el render con Haiku —
 * filmar no requiere criterio, requiere no equivocarse con las claves.
 *
 *   npm run db:inspia
 */
import { ids } from "@orq/shared";
import type { Company, Department, ModelSelection, Policy, Role, Tool } from "@orq/shared";
import { ToolRegistry, createSkillTools } from "@orq/tools";
import { Store } from "../apps/server/src/db.js";
import { ExportStore } from "../apps/server/src/exports.js";
import { loadEnv } from "../apps/server/src/env.js";

const env = loadEnv();
const store = new Store(env.databaseUrl);
const now = Date.now();

/** Todos por la sesión: la credencial sale de `ant`, no de una API key. */
const modelo = (slug: string): ModelSelection => ({
  providerId: "claude-sesion",
  // Slug explícito y no tier: este proveedor no publica precios, así que las
  // bandas no resuelven y un tier dejaría al rol sin modelo.
  modelSlug: slug,
  tier: "smart",
  temperature: null,
  maxOutputTokens: 8192,
});

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5-20251001";

const company: Company = {
  id: ids.company(),
  name: "INSPIA — Lanzamiento",
  mission:
    "Vendemos INSPIA, la plataforma que digitaliza el ciclo completo de inspecciones eléctricas RETIE y RETILAP.",
  // La marca se lee como se escribe, pero el sintetizador dice "inspia" con
  // acento en la i si no se lo corrige.
  voz: { unaSolaVoz: true, pronunciacion: { INSPIA: "Inspia", RETIE: "Retie", RETILAP: "Retilap" } },
  context: `INSPIA es un sistema multi-tenant para organismos de inspección eléctrica.
Digitaliza el ciclo completo: asignación → planificación → inspección → no conformidades → cierre → dictamen.
Módulos: proyectos, listas de verificación parametrizables por reglamento, no conformidades con evidencia
fotográfica, gestión de equipos de medición con ciclo de préstamo, actas dinámicas, mediciones técnicas,
reportes PDF, control de EPP y matriz de muestreo. Roles: super admin, administrador, director e inspector.
Hay app móvil y web. El sitio es inspia.codla.co.

CONTEXTO DE MERCADO (agosto 2026):
El RETIE actualizado (Resolución 40117 de 2024, complementada por la 40304 de 2025) es OBLIGATORIO desde el
1 de enero de 2026: el período de transición terminó el 31 de diciembre de 2025. Toda instalación nueva,
ampliación o remodelación debe demostrar cumplimiento ante organismos de inspección acreditados por ONAC.
Además, desde el 1 de enero de 2026 vencieron los certificados de competencia emitidos bajo la Resolución
40293 de 2021: un inspector sin recertificar no puede inspeccionar.

SEGMENTO OBJETIVO: retail y grandes superficies. Los centros comerciales son sector crítico para el
cumplimiento eléctrico. Una cadena con decenas o cientos de puntos de venta tiene instalaciones distintas por
antigüedad, superficie y horario, y coordina múltiples proveedores: sin un sistema central, la operación se
vuelve lenta e imposible de controlar.

LA CAMPAÑA: oferta especial de lanzamiento. El entregable es UN video promocional de 60 segundos.`,
  currency: "USD",
  budgetUsd: 5,
  defaultModel: modelo(SONNET),
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

const estrategia = dep("Estrategia", "Define el ángulo y aprueba la pieza.", 400, 40);
const contenido = dep("Contenido", "Escribe y revisa el guion.", 180, 220);
const produccion = dep("Producción", "Filma la pieza.", 620, 220);

// Las habilidades no se otorgan solas: hay que registrarlas en `tools` y
// asignarlas por `toolIds`, o el realizador no encuentra `export_video`.
const registry = new ToolRegistry();
for (const skill of createSkillTools(new ExportStore(env.exportsDir).forCompany("seed"), {
  musicaHome: env.musicaDir,
})) {
  registry.register(skill);
}
const catalogo: Tool[] = registry
  .describe()
  .filter((tool) => tool.origin === "capability" || tool.origin === "skill")
  .map((tool) => ({ ...tool, id: ids.tool() }));

const herramientas = (...nombres: string[]): string[] =>
  nombres.map((n) => catalogo.find((t) => t.name === n)?.id ?? "").filter(Boolean);

const directora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: estrategia.id,
  name: "Valentina Ríos",
  title: "Directora de campaña",
  systemPrompt: `Dirigís el lanzamiento de INSPIA. Decidís el ángulo comercial y aprobás la pieza; no la escribís vos.

Tu criterio: el video le habla a un responsable de mantenimiento o de operaciones de una cadena de retail, no a
un ingeniero. Lo que lo mueve es el riesgo regulatorio concreto —el RETIE ya es obligatorio y sus certificados
de inspector vencieron— y el descontrol de coordinar decenas de sedes.

Encargás el guion a Julián con un ángulo claro y un criterio de "terminado". Cuando Mariana lo apruebe, le
pedís a Nadia que lo filme. No repitas el trabajo de tu equipo: decidí, desbloqueá y cerrá.`,
  model: modelo(OPUS),
  toolIds: herramientas("read_artifact", "list_artifacts", "check_activity", "list_output"),
  authority: "executive",
  reportsTo: null,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 400, y: 110 },
};

const guionista: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Julián Prieto",
  title: "Guionista",
  systemPrompt: `Escribís el guion del video con write_artifact, en la clave "guion-lanzamiento".

El guion ES la línea de tiempo del video. Formato exacto:
- Un solo "#" con el título: es la portada.
- Cada "##" abre una escena. Podés empezarlo con un ícono, así: "## :objetivo: Cumplí sin correr".
- Los párrafos debajo son la VOZ EN OFF: lo que se escucha. Escribí para el oído, no para el ojo.
- Las viñetas aparecen en pantalla mientras se habla.
- "![lo que se ve](video:multimedia/inspia-sitio.mp4)" incrusta la grabación real de la plataforma.
- "![lo que muestra](visual:flujo)" dibuja un diagrama.

REGLA DE DURACIÓN, es la más importante: el video dura lo que dura la narración leída en voz alta. Para 60
segundos necesitás entre 140 y 160 palabras de voz en off EN TOTAL, contando todas las escenas. Contalas. Un
guion de 300 palabras da un video de dos minutos y no sirve.

Apuntá a 5 o 6 escenas cortas. Usá el clip del sitio en una de ellas. Cerrá con la oferta de lanzamiento y una
llamada a la acción con el sitio: inspia.codla.co.`,
  model: modelo(SONNET),
  toolIds: herramientas("write_artifact", "read_artifact", "list_artifacts", "edit_artifact"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 10,
  spendApprovalThresholdUsd: null,
  position: { x: 180, y: 300 },
};

const revisora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: contenido.id,
  name: "Mariana Losada",
  title: "Revisora",
  systemPrompt: `Revisás el guion antes de filmar. No lo reescribís: devolvés correcciones concretas y citadas.

Verificá, en este orden:
1. LARGO. Contá las palabras de voz en off de todas las escenas juntas. Si pasa de 165, decí cuántas sobran y
   dónde recortar. Es el error que arruina la pieza: un guion largo da un video largo.
2. Que haya un solo "#", y que cada escena abra con "##".
3. Que las marcas de ícono estén al principio de un "##" o de una viñeta, NUNCA solas en su renglón: un
   párrafo que es sólo ":objetivo:" se lee en voz alta y suena a error.
4. Que la oferta de lanzamiento y el sitio inspia.codla.co estén en el cierre.
5. Que le hable a retail: sedes, cumplimiento, control. No jerga de ingeniería.

Si está bien, decilo sin rodeos para que se filme.`,
  model: modelo(SONNET),
  toolIds: herramientas("read_artifact", "list_artifacts"),
  authority: "manager",
  reportsTo: directora.id,
  maxTurns: 8,
  spendApprovalThresholdUsd: null,
  position: { x: 180, y: 400 },
};

const realizadora: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: produccion.id,
  name: "Nadia Bercovich",
  title: "Realizadora",
  systemPrompt: `Filmás. Cuando el guion esté aprobado, llamás export_video con la clave "guion-lanzamiento" y
folder "multimedia".

No escribís ni corregís el guion: si algo está mal, se lo devolvés a quien corresponda. Después de filmar,
informá la duración real que devolvió la herramienta. Si se pasa de 70 segundos, avisá que hay que recortar
narración — no lo arregles vos.`,
  model: modelo(HAIKU),
  toolIds: herramientas("export_video", "read_artifact", "list_artifacts", "list_output"),
  authority: "executor",
  reportsTo: directora.id,
  maxTurns: 8,
  spendApprovalThresholdUsd: null,
  position: { x: 620, y: 300 },
};

const policies: Policy[] = [
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Sesenta segundos",
    statement:
      "La pieza dura 60 segundos. El video dura lo que dura la narración: entre 140 y 160 palabras de voz en off en total.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Se revisa antes de filmar",
    statement: "Ningún guion se filma sin la aprobación de la revisora.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Un solo guion",
    statement:
      "Hay un entregable: la clave 'guion-lanzamiento'. Se versiona, no se fragmenta en variantes.",
    appliesToRoleIds: [],
    gate: null,
  },
];

const roles = [directora, guionista, revisora, realizadora];

store.saveCompany(company);
for (const d of [estrategia, contenido, produccion]) store.saveDepartment(d);
for (const r of roles) store.saveRole(r);
for (const p of policies) store.savePolicy(p);
for (const tool of catalogo) store.saveTool(company.id, tool);

console.log(`✓ ${company.name} (${company.id})`);
console.log(`  ${roles.length} roles · ${catalogo.length} herramientas · ${policies.length} políticas`);
for (const r of roles) console.log(`    ${r.name.padEnd(20)} ${r.model.modelSlug}`);
store.close();
