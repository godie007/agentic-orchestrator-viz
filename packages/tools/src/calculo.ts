import type { RegisteredTool } from "./types.js";

/**
 * Aritmética verificable.
 *
 * Un modelo hace cuentas por patrón, y **verificar** una cuenta le cuesta más
 * que hacerla. Las cuatro fallas de calidad más caras que medimos en este
 * proyecto fueron aritmética, no criterio:
 *
 *   - una propuesta que decía "US$114.100 (margen 38,2%)" cuando a ese precio
 *     el margen es 35,0% —y el mismo documento lo calculaba bien dos secciones
 *     más abajo—;
 *   - un ahorro de $80.000.000 donde la cuenta daba $14.400.000, por multiplicar
 *     los leads por el ticket completo en vez de por la tasa de cierre;
 *   - una tabla de sensibilidad con 29,3% donde daba 28,5%;
 *   - un diagnóstico que afirmaba 940 horas/mes de trabajo cuando la capacidad
 *     del equipo era 260.
 *
 * Las cuatro pasaron por un control de calidad que no las vio. Esta herramienta
 * convierte "¿esto parece bien?" en "¿esto es igual a esto?".
 */

/** Un número escrito como lo escribe la gente, a número de verdad. */
export function normalizarNumero(texto: string): number {
  const limpio = texto.replace(/\s|\$/g, "");

  // Con coma, la coma es el decimal y los puntos son miles: "3.200.000,50".
  if (limpio.includes(",")) {
    return Number(limpio.replace(/\./g, "").replace(",", "."));
  }

  const puntos = limpio.split(".").length - 1;
  if (puntos === 0) return Number(limpio);

  // Varios puntos sólo pueden ser separadores de miles: "3.200.000".
  if (puntos > 1) return Number(limpio.replace(/\./g, ""));

  // Un solo punto es ambiguo. Tres dígitos después es miles —"1.500" son mil
  // quinientos pesos, no uno coma cinco— salvo que la parte entera sea 0, donde
  // "0.650" sólo puede ser decimal.
  const [entera = "", decimal = ""] = limpio.split(".");
  if (decimal.length === 3 && entera !== "0") return Number(limpio.replace(".", ""));
  return Number(limpio);
}

type Token = { tipo: "num"; valor: number } | { tipo: "op"; valor: string };

function tokenizar(expresion: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expresion.length) {
    const c = expresion[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9.,$]/.test(c)) {
      let j = i;
      while (j < expresion.length && /[0-9.,$]/.test(expresion[j]!)) j += 1;
      const crudo = expresion.slice(i, j);
      const valor = normalizarNumero(crudo);
      if (!Number.isFinite(valor)) throw new Error(`No entiendo el número "${crudo}"`);
      tokens.push({ tipo: "num", valor });
      i = j;
      continue;
    }
    // Se aceptan los signos que el modelo escribe naturalmente.
    const op = { "×": "*", "·": "*", "÷": "/", "−": "-" }[c] ?? c;
    if (!"+-*/()%^".includes(op)) throw new Error(`No entiendo el símbolo "${c}"`);
    tokens.push({ tipo: "op", valor: op });
    i += 1;
  }
  return tokens;
}

/**
 * Evaluador propio, sin `eval` ni `Function`: la expresión la escribe un modelo
 * y no puede ser un canal para ejecutar código.
 */
function evaluar(tokens: Token[]): number {
  let pos = 0;

  const mirar = (): Token | undefined => tokens[pos];
  const comer = (valor: string): boolean => {
    const t = mirar();
    if (t?.tipo === "op" && t.valor === valor) {
      pos += 1;
      return true;
    }
    return false;
  };

  const primario = (): number => {
    if (comer("(")) {
      const v = suma();
      if (!comer(")")) throw new Error("Falta cerrar un paréntesis");
      return v;
    }
    if (comer("-")) return -primario();
    if (comer("+")) return primario();
    const t = mirar();
    if (t?.tipo !== "num") throw new Error("Esperaba un número");
    pos += 1;
    let v = t.valor;
    // Porcentaje como sufijo: "35%" es 0,35.
    if (comer("%")) v = v / 100;
    return v;
  };

  const potencia = (): number => {
    const base = primario();
    if (comer("^")) return Math.pow(base, potencia());
    return base;
  };

  const producto = (): number => {
    let v = potencia();
    for (;;) {
      if (comer("*")) v *= potencia();
      else if (comer("/")) {
        const d = potencia();
        if (d === 0) throw new Error("División por cero");
        v /= d;
      } else return v;
    }
  };

  const suma = (): number => {
    let v = producto();
    for (;;) {
      if (comer("+")) v += producto();
      else if (comer("-")) v -= producto();
      else return v;
    }
  };

  const resultado = suma();
  if (pos !== tokens.length) throw new Error("Sobra algo al final de la expresión");
  return resultado;
}

export function calcularExpresion(expresion: string): number {
  const valor = evaluar(tokenizar(expresion));
  if (!Number.isFinite(valor)) throw new Error("El resultado no es un número");
  return valor;
}

/** Como lo escribiría una persona: separador de miles, hasta dos decimales. */
export function formatear(valor: number): string {
  const redondeado = Math.round(valor * 100) / 100;
  return redondeado.toLocaleString("es-CO", { maximumFractionDigits: 2 });
}

/**
 * Verificar todas las cifras de un documento de una vez, y quedarse con la
 * tabla para pegarla en el informe.
 *
 * Existe porque `calcular` sola no alcanzó. En la prueba, el auditor verificó
 * tres cifras de una propuesta que tenía una docena y cerró el turno: no
 * mintió, simplemente dejó de hacerlo, y el silencio se leía igual que "está
 * todo bien". Una cifra que nadie miró y una verificada dan la misma salida.
 *
 * El arreglo no es pedir exhaustividad en el prompt —ya sabemos que no
 * alcanza— sino **hacer que el camino completo sea el más barato**: verificar
 * doce cifras cuesta una llamada en vez de doce, y devuelve la tabla armada.
 * Lo que falta se ve, porque falta una fila.
 */
export const verificarCifras: RegisteredTool = {
  name: "verificar_cifras",
  origin: "coordination",
  readOnly: true,
  clavesDeCache: ["cifras"],
  requiresApproval: false,
  description:
    "Verifica de una sola vez todas las cifras que afirma un documento y te " +
    "devuelve la tabla lista para pegar en tu informe, con el veredicto de cada " +
    "una. Pasale una fila por cifra: qué afirma, con qué cuenta se comprueba y " +
    "qué valor dice el documento. Usala en vez de llamar a calcular una por una: " +
    "cuesta una sola llamada y deja constancia de lo que verificaste y de lo que " +
    "no, que es lo que hace auditable tu propia auditoría.",
  inputSchema: {
    type: "object",
    properties: {
      entregable: {
        type: "string",
        description:
          "Clave del entregable cuyas cifras estás verificando. Ponela siempre: sin ella la " +
          "verificación no queda registrada y el documento no se va a poder exportar.",
      },
      cifras: {
        type: "array",
        description: "Una fila por cifra del documento.",
        items: {
          type: "object",
          properties: {
            concepto: { type: "string", description: 'Qué cifra es. Ej: "margen a $114.100"' },
            expresion: { type: "string", description: 'La cuenta. Ej: "(114100 - 74165) / 114100"' },
            esperado: { type: "string", description: "El valor que afirma el documento." },
            fuente: { type: "string", description: "Opcional: de dónde salen los datos." },
          },
          required: ["concepto", "expresion", "esperado"],
        },
      },
    },
    required: ["cifras"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const crudas = args.cifras;
    if (!Array.isArray(crudas) || crudas.length === 0) {
      return {
        ok: false,
        content:
          "verificar_cifras: falta la lista `cifras`. Pasá una fila por cada número que el " +
          "documento afirma, con concepto, expresion y esperado.",
      };
    }

    const filas: string[] = [];
    let malas = 0;
    let ilegibles = 0;

    for (const cruda of crudas) {
      const fila = cruda as Record<string, unknown>;
      const concepto = String(fila.concepto ?? "").trim() || "(sin concepto)";
      const expresion = String(fila.expresion ?? "").trim();
      const esperadoTexto = String(fila.esperado ?? "").trim();
      const fuente = String(fila.fuente ?? "").trim();

      if (!expresion || !esperadoTexto) {
        ilegibles += 1;
        filas.push(`| ${concepto} | ${expresion || "—"} | ${esperadoTexto || "—"} | — | ⚠️ sin datos para verificar |`);
        continue;
      }

      let valor: number;
      try {
        valor = calcularExpresion(expresion);
      } catch (error) {
        ilegibles += 1;
        filas.push(
          `| ${concepto} | \`${expresion}\` | ${esperadoTexto} | — | ⚠️ no pude calcularla: ${
            error instanceof Error ? error.message : error
          } |`,
        );
        continue;
      }

      const esperado = normalizarNumero(esperadoTexto);
      const relativa =
        Number.isFinite(esperado) && Math.abs(esperado) > 0
          ? Math.abs(valor - esperado) / Math.abs(esperado)
          : Number.POSITIVE_INFINITY;

      if (!Number.isFinite(esperado)) {
        ilegibles += 1;
        filas.push(`| ${concepto} | \`${expresion}\` | ${esperadoTexto} | ${formatear(valor)} | ⚠️ no pude leer el valor afirmado |`);
        continue;
      }

      const coincide = relativa <= 0.005;
      if (!coincide) malas += 1;
      const veredicto = coincide
        ? "✓ correcta"
        : `✗ **el documento dice ${formatear(esperado)} y da ${formatear(valor)}**`;
      filas.push(
        `| ${concepto}${fuente ? ` <br><sub>${fuente}</sub>` : ""} | \`${expresion}\` | ${formatear(
          esperado,
        )} | ${formatear(valor)} | ${veredicto} |`,
      );
    }

    const tabla = [
      "| Cifra | Cuenta | Dice el documento | Da la cuenta | Veredicto |",
      "|---|---|---|---|---|",
      ...filas,
    ].join("\n");

    // Queda constancia contra el entregable y contra su versión: si después se
    // reescribe, la verificación de la versión anterior no vale y la
    // exportación lo va a exigir de nuevo.
    let registro = "";
    const clave = String(args.entregable ?? "").trim();
    if (clave && ctx?.workspace) {
      const artefacto = await ctx.workspace.readArtifact(clave);
      if (artefacto) {
        ctx.workspace.registrarVerificacion(clave, {
          version: artefacto.version,
          total: crudas.length,
          malas,
          sinVerificar: ilegibles,
          roleId: ctx.actor?.id ?? "",
        });
        registro = `\n\nQueda registrado sobre ${clave} v${artefacto.version}.`;
      } else {
        registro = `\n\n(No existe el entregable "${clave}", así que no quedó registrado contra ninguno.)`;
      }
    } else {
      registro =
        `\n\nOjo: no indicaste \`entregable\`, así que esta verificación no queda registrada ` +
        `y el documento no se va a poder exportar. Volvé a correrla con la clave.`;
    }

    const titular =
      malas > 0
        ? `${malas} de ${crudas.length} cifras NO coinciden. No sale así.`
        : `Las ${crudas.length} cifras verificadas coinciden.`;

    return {
      ok: true,
      content:
        `${titular}${ilegibles > 0 ? ` (${ilegibles} quedaron sin verificar.)` : ""}\n\n${tabla}\n\n` +
        `Pegá esta tabla en tu informe. Si el documento afirma cifras que no están acá, ` +
        `todavía no las verificaste: sumalas y volvé a correrla.${registro}`,
      summary:
        malas > 0
          ? `✗ ${malas}/${crudas.length} cifras mal`
          : `✓ ${crudas.length} cifras verificadas`,
    };
  },
};

export const calcular: RegisteredTool = {
  name: "calcular",
  origin: "coordination",
  readOnly: true,
  // `concepto` es una etiqueta para la traza y no cambia el resultado: si
  // entrara en la huella, la misma cuenta escrita con otro rótulo se volvería
  // a ejecutar. Lo medimos: el auditor calculó dos veces "933 * 22000" con
  // conceptos apenas distintos.
  clavesDeCache: ["expresion", "esperado"],
  requiresApproval: false,
  description:
    "Hace una cuenta de verdad, en vez de estimarla de cabeza. Usala siempre que " +
    "un número vaya a un entregable: márgenes, precios, horas por mes, repagos, " +
    "porcentajes. Si le pasás `esperado`, te dice si coincide con lo que afirma " +
    "el documento y por cuánto difiere: es la forma de verificar una cifra que ya " +
    "está escrita. Acepta números como se escriben ($ 3.200.000, 0,65, 35%) y los " +
    "operadores + - * / ( ) ^.",
  inputSchema: {
    type: "object",
    properties: {
      expresion: {
        type: "string",
        description: 'La cuenta, por ejemplo "(114100 - 74165) / 114100" o "25 * 18% * 3.200.000"',
      },
      esperado: {
        type: "string",
        description:
          "Opcional. El valor que afirma el documento, para contrastarlo con el resultado real.",
      },
      concepto: {
        type: "string",
        description: "Opcional. Qué estás calculando, para que quede en la traza.",
      },
    },
    required: ["expresion"],
    additionalProperties: false,
  },
  async execute(args) {
    const expresion = String(args.expresion ?? "").trim();
    if (!expresion) return { ok: false, content: "calcular: falta la expresión." };

    let valor: number;
    try {
      valor = calcularExpresion(expresion);
    } catch (error) {
      return {
        ok: false,
        content:
          `No pude calcular "${expresion}": ${error instanceof Error ? error.message : error}. ` +
          `Escribila con números y los operadores + - * / ( ) ^, sin texto en el medio.`,
      };
    }

    const concepto = args.concepto ? `${String(args.concepto)}: ` : "";
    const base = `${concepto}${expresion} = ${formatear(valor)}`;

    if (args.esperado == null || String(args.esperado).trim() === "") {
      return { ok: true, content: base, summary: `= ${formatear(valor)}` };
    }

    const esperado = normalizarNumero(String(args.esperado));
    if (!Number.isFinite(esperado)) {
      return { ok: true, content: `${base}\n(no pude leer el valor esperado "${args.esperado}")` };
    }

    // Tolerancia por redondeo: lo que se compara son cifras de un documento,
    // no coma flotante exacta.
    const diferencia = Math.abs(valor - esperado);
    const relativa = Math.abs(esperado) > 0 ? diferencia / Math.abs(esperado) : diferencia;
    if (relativa <= 0.005) {
      return {
        ok: true,
        content: `${base}\n✓ Coincide con lo afirmado (${formatear(esperado)}).`,
        summary: `✓ ${formatear(valor)}`,
      };
    }

    const veces = esperado !== 0 ? valor / esperado : 0;
    const detalle =
      Math.abs(veces) >= 2 || (Math.abs(veces) > 0 && Math.abs(veces) <= 0.5)
        ? ` El documento está ${formatear(1 / veces)} veces ${veces < 1 ? "arriba" : "abajo"}.`
        : ` Difiere en ${formatear(diferencia)}.`;
    return {
      ok: true,
      content:
        `${base}\n✗ NO coincide: el documento afirma ${formatear(esperado)} y la cuenta da ` +
        `${formatear(valor)}.${detalle} Corregilo antes de que salga.`,
      summary: `✗ dice ${formatear(esperado)}, da ${formatear(valor)}`,
    };
  },
};
