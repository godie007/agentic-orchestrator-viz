import { bloques, buscarEnEntregables } from "./busqueda.js";
import { calcular, verificarCifras } from "./calculo.js";
import type { Role } from "@orq/shared";
import { fail, ok, preview, type AgentWorkspace, type RegisteredTool } from "./types.js";

/**
 * Herramientas de coordinación: lo que hace que la empresa se comporte como
 * una empresa y no como un modelo hablando solo.
 *
 * Los agentes no comparten contexto. Todo lo que un rol sabe de otro llegó por
 * una de estas herramientas, igual que en una organización real donde nadie ve
 * la cabeza de su compañero.
 *
 * Los roles se referencian **por nombre**, no por ID: los modelos manejan mal
 * los identificadores opacos y confunden unos con otros. `resolveRole` acepta
 * nombre, cargo o ID, y cuando falla devuelve la lista de nombres válidos para
 * que el agente se corrija solo en la iteración siguiente.
 */

function resolveRole(workspace: AgentWorkspace, reference: string): Role | undefined {
  const needle = reference.trim().toLowerCase();
  return workspace.roles.find(
    (role) =>
      role.id === reference ||
      role.name.toLowerCase() === needle ||
      role.title.toLowerCase() === needle,
  );
}

/**
 * Título comparable: sin mayúsculas, tildes, puntuación ni espacios de más.
 * "Control de Calidad de entregables" y "control de calidad de entregables."
 * son la misma tarea aunque el modelo las escriba distinto.
 */
function normalizarTitulo(titulo: string): string {
  return titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function roleNames(workspace: AgentWorkspace): string {
  return workspace.roles.map((role) => `"${role.name}" (${role.title})`).join(", ");
}

function stringProp(description: string) {
  return { type: "string", description } as const;
}

/**
 * Lee los campos obligatorios de una llamada.
 *
 * Sin esto, un argumento faltante se coerciona a cadena vacía y la herramienta
 * "tiene éxito" produciendo basura —un entregable sin título ni contenido, un
 * mensaje sin cuerpo—. Devolver el error deja que el agente se corrija en la
 * iteración siguiente, que es lo que haría una persona a la que le rebotan un
 * formulario incompleto.
 *
 * Pasa seguido cuando el modelo agota `maxOutputTokens` a mitad del JSON de
 * argumentos: llega troceado y sin los campos del final.
 */
function readRequired(
  args: Record<string, unknown>,
  fields: string[],
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of fields) {
    const raw = args[field];
    const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (!value) missing.push(field);
    else values[field] = value;
  }

  if (missing.length > 0) {
    // `__raw` aparece cuando el JSON de argumentos llegó cortado: decirlo
    // explícitamente evita que el agente repita la llamada igual de larga.
    const truncated = "__raw" in args;
    return {
      ok: false,
      error:
        `faltan los campos obligatorios: ${missing.join(", ")}.` +
        (truncated
          ? " Los argumentos llegaron cortados, probablemente por longitud: volvé a llamarla con un contenido más breve."
          : " Volvé a llamarla incluyéndolos."),
    };
  }
  return { ok: true, values };
}

const sendMessage: RegisteredTool = {
  name: "send_message",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Envía un mensaje a otro rol de la empresa. Usalo para pedir trabajo, " +
    "compartir información o coordinar. El destinatario lo recibe en su bandeja " +
    "y lo procesa en el ciclo siguiente.",
  inputSchema: {
    type: "object",
    properties: {
      to: stringProp("Nombre del rol destinatario, ej: 'Director Comercial'"),
      type: {
        type: "string",
        enum: ["request", "report"],
        description:
          "'request' si esperás una respuesta o una acción; 'report' si solo informás.",
      },
      subject: stringProp("Asunto corto"),
      body: stringProp("Cuerpo del mensaje. Incluí todo el contexto que el otro necesite: no ve tu conversación."),
    },
    required: ["to", "type", "subject", "body"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["to", "subject", "body"]);
    if (!parsed.ok) return fail(`send_message: ${parsed.error}`);
    const to = parsed.values.to!;
    const target = resolveRole(ctx.workspace, to);
    if (!target) {
      return fail(`No existe el rol "${to}". Roles disponibles: ${roleNames(ctx.workspace)}`);
    }
    if (target.id === ctx.actor.id) {
      return fail("No podés enviarte un mensaje a vos mismo.");
    }

    // Un mensaje por persona hasta que conteste.
    //
    // Sin esto los agentes insisten: medimos diez mensajes de un coordinador a
    // la misma persona en una corrida —pedido, recordatorio, seguimiento,
    // escalamiento— todos sobre lo mismo. Insistir no acelera a nadie: el otro
    // contesta en su próximo ciclo igual, y mientras tanto cada mensaje le come
    // un lugar en la bandeja y contexto a los dos. Peor todavía, el que insiste
    // se queda esperando en vez de avanzar con lo que sí puede hacer solo.
    const pendiente = ctx.workspace
      .mensajesSinResponder()
      .find((mensaje) => mensaje.toRoleId === target.id);
    if (pendiente) {
      return fail(
        `Ya le escribiste a ${target.name} y todavía no te contestó: "${pendiente.subject}". ` +
          `Va a responderte en su próximo ciclo; insistir no lo acelera. Si te falta algo más ` +
          `para ese mismo tema, esperá y sumalo cuando conteste. Mientras tanto, avanzá con lo ` +
          `que puedas hacer sin su respuesta o pedile a otra área lo que sí depende de ella.`,
      );
    }

    const type = args.type === "report" ? "report" : "request";
    const message = await ctx.workspace.sendMessage({
      toRoleId: target.id,
      toDepartmentId: null,
      type,
      subject: parsed.values.subject!,
      body: parsed.values.body!,
      threadId: null, // mensaje nuevo: abre hilo propio
      inReplyTo: null,
    });
    return ok(
      `Mensaje enviado a ${target.name} (hilo ${message.threadId}). Lo va a leer en el ciclo siguiente.`,
      `→ ${target.name}: ${preview(parsed.values.subject!, 80)}`,
    );
  },
};

const reply: RegisteredTool = {
  name: "reply",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Responde el mensaje que estás atendiendo. Cierra el pedido en el hilo " +
    "original, así quien te escribió sabe que ya está resuelto.",
  inputSchema: {
    type: "object",
    properties: {
      body: stringProp("Tu respuesta, completa y autocontenida."),
    },
    required: ["body"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["body"]);
    if (!parsed.ok) return fail(`reply: ${parsed.error}`);
    if (!ctx.currentThreadId || !ctx.currentMessageId) {
      return fail(
        "No hay ningún mensaje que responder en este turno. Si querés iniciar una " +
          "conversación, usá send_message.",
      );
    }
    const original = ctx.workspace.roles.find((role) => role.id === ctx.replyToRoleId);
    if (!original) {
      // El encargo lo escribió la persona, que no es un rol y no tiene bandeja.
      // Antes esto devolvía "no hay ningún mensaje que responder" y el agente
      // reintentaba: en una corrida real se comió 14 de 25 llamadas a `reply`,
      // una iteración entera cada una, para acusar recibo de algo que nadie iba
      // a leer. La respuesta correcta es que no hace falta, y cuál es el canal
      // que sí llega.
      return fail(
        "Ese mensaje lo escribió la persona a cargo, no un rol: no hace falta acusar " +
          "recibo ni tiene dónde llegar la respuesta. Poneté con el trabajo. Si te falta " +
          "un dato que sólo ella tiene, pedíselo con request_context, que sí le llega.",
      );
    }
    await ctx.workspace.sendMessage({
      toRoleId: original.id,
      toDepartmentId: null,
      type: "response",
      subject: "Re:",
      body: parsed.values.body!,
      threadId: ctx.currentThreadId,
      inReplyTo: ctx.currentMessageId,
    });
    return ok(
      `Respuesta enviada a ${original.name}.`,
      `↩ ${original.name}: ${preview(parsed.values.body!, 80)}`,
    );
  },
};

const broadcast: RegisteredTool = {
  name: "broadcast",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Comunica algo a todos los roles de un departamento a la vez. Usalo para " +
    "anuncios, no para pedidos individuales.",
  inputSchema: {
    type: "object",
    properties: {
      department: stringProp("Nombre del departamento destinatario"),
      subject: stringProp("Asunto"),
      body: stringProp("Cuerpo del anuncio"),
    },
    required: ["department", "subject", "body"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["department", "subject", "body"]);
    if (!parsed.ok) return fail(`broadcast: ${parsed.error}`);
    const needle = parsed.values.department!.toLowerCase();
    const department = ctx.workspace.departments.find(
      (dep) => dep.id === args.department || dep.name.toLowerCase() === needle,
    );
    if (!department) {
      const names = ctx.workspace.departments.map((d) => `"${d.name}"`).join(", ");
      return fail(`No existe el departamento "${args.department}". Disponibles: ${names}`);
    }
    await ctx.workspace.sendMessage({
      toRoleId: null,
      toDepartmentId: department.id,
      type: "broadcast",
      subject: parsed.values.subject!,
      body: parsed.values.body!,
      threadId: null,
      inReplyTo: null,
    });
    const recipients = ctx.workspace.roles.filter((r) => r.departmentId === department.id).length;
    return ok(
      `Anuncio enviado a ${department.name} (${recipients} roles).`,
      `📢 ${department.name}: ${preview(parsed.values.subject!, 80)}`,
    );
  },
};

const escalate: RegisteredTool = {
  name: "escalate",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Escala un asunto a tu superior. Usalo cuando la decisión excede tu " +
    "autoridad, cuando estás bloqueado, o cuando el asunto cruza departamentos.",
  inputSchema: {
    type: "object",
    properties: {
      reason: stringProp("Por qué escalás en una frase"),
      detail: stringProp("Contexto completo: qué pasó, qué intentaste, qué necesitás decidir"),
    },
    required: ["reason", "detail"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["reason", "detail"]);
    if (!parsed.ok) return fail(`escalate: ${parsed.error}`);
    if (!ctx.actor.reportsTo) {
      return fail(
        `Sos ${ctx.actor.title} y no reportás a nadie: esta decisión es tuya. ` +
          `Tomala y seguí, o pedile aprobación a la persona con request_approval.`,
      );
    }
    const boss = ctx.workspace.getRole(ctx.actor.reportsTo);
    if (!boss) return fail("Tu superior no existe en la configuración de la empresa.");

    await ctx.workspace.sendMessage({
      toRoleId: boss.id,
      toDepartmentId: null,
      type: "escalation",
      subject: `Escalamiento: ${parsed.values.reason!}`,
      body: parsed.values.detail!,
      threadId: ctx.currentThreadId,
      inReplyTo: ctx.currentMessageId,
    });
    return ok(
      `Escalado a ${boss.name} (${boss.title}).`,
      `⬆ ${boss.name}: ${preview(parsed.values.reason!, 80)}`,
    );
  },
};

const assignTask: RegisteredTool = {
  name: "assign_task",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Asigna una tarea a alguien de tu equipo. Aparece en su tablero y la ve " +
    "en su próximo ciclo. Solo podés asignar a quienes te reportan.",
  inputSchema: {
    type: "object",
    properties: {
      assignee: stringProp("Nombre del rol al que le asignás la tarea"),
      title: stringProp("Título breve y accionable"),
      detail: stringProp("Qué hay que hacer y con qué criterio se considera terminada"),
      priority: {
        type: "string",
        enum: ["low", "normal", "high", "urgent"],
        description: "Prioridad relativa",
      },
    },
    required: ["assignee", "title", "detail"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["assignee", "title", "detail"]);
    if (!parsed.ok) return fail(`assign_task: ${parsed.error}`);
    const target = resolveRole(ctx.workspace, parsed.values.assignee!);
    if (!target) {
      return fail(
        `No existe el rol "${args.assignee}". Roles disponibles: ${roleNames(ctx.workspace)}`,
      );
    }

    // La jerarquía se valida acá y no en el prompt: un agente puede ignorar
    // una instrucción, pero no puede saltarse el ejecutor de la herramienta.
    const reports = ctx.workspace.directReports(ctx.actor.id);
    const allowed =
      ctx.actor.authority === "executive" || reports.some((r) => r.id === target.id);
    if (!allowed) {
      const names = reports.map((r) => `"${r.name}"`).join(", ") || "nadie";
      return fail(
        `${target.name} no te reporta, así que no podés asignarle tareas. ` +
          `Tu equipo directo es: ${names}. Si necesitás algo de otro área, usá send_message.`,
      );
    }

    // Un coordinador que no se acuerda de lo que ya repartió asigna la misma
    // cosa dos veces, y en el tablero aparecen dos tarjetas iguales que se
    // mueven por separado: el asignado hace el trabajo una vez y la copia queda
    // colgada para siempre. Se ataja acá y no en el prompt, como el resto.
    const abiertas = await ctx.workspace.listTasks(target.id);
    const yaAsignada = abiertas.find(
      (tarea) =>
        tarea.status !== "done" &&
        tarea.status !== "cancelled" &&
        normalizarTitulo(tarea.title) === normalizarTitulo(parsed.values.title!),
    );
    if (yaAsignada) {
      return fail(
        `${target.name} ya tiene abierta la tarea "${yaAsignada.title}" (id ${yaAsignada.id}), ` +
          `que es la misma que estás asignando. Si querés sumarle contexto, mandale un ` +
          `mensaje; si cambió el alcance, decíselo referenciando esa tarea. No la dupliques.`,
      );
    }

    const task = await ctx.workspace.createTask({
      title: parsed.values.title!,
      detail: parsed.values.detail!,
      assigneeRoleId: target.id,
      priority: (args.priority as "low" | "normal" | "high" | "urgent") ?? "normal",
      dueTick: null,
    });
    return ok(
      `Tarea "${task.title}" asignada a ${target.name} (id ${task.id}).`,
      `✓ ${target.name}: ${preview(task.title, 80)}`,
    );
  },
};

const updateTask: RegisteredTool = {
  name: "update_task",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Mueve una de tus tareas de etapa. Ponela en 'in_progress' cuando arrancás, " +
    "'in_review' cuando terminaste el trabajo y lo mandaste a verificar, 'done' " +
    "con el resultado cuando quedó aprobado, o 'blocked' explicando qué te frena. " +
    "Es lo único que hace visible en qué anda tu trabajo: una tarea que nunca se " +
    "mueve parece abandonada aunque la estés haciendo.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: stringProp("ID de la tarea (lo ves en tu lista de tareas)"),
      status: {
        type: "string",
        enum: ["in_progress", "in_review", "blocked", "done", "cancelled"],
      },
      result: stringProp("Resultado si la terminaste, o el motivo del bloqueo"),
    },
    required: ["task_id", "status"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["task_id", "status"]);
    if (!parsed.ok) return fail(`update_task: ${parsed.error}`);
    const taskId = parsed.values.task_id!;

    // Sólo el asignado mueve su tarea. Medimos a un coordinador asignarle el
    // diagnóstico a otra persona y acto seguido moverlo él mismo a
    // "in_progress" y después a "blocked", sin que la otra hubiera empezado:
    // el tablero mostraba a alguien trabado en algo que nunca tocó. Un tablero
    // que miente es peor que no tener tablero, así que se verifica en la
    // herramienta y no en el prompt.
    const propias = await ctx.workspace.listTasks(ctx.actor.id);
    if (!propias.some((tarea) => tarea.id === taskId)) {
      return fail(
        `La tarea "${taskId}" no es tuya, así que no podés moverla de etapa. Cada uno ` +
          `mueve las suyas: es lo que hace que el tablero refleje el trabajo real. ` +
          `Si querés saber cómo viene, o pedir que la frenen, escribile a quien la tiene ` +
          `con send_message.`,
      );
    }

    const updated = await ctx.workspace.updateTask(taskId, {
      status: args.status as "in_progress" | "in_review" | "blocked" | "done" | "cancelled",
      ...(args.result != null ? { result: String(args.result) } : {}),
    });
    if (!updated) return fail(`No existe la tarea "${taskId}".`);
    return ok(`Tarea "${updated.title}" → ${updated.status}.`, `✓ ${updated.title} → ${updated.status}`);
  },
};

const listMyTasks: RegisteredTool = {
  name: "list_my_tasks",
  origin: "coordination",
  readOnly: true,
  requiresApproval: false,
  description: "Lista las tareas que tenés asignadas, con su estado actual.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const tasks = await ctx.workspace.listTasks(ctx.actor.id);
    if (tasks.length === 0) return ok("No tenés tareas asignadas.");
    const lines = tasks.map(
      (task) => `- [${task.status}] ${task.id}: ${task.title} (prioridad ${task.priority})`,
    );
    return ok(lines.join("\n"), `${tasks.length} tareas`);
  },
};

const requestApproval: RegisteredTool = {
  name: "request_approval",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Pide autorización antes de comprometer a la empresa en algo que excede tu " +
    "autoridad (gastos, contratos, compromisos con clientes). La corrida se " +
    "detiene en esta rama hasta que alguien resuelva.",
  inputSchema: {
    type: "object",
    properties: {
      reason: stringProp("Qué querés hacer y por qué necesitás autorización"),
    },
    required: ["reason"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["reason"]);
    if (!parsed.ok) return fail(`request_approval: ${parsed.error}`);
    const approval = await ctx.workspace.requestApproval({
      approverRoleId: ctx.actor.reportsTo,
      reason: parsed.values.reason!,
      toolName: null,
      toolArgs: null,
    });
    const who = ctx.actor.reportsTo
      ? (ctx.workspace.getRole(ctx.actor.reportsTo)?.name ?? "tu superior")
      : "la persona a cargo";
    return ok(
      `Aprobación solicitada a ${who} (id ${approval.id}). Quedás a la espera.`,
      `⏸ aprobación: ${preview(parsed.values.reason!, 80)}`,
    );
  },
};

const writeArtifact: RegisteredTool = {
  name: "write_artifact",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Guarda un entregable —propuesta, análisis, informe, decisión— para que otros roles " +
    "lo lean y para poder exportarlo a Word o PDF. Escribir con la misma 'key' crea una " +
    "versión nueva.\n\n" +
    "Si el entregable ya existe y sólo vas a corregir partes, usá edit_artifact: escribís " +
    "los cambios y no el documento entero.\n\n" +
    "Escribilo como el documento que va a leer un cliente, no como una nota interna:\n" +
    "- Empezá con '# Título' y organizá con '## Secciones' con nombre propio.\n" +
    "- Usá tablas markdown para comparar cosas y listas para enumerarlas. Un párrafo con " +
    "  cinco puntos y coma es una tabla mal escrita.\n" +
    "- Nada sobre tu propio proceso: ni ciclos, ni bandejas, ni qué herramientas tenés. " +
    "  Al lector eso no le dice nada.\n" +
    "- Si te falta un dato, marcalo como pendiente en una línea; no rellenes.",
  inputSchema: {
    type: "object",
    properties: {
      key: stringProp("Identificador estable, ej: 'propuesta-retail'. Reusalo para versionar."),
      title: stringProp("Título legible"),
      content: stringProp("Contenido completo del entregable"),
      content_type: {
        type: "string",
        enum: ["markdown", "json", "text"],
      },
    },
    required: ["key", "title", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["key", "title", "content"]);
    if (!parsed.ok) return fail(`write_artifact: ${parsed.error}`);

    const calidad = revisarCalidad(parsed.values.title!, parsed.values.content!);
    if (calidad.rechazo) return fail(`write_artifact: ${calidad.rechazo}`);

    // Los agentes tienden a inventar una clave nueva por ciclo
    // ("propuesta-ciclo-3", "propuesta-v2", "propuesta-final") y el entregable
    // termina partido en pedazos que nadie integra. Si la clave es una variante
    // de una existente, se rechaza y se ofrece la original para versionar.
    const existentes = await ctx.workspace.listArtifacts();
    // Los marcadores se quitan en cualquier posición, no solo al final: el
    // modelo escribe tanto "informe-ciclo3" como "informe-ciclo3-final".
    const raiz = (key: string): string =>
      key
        .toLowerCase()
        .replace(/[_\s]+/g, "-")
        .replace(/-(ciclo|v|version|vers|parte|rev|iter)-?\d+/g, "")
        .replace(/-\d+(?=-|$)/g, "")
        .replace(/-(final|inicial|borrador|draft|parcial|actualizad[oa]|nuev[oa])(?=-|$)/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-+$/g, "");
    const pedida = raiz(parsed.values.key!);
    const similar = existentes.find((candidate) => {
      if (candidate.key === parsed.values.key) return false;
      const suya = raiz(candidate.key);
      if (suya === pedida) return true;
      // Un entregable colgado del anterior —"plan-paginacion-detalle" sobre
      // "plan-paginacion"— es el mismo tema partido en dos. El agente lo usa
      // para esquivar el versionado cuando el marcador no es un número.
      return pedida.startsWith(`${suya}-`);
    });
    if (similar) {
      return fail(
        `Ya existe el entregable "${similar.key}" ("${similar.title}", v${similar.version}), ` +
          `que es lo mismo que estás por crear con otra clave. Volvé a llamar write_artifact ` +
          `con key="${similar.key}" y el contenido completo actualizado: eso crea la versión ` +
          `siguiente. Si de verdad es otro documento, usá una clave que no sea una variante ` +
          `de esa.`,
      );
    }

    const artifact = await ctx.workspace.writeArtifact({
      key: parsed.values.key!,
      title: parsed.values.title!,
      contentType: (args.content_type as "markdown" | "json" | "text") ?? "markdown",
      content: parsed.values.content!,
    });
    return ok(
      `Entregable "${artifact.title}" guardado como "${artifact.key}" v${artifact.version}.` +
        (calidad.aviso ? ` Para la próxima versión: ${calidad.aviso}` : ""),
      `📄 ${artifact.title} v${artifact.version}`,
    );
  },
};

/**
 * Edita un entregable por reemplazo, en vez de reescribirlo entero.
 *
 * Medido sobre una corrida real: entre v16 y v19 del mismo documento cambió el
 * 4% de las líneas y se reescribieron las 184 cada vez. El 21% de **todos** los
 * tokens de salida de la corrida se fue en volver a tipear texto idéntico.
 *
 * Y no es sólo el gasto: reescribir 17.000 caracteres para tocar tres líneas es
 * la forma más común de que el modelo agote `max_tokens` a mitad del JSON y la
 * llamada llegue con los argumentos cortados. El entregable a medio escribir
 * salía de ahí.
 */
const editArtifact: RegisteredTool = {
  name: "edit_artifact",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Corrige partes de un entregable existente sin reescribirlo entero. Crea una versión " +
    "nueva, igual que write_artifact.\n\n" +
    "Usala siempre que estés aplicando correcciones o agregando una sección: es más rápida, " +
    "más barata y no corre riesgo de cortarse a la mitad. Reservá write_artifact para la " +
    "primera versión o para una reescritura de verdad.\n\n" +
    "Cada cambio busca un texto **exacto** —copialo tal cual de read_artifact, con sus " +
    "espacios— y lo reemplaza. Si el texto aparece más de una vez, agregá contexto alrededor " +
    "hasta que sea único. Para borrar un bloque, dejá 'reemplazar' vacío.",
  inputSchema: {
    type: "object",
    properties: {
      key: stringProp("Identificador del entregable a corregir"),
      cambios: {
        type: "array",
        description: "Reemplazos a aplicar, en orden.",
        items: {
          type: "object",
          properties: {
            buscar: stringProp("Texto exacto a reemplazar, único en el documento"),
            reemplazar: stringProp("Texto nuevo. Vacío borra el bloque."),
          },
          required: ["buscar"],
          additionalProperties: false,
        },
      },
    },
    required: ["key", "cambios"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["key"]);
    if (!parsed.ok) return fail(`edit_artifact: ${parsed.error}`);

    const cambios = args.cambios;
    if (!Array.isArray(cambios) || cambios.length === 0) {
      return fail(`edit_artifact: "cambios" tiene que ser una lista con al menos un reemplazo.`);
    }

    const artifact = await ctx.workspace.readArtifact(parsed.values.key!);
    if (!artifact) {
      const existentes = await ctx.workspace.listArtifacts();
      const claves = existentes.map((a) => `"${a.key}"`).join(", ") || "ninguno todavía";
      return fail(
        `No existe el entregable "${parsed.values.key}". Los que hay: ${claves}. ` +
          `Si es nuevo, escribilo con write_artifact.`,
      );
    }

    let contenido = artifact.content;
    const aplicados: string[] = [];

    for (const [i, crudo] of cambios.entries()) {
      const cambio = crudo as { buscar?: unknown; reemplazar?: unknown };
      const buscar = typeof cambio.buscar === "string" ? cambio.buscar : "";
      const reemplazar = typeof cambio.reemplazar === "string" ? cambio.reemplazar : "";
      if (!buscar) {
        return fail(`edit_artifact: el cambio ${i + 1} no trae "buscar".`);
      }

      let veces = contarApariciones(contenido, buscar);
      let aBuscar = buscar;

      // Los modelos copian el texto **aplanando los saltos de línea**: una
      // tabla markdown de seis renglones vuelve como una sola línea con pipes.
      // Es la causa de la mayoría de los rechazos que medimos, y no es un error
      // del agente sobre el contenido: reconoció el bloque bien. Si el match
      // exacto falla, se reintenta ignorando cómo está partido el espacio.
      if (veces === 0) {
        const flexible = buscarIgnorandoEspacios(contenido, buscar);
        if (flexible) {
          aBuscar = flexible;
          veces = contarApariciones(contenido, flexible);
        }
      }

      if (veces === 0) {
        return fail(
          `edit_artifact: el cambio ${i + 1} no encontró su texto en "${artifact.key}" v${artifact.version}. ` +
            `Buscabas: "${preview(buscar, 120)}". Copialo tal cual sale de read_artifact —los ` +
            `espacios y saltos de línea cuentan— o reescribí el documento con write_artifact. ` +
            `Los cambios anteriores no se aplicaron: nada quedó a medias.`,
        );
      }
      if (veces > 1) {
        return fail(
          `edit_artifact: el cambio ${i + 1} encontró ${veces} veces "${preview(buscar, 80)}". ` +
            `Agregá contexto alrededor —la línea de arriba o el título de la sección— hasta que ` +
            `sea único, así no se toca el lugar equivocado.`,
        );
      }

      contenido = contenido.replace(aBuscar, () => reemplazar);
      aplicados.push(`${aBuscar.length}→${reemplazar.length}`);
    }

    if (contenido === artifact.content) {
      return fail(
        `edit_artifact: los cambios dejaron el documento igual que estaba. No se creó una ` +
          `versión nueva.`,
      );
    }

    // La versión editada pasa el mismo control que una escrita entera: por acá
    // no se entra a guardar algo que write_artifact habría rechazado.
    const calidad = revisarCalidad(artifact.title, contenido);
    if (calidad.rechazo) return fail(`edit_artifact: ${calidad.rechazo}`);

    const guardado = await ctx.workspace.writeArtifact({
      key: artifact.key,
      title: artifact.title,
      contentType: artifact.contentType,
      content: contenido,
    });

    const tocados = aplicados.reduce((total, tramo) => total + Number(tramo.split("→")[1] ?? 0), 0);
    return ok(
      `Entregable "${guardado.title}" corregido: ${cambios.length} cambio(s), ahora es ` +
        `v${guardado.version}. Escribiste ${tocados} caracteres en vez de los ` +
        `${contenido.length} del documento entero.` +
        (calidad.aviso ? ` Para la próxima: ${calidad.aviso}` : ""),
      `✏️ ${guardado.title} v${guardado.version} (${cambios.length} cambio(s))`,
    );
  },
};

/**
 * Busca un texto tratando cualquier corrida de espacios como equivalente.
 *
 * Devuelve el fragmento **tal como está en el documento**, para poder
 * reemplazarlo literalmente después. `null` si no aparece o si aparece más de
 * una vez: en ese caso quien llama tiene que pedir más contexto, no adivinar.
 */
function buscarIgnorandoEspacios(donde: string, que: string): string | null {
  const patron = que
    .trim()
    .split(/\s+/)
    .map((parte) => parte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  if (!patron) return null;

  const encontrados = donde.match(new RegExp(patron, "g"));
  if (!encontrados || encontrados.length !== 1) return null;
  return encontrados[0];
}

/** Cuántas veces aparece un texto literal. Sin regex: el texto trae metacaracteres. */
function contarApariciones(donde: string, que: string): number {
  let n = 0;
  let desde = 0;
  for (;;) {
    const i = donde.indexOf(que, desde);
    if (i === -1) return n;
    n++;
    desde = i + que.length;
  }
}

const readArtifact: RegisteredTool = {
  name: "read_artifact",
  origin: "coordination",
  readOnly: true,
  requiresApproval: false,
  description:
    "Lee un entregable guardado. Si es largo te devuelve su índice en vez del " +
    "texto completo: pedí después la sección que necesites con `seccion`, o " +
    "buscá el dato con buscar_en_entregables. Traerte veinte mil caracteres para " +
    "mirar una cifra te gasta el turno y el contexto.",
  inputSchema: {
    type: "object",
    properties: {
      key: stringProp("Identificador del entregable"),
      seccion: stringProp(
        "Opcional: el encabezado que querés, tal como figura en el índice. Parcial alcanza.",
      ),
    },
    required: ["key"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["key"]);
    if (!parsed.ok) return fail(`read_artifact: ${parsed.error}`);
    const artifact = await ctx.workspace.readArtifact(parsed.values.key!);
    if (!artifact) {
      const available = await ctx.workspace.listArtifacts();
      const keys = available.map((a) => `"${a.key}"`).join(", ") || "ninguno todavía";
      return fail(`No existe el entregable "${args.key}". Disponibles: ${keys}`);
    }

    const encabezado = `# ${artifact.title} (v${artifact.version})`;
    const partes = bloques(artifact.content);

    // Una sección concreta: es lo que el modelo venía inventando con `start=`.
    if (args.seccion) {
      const buscada = String(args.seccion).toLowerCase();
      const elegidas = partes.filter((p) => p.titulo.toLowerCase().includes(buscada));
      if (elegidas.length === 0) {
        const indice = partes.map((p) => p.titulo).filter(Boolean);
        return fail(
          `"${args.seccion}" no es una sección de ${artifact.key}. Las que tiene son: ` +
            `${indice.join(" · ") || "ninguna, es un documento sin encabezados"}.`,
        );
      }
      const texto = elegidas.map((p) => `## ${p.titulo}\n${p.texto}`).join("\n\n");
      return ok(`${encabezado}\n\n${texto}`, `📖 ${artifact.title} › ${args.seccion}`);
    }

    // Un documento largo se devuelve como índice.
    //
    // Medimos a un auditor leer los mismos tres entregables enteros en dos
    // ciclos seguidos —el memo no la frena porque es por turno y entre turnos
    // la conversación se reinicia— y quedarse sin iteraciones antes de
    // verificar nada. Traer el índice cuesta cien veces menos y le dice qué
    // pedir después.
    const TOPE_ENTERO = 4_000;
    const indice = partes.map((p) => p.titulo).filter(Boolean);
    if (artifact.content.length > TOPE_ENTERO && indice.length > 1) {
      return ok(
        `${encabezado}\n\n` +
          `Este entregable tiene ${artifact.content.length} caracteres, así que va su índice ` +
          `en vez del texto completo:\n\n` +
          indice.map((t) => `- ${t}`).join("\n") +
          `\n\nPedí la que necesites con read_artifact(key: "${artifact.key}", seccion: "…"), ` +
          `o si buscás un dato puntual usá buscar_en_entregables, que mira en todos los ` +
          `entregables a la vez.`,
        `📖 ${artifact.title} v${artifact.version} — índice (${indice.length} secciones)`,
      );
    }

    return ok(
      `${encabezado}\n\n${artifact.content}`,
      `📖 ${artifact.title} v${artifact.version}`,
    );
  },
};

const listArtifacts: RegisteredTool = {
  name: "list_artifacts",
  origin: "coordination",
  readOnly: true,
  requiresApproval: false,
  description:
    "Lista los entregables de la empresa con su versión, incluidos los que " +
    "produjo otra área en un trabajo anterior. Miralo antes de escribir: si el " +
    "documento ya existe, se versiona con read_artifact y write_artifact en vez " +
    "de empezar otro con una clave parecida.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const artifacts = await ctx.workspace.listArtifacts();
    if (artifacts.length === 0) return ok("Todavía no hay entregables.");

    // Marcar los de antes evita que el agente los dé por escritos por él en
    // este ciclo y los publique sin leerlos.
    const linea = (a: (typeof artifacts)[number]): string =>
      `- ${a.key}: ${a.title} (v${a.version})` +
      (a.deOtraCorrida ? " — ya existía de un trabajo anterior, leelo antes de tocarlo" : "");

    return ok(artifacts.map(linea).join("\n"), `${artifacts.length} entregables`);
  },
};


/**
 * Rechaza lo que no es un entregable.
 *
 * Son dos fallas observadas, las dos hacen que el PDF que abre el cliente no
 * sirva:
 *
 * 1. **Documentos sobre el propio proceso.** El agente titula "Respuesta a
 *    pedido (Ciclo 4 - Bandeja de entrada)" y escribe sobre qué herramientas
 *    cree tener. Al lector eso no le dice nada del negocio.
 * 2. **Muros de texto.** Todo en un párrafo con punto y coma, sin un solo
 *    título. El render puede maquetar lo que reciba, pero no puede inventar
 *    una estructura que no está.
 *
 * Se revisa en la herramienta y no solo en el prompt: un agente puede ignorar
 * una instrucción, pero no el ejecutor.
 */
const PALABRAS_DE_PROCESO =
  /\b(ciclo\s*\d|bandeja de entrada|respuesta a pedido|seguimiento del pedido|mi turno|herramientas? (?:no )?disponibles?)\b/i;

/**
 * Un dictamen sobre un entregable **no es** un entregable.
 *
 * Es la falla más cara que vimos: un rol revisor recibe un guion, escribe sus
 * correcciones con `write_artifact` y —peor— reusa la clave del original. La
 * versión siguiente del guion ya no es el guion: son las notas de la revisión, y
 * lo que se filma después es una lista de correcciones leída en voz alta.
 *
 * La guardia anterior no lo agarraba porque el documento *tiene* estructura:
 * títulos, listas, hasta tablas. Lo que está mal no es la forma sino de qué
 * habla. Una revisión se manda con `reply`, que es su lugar: el que la recibe la
 * lee y guarda **el guion corregido**, no el dictamen.
 */
const PALABRAS_DE_DICTAMEN =
  /\b(correcciones?|revisi[óo]n|observaciones|hallazgos|devoluci[óo]n|feedback|checklist de (?:calidad|revisi[óo]n)|control de calidad|informe de revisi[óo]n)\b/i;

export interface Calidad {
  /** Impide guardar: el documento no sirve así. */
  rechazo?: string;
  /** Se guarda igual, pero se le dice para que la próxima versión mejore. */
  aviso?: string;
}

export function revisarCalidad(title: string, content: string): Calidad {
  if (PALABRAS_DE_DICTAMEN.test(title)) {
    return {
      rechazo:
        `"${title}" es una revisión, no un entregable. Una devolución se manda con ` +
        `reply a quien escribió el documento —ahí la lee y la aplica—; guardarla ` +
        `como entregable pisa el original y lo que se publica después son tus ` +
        `notas en vez del documento. Si lo que querés es guardar el documento ya ` +
        `corregido, escribilo entero con su título propio.`,
    };
  }

  if (PALABRAS_DE_PROCESO.test(title)) {
    return {
      rechazo:
        `el título "${title}" habla de tu proceso interno, no del contenido. ` +
        `Un entregable lo lee alguien de afuera: titulalo por lo que resuelve ` +
        `("Plan de paginación", "Informe de estado"), sin ciclos ni bandejas.`,
    };
  }

  const cuerpo = content.trim();
  // Una nota corta no necesita estructura; un documento sí.
  if (cuerpo.length < 400) return {};

  const titulos = (cuerpo.match(/^#{1,3} .+/gm) ?? []).length;
  const listas = (cuerpo.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm) ?? []).length;

  if (titulos === 0 && listas < 3) {
    return {
      rechazo:
        `el contenido es un bloque de texto sin estructura. Un entregable se lee ` +
        `con "## Secciones", listas y tablas markdown: escribilo así y se exporta ` +
        `a Word y PDF con esa forma.`,
    };
  }

  // Un párrafo largo es un problema de estilo, no de validez: el documento ya
  // tiene estructura. Rechazarlo costaba un turno entero por cada intento —un
  // agente agotó sus 8 iteraciones peleando con esto— así que se guarda y se
  // avisa, para que la versión siguiente lo corrija.
  const parrafoLargo = cuerpo
    .split(/\n\s*\n/)
    .find((parrafo) => !parrafo.startsWith("|") && parrafo.length > 900);
  if (parrafoLargo) {
    return {
      aviso:
        `hay un párrafo de ${parrafoLargo.length} caracteres sin cortes. En la próxima ` +
        `versión partilo en secciones, o pasalo a lista o tabla si estás enumerando.`,
    };
  }

  return {};
}

/**
 * Auditoría de lo que hicieron los demás.
 *
 * Un revisor que solo lee los mensajes revisa lo que los agentes **cuentan**.
 * Con esto revisa lo que **hicieron**: qué herramientas ejecutaron y con qué
 * resultado. Es la única forma de detectar la clase de error que más vimos —un
 * agente ejecuta algo con éxito y después informa que no pudo, o dice que
 * produjo un entregable que nunca escribió—.
 */
const checkActivity: RegisteredTool = {
  name: "check_activity",
  origin: "coordination",
  readOnly: true,
  requiresApproval: false,
  description:
    "Muestra qué herramientas ejecutó cada agente en esta corrida y con qué resultado. " +
    "Usalo para contrastar lo que un agente informó con lo que realmente hizo antes de " +
    "dar un trabajo por bueno. Podés filtrar por rol y ver solo los fallos.",
  inputSchema: {
    type: "object",
    properties: {
      role: stringProp("Nombre del rol a auditar. Vacío = todos."),
      only_failures: {
        type: "boolean",
        description: "Solo las llamadas que fallaron. Útil para ir directo a lo que se rompió.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const entradas = ctx.workspace.listActivity();
    if (entradas.length === 0) {
      return ok("Todavía no ejecutó nada nadie en esta corrida.");
    }

    const filtroRol = String(args.role ?? "").trim();
    let objetivo = entradas;

    if (filtroRol) {
      const rol = resolveRole(ctx.workspace, filtroRol);
      if (!rol) {
        return fail(`No existe el rol "${filtroRol}". Roles: ${roleNames(ctx.workspace)}`);
      }
      objetivo = objetivo.filter((entrada) => entrada.roleId === rol.id);
    }
    if (args.only_failures === true) objetivo = objetivo.filter((entrada) => !entrada.ok);

    if (objetivo.length === 0) {
      return ok(
        filtroRol
          ? `${filtroRol} no tiene ${args.only_failures === true ? "fallos" : "actividad"} registrados.`
          : "No hay nada que coincida con ese filtro.",
      );
    }

    const nombre = (roleId: string): string =>
      ctx.workspace.roles.find((role) => role.id === roleId)?.name ?? "?";

    // Se muestran las últimas: en una corrida larga lo viejo ya se revisó.
    const lineas = objetivo
      .slice(-60)
      .map(
        (entrada) =>
          `- c${entrada.tick} ${nombre(entrada.roleId)} · ${entrada.tool} · ` +
          `${entrada.ok ? "ok" : "FALLÓ"} · ${entrada.detail}`,
      );

    const fallos = objetivo.filter((entrada) => !entrada.ok).length;
    return ok(
      `${objetivo.length} llamadas${fallos ? `, ${fallos} con error` : ""}:\n${lineas.join("\n")}`,
      `${objetivo.length} llamadas`,
    );
  },
};

/**
 * Memoria de la empresa. Es la herramienta que evita volver a pagar por lo
 * mismo: lo que se registra acá entra en el prompt de todas las corridas
 * siguientes, así que el conocimiento no se re-deriva a fuerza de mensajes.
 */
const recordLesson: RegisteredTool = {
  name: "record_lesson",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Registra algo que la empresa aprendió y le va a servir en el futuro: una " +
    "tarifa, un criterio, una preferencia de un tipo de cliente, un error a no " +
    "repetir. Queda disponible para todos los roles en las próximas corridas, " +
    "así que no hace falta volver a averiguarlo. Registrá solo lo que sea " +
    "reutilizable — no el detalle de este encargo puntual.",
  inputSchema: {
    type: "object",
    properties: {
      topic: stringProp("Agrupador corto, ej: 'precios', 'estimación', 'cliente:retail'"),
      lesson: stringProp(
        "La lección, autocontenida: alguien que no vio esta conversación tiene que poder aplicarla.",
      ),
    },
    required: ["topic", "lesson"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["topic", "lesson"]);
    if (!parsed.ok) return fail(`record_lesson: ${parsed.error}`);
    const learning = await ctx.workspace.recordLesson({
      topic: parsed.values.topic!,
      lesson: parsed.values.lesson!,
    });
    return ok(
      learning.timesConfirmed > 1
        ? `Lección reafirmada (ya estaba registrada bajo "${learning.topic}").`
        : `Lección registrada bajo "${learning.topic}". Va a estar disponible en las próximas corridas.`,
      `🧠 ${preview(learning.topic, 40)}`,
    );
  },
};


/**
 * Pedidos a la persona a cargo.
 *
 * Hay cosas que un agente no puede resolver hablando con sus colegas: incorporar
 * a alguien al equipo, conocer un dato del negocio que nadie adentro tiene, o
 * conseguir acceso a una herramienta. Estas tres herramientas abren una
 * solicitud en la bandeja de la persona, que decide y responde.
 *
 * Son deliberadamente distintas de `request_approval`, que pide permiso a otro
 * agente para algo puntual: acá se está pidiendo cambiar la empresa o recibir
 * información de afuera.
 */

const requestNewRole: RegisteredTool = {
  name: "request_new_role",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Proponé incorporar un rol nuevo a la empresa cuando falte una capacidad " +
    "que nadie cubre. La persona a cargo lo revisa y decide; si acepta, el rol " +
    "se crea y empieza a trabajar. No lo uses para pedirle algo a alguien que " +
    "ya existe: para eso está send_message.",
  inputSchema: {
    type: "object",
    properties: {
      name: stringProp("Nombre propio de la persona, ej: 'Marta Sosa'"),
      title: stringProp("Cargo, ej: 'Analista de Datos'"),
      department: stringProp("Departamento. Si no existe, se crea."),
      system_prompt: stringProp(
        "Sus instrucciones: qué hace, con qué criterio y qué entrega. Escribilas como si le hablaras a esa persona.",
      ),
      reports_to: stringProp("Nombre del rol al que reportaría. Vacío = a vos."),
      reason: stringProp("Por qué hace falta y qué se desbloquea al tenerlo"),
    },
    required: ["name", "title", "department", "system_prompt", "reason"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["name", "title", "department", "system_prompt", "reason"]);
    if (!parsed.ok) return fail(`request_new_role: ${parsed.error}`);

    const yaExiste = ctx.workspace.roles.some(
      (role) => role.name.toLowerCase() === parsed.values.name!.toLowerCase(),
    );
    if (yaExiste) {
      return fail(
        `Ya existe un rol llamado "${parsed.values.name}". Si necesitás algo de esa persona, ` +
          `escribile con send_message.`,
      );
    }

    const request = await ctx.workspace.createRequest({
      type: "create_role",
      reason: parsed.values.reason!,
      roleProposal: {
        name: parsed.values.name!,
        title: parsed.values.title!,
        departmentName: parsed.values.department!,
        systemPrompt: parsed.values.system_prompt!,
        authority: "executor",
        reportsToName:
          typeof args.reports_to === "string" && args.reports_to.trim()
            ? args.reports_to.trim()
            : ctx.actor.name,
      },
      question: null,
      toolNames: [],
    });
    return ok(
      `Propuesta enviada a la persona a cargo: incorporar a ${parsed.values.name} ` +
        `(${parsed.values.title}). Queda pendiente de decisión (${request.id}). ` +
        `Seguí con lo que puedas hacer sin ese rol.`,
      `👤 propone: ${preview(parsed.values.title!, 60)}`,
    );
  },
};

const requestContext: RegisteredTool = {
  name: "request_context",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Pedile a la persona a cargo un dato del negocio que no está en tu contexto " +
    "y que nadie de la empresa puede saber: una restricción del cliente, una " +
    "decisión comercial, un número real. Antes de usarla, fijate si algún colega " +
    "puede responderlo con send_message.",
  inputSchema: {
    type: "object",
    properties: {
      question: stringProp("La pregunta concreta, respondible en pocas líneas"),
      reason: stringProp("Qué estás haciendo y por qué te bloquea no saberlo"),
    },
    required: ["question", "reason"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["question", "reason"]);
    if (!parsed.ok) return fail(`request_context: ${parsed.error}`);

    // Una consulta por vez. Con una pregunta sin responder, el agente sigue
    // trabajando y vuelve a preguntar; las consultas se apilan y cada una le
    // cuesta un ciclo a alguien. Medimos a un agente hacer una segunda tanda
    // repitiendo tres preguntas que ya le habían contestado.
    const propia = ctx.workspace
      .listRequests()
      .find(
        (pedido) =>
          pedido.status === "pending" &&
          pedido.type === "context" &&
          pedido.requestedByRoleId === ctx.actor.id,
      );
    if (propia) {
      return fail(
        `Ya tenés una consulta sin responder: "${(propia.question ?? propia.reason).slice(0, 140)}". ` +
          `Esperá esa respuesta antes de preguntar otra cosa —va a llegarte a la bandeja— y ` +
          `mientras tanto avanzá con lo que sí podés hacer. Si te falta algo más, sumalo cuando ` +
          `te contesten, en una sola consulta.`,
      );
    }

    const request = await ctx.workspace.createRequest({
      type: "context",
      reason: parsed.values.reason!,
      roleProposal: null,
      question: parsed.values.question!,
      toolNames: [],
    });
    return ok(
      `Consulta enviada a la persona a cargo (${request.id}). La respuesta te va a llegar ` +
        `a tu bandeja. Mientras tanto, avanzá con lo que no dependa de eso.`,
      `❓ consulta: ${preview(parsed.values.question!, 60)}`,
    );
  },
};

const requestToolAccess: RegisteredTool = {
  name: "request_tool_access",
  origin: "coordination",
  readOnly: false,
  requiresApproval: false,
  description:
    "Pedí acceso a herramientas que hoy no tenés asignadas y necesitás para tu " +
    "trabajo. Nombrálas exactamente como figuran en el catálogo de la empresa.",
  inputSchema: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Nombres exactos de las herramientas",
      },
      reason: stringProp("Para qué las necesitás"),
    },
    required: ["tools", "reason"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const parsed = readRequired(args, ["reason"]);
    if (!parsed.ok) return fail(`request_tool_access: ${parsed.error}`);
    const names = Array.isArray(args.tools)
      ? args.tools.map(String).filter((name) => name.trim())
      : [];
    if (names.length === 0) {
      return fail("request_tool_access: indicá al menos una herramienta en 'tools'.");
    }
    const request = await ctx.workspace.createRequest({
      type: "tool_access",
      reason: parsed.values.reason!,
      roleProposal: null,
      question: null,
      toolNames: names,
    });
    return ok(
      `Pedido de acceso enviado (${request.id}): ${names.join(", ")}. ` +
        `Si se aprueba, vas a tenerlas en tu próximo turno.`,
      `🔑 pide: ${preview(names.join(", "), 60)}`,
    );
  },
};

/** Todas las herramientas de coordinación. Todo rol las recibe siempre. */
export const coordinationTools: RegisteredTool[] = [
  // `calcular` no coordina a nadie, pero va acá porque las de coordinación se
  // otorgan siempre: hacer una cuenta bien no es una capacidad especial que
  // haya que asignar rol por rol, es higiene. Un rol nuevo la tiene desde el
  // primer turno sin que nadie se acuerde de dársela.
  calcular,
  verificarCifras,
  buscarEnEntregables,
  sendMessage,
  reply,
  broadcast,
  escalate,
  assignTask,
  updateTask,
  listMyTasks,
  requestApproval,
  writeArtifact,
  editArtifact,
  readArtifact,
  listArtifacts,
  checkActivity,
  recordLesson,
  requestNewRole,
  requestContext,
  requestToolAccess,
];
