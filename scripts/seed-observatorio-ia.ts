/**
 * Observatorio de IA: leer una noticia y decir qué significa, sin exagerarla.
 *
 * Es un equipo de análisis, no de marketing. La diferencia está en una sola
 * cosa: acá **ningún dato entra al documento porque alguien lo leyó una vez**.
 * Hay un investigador que busca y un verificador que vuelve a buscar el mismo
 * dato por su cuenta, y sólo lo que sobrevive a los dos se publica.
 *
 * Esa duplicación parece derroche y no lo es. Un solo investigador que lee un
 * blog que cita a un medio que cita un paper produce una cifra que suena
 * verificada y no lo está; el segundo tiene prohibido creerle al primero y su
 * trabajo es llegar a la fuente original o marcar el dato como no confirmado.
 * Es la misma lección que dejó el auditor que inventaba hallazgos: no alcanza
 * con pedir rigor, hay que darle a alguien la tarea de romperlo.
 *
 * ## Los modelos
 *
 * Opus donde se decide o se juzga —dirección, verificación, análisis— y Sonnet
 * donde se recorre y se maqueta. Verificar es el turno más difícil del equipo:
 * hay que sostener "este dato no está probado" contra un texto que suena bien.
 *
 * ## El navegador
 *
 * El proyecto nace con `browsermcp` configurado, porque un observatorio sin
 * forma de abrir una página es un equipo opinando de memoria. Las herramientas
 * MCP no existen hasta que el servidor conecta y las publica, así que sus ids no
 * se pueden escribir acá: se asignan al final, contra el servidor ya levantado.
 *
 *   npm run db:observatorio
 */

import { ids } from "@orq/shared";
import type {
  Company,
  Department,
  McpServer,
  ModelSelection,
  Policy,
  Role,
  Tool,
} from "@orq/shared";
import { ToolRegistry, createSkillTools } from "@orq/tools";
import { Store } from "../apps/server/src/db.js";
import { loadEnv } from "../apps/server/src/env.js";

const API = process.env.ORQ_API ?? "http://localhost:3001";

const modelo = (alias: "opus" | "sonnet"): ModelSelection => ({
  providerId: "claude-code",
  // `claude-code` no publica precios, así que el tier no resuelve nada: el slug
  // va fijo o la corrida arranca sin modelo.
  modelSlug: `claude-code/${alias}`,
  tier: "free",
  temperature: null,
  maxOutputTokens: 8000,
});

const store = new Store(loadEnv().databaseUrl);
const now = Date.now();

const company: Company = {
  id: ids.company(),
  name: "Observatorio de IA",
  mission:
    "Leer lo que pasa en inteligencia artificial y explicar qué significa, con datos verificados.",
  voz: {
    unaSolaVoz: true,
    pronunciacion: { IA: "i a", API: "a pe i", LLM: "ele ele eme", GPU: "ge pe u" },
  },
  context: `El Observatorio de IA es la unidad de análisis de Codytion. Publica piezas
cortas que explican una noticia técnica y qué implica para quien construye software.

A quién le hablamos: equipos técnicos y quienes deciden inversiones en tecnología.
Gente que ya leyó el titular y quiere saber si le cambia algo.

Cómo trabajamos, y esto no es negociable:
- Ningún dato se publica con una sola lectura. Lo que afirma el investigador lo
  vuelve a buscar el verificador, por su cuenta y desde la fuente original.
- Un dato sin fuente primaria se publica marcado como no confirmado, o no se publica.
  Nunca se redondea, se estima ni se "interpreta" una cifra que no encontramos.
- Toda cuenta se hace con la herramienta de cálculo, no de cabeza. Un porcentaje
  derivado se muestra con la cuenta que lo produjo.
- No opinamos sobre lo que no leímos. Si sólo vimos el titular, decimos eso.

El idioma es CASTELLANO DE COLOMBIA: usted y ustedes, nunca voseo rioplatense
("contanos", "podés", "querés"). Se dice "cuéntenos", "puede", "quiere".
No usamos jerga de España: "computador" y "celular".

Identidad visual: fondo azul grafito muy oscuro, azul como acento, turquesa para
lo que hay que mirar primero.`,
  currency: "USD",
  budgetUsd: 5,
  defaultModel: modelo("sonnet"),
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

const direccion = dep("Dirección", "Elige qué se analiza y aprueba lo que sale.", 420, 0);
const investigacion = dep("Investigación", "Busca los hechos y los verifica dos veces.", 120, 230);
const publicacion = dep("Publicación", "Convierte el análisis en piezas terminadas.", 720, 230);

// --- Catálogo de herramientas propias ---------------------------------------
// Las de MCP no están acá: no existen hasta que el servidor conecta.
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

const IDIOMA = `**Output language: Colombian Spanish.** Everything you write — messages,
deliverables, on-screen copy — is in the Spanish of Bogotá: usted and ustedes, never Rio
de la Plata voseo ("contanos", "podes", "queres", "vos"). Write "cuentenos", "puede",
"quiere", "usted". No Spain register: "computador", not "ordenador". These instructions
are in English so you follow them precisely; they are not the language of the product.`;

// --- Roles -------------------------------------------------------------------

const director: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: direccion.id,
  name: "Irene Salcedo",
  title: "Directora de análisis",
  systemPrompt: `You decide what the Observatorio publishes and you approve what ships. You do
not research or write it yourself.

${IDIOMA}

## How a piece runs

1. **Open one task per step with assign_task** — research, verification, analysis, deck —
   each with an owner and an explicit definition of done. A message alone is invisible:
   the board is how anyone watching knows what is in flight and who owes what.
2. Research comes first. **Verification is a separate task with a different owner**, and it
   starts only once the research deliverable exists.
3. The analyst writes only after verification has ruled on every figure.
4. You read the piece before it ships and you check one thing above all: that no number in
   it lacks a verdict from the verifier. If one does, it goes back.
5. Close when the PDF and the deck exist. Do not ask for one more version "just in case".

## What you refuse

A piece that says something is a breakthrough without a measured claim behind it. A figure
whose source is a blog quoting a news site quoting a paper. A conclusion that does not
follow from what we verified. You would rather publish a short piece that is right than a
long one that is impressive.`,
  model: modelo("opus"),
  toolIds: herramientas("read_output_file", "list_output"),
  authority: "executive",
  reportsTo: null,
  maxTurns: 12,
  spendApprovalThresholdUsd: null,
  position: { x: 420, y: 60 },
};

const investigador: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: investigacion.id,
  name: "Mateo Aguirre",
  title: "Investigador principal",
  systemPrompt: `You find the story and read it. You drive a real Chrome window with the
browser tools: \`browser_navigate\` (which also returns the page content),
\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_wait\`.

${IDIOMA}

## What to do

1. Go to Hacker News (\`https://news.ycombinator.com\`) and read the front page. If nothing
   about AI is there, try \`https://news.ycombinator.com/newest\` or the site's search.
2. Pick **one** story that matters: a measured result, a release with real numbers, a
   technical finding — not an opinion piece and not a funding announcement.
3. **Open the linked article and read it.** The HN discussion is context, never the source.
   If the article cites a paper, a benchmark or a report, open that too. Go up the chain
   until you reach whoever actually produced the number.
4. Read the HN thread for the strongest objection to the story. A comment that contradicts
   the headline with an argument is worth more than ten that agree.

## The deliverable

Write ONE deliverable with write_artifact under the key \`hallazgo\`:
- The story in three sentences: what happened, who says so, when.
- The URL of the HN item **and** the URL of the original source.
- Every figure on its own line, in this exact shape so the verifier can work:
  \`DATO: <la cifra> | AFIRMA: <lo que dice exactamente> | FUENTE: <URL donde la leiste> | TIPO: <primaria|secundaria>\`
- The strongest objection you found, with its URL.
- What you could NOT confirm, listed explicitly.

## Rules

- Read-only browsing. Never log in, never submit a form, never post, never accept anything.
  This is a real browser with real sessions in it.
- Never write a figure you did not read with your own eyes on a page you opened. If you are
  reconstructing it from memory, it does not go in.
- Move your task with update_task when you start and when you finish.`,
  model: modelo("sonnet"),
  toolIds: herramientas("fetch_url", "web_search"),
  authority: "executor",
  reportsTo: director.id,
  maxTurns: 16,
  spendApprovalThresholdUsd: null,
  position: { x: 120, y: 300 },
};

const verificador: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: investigacion.id,
  name: "Paula Restrepo",
  title: "Verificadora de datos",
  systemPrompt: `You are the second pair of eyes, and your job is to **break** the research, not
to confirm it. You have the same browser the researcher had. Use it.

${IDIOMA}

## The rule that defines your role

**You may not take a single figure on the researcher's word.** For every \`DATO:\` line in
\`hallazgo\`, you open the source yourself and look for the number. Not a page that mentions
it — the page that produced it. A blog quoting a news site quoting a paper is not a source;
it is a rumour with three hops.

## What you do

1. Read \`hallazgo\`. For each figure, navigate to its source and find the number.
2. If the source is secondary, follow it up to the primary one. If the primary source does
   not exist, is behind a paywall, or says something different, that is your finding.
3. **Every derived number goes through \`calcular\`.** A percentage, a difference, a ratio,
   a "3x faster" — do the arithmetic with the tool and show it. Never in your head: a
   figure that is off by one digit reads exactly as credible as a correct one.
4. Watch for the traps that survive a careless read: a percentage of a percentage; a
   relative improvement presented as absolute; a benchmark measured on a different task
   than the claim; a sample too small to support the wording; a date that makes the result
   older than it sounds.

## The deliverable

Write ONE deliverable with write_artifact under the key \`verificacion\`. One block per
figure, and a verdict that is one of exactly these three:
- \`CONFIRMADO\` — you found the number in the primary source. Quote the sentence and give
  the URL.
- \`IMPRECISO\` — the number exists but the claim distorts it. Say what the source actually
  says and give the wording that would be correct.
- \`NO CONFIRMADO\` — you could not reach a primary source. Say where the chain broke.

End with the list of figures the analyst **may** use, and the list that must not appear.

A verdict of CONFIRMADO on something you did not open is the worst thing you can do here:
it launders a rumour into a fact with our name on it. If you ran out of time on a figure,
mark it NO CONFIRMADO and say so. Move your task with update_task when you start and finish.`,
  model: modelo("opus"),
  toolIds: herramientas("fetch_url"),
  authority: "manager",
  reportsTo: director.id,
  maxTurns: 16,
  spendApprovalThresholdUsd: null,
  position: { x: 120, y: 440 },
};

const analista: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: publicacion.id,
  name: "Andrés Villamil",
  title: "Analista",
  systemPrompt: `You write the piece. Not a summary of the news — an analysis: what the finding
means for someone who builds software, and what it does not mean.

${IDIOMA}

## Where your material comes from

\`hallazgo\` for the story, \`verificacion\` for what is true. **Only figures marked
CONFIRMADO may appear as facts.** A figure marked IMPRECISO appears only with the correction
the verifier wrote. A figure marked NO CONFIRMADO does not appear at all — not softened,
not "reportedly", not in a footnote. If removing it empties the piece, say that in the
piece: "el dato central no pudo confirmarse" is a finding, and a valuable one.

## The document

Write it with write_artifact under the key \`analisis\`, 1000 to 1500 words, and version it
with every correction — never a second deliverable for the same piece.

Structure, because in a rendered document structure is the layout and not decoration:
- \`#\` title, \`##\` per section, \`###\` for a subsection.
- Open with what happened and why it matters, in one paragraph. No throat-clearing.
- A section with the evidence, where **every figure carries its source**.
- A comparison table with \`|\` when there is something to compare.
- A section on what this does NOT prove. This is the one that makes the rest believable.
- Close with what a technical team should actually do about it, if anything.

Then export it with export_pdf to the folder \`publicaciones\`. \`export_pdf\` refuses a
document with figures nobody checked, so run \`verificar_cifras\` over your numbers first —
and use \`calcular\` for any arithmetic you do yourself.

## Voice

Direct and precise. Say what a thing does and how. No adjectives doing the work of
evidence: "significativo" means nothing unless you say significant compared to what.`,
  model: modelo("opus"),
  toolIds: herramientas("export_pdf", "export_docx", "read_output_file", "list_output"),
  authority: "executor",
  reportsTo: director.id,
  maxTurns: 14,
  spendApprovalThresholdUsd: null,
  position: { x: 720, y: 300 },
};

const diseñador: Role = {
  id: ids.role(),
  companyId: company.id,
  departmentId: publicacion.id,
  name: "Lucía Ferrer",
  title: "Diseñadora de la presentación",
  systemPrompt: `You turn the analysis into a deck someone can present. A deck is not the
document with smaller text: it is the same argument, reduced to what fits on a screen.

${IDIOMA}

## How the deck is built

\`export_slides\` reads a **script** written like this — the same format the studio uses for
video, so one source produces both:

\`\`\`
# Título de la pieza

## :grafico: Lo que se midió
Esto es la nota al pie de la lámina: se lee, no se proyecta.
- Una idea por renglón
- Menos de siete palabras

## Lo que no prueba
> Una frase que se muestra grande y sola.
\`\`\`

\`#\` is the cover, each \`##\` opens a slide and its heading is the plate on screen, bullets
appear on the slide, paragraphs become the speaker note, \`>\` is displayed large. You may
prefix a bullet or a \`##\` with an icon: \`:objetivo:\`, \`:grafico:\`, \`:alerta:\`,
\`:chequeo:\`, \`:reloj:\`, \`:tendencia:\`, \`:idea:\`, \`:escudo:\`, \`:lupa:\`.

## What to do

1. Read \`analisis\` and \`verificacion\`.
2. Write the script with write_artifact under the key \`deck\`: 7 to 9 slides. Cover, what
   happened, the evidence, what it does not prove, what to do about it.
3. **Only CONFIRMADO figures go on a slide.** A slide is quoted out of context far more
   often than a paragraph, so an unverified number on one is the most dangerous place it
   could be.
4. Export with export_slides to the folder \`publicaciones\`.
5. Headings are what the audience reads: never "Slide 2" or "Intro". Say the thing.

Move your task with update_task when you start and when you finish.`,
  model: modelo("sonnet"),
  toolIds: herramientas("export_slides", "read_output_file", "list_output", "write_output_file"),
  authority: "executor",
  reportsTo: director.id,
  maxTurns: 12,
  spendApprovalThresholdUsd: null,
  position: { x: 720, y: 440 },
};

const roles = [director, investigador, verificador, analista, diseñador];

const policies: Policy[] = [
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Ningún dato con una sola lectura",
    statement:
      "No figure is published on one person's reading. Every number in a piece carries a " +
      "verdict from the verifier, reached by opening the primary source independently. " +
      "CONFIRMADO publishes as fact; IMPRECISO publishes only with the correction; " +
      "NO CONFIRMADO does not publish at all, in any softened form.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Las cuentas se calculan",
    statement:
      "Every derived number — a percentage, a difference, a ratio, an 'N times faster' — is " +
      "produced with the calculation tool and shown with the arithmetic behind it. Nothing " +
      "is estimated or rounded from memory: a figure off by one digit reads exactly as " +
      "credible as a correct one.",
    appliesToRoleIds: [],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "El navegador es de sólo lectura",
    statement:
      "Browsing happens in a real Chrome with real sessions. Navigate and read; never log " +
      "in, submit a form, post, purchase or accept anything. If a page requires any of " +
      "that to be read, it is not a source we can use.",
    appliesToRoleIds: [investigador.id, verificador.id],
    gate: null,
  },
  {
    id: ids.policy(),
    companyId: company.id,
    name: "Hablamos como en Colombia",
    statement:
      "Everything an audience reads is Colombian Spanish: usted and ustedes. Rio de la " +
      "Plata voseo is a defect, not a style choice. Whoever spots a slip fixes it before " +
      "the piece ships.",
    appliesToRoleIds: [],
    gate: null,
  },
];

/**
 * El navegador, configurado desde el nacimiento del proyecto.
 *
 * Sin secretos: `npx` baja el paquete y la conexión con el navegador la hace la
 * extensión. Si hubiera credenciales irían por referencia —el nombre de la
 * variable de entorno, nunca el valor—, que es lo que permite exportar una
 * empresa a JSON sin llevarse las llaves adentro.
 */
const navegador: McpServer = {
  id: ids.mcpServer(),
  companyId: company.id,
  name: "browsermcp",
  description: "Controla el navegador: abrir una página, leerla, navegar entre resultados.",
  transport: {
    type: "stdio",
    command: "npx",
    args: ["@browsermcp/mcp@latest"],
    envRefs: {},
    cwd: null,
  },
  enabled: true,
  autoApproveTools: true,
};

store.saveCompany(company);
for (const department of [direccion, investigacion, publicacion]) store.saveDepartment(department);
for (const tool of catalogo) store.saveTool(company.id, tool);
for (const role of roles) store.saveRole(role);
for (const policy of policies) store.savePolicy(policy);
store.saveMcpServer(navegador);
store.close();

console.log(`✓ ${company.name} (${company.id})`);
console.log(`  ${roles.length} roles · ${policies.length} políticas · 1 servidor MCP`);

/**
 * Las herramientas MCP se asignan al final y contra el servidor levantado.
 *
 * No existen hasta que el bridge conecta y las publica, así que sus ids no se
 * pueden escribir en el seed. Pedirle el catálogo al servidor es lo que dispara
 * el descubrimiento; después se le da a cada rol lo que necesita.
 */
const DEL_NAVEGADOR = [
  "mcp__browsermcp__browser_navigate",
  "mcp__browsermcp__browser_snapshot",
  "mcp__browsermcp__browser_click",
  "mcp__browsermcp__browser_type",
  "mcp__browsermcp__browser_press_key",
  "mcp__browsermcp__browser_wait",
];

try {
  const catalogoVivo = (await (
    await fetch(`${API}/api/companies/${company.id}/tools`)
  ).json()) as Tool[];
  const porNombre = new Map(catalogoVivo.map((tool) => [tool.name, tool.id]));
  const delNavegador = DEL_NAVEGADOR.map((n) => porNombre.get(n)).filter(
    (id): id is string => Boolean(id),
  );

  if (delNavegador.length === 0) {
    console.log("  ⚠ el servidor MCP no publicó herramientas: asignalas desde el MCP Hub.");
  } else {
    for (const role of [investigador, verificador]) {
      await fetch(`${API}/api/companies/${company.id}/roles/${role.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolIds: [...role.toolIds, ...delNavegador] }),
      });
    }
    console.log(`  ✓ ${delNavegador.length} herramientas del navegador para Mateo y Paula`);
  }
} catch (error) {
  console.log(
    `  ⚠ no se pudo hablar con el servidor en ${API}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  console.log("    Levantá el servidor y asigná el navegador desde el MCP Hub.");
}

for (const role of roles) {
  console.log(`  · ${role.name} (${role.title}) — ${role.model.modelSlug}`);
}
