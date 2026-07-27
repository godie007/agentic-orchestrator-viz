import { Store } from "./db.js";
import { loadEnv } from "./env.js";

/**
 * Aplica el esquema a la base y muestra en qué estado quedó.
 *
 * No hay migraciones versionadas: el esquema es idempotente (`CREATE TABLE IF
 * NOT EXISTS`) y el constructor de `Store` lo aplica solo. Este script existe
 * para poder crear o verificar la base **sin levantar el servidor ni sembrar
 * datos** —útil al clonar el repo, al apuntar `DATABASE_URL` a otro archivo, o
 * para confirmar que una base existente tiene todas las tablas—.
 *
 *   npm run db:migrate
 *
 * Si algún día hacen falta migraciones de verdad —renombrar una columna, mover
 * datos— este es el lugar donde entran, antes de que el esquema se aplique.
 */

const env = loadEnv();
const store = new Store(env.databaseUrl);

try {
  const tablas = store.tableCounts();
  const ancho = Math.max(...tablas.map((tabla) => tabla.name.length));

  console.log(`Base: ${env.databaseUrl}`);
  console.log(`Esquema aplicado — ${tablas.length} tablas.\n`);
  for (const tabla of tablas) {
    console.log(`  ${tabla.name.padEnd(ancho)}  ${String(tabla.rows).padStart(6)} filas`);
  }

  const vacia = tablas.every((tabla) => tabla.rows === 0);
  if (vacia) console.log("\nLa base está vacía. `npm run db:seed` carga la empresa de ejemplo.");
} finally {
  store.close();
}
