import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Role } from "@orq/shared";
import type {
  OrgToolsBridge,
  OrgToolsSession,
  ToolCall,
} from "@orq/llm";
import type { RegisteredTool, ToolContext } from "@orq/tools";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { EventBus } from "./events.js";
import type { RunState } from "./state.js";
import { executeOne } from "./loop.js";

/**
 * Puente MCP para el proveedor `claude-code`.
 *
 * Claude Code corre su propio loop y no devuelve `tool_calls`; el motor no
 * puede interceptar y ejecutar sus llamadas con el `ToolRegistry`. En vez de
 * eso, este puente expone las herramientas de coordinación del org como un
 * servidor MCP que vive **_en el proceso del engine_**, con acceso directo al
 * `RunState` y al `bus`. El CLI de Claude Code se conecta a ese servidor y sus
 * llamadas se ejecutan con la misma maquinaria que el loop (`executeOne`), así
 * que las herramientas ven el mundo exactamente igual y emiten los mismos
 * eventos de coordinación.
 *
 * El transporte es un socket Unix + un relay stdio (ver `claude-code-relay.mjs`):
 * Claude escribe su protocolo MCP en stdin y el relay lo canaliza al socket
 * donde vive el servidor; las respuestas vuelven por el mismo camino. Cada
 * delegación (`open()`) crea un socket y un servidor MCP **nuevos** para que los
 * turnos de `claude-code` en paralelo no compartan estado ni colisiones de
 * nombres de herramientas.
 */
export interface ClaudeMcpDeps {
  bus: EventBus;
  state: RunState;
  role: Role;
  /** Herramientas del rol, resueltas por nombre (el `byName` del turno). */
  byName: Map<string, RegisteredTool>;
  /** Contexto del turno actual, ya preparado por el motor. */
  ctx: ToolContext;
  /** Directorio de salida de la empresa, en sólo lectura. Ver `TurnDeps`. */
  dirDeTrabajo?: string;
}

export function createClaudeMcpBridge(deps: ClaudeMcpDeps): OrgToolsBridge {
  const serverName = "orq";
  return {
    async open(): Promise<OrgToolsSession> {
      const socketPath = join(
        tmpdir(),
        `orq-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
      );
      const net = createServer((socket) => {
        const sdk = new Server({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });
        sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [...deps.byName.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }));
        sdk.setRequestHandler(CallToolRequestSchema, async (request) => {
          const call: ToolCall = {
            id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: request.params.name,
            arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
          };
          return handleToolCall(deps, call);
        });
        void sdk.connect(new StdioServerTransport(socket, socket)).then(() => {
          socket.on("close", () => void sdk.close());
        });
      });
      net.listen(socketPath);

      await new Promise<void>((resolve, reject) => {
        net.on("listening", resolve);
        net.on("error", reject);
      });

      return {
        socketPath,
        serverName,
        allowedTools: [...deps.byName.keys()].map((name) => `mcp__${serverName}__${name}`),
        ...(deps.dirDeTrabajo ? { cwd: deps.dirDeTrabajo } : {}),
        async close() {
          await new Promise<void>((resolve) => net.close(() => resolve()));
        },
      };
    },
  };
}

async function handleToolCall(deps: ClaudeMcpDeps, call: ToolCall): Promise<CallToolResult> {
  const result = await executeOne(call, deps.byName, deps.ctx, deps.state, deps.bus);
  const text = result.message.content;
  if (result.failure?.length) {
    return { isError: true, content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text }] };
}