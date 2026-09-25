import { buildRegistry } from "@orq/llm";
import { Store } from "./db.js";
import { loadEnv } from "./env.js";
import { Runtime } from "./runtime.js";
import { construirApp } from "./app.js";
import { MisionScheduler } from "./misiones.js";

const env = loadEnv();
const store = new Store(env.databaseUrl);
const providers = buildRegistry(process.env);
const runtime = new Runtime(store, providers, env);
const misiones = new MisionScheduler(store, runtime, runtime.correo, env.appUrl, env.misionTickMs);

// El armado del Fastify vive en `construirApp`, compartido con los tests.
const app = await construirApp(
  { store, runtime, providers, misiones },
  { logger: { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } } },
);

// Una corrida no sobrevive al reinicio: su estado vivo está en memoria. Con un
// apagado ordenado quedan en `stopped`, pero una caída dura las dejaba en
// `running` para siempre — la UI mostraba una corrida en curso que no existe, y
// las misiones de esa empresa quedaban bloqueadas por `tieneCorridaViva`.
const huerfanas = store.sanearCorridasHuerfanas();
if (huerfanas > 0) {
  app.log.warn(
    `${huerfanas} corrida(s) habían quedado marcadas como vivas de un arranque anterior: ` +
      `se cerraron. Su traza y sus entregables siguen; el trabajo abierto lo hereda la ` +
      `próxima corrida de esa empresa.`,
  );
}

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
