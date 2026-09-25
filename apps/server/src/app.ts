import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { registrarRutasDeCodigo } from "./rutas-codigo.js";
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
  opciones: {
    logger?: FastifyServerOptions["logger"];
    /**
     * Orígenes que pueden llamar a la API desde un navegador. Sin la lista,
     * cualquiera (lo que usan los tests con `inject`, que no tienen origen).
     */
    origenes?: string[];
  } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opciones.logger ?? false,
    // Los entregables que escriben los agentes pueden ser grandes.
    bodyLimit: 10 * 1024 * 1024,
  });
  // CORS cerrado a la app. Con `origin: true` cualquier página abierta en el
  // navegador podía llamar a la API de localhost —y desde que hay vista previa,
  // eso incluye el JavaScript que escribe un agente—. La UI va por el proxy de
  // Vite (mismo origen), así que cerrar no le cuesta nada.
  const permitidos = opciones.origenes ? new Set(opciones.origenes) : null;
  await app.register(cors, {
    origin: permitidos ? (origen, listo) => listo(null, !origen || permitidos.has(origen)) : true,
  });
  await registerRoutes(app, deps);
  registrarRutasDeCodigo(app, deps);
  return app;
}
