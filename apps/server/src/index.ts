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
// Antes de armar la app: ningún MCP puede arrancar con una ruta del layout viejo.
const migracion = runtime.migrarLayout();
runtime.directorios.prepararRaiz();
// Worktrees cuya carpeta ya no está: git los olvida para que no bloqueen ramas.
await runtime.repos.podar(store.listCompanies().map((company) => company.id));
// Servicios de la vista previa que quedaron vivos de un servidor anterior (un
// reinicio de `tsx watch` no los mata: van en su propio grupo de procesos).
const huerfanos = await runtime.servicios.barrerHuerfanos();
// Y los de este servidor mueren con él, se cierre como se cierre.
process.on("exit", () => runtime.servicios.detenerTodos());
const misiones = new MisionScheduler(store, runtime, runtime.correo, env.appUrl, env.misionTickMs);

// El armado del Fastify vive en `construirApp`, compartido con los tests.
const app = await construirApp(
  { store, runtime, providers, misiones },
  {
    logger: { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } } },
    origenes: [
      new URL(env.appUrl).origin,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      `http://localhost:${env.port}`,
      `http://127.0.0.1:${env.port}`,
    ],
  },
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

if (huerfanos > 0) {
  app.log.warn(`Se cerraron ${huerfanos} servicio(s) de vista previa que había dejado vivos el servidor anterior.`);
}
if (migracion.movidas.length > 0) {
  app.log.info(
    `Salida mudada al layout por proyecto: ${migracion.movidas
      .map((m) => m.destino)
      .join(", ")}. Servidores MCP con rutas reescritas: ${migracion.mcpReescritos}.`,
  );
}
if (migracion.enConflicto.length > 0) {
  app.log.warn(
    `Estas empresas tienen salida en data/exports y en su carpeta de proyecto: no se ` +
      `fusionaron solas. Revisalas a mano: ${migracion.enConflicto.join(", ")}.`,
  );
}
if (migracion.sinEmpresa.length > 0) {
  app.log.warn(
    `Quedan ${migracion.sinEmpresa.length} carpeta(s) en ${env.exportsDir} sin empresa ` +
      `detrás (${migracion.sinEmpresa.join(", ")}). No se tocaron.`,
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
