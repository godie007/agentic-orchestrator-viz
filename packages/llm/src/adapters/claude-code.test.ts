import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCodeProvider,
  claudeCodeCatalog,
  construirArgs,
  diagnosticoDelTurno,
  entornoDelCli,
  herramientasPara,
  herramientasPropiasDelCli,
  HERRAMIENTAS_DE_LECTURA,
  ultimoTextoDeAsistente,
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
describe("un turno que el CLI cierra mal no tira el trabajo", () => {
  const linea = (o: unknown): string => JSON.stringify(o);

  it("rescata el último texto del agente", () => {
    // Medido: un verificador hizo 27 llamadas, escribió su entregable y movió
    // su tarea; falló su última llamada, el CLI cortó a las 33 vueltas y el
    // turno entero se registró como fallido y sin resumen.
    const stdout = [
      linea({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "arranco" }] } }),
      linea({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "verificación escrita en verificacion-guion" }] } }),
      linea({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "" }] } }),
      linea({ type: "result", is_error: true }),
    ].join("\n");
    expect(ultimoTextoDeAsistente(stdout)).toBe("verificación escrita en verificacion-guion");
  });

  it("ignora los mensajes sintéticos, que los fabrica el CLI al cortar", () => {
    const stdout = linea({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "corté por límite" }] },
    });
    expect(ultimoTextoDeAsistente(stdout)).toBeNull();
  });

  it("sin una sola palabra del agente no hay nada que rescatar", () => {
    // Ahí el fallo sí es un fallo y tiene que informarse como tal.
    expect(ultimoTextoDeAsistente(linea({ type: "result", is_error: true }))).toBeNull();
    expect(ultimoTextoDeAsistente("")).toBeNull();
  });

  it("aguanta líneas que no son JSON", () => {
    const stdout = ["ruido", linea({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } })].join("\n");
    expect(ultimoTextoDeAsistente(stdout)).toBe("ok");
  });
});

describe("entornoDelCli", () => {
  it("no le pasa credenciales de API al CLI: la suscripción no puede terminar facturando por token", () => {
    const env = entornoDelCli({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      ANTHROPIC_API_KEY: "sk-ant-api",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat",
    });
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/Users/x");
    expect(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
  });
});

describe("modo código", () => {
  const lista = (texto: string) => texto.split(",");

  it("nunca se otorga Bash: los comandos van por ejecutar_comando, que tiene sandbox y deja rastro", () => {
    for (const modo of ["codigo-lectura", "codigo-escritura"] as const) {
      expect(lista(herramientasPara(modo))).not.toContain("Bash");
    }
  });

  it("sin el arriendo no hay nada que escriba; con el arriendo, Edit y Write", () => {
    const lectura = lista(herramientasPara("codigo-lectura"));
    for (const prohibida of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(lectura).not.toContain(prohibida);
    const escritura = lista(herramientasPara("codigo-escritura"));
    expect(escritura).toContain("Edit");
    expect(escritura).toContain("Write");
  });

  it("la salida de la empresa sigue en sólo lectura, como antes", () => {
    expect(herramientasPara("salida-lectura")).toBe(HERRAMIENTAS_DE_LECTURA);
  });

  it("niega explícito Bash y cualquier edición de .git", () => {
    const args = construirArgs({
      prompt: "x",
      model: "sonnet",
      propias: herramientasPara("codigo-escritura"),
      negadas: ["Bash", "Edit(.git/**)", "Write(.git/**)"],
    });
    const negadas = args[args.indexOf("--disallowedTools") + 1] ?? "";
    expect(negadas).toContain("Bash");
    expect(negadas).toContain("Edit(.git/**)");
  });
});

describe("herramientasPropiasDelCli", () => {
  it("cuenta lo que el CLI hizo por su cuenta y deja afuera lo que ya pasó por el puente", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Edito." },
            { type: "tool_use", name: "Edit", input: { file_path: "/wt/src/a.ts", old_string: "x", new_string: "y" } },
            { type: "tool_use", name: "mcp__orq__ejecutar_comando", input: { comando: "npm test" } },
          ],
        },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/wt/b.ts" } }] } }),
    ].join("\n");
    expect(herramientasPropiasDelCli(stdout)).toEqual([
      { nombre: "Edit", ruta: "/wt/src/a.ts" },
      { nombre: "Read", ruta: "/wt/b.ts" },
    ]);
  });
});

describe("turnos que no se cuelgan esperando a una API saturada", () => {
  const linea = (o: unknown): string => JSON.stringify(o);

  it("pide fallback de modelo y eventos parciales (el latido del vigilante)", () => {
    const args = construirArgs({ prompt: "x", model: "opus", propias: "Read", respaldo: "sonnet", parciales: true });
    expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet");
    expect(args).toContain("--include-partial-messages");
    // Un respaldo igual al modelo pedido no es un respaldo.
    expect(construirArgs({ prompt: "x", model: "opus", propias: "Read", respaldo: "opus" })).not.toContain("--fallback-model");
  });

  it("baja los reintentos del CLI a cuatro, salvo que quien corre el servidor diga otra cosa", () => {
    expect(entornoDelCli({})["CLAUDE_CODE_MAX_RETRIES"]).toBe("4");
    expect(entornoDelCli({ CLAUDE_CODE_MAX_RETRIES: "7" })["CLAUDE_CODE_MAX_RETRIES"]).toBe("7");
  });

  it("dice cuándo respondió otro modelo que el pedido", () => {
    const stdout = [
      linea({ type: "system", subtype: "api_retry", attempt: 1 }),
      linea({ type: "system", subtype: "api_retry", attempt: 2 }),
      linea({ type: "system", subtype: "api_retry", attempt: 3 }),
      linea({ type: "result", is_error: false, result: "ok", modelUsage: { "claude-sonnet-5-20260801": {} } }),
    ].join("\n");
    const d = diagnosticoDelTurno(stdout, "opus");
    expect(d.reintentos).toBe(3);
    expect(d.modeloReal).toBe("sonnet");
    expect(d.avisos.join(" ")).toMatch(/opus estaba saturado.*sonnet/);
    expect(d.avisos.join(" ")).toMatch(/reintentó 3 veces/);
  });

  it("avisa cuando la suscripción se acerca a su límite, y calla cuando no", () => {
    const evento = (uso: number, status = "allowed") =>
      linea({
        type: "rate_limit_event",
        rate_limit_info: { status, unifiedWindows: { five_hour: { utilization: uso, resetsAt: 1790318400 }, seven_day: { utilization: 0.1 } } },
      });
    expect(diagnosticoDelTurno(evento(0.35), "opus").avisos).toEqual([]);
    expect(diagnosticoDelTurno(evento(0.86), "opus").avisos.join(" ")).toMatch(/86% de su ventana de 5 horas/);
    expect(diagnosticoDelTurno(evento(1, "rejected"), "opus").avisos.join(" ")).toMatch(/llegó al límite/);
  });

  it("corta un CLI que se queda callado, en vez de esperarlo quince minutos, y guarda la transcripción", async () => {
    // Un "CLI" que arranca, dice hola y después no emite nada más: lo que se
    // veía cuando la API no contestaba.
    const dir = mkdtempSync(join(tmpdir(), "orq-cli-colgado-"));
    const falso = join(dir, "claude-falso.sh");
    writeFileSync(falso, `#!/bin/sh\necho '${linea({ type: "system", subtype: "init" })}'\nsleep 30\n`);
    chmodSync(falso, 0o755);
    const provider = new ClaudeCodeProvider({ command: falso, workspaceDir: dir, silencioMaxMs: 300 });

    const inicio = Date.now();
    await expect(
      (async () => {
        for await (const _ of provider.chat({
          model: "claude-code/opus",
          messages: [{ role: "user", content: "hola" }],
          maxOutputTokens: 100,
        })) {
          // no llega nada
        }
      })(),
    ).rejects.toThrow(/no respondió/);
    expect(Date.now() - inicio).toBeLessThan(10_000);
    const transcripciones = join(dir, "transcripciones");
    expect(existsSync(transcripciones) && readdirSync(transcripciones).length).toBe(1);
  });
});

describe("herramientas del org de entrada, sin ToolSearch", () => {
  it("apaga la búsqueda diferida de herramientas: cada búsqueda era una vuelta entera del loop", () => {
    expect(entornoDelCli({})["ENABLE_TOOL_SEARCH"]).toBe("false");
    expect(entornoDelCli({ ENABLE_TOOL_SEARCH: "auto" })["ENABLE_TOOL_SEARCH"]).toBe("auto");
  });
});
