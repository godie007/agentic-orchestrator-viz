import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
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
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
