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
    const state = { forActor: () => ({}), recordActivity: () => {} } as unknown as RunState;
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
});