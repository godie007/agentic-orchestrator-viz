import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRegistry } from "./registry.js";

/**
 * El registro es el único lugar que sabe qué adaptadores existen, y decide con
 * qué credencial se construye cada uno. Estos tests fijan las dos reglas que no
 * se ven leyendo el archivo: un proveedor sin credencial no se registra, y el
 * de sesión convive con el de API key en vez de reemplazarlo.
 */

const clavePrevia = process.env["ANTHROPIC_API_KEY"];

beforeEach(() => {
  delete process.env["ANTHROPIC_API_KEY"];
});

afterEach(() => {
  if (clavePrevia === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = clavePrevia;
});

describe("buildRegistry", () => {
  it("no registra nada sin credenciales", () => {
    expect(buildRegistry({}).list()).toHaveLength(0);
  });

  it("no registra Claude (sesión) mientras el interruptor esté apagado", () => {
    // La credencial vive en el perfil de disco, así que no hay nada en el
    // entorno de lo que deducir la intención: si no se prende, no va.
    expect(buildRegistry({}).has("claude-sesion")).toBe(false);
    expect(buildRegistry({ ORQ_CLAUDE_SESION: "0" }).has("claude-sesion")).toBe(false);
    expect(buildRegistry({ ORQ_CLAUDE_SESION: "" }).has("claude-sesion")).toBe(false);
  });

  it("lo registra con las formas usuales de decir que sí", () => {
    for (const valor of ["1", "true", "TRUE", " si ", "sí"]) {
      expect(buildRegistry({ ORQ_CLAUDE_SESION: valor }).has("claude-sesion")).toBe(true);
    }
  });

  it("no registra Claude Code (suscripción) sin el interruptor", () => {
    // Requiere el CLI instalado y logueado en la máquina; no se infiere del
    // entorno: hay que prenderlo explícito.
    expect(buildRegistry({}).has("claude-code")).toBe(false);
    expect(buildRegistry({ ORQ_CLAUDE_CODE: "" }).has("claude-code")).toBe(false);
  });

  it("registra Claude Code cuando se prende el interruptor", () => {
    const provider = buildRegistry({ ORQ_CLAUDE_CODE: "1" }).get("claude-code");
    expect(provider.id).toBe("claude-code");
    expect(provider.label.toLowerCase()).toContain("suscripción");
  });

  it("convive con el proveedor de API key en vez de reemplazarlo", () => {
    // Es la razón de que sea un id aparte: un rol elige proveedor por id, así
    // que sólo separados se le puede dar la sesión a un agente y la clave al
    // resto.
    const registry = buildRegistry({
      ANTHROPIC_API_KEY: "sk-ant-de-prueba",
      ORQ_CLAUDE_SESION: "1",
    });

    expect(registry.has("anthropic")).toBe(true);
    expect(registry.has("claude-sesion")).toBe(true);
    expect(registry.get("claude-sesion").label).toBe("Claude (sesión)");
    expect(registry.get("anthropic").label).toBe("Anthropic");
  });

  it("saca del entorno una ANTHROPIC_API_KEY vacía al prender la sesión", () => {
    // Una clave vacía gana su lugar en la cadena de credenciales del SDK y
    // autentica con una clave en blanco: la sesión nunca se usaría y el error
    // sería un 401 sin explicación. `.env.example` la trae vacía, así que
    // copiarlo encima basta para caer acá.
    process.env["ANTHROPIC_API_KEY"] = "";

    const registry = buildRegistry({ ANTHROPIC_API_KEY: "", ORQ_CLAUDE_SESION: "1" });

    expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(registry.has("claude-sesion")).toBe(true);
    // Vacía tampoco alcanzaba para el proveedor de API key, así que borrarla no
    // le costó nada a nadie.
    expect(registry.has("anthropic")).toBe(false);
  });

  it("no toca una ANTHROPIC_API_KEY que sí tiene valor", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-de-prueba";

    buildRegistry({ ANTHROPIC_API_KEY: "sk-ant-de-prueba", ORQ_CLAUDE_SESION: "1" });

    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-de-prueba");
  });

  it("un token OAuth viaja como Bearer y con el beta que exige la API", () => {
    // Pasar de clave a token no es cambiar un valor: cambia el header de
    // `x-api-key` a `Authorization: Bearer` **y** exige el beta
    // `oauth-2025-04-20`. Sin ese beta, `/v1/messages` rechaza un token válido.
    const provider = buildRegistry({
      ORQ_CLAUDE_SESION: "1",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-de-prueba",
    }).get("claude-sesion") as unknown as {
      client: {
        authToken: string | null;
        apiKey: string | null;
        _options: { defaultHeaders?: Record<string, string> };
      };
    };

    expect(provider.client.authToken).toBe("sk-ant-oat01-de-prueba");
    expect(provider.client.apiKey).toBeNull();
    expect(provider.client._options.defaultHeaders?.["anthropic-beta"]).toBe(
      "oauth-2025-04-20",
    );
  });

  it("con API key no manda el beta de OAuth", () => {
    // El beta va sólo cuando la credencial es un token: mandarlo con una clave
    // estática sería declarar un modo de autenticación que no se está usando.
    const provider = buildRegistry({ ANTHROPIC_API_KEY: "sk-ant-de-prueba" }).get(
      "anthropic",
    ) as unknown as {
      client: { apiKey: string | null; _options: { defaultHeaders?: Record<string, string> } };
    };

    expect(provider.client.apiKey).toBe("sk-ant-de-prueba");
    expect(provider.client._options.defaultHeaders?.["anthropic-beta"]).toBeUndefined();
  });

  it("nombra los proveedores configurados cuando se pide uno que no está", () => {
    const registry = buildRegistry({ ORQ_CLAUDE_SESION: "1" });
    expect(() => registry.get("openai")).toThrow(/claude-sesion/);
  });
});
