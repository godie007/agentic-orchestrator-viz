import { describe, expect, it } from "vitest";
import {
  OpenCodeProvider,
  catalogoOpenCode,
  configDelTurno,
  construirArgs,
  hayTexto,
  leerSalida,
  normalizarSlug,
} from "./opencode.js";
import { resolverTierEstatico } from "../modelos-claude.js";
import type { OrgToolsSession } from "../types.js";

const sesion = (cwd?: string): OrgToolsSession => ({
  socketPath: "/tmp/orq.sock",
  serverName: "orq",
  allowedTools: ["mcp__orq__send_message", "mcp__orq__write_output_file"],
  ...(cwd ? { cwd } : {}),
  close: async () => {},
});

describe("catalogoOpenCode", () => {
  it("usa los slugs del CLI tal cual: ya vienen namespaceados", () => {
    const catalogo = catalogoOpenCode("opencode", ["opencode/claude-sonnet-5", "zai/glm-5"]);
    expect(catalogo.map((m) => m.slug)).toEqual(["opencode/claude-sonnet-5", "zai/glm-5"]);
    // Volver a prefijarlos daría `opencode/opencode/…`, que el CLI no conoce.
    expect(catalogo.every((m) => !m.slug.startsWith("opencode/opencode/"))).toBe(true);
  });

  it("no publica precios y no declara tool-calling: el CLI corre su propio loop", () => {
    for (const model of catalogoOpenCode("opencode", ["opencode/claude-opus-5"])) {
      expect(model.inputPricePerMTok).toBeNull();
      expect(model.outputPricePerMTok).toBeNull();
      expect(model.supportsTools).toBe(false);
    }
  });

  it("deduplica", () => {
    expect(catalogoOpenCode("opencode", ["a/b", "a/b"])).toHaveLength(1);
  });
});

describe("OpenCodeProvider", () => {
  it("se identifica con el id opencode y delega el turno", () => {
    const provider = new OpenCodeProvider();
    expect(provider.id).toBe("opencode");
    expect(provider.label).toContain("suscripción");
    // Es lo que hace que el motor le preste el puente MCP del org.
    expect(provider.delegaElTurno).toBe(true);
  });
});

describe("el directorio de la empresa se presta en sólo lectura", () => {
  it("con directorio de empresa no habilita ninguna herramienta que escriba", () => {
    const config = configDelTurno({ soloLectura: true, session: sesion("/data/exports/acme") });
    const tools = (config["agent"] as Record<string, { tools: Record<string, boolean> }>)["orq"]!
      .tools;
    for (const prohibida of ["write", "edit", "patch", "bash"]) {
      expect(tools[prohibida] ?? false).toBe(false);
    }
    expect(tools["read"]).toBe(true);
    expect(tools["grep"]).toBe(true);
  });

  it("además niega explícitamente edit y bash: con --auto, lo que no se niega se aprueba", () => {
    const config = configDelTurno({ soloLectura: true, session: sesion("/data/exports/acme") });
    const permiso = (config["agent"] as Record<string, { permission: Record<string, string> }>)[
      "orq"
    ]!.permission;
    expect(permiso["edit"]).toBe("deny");
    expect(permiso["bash"]).toBe("deny");
  });

  it("en su propia carpeta sí puede escribir: ahí no hay nada que proteger", () => {
    const config = configDelTurno({ soloLectura: false });
    const tools = (config["agent"] as Record<string, { tools: Record<string, boolean> }>)["orq"]!
      .tools;
    expect(tools["write"]).toBe(true);
    expect(tools["bash"]).toBe(true);
  });

  it("barre con * las herramientas heredadas de la config global del usuario", () => {
    // La config de opencode se **fusiona**: sin el barrido, los servidores MCP
    // globales le prestarían al agente vías de escribir que el org no ve.
    const config = configDelTurno({ soloLectura: true, session: sesion("/data/exports/acme") });
    const tools = (config["agent"] as Record<string, { tools: Record<string, boolean> }>)["orq"]!
      .tools;
    expect(tools["*"]).toBe(false);
    // Y habilita las del org, que opencode nombra `<servidor>_<tool>`.
    expect(tools["orq*"]).toBe(true);
  });

  it("declara el servidor MCP del org apuntando al socket de la sesión", () => {
    const config = configDelTurno({ soloLectura: true, session: sesion("/data/exports/acme") });
    const mcp = config["mcp"] as Record<string, { type: string; environment: Record<string, string> }>;
    expect(mcp["orq"]?.type).toBe("local");
    expect(mcp["orq"]?.environment["ORQ_SOCKET"]).toBe("/tmp/orq.sock");
  });

  it("sin sesión no declara ningún MCP", () => {
    expect(configDelTurno({ soloLectura: false })["mcp"]).toBeUndefined();
  });
});

describe("construirArgs", () => {
  it("corre sin plugins y sin quedarse esperando un permiso interactivo", () => {
    const args = construirArgs({ prompt: "hola", model: "opencode/claude-sonnet-5" });
    expect(args[0]).toBe("run");
    expect(args).toContain("--pure");
    // Sin `--auto` el proceso espera una respuesta que nadie va a dar y el
    // turno se cuelga entero.
    expect(args).toContain("--auto");
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args[args.indexOf("--model") + 1]).toBe("opencode/claude-sonnet-5");
    // El mensaje va último y como posicional.
    expect(args.at(-1)).toBe("hola");
  });
});

describe("leerSalida", () => {
  const linea = (obj: unknown): string => JSON.stringify(obj);

  it("devuelve el último bloque de texto y suma el consumo de todos los pasos", () => {
    const stdout = [
      linea({ type: "text", part: { text: "arranco" } }),
      linea({
        type: "step_finish",
        part: { tokens: { input: 100, output: 20, cache: { read: 900, write: 100 } }, cost: 0.01 },
      }),
      linea({ type: "text", part: { text: "listo, entregué el informe" } }),
      linea({ type: "step_finish", part: { tokens: { input: 50, output: 10 }, cost: 0.02 } }),
    ].join("\n");

    const { texto, uso, costoUsd } = leerSalida(stdout);
    expect(texto).toBe("listo, entregué el informe");
    // La entrada incluye lo cacheado: es contexto que igual se envió.
    expect(uso.inputTokens).toBe(100 + 1000 + 50);
    expect(uso.cachedInputTokens).toBe(1000);
    expect(uso.outputTokens).toBe(30);
    expect(costoUsd).toBeCloseTo(0.03);
  });

  it("cuenta el razonamiento como salida", () => {
    const stdout = linea({
      type: "step_finish",
      part: { tokens: { input: 1, output: 2, reasoning: 5 } },
    });
    expect(leerSalida(stdout).uso.outputTokens).toBe(7);
  });

  it("un turno sin texto pero con error falla con el detalle del CLI", () => {
    const stdout = linea({
      type: "error",
      error: { name: "APIError", data: { message: "Insufficient balance" } },
    });
    // Sin esto, una credencial sin saldo se ve como un turno vacío y la corrida
    // muere sin decir por qué.
    expect(() => leerSalida(stdout)).toThrowError(/Insufficient balance/);
  });

  it("ignora las líneas que no son JSON", () => {
    const stdout = ["ruido del arranque", linea({ type: "text", part: { text: "ok" } })].join("\n");
    expect(leerSalida(stdout).texto).toBe("ok");
  });
});

describe("normalizarSlug", () => {
  it("corrige el id del proveedor pegado dos veces", () => {
    expect(normalizarSlug("opencode/opencode/claude-opus-5")).toBe("opencode/claude-opus-5");
  });

  it("deja pasar los slugs de otros proveedores del CLI", () => {
    expect(normalizarSlug("zai/glm-5")).toBe("zai/glm-5");
    expect(normalizarSlug("opencode/claude-sonnet-5")).toBe("opencode/claude-sonnet-5");
  });
});

describe("tiers", () => {
  const catalogo = catalogoOpenCode("opencode", [
    "opencode/claude-haiku-4-5",
    "opencode/claude-sonnet-5",
    "opencode/claude-opus-5",
  ]);

  it("resuelve por el mapa curado: sin precios, las bandas no pueden", () => {
    expect(resolverTierEstatico("opencode", "cheap", catalogo)?.model.slug).toBe(
      "opencode/claude-haiku-4-5",
    );
    expect(resolverTierEstatico("opencode", "standard", catalogo)?.model.slug).toBe(
      "opencode/claude-sonnet-5",
    );
    expect(resolverTierEstatico("opencode", "smart", catalogo)?.model.slug).toBe(
      "opencode/claude-opus-5",
    );
  });

  it("free resuelve a un modelo que no descuenta saldo", () => {
    // Es el único tier que se puede afirmar sin saber en qué plan está la
    // cuenta: Zen los marca con el sufijo `-free`.
    const conFree = catalogoOpenCode("opencode", [
      "opencode/claude-opus-5",
      "opencode/deepseek-v4-flash-free",
    ]);
    expect(resolverTierEstatico("opencode", "free", conFree)?.model.slug).toBe(
      "opencode/deepseek-v4-flash-free",
    );
  });

  it("cae al equivalente de otra credencial si el plan de Zen no está", () => {
    // El catálogo depende de con qué se haya logueado la máquina.
    const conSesion = catalogoOpenCode("opencode", ["anthropic/claude-sonnet-5"]);
    expect(resolverTierEstatico("opencode", "standard", conSesion)?.model.slug).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});

describe("un turno cortado por tiempo no tira el trabajo", () => {
  const linea = (o: unknown): string => JSON.stringify(o);

  it("reconoce que hubo texto emitido antes del corte", () => {
    const parcial = [
      linea({ type: "step_start", part: {} }),
      linea({ type: "text", part: { text: "documenté el ciclo hasta la NC" } }),
    ].join("\n");
    expect(hayTexto(parcial)).toBe(true);
  });

  it("un turno que sólo llamó herramientas no tiene nada que rescatar", () => {
    // Sin texto no hay resumen: ahí el corte sí es un fallo, y se informa.
    const soloTools = linea({ type: "tool_use", part: { state: { status: "completed" } } });
    expect(hayTexto(soloTools)).toBe(false);
    expect(hayTexto("")).toBe(false);
  });
});
