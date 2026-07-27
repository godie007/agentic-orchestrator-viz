import type { TraceEvent } from "@orq/shared";

/**
 * Deriva el estado visible de la empresa a partir de la traza.
 *
 * La UI no consulta estado: lo reconstruye reproduciendo los eventos hasta un
 * punto dado. Eso hace que "ver en vivo" y "retroceder en el timeline" sean la
 * misma operación con un corte distinto, y que el replay muestre exactamente lo
 * que se vio la primera vez.
 */

export interface RoleActivity {
  thinking: boolean;
  modelSlug: string | null;
  /** Herramienta que está ejecutando ahora mismo, si hay alguna. */
  runningTool: string | null;
  turns: number;
  costUsd: number;
  lastSummary: string | null;
}

export interface MessageFlow {
  id: string;
  from: string | null;
  to: string | null;
  type: string;
  subject: string;
  preview: string;
  at: number;
  tick: number;
}

export interface McpActivity {
  serverId: string;
  toolName: string;
  roleId: string;
  at: number;
}

export interface DerivedState {
  roles: Map<string, RoleActivity>;
  flows: MessageFlow[];
  mcpCalls: McpActivity[];
  toolSelections: Map<string, { exposed: string[]; candidates: string[]; reason: string }>;
  tick: number;
  maxTick: number;
  totalCostUsd: number;
  budgetUsd: number;
  status: string;
  stopReason: string | null;
  /** Cuántos eventos hay por tick, para dibujar la densidad del timeline. */
  eventsPerTick: Map<number, number>;
}

function emptyRole(): RoleActivity {
  return { thinking: false, modelSlug: null, runningTool: null, turns: 0, costUsd: 0, lastSummary: null };
}

export function derive(events: TraceEvent[], upTo = events.length): DerivedState {
  const roles = new Map<string, RoleActivity>();
  const flows: MessageFlow[] = [];
  const mcpCalls: McpActivity[] = [];
  const toolSelections = new Map<string, { exposed: string[]; candidates: string[]; reason: string }>();
  const eventsPerTick = new Map<number, number>();

  let tick = 0;
  let maxTick = 0;
  let totalCostUsd = 0;
  let budgetUsd = 0;
  let status = "idle";
  let stopReason: string | null = null;

  const roleOf = (id: string): RoleActivity => {
    let entry = roles.get(id);
    if (!entry) {
      entry = emptyRole();
      roles.set(id, entry);
    }
    return entry;
  };

  for (let index = 0; index < Math.min(upTo, events.length); index++) {
    const event = events[index]!;
    tick = Math.max(tick, event.tick);
    maxTick = Math.max(maxTick, event.tick);
    eventsPerTick.set(event.tick, (eventsPerTick.get(event.tick) ?? 0) + 1);

    switch (event.type) {
      case "run.status":
        status = event.status;
        stopReason = event.reason;
        break;

      case "agent.thinking": {
        const role = roleOf(event.roleId);
        role.thinking = true;
        role.modelSlug = event.modelSlug;
        break;
      }

      case "agent.turn_end": {
        const role = roleOf(event.roleId);
        role.thinking = false;
        role.runningTool = null;
        role.turns += 1;
        role.costUsd += event.costUsd;
        role.lastSummary = event.summary;
        break;
      }

      case "agent.message":
        flows.push({
          id: event.messageId,
          from: event.fromRoleId,
          to: event.toRoleId,
          type: event.messageType,
          subject: event.subject,
          preview: event.preview,
          at: event.at,
          tick: event.tick,
        });
        break;

      case "tool.selection":
        toolSelections.set(event.roleId, {
          exposed: event.exposed,
          candidates: event.candidates,
          reason: event.reason,
        });
        break;

      case "tool.start":
        roleOf(event.roleId).runningTool = event.toolName;
        break;

      case "tool.end": {
        const role = roleOf(event.roleId);
        if (role.runningTool === event.toolName) role.runningTool = null;
        if (event.mcpServerId) {
          mcpCalls.push({
            serverId: event.mcpServerId,
            toolName: event.toolName,
            roleId: event.roleId,
            at: event.at,
          });
        }
        break;
      }

      case "cost.updated":
        totalCostUsd = event.totalUsd;
        budgetUsd = event.budgetUsd;
        break;
    }
  }

  return {
    roles,
    flows,
    mcpCalls,
    toolSelections,
    tick,
    maxTick,
    totalCostUsd,
    budgetUsd,
    status,
    stopReason,
    eventsPerTick,
  };
}

/** Mensajes recientes: son los que se animan sobre las aristas. */
export function recentFlows(flows: MessageFlow[], windowMs = 4000): Set<string> {
  const cutoff = Date.now() - windowMs;
  const active = new Set<string>();
  for (const flow of flows) {
    if (flow.at >= cutoff && flow.from && flow.to) active.add(`${flow.from}->${flow.to}`);
  }
  return active;
}

export const MESSAGE_COLOR: Record<string, string> = {
  request: "var(--color-request)",
  response: "var(--color-response)",
  report: "var(--color-ink-faint)",
  escalation: "var(--color-escalation)",
  approval_request: "var(--color-approval)",
  approval_grant: "var(--color-approval)",
  approval_deny: "var(--color-danger)",
  broadcast: "var(--color-accent)",
  human: "var(--color-warn)",
};

export const MESSAGE_LABEL: Record<string, string> = {
  request: "pedido",
  response: "respuesta",
  report: "informe",
  escalation: "escalamiento",
  approval_request: "pide aprobación",
  approval_grant: "aprobado",
  approval_deny: "rechazado",
  broadcast: "anuncio",
  human: "persona",
};
