import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry, type LlmProvider } from "@orq/llm";
import type { ProviderId } from "@orq/shared";
import { Store } from "../db.js";
import { Runtime } from "../runtime.js";
import type { Env } from "../env.js";

/**
 * El arnés de los tests del servidor: tmpdir + Store SQLite real + Runtime.
 *
 * Estaba duplicado inline en `equipo.test.ts` y `roles-vivos.test.ts`, y cada
 * archivo nuevo lo volvía a copiar. Acá vive una sola vez; el que necesita un
 * proveedor guionado registra el `FakeProvider` de `@orq/engine` encima.
 */

export function envDePrueba(base: string): Env {
  return {
    port: 0,
    databaseUrl: join(base, "db.sqlite"),
    proyectosDir: join(base, "proyectos"),
    exportsDir: join(base, "exports"),
    musicaDir: join(base, "musica"),
    contextoDir: join(base, "contexto"),
    defaultBudgetUsd: 1,
    defaultMaxTicks: 10,
    agentConcurrency: 1,
    emailWebhookUrl: null,
    appUrl: "http://localhost:5173",
    apiUrl: "http://localhost:3001",
    misionTickMs: 60_000,
  };
}

export function proveedorFalso(id: ProviderId = "openai"): LlmProvider {
  return {
    id,
    label: id,
    listModels: async () => [],
    healthCheck: async () => ({ ok: true, detail: "" }),
    // eslint-disable-next-line require-yield
    chat: async function* () {
      throw new Error("no se usa: registrá un FakeProvider guionado si el test corre turnos");
    },
  };
}

export interface EntornoDePrueba {
  dir: string;
  store: Store;
  providers: ProviderRegistry;
  runtime: Runtime;
  cerrar(): void;
}

export function armarEntorno(extraProviders: LlmProvider[] = []): EntornoDePrueba {
  const dir = mkdtempSync(join(tmpdir(), "orq-server-"));
  const store = new Store(join(dir, "test.sqlite"));
  const providers = new ProviderRegistry();
  providers.register(proveedorFalso());
  for (const provider of extraProviders) providers.register(provider);
  const runtime = new Runtime(store, providers, envDePrueba(dir));
  return {
    dir,
    store,
    providers,
    runtime,
    cerrar() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
