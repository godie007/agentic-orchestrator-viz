import Fastify from "fastify";
import cors from "@fastify/cors";
import { buildRegistry } from "@orq/llm";
import { Store } from "./db.js";
import { loadEnv } from "./env.js";
import { Runtime } from "./runtime.js";
import { registerRoutes } from "./routes.js";
import { MisionScheduler } from "./misiones.js";

const env = loadEnv();
const store = new Store(env.databaseUrl);
const providers = buildRegistry(process.env);
const runtime = new Runtime(store, providers, env);
const misiones = new MisionScheduler(store, runtime, runtime.correo, env.appUrl, env.misionTickMs);

const app = Fastify({
  logger: { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } },
  // Los entregables que escriben los agentes pueden ser grandes.
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(cors, { origin: true });
await registerRoutes(app, { store, runtime, providers, misiones });

misiones.start();
if (!env.emailWebhookUrl) {
  app.log.warn(
    "Sin N8N_EMAIL_WEBHOOK_URL: las misiones van a correr pero no van a poder avisar por " +
      "correo, y send_email va a fallar diciendo justamente eso.",
  );
}

if (providers.list().length === 0) {
  app.log.warn(
    "No hay ningún proveedor LLM configurado. Copiá .env.example a .env y completá al menos " +
      "una API key; sin eso las corridas fallan al arrancar.",
  );
}

await app.listen({ port: env.port, host: "127.0.0.1" });
app.log.info(
  `Proveedores configurados: ${providers.list().map((p) => p.id).join(", ") || "ninguno"}`,
);

// Cierre ordenado: se cortan las corridas vivas y se bajan los MCP para no
// dejar procesos hijos huérfanos.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      app.log.info("Cerrando…");
      misiones.stop();
      await runtime.shutdown();
      await app.close();
      store.close();
      process.exit(0);
    })();
  });
}
