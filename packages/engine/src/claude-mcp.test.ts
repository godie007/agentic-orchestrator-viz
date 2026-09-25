import { describe, expect, it } from "vitest";
import { connect } from "node:net";
import type { RegisteredTool } from "@orq/tools";
import type { EventBus } from "./events.js";
import type { RunState } from "./state.js";
import { createClaudeMcpBridge } from "./claude-mcp.js";

/**
 * Puente MCP hacia las herramientas del org para el proveedor `claude-code`.
 *
 * Claude Code corre su propio loop y no devuelve `tool_calls`, así que el
 * puente le expone las tools del org como un servidor MCP que vive en el
 * proceso del engine y ejecuta con la misma maquinaria (`executeOne`). Este
 * test habla el protocolo MCP por el socket (sin invocar al CLI real): valida
 * que el servidor liste las tools y que una llamada delegue a la `execute` real.
 */

function habitada(
  nombre: string,
  out = "ok",
  after?: (args: Record<string, unknown>) => void,
): RegisteredTool {
  return {
    name: nombre,
    description: `Herramienta de prueba ${nombre}.`,
    inputSchema: { type: "object", properties: { valor: { type: "string" } } },
    origin: "coordination",
    readOnly: true,
    requiresApproval: false,
    execute: async (args) => {
      after?.(args);
      return { ok: true, content: `${out}:${String(args.valor ?? "")}` };
    },
  };
}

/** Cliente MCP mínimo: inicializa el protocolo y resuelve la operación pedida. */
function callMCP(
  socketPath: string,
  op: "list" | "call",
  extra?: { name: string; args: Record<string, unknown> },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    let buffer = "";
    const ids = { init: 1, list: 2, call: 3 };
    let done = false;

    const send = (obj: unknown) => socket.write(JSON.stringify(obj) + "\n");
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      socket.end();
      resolve(value);
    };

    socket.on("connect", () => {
      send({
        jsonrpc: "2.0",
        id: ids.init,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    });

    socket.on("data", (raw: string) => {
      buffer += raw;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === ids.init) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          if (op === "list") {
            send({ jsonrpc: "2.0", id: ids.list, method: "tools/list", params: {} });
          } else if (extra) {
            send({
              jsonrpc: "2.0",
              id: ids.call,
              method: "tools/call",
              params: { name: extra.name, arguments: extra.args },
            });
          }
        } else if (msg.id === ids.list || msg.id === ids.call) {
          finish(msg.error ?? msg.result);
        }
      }
    });
    socket.on("error", reject);
    socket.on("end", () => finish(undefined));
  });
}

describe("createClaudeMcpBridge", () => {
  function bridgePara(byName: Map<string, RegisteredTool>) {
    // Las colecciones van vacías pero presentes: los emisores de eventos de
    // efecto (`write_artifact`, `assign_task`…) leen la última entrada.
    const state = {
      forActor: () => ({}),
      recordActivity: () => {},
      artifacts: [],
      messages: [],
      requests: [],
      approvals: [],
    } as unknown as RunState;
    return createClaudeMcpBridge({
      bus: { emit: () => {} } as unknown as EventBus,
      state,
      role: { id: "r1", name: "Coordinador", reportsTo: "admin" } as never,
      byName,
      ctx: {
        runId: "run1",
        tick: 1,
        actor: { id: "r1" } as never,
        workspace: {},
        currentThreadId: null,
        currentMessageId: null,
        replyToRoleId: null,
      } as never,
    });
  }

  it("expone las tools del org con el prefijo mcp__orq__", async () => {
    const byName = new Map<string, RegisteredTool>([
      ["revisar", habitada("revisar")],
      ["enviar", habitada("enviar")],
    ]);
    const session = await bridgePara(byName).open();
    try {
      expect(session.serverName).toBe("orq");
      expect(session.allowedTools).toEqual(["mcp__orq__revisar", "mcp__orq__enviar"]);
    } finally {
      await session.close();
    }
  });

  it("lista las tools por el protocolo MCP", async () => {
    const byName = new Map<string, RegisteredTool>([["saludar", habitada("saludar")]]);
    const session = await bridgePara(byName).open();
    try {
      const list = (await callMCP(session.socketPath, "list")) as {
        tools: { name: string }[];
      };
      expect(list.tools).toHaveLength(1);
      expect(list.tools[0]!.name).toBe("saludar");
    } finally {
      await session.close();
    }
  });

  it("delega la llamada a la herramienta real del rol", async () => {
    const ejecutado: string[] = [];
    const byName = new Map<string, RegisteredTool>([
      ["saludar", habitada("saludar", "saluda-ok", (args) => { ejecutado.push(String(args.valor ?? "")); })],
    ]);
    const session = await bridgePara(byName).open();
    try {
      const out = (await callMCP(session.socketPath, "call", {
        name: "saludar",
        args: { valor: "Lucas" },
      })) as { content: { text: string }[] };
      expect(ejecutado).toEqual(["Lucas"]);
      expect(out.content[0]!.text).toContain("saluda-ok");
    } finally {
      await session.close();
    }
  });
  it("una relectura idéntica devuelve un puntero, no el contenido otra vez", async () => {
    // El memo del loop no llegaba al camino delegado, y es donde más pesa: un
    // turno delegado encadena decenas de llamadas y cada resultado se reenvía
    // en todas las vueltas que le siguen.
    let veces = 0;
    const byName = new Map<string, RegisteredTool>([
      ["leer", habitada("leer", "contenido-largo", () => { veces += 1; })],
    ]);
    const session = await bridgePara(byName).open();
    try {
      const primera = (await callMCP(session.socketPath, "call", {
        name: "leer",
        args: { valor: "guion" },
      })) as { content: { text: string }[] };
      const segunda = (await callMCP(session.socketPath, "call", {
        name: "leer",
        args: { valor: "guion" },
      })) as { content: { text: string }[] };

      expect(primera.content[0]!.text).toContain("contenido-largo");
      expect(segunda.content[0]!.text).toContain("más arriba");
      expect(segunda.content[0]!.text).not.toContain("contenido-largo");
      // Y no se vuelve a ejecutar: el memo ahorra el trabajo, no sólo los tokens.
      expect(veces).toBe(1);
    } finally {
      await session.close();
    }
  });

  it("después de una escritura, releer devuelve el contenido nuevo y no un puntero", async () => {
    // El memo del puente no se vaciaba nunca: leer → editar → leer contestaba
    // "ya lo leíste más arriba" y el agente seguía trabajando sobre la versión
    // anterior a su propia edición.
    let contenido = "version-1";
    const leer: RegisteredTool = {
      ...habitada("leer"),
      execute: async () => ({ ok: true, content: contenido }),
    };
    const editar: RegisteredTool = {
      ...habitada("editar"),
      readOnly: false,
      execute: async () => {
        contenido = "version-2";
        return { ok: true, content: "editado" };
      },
    };
    const byName = new Map<string, RegisteredTool>([["leer", leer], ["editar", editar]]);
    const session = await bridgePara(byName).open();
    try {
      await callMCP(session.socketPath, "call", { name: "leer", args: { valor: "a" } });
      await callMCP(session.socketPath, "call", { name: "editar", args: { valor: "a" } });
      const releida = (await callMCP(session.socketPath, "call", {
        name: "leer",
        args: { valor: "a" },
      })) as { content: { text: string }[] };
      expect(releida.content[0]!.text).toContain("version-2");
    } finally {
      await session.close();
    }
  });

  it("una lectura con otros argumentos sí se ejecuta", async () => {
    let veces = 0;
    const byName = new Map<string, RegisteredTool>([
      ["leer", habitada("leer", "ok", () => { veces += 1; })],
    ]);
    const session = await bridgePara(byName).open();
    try {
      await callMCP(session.socketPath, "call", { name: "leer", args: { valor: "guion" } });
      await callMCP(session.socketPath, "call", { name: "leer", args: { valor: "brief" } });
      expect(veces).toBe(2);
    } finally {
      await session.close();
    }
  });

  it("un resultado enorme entra acotado y dice cómo pedir el resto", async () => {
    const gigante: RegisteredTool = {
      ...habitada("listar"),
      inputSchema: {
        type: "object",
        properties: { folder: { type: "string" } },
        additionalProperties: false,
      },
      execute: async () => ({ ok: true, content: "x".repeat(60_000) }),
    } as RegisteredTool;
    const session = await bridgePara(new Map([["listar", gigante]])).open();
    try {
      const out = (await callMCP(session.socketPath, "call", {
        name: "listar",
        args: {},
      })) as { content: { text: string }[] };
      const texto = out.content[0]!.text;
      expect(texto.length).toBeLessThan(20_000);
      expect(texto).toContain("RECORTADO");
      // Nombra un argumento que la herramienta declara de verdad.
      expect(texto).toContain("folder");
    } finally {
      await session.close();
    }
  });
  it("pasado el tope de largo niega lecturas pero deja entregar", async () => {
    // La asimetría es el punto: lo que alarga un turno es explorar, lo que lo
    // cierra es entregar. Negar todo dejaría al agente sin poder guardar lo que
    // ya averiguó, que es justo el trabajo que se quiere conservar.
    const lectura = habitada("leer");
    const escritura: RegisteredTool = { ...habitada("write_artifact"), readOnly: false };
    const session = await bridgePara(
      new Map([
        ["leer", lectura],
        ["write_artifact", escritura],
      ]),
    ).open();
    try {
      // 80 llamadas es el tope; se hacen con argumentos distintos para que el
      // memo no las absorba y cuenten de verdad.
      for (let i = 0; i < 80; i += 1) {
        await callMCP(session.socketPath, "call", { name: "leer", args: { valor: `v${i}` } });
      }
      const negada = (await callMCP(session.socketPath, "call", {
        name: "leer",
        args: { valor: "otra" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(negada.isError).toBe(true);
      expect(negada.content[0]!.text).toContain("FRENÁ");
      expect(negada.content[0]!.text).toContain("write_artifact");

      const entrega = (await callMCP(session.socketPath, "call", {
        name: "write_artifact",
        args: { valor: "informe" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(entrega.isError).toBeUndefined();
      expect(entrega.content[0]!.text).toContain("ok");
    } finally {
      await session.close();
    }
  }, 20_000);

  it("avisa antes de llegar al tope, para que pueda cerrar ordenado", async () => {
    const byName = new Map<string, RegisteredTool>([["leer", habitada("leer")]]);
    const session = await bridgePara(byName).open();
    try {
      let ultimo = "";
      for (let i = 0; i < 50; i += 1) {
        const out = (await callMCP(session.socketPath, "call", {
          name: "leer",
          args: { valor: `v${i}` },
        })) as { content: { text: string }[] };
        ultimo = out.content[0]!.text;
      }
      expect(ultimo).toContain("50 llamadas en este turno");
      expect(ultimo).toContain("andá cerrando");
    } finally {
      await session.close();
    }
  }, 20_000);
});
