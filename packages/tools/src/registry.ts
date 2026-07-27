import type { Role, Tool } from "@orq/shared";
import type { RegisteredTool } from "./types.js";
import { coordinationTools } from "./coordination.js";
import { capabilityTools } from "./capability.js";

/**
 * Registro de herramientas.
 *
 * Conviven tres orígenes con la misma forma: coordinación (built-in), capacidad
 * (built-in) y MCP (descubiertas). Un rol solo ve las suyas, y las de
 * coordinación las tiene siempre —sin ellas no podría hablar con nadie y la
 * empresa no existiría como tal.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor() {
    for (const tool of [...coordinationTools, ...capabilityTools]) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Quita todas las tools de un servidor MCP (al desconectarse o recargar). */
  unregisterByMcpServer(serverId: string): string[] {
    const removed: string[] = [];
    for (const [name, tool] of this.tools) {
      if (tool.mcpServerId === serverId) {
        this.tools.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  byOrigin(origin: RegisteredTool["origin"]): RegisteredTool[] {
    return this.all().filter((tool) => tool.origin === origin);
  }

  /**
   * Herramientas que un rol tiene permitidas: las de coordinación siempre, más
   * las que su configuración le asignó explícitamente.
   */
  forRole(role: Role, configuredTools: readonly Tool[]): RegisteredTool[] {
    const assignedNames = new Set(
      configuredTools.filter((tool) => role.toolIds.includes(tool.id)).map((tool) => tool.name),
    );
    return this.all().filter(
      (tool) => tool.origin === "coordination" || assignedNames.has(tool.name),
    );
  }

  /** Metadatos para persistir y mostrar en la UI. */
  describe(): Array<Omit<Tool, "id">> {
    return this.all().map((tool) => ({
      name: tool.name,
      origin: tool.origin,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mcpServerId: tool.mcpServerId ?? null,
      requiresApproval: tool.requiresApproval,
      readOnly: tool.readOnly,
    }));
  }
}
