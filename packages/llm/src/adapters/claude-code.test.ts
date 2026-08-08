import { describe, expect, it } from "vitest";
import {
  ClaudeCodeProvider,
  claudeCodeCatalog,
  construirArgs,
  HERRAMIENTAS_DE_LECTURA,
} from "./claude-code.js";

describe("claudeCodeCatalog", () => {
  it("expone los alias de modelo con slug claude-code/<alias>", () => {
    const catalog = claudeCodeCatalog("claude-code", "sonnet");
    const slugs = catalog.map((m) => m.slug);
    expect(slugs).toContain("claude-code/sonnet");
    expect(slugs).toContain("claude-code/opus");
    expect(slugs).toContain("claude-code/haiku");
    // Preferido primero y sin repetidos.
    expect(slugs[0]).toBe("claude-code/sonnet");
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("no publica precios: el costo del modelo se cuenta como 0", () => {
    for (const model of claudeCodeCatalog("claude-code", "sonnet")) {
      expect(model.inputPricePerMTok).toBeNull();
      expect(model.outputPricePerMTok).toBeNull();
    }
  });
});

describe("ClaudeCodeProvider", () => {
  it("se identifica con el id claude-code y una etiqueta legible", () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.id).toBe("claude-code");
    expect(provider.label).toContain("suscripción");
  });

  it("listModels devuelve el catálogo sin llamar al CLI", async () => {
    const provider = new ClaudeCodeProvider();
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(3);
  });

  it("marca un `done` con texto y sin tool_calls, para que el engine corte el turno", async () => {
    // El loop del engine rompe al ver cero llamadas. Verificamos que el
    // contrato devuelve exactamente eso.
    const done = await collectStream([{ type: "done", message: { role: "assistant", content: "listo" }, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop", modelSlug: "claude-code/sonnet" }]);
    expect(done.message.content).toBe("listo");
    expect(done.message.toolCalls ?? []).toHaveLength(0);
    expect(done.usage.inputTokens).toBe(0);
    expect(done.usage.outputTokens).toBe(0);
  });
});

describe("el directorio de la empresa se presta en sólo lectura", () => {
  const sesion = (cwd?: string) => ({
    socketPath: "/tmp/x.sock",
    serverName: "orq",
    allowedTools: ["mcp__orq__write_output_file", "mcp__orq__read_artifact"],
    ...(cwd ? { cwd } : {}),
    close: async () => {},
  });

  const permitidas = (args: string[]): string[] =>
    (args[args.indexOf("--allowedTools") + 1] ?? "").split(",");

  it("sobre el directorio de la empresa no se otorga nada que escriba", () => {
    // Escribir tiene que seguir yendo por `write_output_file`: es lo único que
    // sanea la ruta segmento por segmento, anota la procedencia y respeta la
    // jerarquía de borrado. Un `Write` del CLI saltearía las tres.
    const args = construirArgs({
      prompt: "hola",
      model: "sonnet",
      propias: HERRAMIENTAS_DE_LECTURA,
      session: sesion("/data/exports/cmp_1"),
      configPath: "/tmp/mcp.json",
    });
    for (const prohibida of ["Write", "Edit", "Bash", "NotebookEdit"]) {
      expect(permitidas(args)).not.toContain(prohibida);
    }
  });

  it("pero sí lo necesario para mirar: leer, listar y buscar", () => {
    const args = construirArgs({
      prompt: "hola",
      model: "sonnet",
      propias: HERRAMIENTAS_DE_LECTURA,
      session: sesion("/data/exports/cmp_1"),
      configPath: "/tmp/mcp.json",
    });
    for (const necesaria of ["Read", "Glob", "Grep"]) {
      expect(permitidas(args)).toContain(necesaria);
    }
  });

  it("las herramientas del org viajan junto a las propias", () => {
    const args = construirArgs({
      prompt: "hola",
      model: "sonnet",
      propias: HERRAMIENTAS_DE_LECTURA,
      session: sesion("/data/exports/cmp_1"),
      configPath: "/tmp/mcp.json",
    });
    expect(permitidas(args)).toContain("mcp__orq__write_output_file");
    expect(args).toContain("--strict-mcp-config");
  });

  it("sin sesión del org no se declara ninguna config de MCP", () => {
    const args = construirArgs({ prompt: "hola", model: "sonnet", propias: "Read" });
    expect(args).not.toContain("--mcp-config");
    expect(permitidas(args)).toEqual(["Read"]);
  });
});

describe("corte por tiempo", () => {
  it("declara un corte mucho más largo que el de una API", () => {
    // El motor usa 120 s por defecto, que alcanzan para una API que contesta en
    // segundos. Acá se espera un agent loop entero: con ese corte, cada turno
    // moría por tiempo justo mientras el agente trabajaba.
    const provider = new ClaudeCodeProvider();
    expect(provider.timeoutMs).toBeGreaterThan(120_000);
  });

  it("abortar cierra la promesa en vez de dejar el turno colgado", async () => {
    // La regresión que colgó una corrida entera: `onAbort` mataba el proceso y
    // el handler de `exit` salía por `if (aborted) return`, así que la promesa
    // no se resolvía nunca. La corrida quedaba en un ciclo, sin proceso vivo y
    // sin `agent.turn_end`, para siempre.
    const provider = new ClaudeCodeProvider({ command: "/bin/sleep" });
    const signal = AbortSignal.abort();

    await expect(
      (async () => {
        for await (const _ of provider.chat({
          model: "claude-code/sonnet",
          messages: [{ role: "user", content: "hola" }],
          maxOutputTokens: 100,
          signal,
        })) {
          // No debería llegar ningún evento: lo que importa es que termine.
        }
      })(),
    ).rejects.toThrow(/cortó/);
  });
});

interface DoneLike {
  type: "done";
  message: { role: string; content: string; toolCalls?: unknown[] };
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
  modelSlug: string;
}

async function collectStream(events: DoneLike[]): Promise<DoneLike> {
  return events[0] as DoneLike;
}

// `lastResult` se prueba indirectamente vía healthCheck del registro; el parseo
// real de stream-json queda cubierto por los tests de integración que requieren
// el CLI instalado (ver scripts/check-llm.ts).