import { describe, expect, it } from "vitest";
import { aplicarRed, archivosDelStack, fallaDe, type Registro } from "./sonda.js";

describe("inspector de la vista previa", () => {
  it("saca del stack los archivos propios con su línea, sin dependencias", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "    at FotoGrid (http://127.0.0.1:4301/src/components/FotoGrid.tsx?t=1727000000:42:17)",
      "    at renderWithHooks (http://127.0.0.1:4301/node_modules/.vite/deps/chunk-ABC.js?v=1:1100:26)",
      "    at http://127.0.0.1:4301/src/pages/Fotos.tsx:88:5",
      "    at FotoGrid (http://127.0.0.1:4301/src/components/FotoGrid.tsx:50:1)",
    ].join("\n");
    expect(archivosDelStack(stack)).toEqual([
      { ruta: "src/components/FotoGrid.tsx", linea: 42 },
      { ruta: "src/pages/Fotos.tsx", linea: 88 },
    ]);
  });

  it("un pedido fallido se cuenta con método, estado, lo enviado y la respuesta", () => {
    let r: Registro[] = [];
    r = aplicarRed(r, { fase: "inicio", id: 1, metodo: "POST", url: "http://127.0.0.1:4300/api/photos/upload", cuerpo: "multipart — foto: a.jpg (10 B, image/jpeg)", at: 1, ruta: "/fotos" });
    r = aplicarRed(r, { fase: "fin", id: 1, estado: 413, ms: 12, respuesta: '{"error":"FILE_TOO_LARGE"}' });
    const f = fallaDe(r[0]!);
    expect(f.titulo).toBe("POST /api/photos/upload → 413");
    expect(f.detalle).toContain("Enviado: multipart — foto: a.jpg");
    expect(f.detalle).toContain("FILE_TOO_LARGE");
    expect(f.pagina).toBe("/fotos");
  });
});
