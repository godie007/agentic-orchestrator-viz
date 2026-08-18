/**
 * Vuelca la memoria de una empresa al árbol de contexto, como vault de Obsidian.
 *
 *   npx tsx scripts/vault-contexto.ts <companyId>
 *
 * La memoria de la base entra en el prompt **topeada**: en la empresa que
 * disparó esto había 58 lecciones y entraban unas diez. Las otras 48 existían y
 * ningún agente podía verlas ni pedirlas — índice sin recuperación. Acá pasan a
 * ser notas por tema, navegables en Obsidian y accesibles con `leer_contexto`.
 *
 * La base sigue siendo la fuente de lo **corto** —la lección de un párrafo que
 * viaja en cada turno—, y el vault, de lo **largo**. No compiten: guardan cosas
 * distintas, y la línea entre las dos la fija la aritmética del proyecto — traer
 * algo cuesta una iteración entera (20.000 a 28.000 tokens de prefijo), así que
 * lo corto conviene mandarlo y lo largo, apuntarlo.
 */
import Database from "better-sqlite3";
import { loadEnv } from "../apps/server/src/env.js";
import { ContextoStore, notaDeAprendizajes, rutaDeTema, tituloDeTema } from "../apps/server/src/contexto.js";

const companyId = process.argv[2];
if (!companyId) {
  console.error("Falta el id de la empresa: npx tsx scripts/vault-contexto.ts <companyId>");
  process.exit(1);
}

const env = loadEnv(process.env);
const db = new Database(env.databaseUrl, { readonly: true });
const contexto = new ContextoStore(env.contextoDir);

const empresa = db.prepare("SELECT data FROM companies WHERE id = ?").get(companyId) as
  | { data: string }
  | undefined;
if (!empresa) {
  console.error(`No existe la empresa "${companyId}".`);
  process.exit(1);
}
const company = JSON.parse(empresa.data) as { name: string; mission: string; context: string };

const learnings = (
  db.prepare("SELECT data FROM learnings WHERE company_id = ?").all(companyId) as { data: string }[]
).map((fila) => JSON.parse(fila.data) as { topic: string; lesson: string; timesConfirmed: number });

/** Un archivo por tema: es como se agrupan en el prompt y como se leen. */
const porTema = new Map<string, typeof learnings>();
for (const learning of learnings) {
  const tema = learning.topic.trim() || "general";
  porTema.set(tema, [...(porTema.get(tema) ?? []), learning]);
}

/** La fecha entra formateada: el render no tiene reloj. */
const hoy = new Date().toISOString().slice(0, 10);

let escritas = 0;
for (const [tema, lecciones] of [...porTema.entries()].sort()) {
  const empresa = { id: companyId, nombre: company.name };
  const guardada = await contexto.escribir(
    empresa,
    rutaDeTema(tema),
    notaDeAprendizajes({
      tema,
      empresa: company.name,
      fecha: hoy,
      lecciones,
      temas: [...porTema.keys()],
    }),
  );
  if (guardada.ok) {
    escritas += 1;
    console.log(`  ${guardada.ruta.padEnd(52)} ${lecciones.length} lección(es)`);
  } else {
    console.error(`  ✗ ${tema}: ${guardada.motivo}`);
  }
}

// La portada del vault: lo primero que se abre en Obsidian.
const mapa = await contexto.mapa({ id: companyId, nombre: company.name });
await contexto.escribir(
  { id: companyId, nombre: company.name },
  "00 - Índice",
  [
    "---",
    `empresa: "${company.name.replace(/"/g, "'")}"`,
    `notas: ${mapa.length}`,
    `actualizada: ${hoy}`,
    "tags:",
    "  - orquestador/indice",
    "---",
    "",
    `# ${company.name}`,
    "",
    company.mission,
    "",
    "## Qué es esto",
    "",
    "El árbol de contexto de esta empresa. Lo escriben los agentes mientras trabajan y lo podés",
    "corregir a mano: se lee tal cual está. Lo corto —una lección de un párrafo— vive en la base",
    "y viaja en el prompt de cada turno; acá vive lo largo, que se abre cuando hace falta.",
    "",
    "## Notas",
    "",
    ...mapa
      .filter((n) => !n.ruta.startsWith("00 - "))
      .map((n) => `- [[${n.ruta.replace(/\.md$/, "")}|${tituloDeTema(n.titulo)}]] (${n.caracteres} car.)`),
  ].join("\n"),
);

console.log(`\n${escritas} nota(s) de aprendizajes + índice`);
console.log(`vault: ${contexto.pathFor({ id: companyId, nombre: company.name })}`);
console.log("Abrilo en Obsidian con “Abrir carpeta como vault”.");
