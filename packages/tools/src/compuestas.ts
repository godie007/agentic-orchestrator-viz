import { ids, normalizarNombre, type ComposicionDeTool, type Tool } from "@orq/shared";
import { fail, ok, preview, type RegisteredTool, type ToolContext, type ToolResult } from "./types.js";

/**
 * Herramientas compuestas: las que un agente puede crearse a sí mismo.
 *
 * Una herramienta compuesta es **declarativa**: una secuencia de herramientas
 * que ya existen, con argumentos fijos y huecos `{{parametro}}` que se llenan
 * al invocarla. No hay código del agente ejecutándose en el servidor — por eso
 * no necesita sandbox ni aprobación: no puede hacer nada que sus componentes
 * no pudieran, y cada paso pasa por el mismo ejecutor, con las mismas guardias
 * y la misma traza, que si el agente lo llamara a mano.
 *
 * Lo que sí aporta es memoria de procedimiento: un rol que descubrió que su
 * trabajo siempre es "leer el entregable X, verificar sus cifras, exportar el
 * PDF" lo deja armado una vez, con nombre, y la empresa lo conserva — la
 * herramienta se persiste como cualquier otra y sobrevive a la corrida, igual
 * que un especialista convocado.
 */

/** `{{parametro}}`: hueco a llenar al invocar la herramienta compuesta. */
const HUECO = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Los parámetros que la composición deja abiertos, en orden de aparición. */
export function extraerParametros(composicion: ComposicionDeTool): string[] {
  const parametros: string[] = [];
  const visto = new Set<string>();
  const recorrer = (valor: unknown): void => {
    if (typeof valor === "string") {
      for (const coincidencia of valor.matchAll(HUECO)) {
        const nombre = coincidencia[1]!;
        if (!visto.has(nombre)) {
          visto.add(nombre);
          parametros.push(nombre);
        }
      }
      return;
    }
    if (Array.isArray(valor)) valor.forEach(recorrer);
    else if (valor && typeof valor === "object") Object.values(valor).forEach(recorrer);
  };
  for (const paso of composicion.pasos) recorrer(paso.args);
  return parametros;
}

/** Reemplaza los huecos de un valor con los argumentos de la invocación. */
function sustituir(valor: unknown, args: Record<string, unknown>): unknown {
  if (typeof valor === "string") {
    // Un hueco que es el valor entero conserva el tipo del argumento: sirve
    // para pasar un número o un objeto sin forzarlo a cadena.
    const entero = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(valor);
    if (entero) return args[entero[1]!];
    return valor.replace(HUECO, (_, nombre: string) => String(args[nombre] ?? ""));
  }
  if (Array.isArray(valor)) return valor.map((item) => sustituir(item, args));
  if (valor && typeof valor === "object") {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([clave, v]) => [
        clave,
        sustituir(v, args),
      ]),
    );
  }
  return valor;
}

/** Cómo una herramienta compuesta encuentra a sus componentes al ejecutarse. */
export type ResolverTool = (name: string) => RegisteredTool | undefined;

/**
 * Envuelve la fila persistida de una herramienta compuesta en algo ejecutable.
 *
 * Los pasos se resuelven **al invocar**, no al registrar: si un componente se
 * dio de baja —un servidor MCP desconectado— el error lo dice por su nombre en
 * el momento en que importa, en vez de dejar una herramienta rota y muda.
 */
export function crearToolCompuesta(tool: Tool, resolver: ResolverTool): RegisteredTool {
  const composicion = tool.composicion;
  if (!composicion) {
    throw new Error(`La herramienta "${tool.name}" no tiene composición: no es de origen "creada".`);
  }

  return {
    name: tool.name,
    origin: "creada",
    description: tool.description,
    inputSchema: tool.inputSchema,
    requiresApproval: false,
    // Aunque todos los pasos fueran de lectura, la secuencia importa: se
    // ejecuta en serie como cualquier mutación.
    readOnly: false,
    async execute(args, ctx): Promise<ToolResult> {
      const faltantes = extraerParametros(composicion).filter(
        (parametro) => args[parametro] == null || String(args[parametro]).trim() === "",
      );
      if (faltantes.length > 0) {
        return fail(`${tool.name}: faltan los parámetros ${faltantes.join(", ")}.`);
      }

      const salidas: string[] = [];
      for (const [indice, paso] of composicion.pasos.entries()) {
        const componente = resolver(paso.tool);
        if (!componente) {
          return fail(
            `${tool.name}: el paso ${indice + 1} usa "${paso.tool}", que ya no está ` +
              `disponible (pudo desconectarse su servidor MCP). ` +
              (salidas.length > 0
                ? `Los pasos anteriores sí se ejecutaron:\n\n${salidas.join("\n\n")}`
                : `No se ejecutó ningún paso.`),
          );
        }
        const resultado = await componente.execute(
          sustituir(paso.args, args) as Record<string, unknown>,
          ctx,
        );
        salidas.push(`[paso ${indice + 1}: ${paso.tool}]\n${resultado.content}`);
        if (!resultado.ok) {
          // Se corta y se cuenta hasta dónde llegó: un pipeline que sigue
          // después de un paso fallido produce basura con cara de éxito.
          return fail(
            `${tool.name}: falló el paso ${indice + 1} (${paso.tool}) y la secuencia se ` +
              `detuvo ahí.\n\n${salidas.join("\n\n")}`,
          );
        }
      }
      return ok(salidas.join("\n\n"), `🧩 ${tool.name}: ${composicion.pasos.length} paso(s) ok`);
    },
  };
}

export interface CrearHerramientaDeps {
  /** Registra la compuesta en el catálogo vivo, para poder invocarla ya. */
  registrar(tool: RegisteredTool): void;
  /** El catálogo vivo, para validar los pasos y resolverlos al ejecutar. */
  resolver: ResolverTool;
}

/** Cuántos pasos como máximo. Más que esto no es una herramienta, es un guion. */
const MAX_PASOS = 6;

/**
 * `crear_herramienta`: un agente arma una herramienta nueva componiendo las que
 * ya tiene, y la empresa la conserva.
 *
 * Los frenos están en el ejecutor, como todas las guardias del proyecto:
 *
 * 1. **Sólo la crea quien decide o coordina** (`executive` o `manager`): un
 *    ejecutor pide la que le falta con `request_tool_access`.
 * 2. **Sólo compone lo que el creador ya puede ejecutar.** Crear no escala
 *    permisos: una compuesta con un paso que no tenés sería una puerta lateral.
 * 3. **Sin recursión**: un paso no puede ser otra compuesta. Dos compuestas que
 *    se llaman entre sí se ejecutarían para siempre.
 * 4. **Sin pasos que requieran aprobación**: la compuesta corre de un tirón y
 *    no puede quedar esperando a una persona por la mitad.
 */
export function createCrearHerramienta(deps: CrearHerramientaDeps): RegisteredTool {
  return {
    name: "crear_herramienta",
    origin: "coordination",
    readOnly: false,
    requiresApproval: false,
    description:
      "Creá una herramienta nueva componiendo las que ya tenés: una secuencia de hasta " +
      `${MAX_PASOS} pasos con argumentos fijos y huecos {{parametro}} que se completan al ` +
      "usarla. Sirve para dejar armado un procedimiento que repetís —leer, verificar, " +
      "exportar— con un solo nombre. Queda en el catálogo de la empresa, te la quedás " +
      "asignada, y sobrevive a esta corrida. Sólo puede componer herramientas que vos " +
      "ya podés ejecutar.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Nombre de la herramienta nueva: minúsculas, números y guiones bajos, ej. 'exportar_informe_semanal'.",
        },
        description: {
          type: "string",
          description:
            "Qué produce y cuándo usarla. Es lo que van a leer los roles que la reciban.",
        },
        pasos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Nombre exacto de una herramienta existente" },
              args: {
                type: "object",
                description:
                  "Argumentos del paso. Un valor puede incluir {{parametro}} para completarlo al invocar.",
              },
            },
            required: ["tool"],
          },
          description: `La secuencia, en orden. Entre 1 y ${MAX_PASOS} pasos.`,
        },
      },
      required: ["name", "description", "pasos"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (ctx.actor.authority === "executor") {
        return fail(
          `Crear herramientas lo decide quien coordina, y vos sos executor. Si te falta ` +
            `una capacidad, pedila con request_tool_access o escalale a tu superior.`,
        );
      }

      const nombre = normalizarNombre(String(args.name ?? "")).replace(/-/g, "_");
      if (!nombre) return fail("crear_herramienta: falta 'name' o no deja caracteres válidos.");
      const descripcion = String(args.description ?? "").trim();
      if (!descripcion) return fail("crear_herramienta: falta 'description'.");
      if (deps.resolver(nombre) || ctx.workspace.tools.some((tool) => tool.name === nombre)) {
        return fail(
          `Ya existe una herramienta llamada "${nombre}". Elegí otro nombre, o usala si hace lo que buscás.`,
        );
      }

      const crudos = Array.isArray(args.pasos) ? args.pasos : [];
      if (crudos.length === 0 || crudos.length > MAX_PASOS) {
        return fail(`crear_herramienta: 'pasos' debe tener entre 1 y ${MAX_PASOS} pasos.`);
      }

      // Lo que el creador puede ejecutar: coordinación (siempre) más lo asignado.
      const asignadas = new Set(
        ctx.workspace.tools
          .filter((tool) => ctx.actor.toolIds.includes(tool.id))
          .map((tool) => tool.name),
      );

      const pasos: ComposicionDeTool["pasos"] = [];
      for (const [indice, crudo] of crudos.entries()) {
        const paso = (crudo ?? {}) as { tool?: unknown; args?: unknown };
        const toolName = String(paso.tool ?? "").trim();
        if (!toolName) return fail(`crear_herramienta: el paso ${indice + 1} no dice qué herramienta usa.`);

        const componente = deps.resolver(toolName);
        if (!componente) {
          return fail(
            `crear_herramienta: el paso ${indice + 1} usa "${toolName}", que no existe en el catálogo.`,
          );
        }
        if (componente.origin === "creada") {
          return fail(
            `crear_herramienta: el paso ${indice + 1} usa "${toolName}", que ya es una herramienta ` +
              `compuesta. Componé directamente sus pasos: compuestas de compuestas no están permitidas.`,
          );
        }
        if (componente.requiresApproval) {
          return fail(
            `crear_herramienta: "${toolName}" requiere aprobación humana y no puede ir dentro de ` +
              `una secuencia automática. Llamala directo cuando haga falta.`,
          );
        }
        if (componente.origin !== "coordination" && !asignadas.has(toolName)) {
          return fail(
            `crear_herramienta: no tenés asignada "${toolName}", así que no podés meterla en una ` +
              `herramienta tuya. Pedila primero con request_tool_access.`,
          );
        }
        const argsPaso =
          paso.args && typeof paso.args === "object" && !Array.isArray(paso.args)
            ? (paso.args as Record<string, unknown>)
            : {};
        pasos.push({ tool: toolName, args: argsPaso });
      }

      const composicion: ComposicionDeTool = { pasos, creadaPorRoleId: ctx.actor.id };
      const parametros = extraerParametros(composicion);
      const fila: Tool = {
        id: ids.tool(),
        name: nombre,
        origin: "creada",
        description: descripcion,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            parametros.map((parametro) => [parametro, { type: "string" }]),
          ),
          required: parametros,
          additionalProperties: false,
        },
        mcpServerId: null,
        requiresApproval: false,
        readOnly: false,
        composicion,
      };

      // Primero el catálogo vivo, después la empresa: si registrar fallara, no
      // queda persistida una herramienta que nadie puede invocar.
      deps.registrar(crearToolCompuesta(fila, deps.resolver));
      ctx.workspace.incorporarHerramienta(fila);

      return ok(
        `Herramienta "${nombre}" creada y asignada a vos: ${pasos.length} paso(s) ` +
          `(${pasos.map((paso) => paso.tool).join(" → ")})` +
          (parametros.length > 0 ? `, con parámetros {${parametros.join(", ")}}` : "") +
          `. Queda en el catálogo de la empresa: otro rol puede recibirla por ` +
          `request_tool_access o desde el diseñador. Podés usarla desde tu próximo turno.`,
        `🧩 creó: ${preview(nombre, 60)}`,
      );
    },
  };
}
