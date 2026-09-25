import { describe, expect, it } from "vitest";
import {
  argvDeArranque,
  clasificarServicio,
  conIdsUnicos,
  expandirUrls,
  parsearDotenv,
  redirigirUrlsLocales,
} from "./servicios.js";

/** El monorepo de INSPIA, tal como lo ve la detección. */
const backend = {
  carpeta: "backend",
  paquete: { scripts: { dev: "ts-node-dev src/index.ts", start: "node dist" }, dependencies: { express: "^4" } },
  notas: 0,
  obsidian: false,
  puertoEnv: 3001,
  salud: "/health",
};
const frontend = {
  carpeta: "frontend",
  paquete: { scripts: { dev: "node scripts/legal.mjs && vite" }, devDependencies: { vite: "^6" }, dependencies: { react: "^19" } },
  notas: 1,
  obsidian: false,
  puertoVite: 5173,
};
const mobile = {
  carpeta: "mobile",
  paquete: { scripts: { start: "expo start", web: "expo start --web" }, dependencies: { expo: "~56", "react-dom": "19", "react-native-web": "*" } },
  notas: 3,
  obsidian: false,
};

describe("clasificarServicio", () => {
  it("reconoce el backend de Express, con su puerto y su ruta de salud", () => {
    const s = clasificarServicio(backend)!;
    expect(s).toMatchObject({ id: "backend", tipo: "api", arrancar: ["npm", "run", "dev"], variablePuerto: "PORT", puertoOriginal: 3001, salud: "/health" });
  });

  it("un frontend de Vite se levanta en el puerto asignado y sólo en localhost", () => {
    const s = clasificarServicio(frontend)!;
    expect(s.tipo).toBe("web");
    expect(argvDeArranque(s, 4301)).toEqual(["npm", "run", "dev", "--", "--port", "4301", "--strictPort", "--host", "127.0.0.1"]);
    expect(s.puertoOriginal).toBe(5173);
  });

  it("Expo es móvil aunque traiga react-dom: clasificarlo como web lo arrancaría con el comando equivocado", () => {
    const s = clasificarServicio(mobile)!;
    expect(s.tipo).toBe("movil");
    expect(argvDeArranque(s, 4302)).toEqual(["npm", "run", "web", "--", "--port", "4302"]);
  });

  it("una carpeta de notas de Obsidian es documentación; una raíz con sólo scripts de test no es nada", () => {
    expect(clasificarServicio({ carpeta: "inspia-obsidian", paquete: null, notas: 40, obsidian: false })?.tipo).toBe("docs");
    expect(clasificarServicio({ carpeta: "notas", paquete: null, notas: 4, obsidian: true })?.tipo).toBe("docs");
    expect(clasificarServicio({ carpeta: "src", paquete: null, notas: 2, obsidian: false })).toBeNull();
    expect(clasificarServicio({ carpeta: "", paquete: { scripts: { test: "node --test" } }, notas: 2, obsidian: false })).toBeNull();
  });

  it("dos servicios con el mismo id se desambiguan", () => {
    const a = clasificarServicio(backend)!;
    expect(conIdsUnicos([a, a]).map((s) => s.id)).toEqual(["backend", "backend-2"]);
  });
});

describe("redirigirUrlsLocales", () => {
  const destinos = new Map([
    [3001, "http://127.0.0.1:4300"],
    [5173, "http://127.0.0.1:4301"],
  ]);

  it("el frontend de la vista previa le habla al backend de la vista previa, no al de la persona", () => {
    const r = redirigirUrlsLocales({ VITE_API_URL: "http://localhost:3001/api", VITE_SUPABASE_URL: "https://x.supabase.co" }, destinos);
    expect(r.variables.VITE_API_URL).toBe("http://127.0.0.1:4300/api");
    expect(r.redirecciones).toEqual([{ clave: "VITE_API_URL", antes: "http://localhost:3001/api", despues: "http://127.0.0.1:4300/api" }]);
  });

  it("en una lista de orígenes reescribe sólo el local y conserva el resto", () => {
    const r = redirigirUrlsLocales({ FRONTEND_URL: "http://localhost:5173,http://localhost:5175,https://staging.x.co" }, destinos);
    expect(r.variables.FRONTEND_URL).toBe("http://127.0.0.1:4301,http://localhost:5175,https://staging.x.co");
  });

  it("avisa sólo de las URLs de la propia app que apuntan afuera: no de Supabase, un webhook ni un secreto", () => {
    const r = redirigirUrlsLocales(
      {
        EXPO_PUBLIC_API_URL: "https://inspia.codla.co/api",
        DATABASE_URL: "postgres://u:p@h/db",
        SENTRY_DSN: "https://k@sentry.io/1",
        SUPABASE_URL: "https://x.supabase.co",
        N8N_CERT_DELETE_URL: "https://n8n.codla.co/webhook/x",
      },
      destinos,
    );
    expect(r.externas).toEqual([{ clave: "EXPO_PUBLIC_API_URL", valor: "https://inspia.codla.co/api" }]);
    expect(r.variables.EXPO_PUBLIC_API_URL).toBe("https://inspia.codla.co/api");
  });

  it("un puerto que no es de ningún servicio queda como estaba", () => {
    expect(redirigirUrlsLocales({ X: "http://localhost:9999" }, destinos).variables.X).toBe("http://localhost:9999");
  });
});

describe("parsearDotenv", () => {
  it("entiende comentarios, export, comillas y # dentro de comillas", () => {
    const texto = [
      "# comentario",
      "export PORT=3001",
      'A="con # adentro"',
      "B='simple'",
      "C=valor # comentario",
      'D="linea\\notra"',
      "",
      "no es una variable",
    ].join("\n");
    expect(parsearDotenv(texto)).toEqual({ PORT: "3001", A: "con # adentro", B: "simple", C: "valor", D: "linea\notra" });
  });
});

it("expandirUrls reemplaza {url:id} y deja a la vista lo que no existe", () => {
  const urls = new Map([["backend", "http://127.0.0.1:4300"]]);
  expect(expandirUrls("{url:backend}/api", urls)).toBe("http://127.0.0.1:4300/api");
  expect(expandirUrls("{url:nada}/api", urls)).toBe("{url:nada}/api");
});
