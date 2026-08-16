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
import { executeOne, huellaDeFallo, huellaDeMotivo } from "./loop.js";

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
  /**
   * Se llama por cada herramienta ejecutada. Alimenta el contador del turno:
   * el CLI no devuelve `tool_calls`, así que sin esto el motor ve un turno
   * "vacío" aunque el agente haya trabajado, y el scheduler lo deja de convocar.
   */
  alEjecutar?: () => void;
}

/**
 * Cuántas veces se tolera la misma llamada fallida antes de negarla, y cuántos
 * fallos del mismo motivo antes de avisar fuerte. Son las mismas tolerancias
 * del agent loop; viven también acá porque el CLI corre su propio loop y el
 * freno del motor no ve sus llamadas: medimos siete `grabar_clip` seguidos
 * chocando contra el mismo texto inexistente, cada uno pagando minutos, sin
 * que nada lo frenara.
 */
const TOLERANCIA_IDENTICA = 3;
const TOLERANCIA_MOTIVO = 5;

export function createClaudeMcpBridge(deps: ClaudeMcpDeps): OrgToolsBridge {
  const serverName = "orq";
  // Fallos acumulados de la delegación entera (no por socket): el CLI puede
  // reconectarse y el freno tiene que recordar contra qué ya chocó.
  const fallos = new Map<string, number>();
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
          return handleToolCall(deps, call, fallos);
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

async function handleToolCall(
  deps: ClaudeMcpDeps,
  call: ToolCall,
  fallos: Map<string, number>,
): Promise<CallToolResult> {
  // La llamada idéntica que ya falló varias veces no se vuelve a ejecutar:
  // dentro del CLI cada intento puede costar minutos (una grabación entera) y
  // el freno del agent loop no ve estas llamadas. Negarla es lo único que
  // obliga a cambiar de enfoque.
  const identica = huellaDeFallo(call.name, call.arguments);
  if ((fallos.get(identica) ?? 0) >= TOLERANCIA_IDENTICA) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `FRENÁ: esta llamada exacta a ${call.name} ya falló ` +
            `${fallos.get(identica)} veces y no se ejecuta de nuevo. Cambiá los argumentos ` +
            `a partir de lo que decían los errores, o resolvé lo que puedas sin esta ` +
            `herramienta y contá el bloqueo al cerrar tu turno.`,
        },
      ],
    };
  }

  const result = await executeOne(call, deps.byName, deps.ctx, deps.state, deps.bus);
  deps.alEjecutar?.();
  let text = result.message.content;
  if (result.failure?.length) {
    for (const huella of result.failure) {
      fallos.set(huella, (fallos.get(huella) ?? 0) + 1);
    }
    const motivo = huellaDeMotivo(call.name, text);
    if ((fallos.get(motivo) ?? 0) >= TOLERANCIA_MOTIVO) {
      text +=
        `\n\nATENCIÓN: llevás ${fallos.get(motivo)} fallos con este mismo motivo aunque ` +
        `cambies los argumentos. La pared no se mueve: dejá de probar variantes y ` +
        `verificá el dato de base (¿la pantalla es la que creés? ¿el texto existe?), ` +
        `o pedí ayuda con send_message.`;
    }
    return { isError: true, content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text }] };
}