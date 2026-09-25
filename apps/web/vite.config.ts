import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // El puerto del servidor sale del mismo .env que usa Fastify (en la raíz del
  // monorepo): fijo acá, cambiar PORT dejaba a la UI hablándole a otro proceso.
  const env = loadEnv(mode, "../..", "");
  const puertoServidor = env.PORT ?? process.env.PORT ?? "3001";

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // Sin esto Vite se corre de puerto en silencio cuando el 5173 está ocupado
      // y quedan dos instancias: una sirviendo y otra que creés que estás usando.
      strictPort: true,
      proxy: {
        // El proxy evita CORS en desarrollo y, sobre todo, deja pasar los
        // streams SSE sin buffering, que es de lo que vive toda la UI en vivo.
        "/api": {
          target: `http://127.0.0.1:${puertoServidor}`,
          changeOrigin: true,
        },
      },
    },
  };
});
