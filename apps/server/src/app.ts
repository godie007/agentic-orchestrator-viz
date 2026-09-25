import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes, type RouteDeps } from "./routes.js";

/**
 * Arma el Fastify con todo registrado, sin escuchar en ningún puerto.
 *
 * Existe para que las rutas se puedan probar con `app.inject` —HTTP de verdad,
 * sin socket— con el mismo armado que producción: `routes.ts` tiene 1.150
 * líneas y cero tests le costaron tres bugs en un solo día. `index.ts` la usa
 * y le agrega lo que sólo tiene sentido en un proceso vivo: logger bonito,
 * saneo de corridas huérfanas, misiones y señales.
 */
export async function construirApp(
  deps: RouteDeps,
  opciones: { logger?: FastifyServerOptions["logger"] } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opciones.logger ?? false,
    // Los entregables que escriben los agentes pueden ser grandes.
    bodyLimit: 10 * 1024 * 1024,
  });
  await app.register(cors, { origin: true });
  await registerRoutes(app, deps);
  return app;
}
