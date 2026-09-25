/**
 * Audita el proceso de una corrida ya persistida, no sólo su artefacto.
 *
 *   npx tsx scripts/auditar-corrida.ts --run=<runId> [--db=<ruta>]
 *
 * Existe porque el resultado correcto de una corrida puede esconder un
 * proceso corrupto: un rol con `export_pdf` asignada dejó una vez un
 * `INSTRUCCIONES-PDF.txt` para que una persona imprimiera a mano, e informó
 * la tarea como completada. La corrida cerró "exitosa" y nadie lo hubiera
 * visto sin mirar qué herramientas se ejecutaron de verdad, tick por tick.
 * `auditarCorrida` (`apps/server/src/auditoria.ts`) hace ese cruce sobre la
 * traza; este script sólo la trae de la base y la imprime legible.
 */
import Database from "better-sqlite3";
import { auditarCorrida } from "../apps/server/src/auditoria.js";
import { fromRoot, loadEnv } from "../apps/server/src/env.js";
import type { TraceEvent } from "@orq/shared";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, ...rest] = a.slice(2).split("=");
      return [k, rest.join("=")] as [string, string];
    }),
);

const runId = args.get("run");
if (!runId) {
  console.error("Falta la corrida: npx tsx scripts/auditar-corrida.ts --run=<runId> [--db=<ruta>]");
  process.exit(1);
}

const env = loadEnv(process.env);
const rutaDb = fromRoot(args.get("db") ?? env.databaseUrl);
const db = new Database(rutaDb, { readonly: true });

const fila = db.prepare("SELECT data FROM events WHERE run_id = ? ORDER BY seq").all(runId) as {
  data: string;
}[];
if (fila.length === 0) {
  console.error(`No hay eventos para la corrida "${runId}" en ${rutaDb}.`);
  process.exit(1);
}
const eventos = fila.map((f) => JSON.parse(f.data) as TraceEvent);

const informe = auditarCorrida(eventos);

const EMOJI: Record<string, string> = { alta: "🔴", media: "🟡", info: "🔵" };
const ORDEN = { alta: 0, media: 1, info: 2 } as const;

console.log(`\nAuditoría de la corrida ${runId} (${eventos.length} eventos)\n`);

if (informe.hallazgos.length === 0) {
  console.log("Sin hallazgos.\n");
} else {
  const ordenados = [...informe.hallazgos].sort((a, b) => ORDEN[a.severidad] - ORDEN[b.severidad]);
  for (const h of ordenados) {
    const ubicacion = [h.tick !== null ? `tick ${h.tick}` : null, h.roleId ? `rol ${h.roleId}` : null]
      .filter(Boolean)
      .join(", ");
    console.log(`${EMOJI[h.severidad]} [${h.regla}]${ubicacion ? ` (${ubicacion})` : ""}`);
    console.log(`   ${h.detalle}\n`);
  }
}

console.log("--- métricas ---");
console.log(`llamadas: ${informe.metricas.llamadas}  fallidas: ${informe.metricas.fallidas}`);
for (const [roleId, m] of Object.entries(informe.metricas.porRol).sort()) {
  console.log(`  ${roleId.padEnd(24)} llamadas=${m.llamadas} fallidas=${m.fallidas}`);
}
console.log("");
