import type { Message, Role, Task } from "@orq/shared";
import type { RunState } from "./state.js";

/**
 * Construcción del prompt de un rol.
 *
 * Un agente no ve la conversación de los demás: todo lo que sabe llega por su
 * bandeja y su tablero. Este archivo arma esa vista parcial del mundo, que es
 * lo que hace que la empresa se comporte como una organización y no como un
 * modelo omnisciente hablando consigo mismo.
 */

export function buildSystemPrompt(state: RunState, role: Role, objective: string): string {
  const sections: string[] = [];

  sections.push(
    `Sos ${role.name}, ${role.title} en ${state.company.name}.`,
    role.systemPrompt.trim(),
  );

  if (state.company.mission.trim()) {
    sections.push(`## Misión de la empresa\n${state.company.mission.trim()}`);
  }
  if (state.company.context.trim()) {
    sections.push(`## Contexto de negocio\n${state.company.context.trim()}`);
  }

  sections.push(`## Objetivo en curso\n${objective}`);
  sections.push(buildOrgSection(state, role));

  const policies = state.policies.filter(
    (policy) => policy.appliesToRoleIds.length === 0 || policy.appliesToRoleIds.includes(role.id),
  );
  if (policies.length > 0) {
    sections.push(
      `## Políticas que debés respetar\n` +
        policies.map((policy) => `- ${policy.name}: ${policy.statement}`).join("\n"),
    );
  }

  sections.push(buildAuthoritySection(role, state));
  sections.push(buildMemorySection(state));
  sections.push(WORKING_AGREEMENT);

  return sections.filter((section) => section.trim()).join("\n\n");
}

function buildOrgSection(state: RunState, role: Role): string {
  const department = state.departments.find((dep) => dep.id === role.departmentId);
  const boss = role.reportsTo ? state.getRole(role.reportsTo) : null;
  const reports = state.directReports(role.id);

  const lines = [`## Tu lugar en la organización`];
  if (department) lines.push(`Departamento: ${department.name}. ${department.purpose}`.trim());
  lines.push(boss ? `Reportás a: ${boss.name} (${boss.title}).` : `No reportás a nadie.`);
  lines.push(
    reports.length > 0
      ? `Te reportan: ${reports.map((r) => `${r.name} (${r.title})`).join(", ")}.`
      : `No tenés equipo a cargo.`,
  );

  // El resto de la empresa se lista para que sepa a quién puede escribir. Sin
  // esto inventa destinatarios y las herramientas rechazan las llamadas.
  const others = state.roles.filter((candidate) => candidate.id !== role.id);
  if (others.length > 0) {
    lines.push(
      `\nOtros roles de la empresa (podés escribirles con send_message):`,
      ...others.map((other) => {
        const dep = state.departments.find((d) => d.id === other.departmentId);
        return `- ${other.name} — ${other.title}${dep ? ` (${dep.name})` : ""}`;
      }),
    );
  }
  return lines.join("\n");
}

function buildAuthoritySection(role: Role, state: RunState): string {
  const boss = role.reportsTo ? state.getRole(role.reportsTo) : null;
  const escalation = boss
    ? `escalá a ${boss.name} con la herramienta escalate`
    : `pedí autorización a la persona a cargo con request_approval`;

  const byLevel: Record<Role["authority"], string> = {
    executor:
      `Ejecutás lo que se te asigna. Las decisiones que cambien el alcance, el ` +
      `presupuesto o los compromisos con terceros no son tuyas: ${escalation}.`,
    manager:
      `Decidís dentro de tu área sin consultar. Lo que cruza departamentos, ` +
      `compromete a la empresa con un tercero o cambia el presupuesto: ${escalation}.`,
    executive: `Decidís por la empresa. Rendís cuentas ante la persona a cargo, no ante otro rol.`,
  };

  const lines = [`## Tu autoridad`, byLevel[role.authority]];
  if (role.spendApprovalThresholdUsd != null) {
    lines.push(
      `Cualquier compromiso económico por encima de US$${role.spendApprovalThresholdUsd} ` +
        `requiere aprobación previa: usá request_approval antes de avanzar.`,
    );
  }
  return lines.join("\n");
}

/**
 * Memoria de la empresa: lo aprendido en corridas anteriores.
 *
 * Va en el prompt en vez de detrás de una herramienta a propósito. El objetivo
 * es no volver a pagar por conocimiento que la empresa ya tiene: si estuviera
 * detrás de una tool, el agente gastaría un turno en descubrirla, otro en
 * llamarla, y muchas veces ni la llamaría. Acá ya está, y el costo es unos
 * pocos cientos de tokens de entrada, que además se cachean.
 *
 * Se acota para que la memoria no crezca sin control y termine costando más de
 * lo que ahorra: las más reafirmadas primero, hasta un límite.
 */
function buildMemorySection(state: RunState, limit = 25): string {
  const learnings = state.learnings.slice(0, limit);
  if (learnings.length === 0) return "";

  const byTopic = new Map<string, string[]>();
  for (const learning of learnings) {
    const list = byTopic.get(learning.topic) ?? [];
    list.push(learning.lesson);
    byTopic.set(learning.topic, list);
  }

  const lines = [
    `## Lo que esta empresa ya aprendió`,
    `Esto viene de trabajos anteriores. Dalo por válido y no lo vuelvas a averiguar;`,
    `si algo resulta estar mal, corregilo con record_lesson.`,
    ``,
  ];
  for (const [topic, lessons] of byTopic) {
    lines.push(`**${topic}**`);
    for (const lesson of lessons) lines.push(`- ${lesson}`);
  }
  const omitted = state.learnings.length - learnings.length;
  if (omitted > 0) lines.push(``, `(${omitted} lecciones más, menos reafirmadas, no se muestran.)`);
  return lines.join("\n");
}

/**
 * Reglas de trabajo comunes. Están redactadas contra fallas concretas que un
 * agente comete si no se le dice: contestar sin usar herramientas (y entonces
 * nadie se entera), reenviar sin contexto (y el otro no puede actuar), o
 * quedarse en un bucle de mensajes sin producir nada.
 */
const WORKING_AGREEMENT = `## Cómo trabajás

Tu turno termina cuando dejás de llamar herramientas. Lo que escribas fuera de
una herramienta no le llega a nadie: es tu razonamiento, no una acción. Para que
algo ocurra, tenés que usar una herramienta.

- Si te escribieron un pedido, respondelo con \`reply\` antes de terminar el turno.
  Dejar un pedido sin respuesta bloquea a quien te escribió.
- Cuando delegues o pidas algo, incluí todo el contexto en el mensaje. La otra
  persona no ve tu conversación ni tus tareas: si no se lo contás, no lo sabe.
- Mantené tus tareas al día con \`update_task\`: es el único modo de que el resto
  vea en qué anda tu trabajo.
- Cuando produzcas un entregable —una propuesta, un análisis, una decisión—
  guardalo con \`write_artifact\`. Un resultado que solo existe en un mensaje se
  pierde.
- No repitas trabajo ya hecho. Antes de empezar algo grande, revisá con
  \`list_artifacts\` si ya existe.
- Sé concreto y breve. Estás coordinando con colegas ocupados, no escribiendo un
  informe.`;

/**
 * El turno concreto: qué llegó a la bandeja y qué hay en el tablero. Va como
 * mensaje de usuario para que quede después del prompt cacheable del sistema.
 */
export function buildTurnPrompt(
  state: RunState,
  role: Role,
  inbox: Message[],
  tasks: Task[],
  /** Cuánto queda de la corrida, para saber si hay que cerrar. */
  progress?: { tick: number; maxTicks: number; spentUsd: number; budgetUsd: number },
): string {
  const sections: string[] = [`# Ciclo ${state.tick}`];

  if (inbox.length === 0) {
    sections.push(
      `## Bandeja de entrada\nSin mensajes nuevos.`,
    );
  } else {
    const rendered = inbox.map((message) => {
      const from = message.fromRoleId
        ? (state.getRole(message.fromRoleId)?.name ?? "desconocido")
        : "la persona a cargo";
      const kind = MESSAGE_LABEL[message.type] ?? message.type;
      return `### ${kind} de ${from}\nAsunto: ${message.subject}\n\n${message.body}`;
    });
    sections.push(`## Bandeja de entrada (${inbox.length})\n\n${rendered.join("\n\n---\n\n")}`);
  }

  if (tasks.length === 0) {
    sections.push(`## Tus tareas\nNo tenés tareas abiertas.`);
  } else {
    sections.push(
      `## Tus tareas\n` +
        tasks
          .map(
            (task) =>
              `- [${task.status}] ${task.id} — ${task.title} (prioridad ${task.priority})\n  ${task.detail}`,
          )
          .join("\n"),
    );
  }

  const closing = buildClosingPressure(progress);
  if (closing) sections.push(closing);

  sections.push(
    inbox.length === 0 && tasks.length === 0
      ? `No tenés nada pendiente. Si no hay nada útil que hacer, terminá el turno sin llamar herramientas.`
      : `Atendé lo anterior usando las herramientas. Priorizá responder pedidos y destrabar a quien te esté esperando.`,
  );

  return sections.join("\n\n");
}

/**
 * Presión de cierre.
 *
 * Sin esto la empresa se comporta como una organización sin fecha de entrega:
 * los agentes siguen pidiéndose información entre sí y la corrida muere por
 * presupuesto sin haber producido nada. Saber cuánto queda es lo que los hace
 * converger en un entregable — igual que una persona a la que le avisan que
 * la reunión con el cliente es mañana.
 */
function buildClosingPressure(
  progress: { tick: number; maxTicks: number; spentUsd: number; budgetUsd: number } | undefined,
): string {
  if (!progress) return "";
  const ticksLeft = Math.max(0, progress.maxTicks - progress.tick);
  const budgetLeft = 1 - progress.spentUsd / Math.max(progress.budgetUsd, 1e-9);

  // El más apremiante de los dos manda: da igual que sobren ciclos si no queda
  // presupuesto para ejecutarlos.
  const urgency = Math.min(ticksLeft / Math.max(progress.maxTicks, 1), Math.max(budgetLeft, 0));

  if (urgency > 0.5) return "";
  if (urgency > 0.25) {
    return (
      `## Queda poco margen\n` +
      `Restan ${ticksLeft} ciclos y ${Math.round(budgetLeft * 100)}% del presupuesto. ` +
      `Dejá de abrir pedidos nuevos: cerrá lo que ya tenés y consolidá el resultado.`
    );
  }
  return (
    `## Cerrá ahora\n` +
    `Restan ${ticksLeft} ciclos y ${Math.round(Math.max(budgetLeft, 0) * 100)}% del presupuesto. ` +
    `No pidas nada más a nadie. Con lo que tengas, producí o completá el entregable ` +
    `final con write_artifact, aunque esté incompleto: dejá explícito qué falta y con ` +
    `qué supuestos trabajaste. Un entregable parcial vale; no entregar nada, no.`
  );
}

const MESSAGE_LABEL: Record<string, string> = {
  request: "Pedido",
  response: "Respuesta",
  report: "Informe",
  escalation: "Escalamiento",
  approval_request: "Pedido de aprobación",
  approval_grant: "Aprobación concedida",
  approval_deny: "Aprobación denegada",
  broadcast: "Anuncio",
  human: "Mensaje de la persona a cargo",
};
