import type { RegisteredTool } from "@orq/tools";

/**
 * Qué tan grande puede entrar un resultado a una conversación que no controlamos.
 *
 * ## Por qué existe este archivo
 *
 * El motor ya se defiende del contexto que crece al cuadrado: `compactarConversacion`
 * retira los resultados ya consumidos y los reemplaza por un puntero. Pero esa
 * defensa actúa sobre **la conversación del motor**, y los proveedores que
 * delegan el turno a un CLI (`claude-code`, `opencode`) no tienen una: corren su
 * propio loop, con su propia conversación, y el motor ve una sola iteración. La
 * defensa correcta quedó del lado equivocado de la frontera.
 *
 * Medido en una corrida real de seis agentes: 21.070.000 tokens de entrada para
 * 132.000 de salida —160 a 1—, con el 96-100% servido desde caché. El caché
 * abarata pero no exime: bajo suscripción esos tokens igual consumen la ventana
 * de uso. Y el reparto dice dónde está: el agente que más navegó gastó 11,1
 * millones él solo, porque cada resultado de herramienta se reenvía en todas las
 * iteraciones que le siguen.
 *
 * ## La regla se invierte al cruzar la frontera
 *
 * En el loop propio se compacta **después**: un resultado se usa en la vuelta
 * siguiente y recién ahí estorba. En el camino delegado no hay un después —la
 * conversación no vuelve nunca—, así que lo que no se acota **al entrar** no se
 * puede acotar más. Por eso acá se corta en la puerta.
 */

/**
 * Tope de un resultado, en caracteres.
 *
 * El número sale de los datos, no del gusto: en la empresa que produjo la
 * medición, el entregable **más grande** son 11.127 caracteres y la mediana
 * 3.881. Con 16.000 ninguna lectura de trabajo se toca — un agente que abre su
 * guion lo recibe entero, que es la mitad del producto— y sí se cortan los que
 * de verdad inflan: listados de cientos de archivos, volcados de página del
 * navegador y documentos patológicos como el de 40k que entró once veces.
 *
 * Subirlo es seguro; bajarlo de ~12.000 empieza a partir entregables reales.
 */
export const TOPE_RESULTADO = 16_000;

/** Cuánto del final se conserva: ahí suelen estar el total y las conclusiones. */
const COLA = 1_500;

export interface Acotado {
  texto: string;
  /** Caracteres que quedaron afuera. `0` si no se recortó nada. */
  recortados: number;
}

/**
 * Recorta un resultado demasiado grande **nombrando cómo pedir el resto**.
 *
 * Un recorte a secas es una trampa: el agente no sabe que le falta algo, actúa
 * sobre la mitad de un documento y produce basura con cara de éxito. Y decirle
 * "pedí menos" sin decirle cómo es peor todavía — los modelos inventan el
 * parámetro (`start=4000`, `page=2`), la herramienta lo ignora por no estar en
 * su esquema y devuelve **todo otra vez**. Esa es exactamente la falla que ya
 * costó 534k tokens de entrada para 2k de salida.
 *
 * Por eso el aviso ofrece **sólo argumentos que la herramienta declara de
 * verdad**, leídos de su propio esquema. Si no declara ninguno que sirva para
 * acotar, se lo dice con todas las letras en vez de sugerir algo que no existe.
 */
export function acotarResultado(
  texto: string,
  tool: RegisteredTool | undefined,
  tope = TOPE_RESULTADO,
): Acotado {
  if (texto.length <= tope) return { texto, recortados: 0 };

  const cabeza = Math.max(0, tope - COLA);
  const recortados = texto.length - tope;
  const cola = texto.slice(texto.length - COLA);

  return {
    texto:
      texto.slice(0, cabeza) +
      `\n\n[…RECORTADO: ${recortados.toLocaleString("es-AR")} caracteres del medio no se ` +
      `enviaron. Este resultado medía ${texto.length.toLocaleString("es-AR")} caracteres y ` +
      `todo lo que entra acá se reenvía en cada vuelta de tu turno, así que se acota en la ` +
      `puerta. ${comoAcotar(tool)}]\n\n` +
      cola,
    recortados,
  };
}

/**
 * La frase que le dice al agente cómo pedir menos, con parámetros reales.
 *
 * Se leen del `inputSchema` y se filtran por nombre: sólo los que sirven para
 * **acotar** (una sección, una carpeta, un filtro, un límite). Ofrecerle
 * `contenido` o `titulo` como forma de leer menos sería ruido.
 */
function comoAcotar(tool: RegisteredTool | undefined): string {
  const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  const declaradas = Object.keys(schema?.properties ?? {});
  const utiles = declaradas.filter((clave) => ACOTADORES.has(clave));

  if (utiles.length === 0) {
    return (
      "Esta herramienta no declara ningún argumento para pedir menos, así que no inventes " +
      "uno (start, page, offset y parecidos se ignoran y te devuelven todo de nuevo): " +
      "trabajá con lo que ves acá o buscá el dato con otra herramienta."
    );
  }
  return `Para pedir sólo lo que necesitás, esta herramienta acepta: ${utiles.join(", ")}.`;
}

/**
 * Argumentos que de verdad acotan una lectura.
 *
 * Es una lista y no una heurística sobre el nombre porque un falso positivo le
 * ofrece al agente un parámetro que no reduce nada, y eso le hace gastar una
 * vuelta para descubrirlo.
 */
const ACOTADORES = new Set([
  "section",
  "seccion",
  "folder",
  "carpeta",
  "ruta",
  "path",
  "query",
  "pregunta",
  "filtro",
  "filter",
  "role",
  "rol",
  "kind",
  "tipo",
  "limit",
  "limite",
  "estado",
  "status",
]);

/**
 * El puntero que reemplaza a una lectura ya hecha en la misma delegación.
 *
 * El contenido completo sigue estando **más arriba en la conversación del CLI**,
 * así que no se pierde nada: se deja de pagar por segunda, tercera y cuarta vez.
 * Es el mismo trato que el memo del loop, que al camino delegado no llegaba —y
 * es donde más se nota, porque un turno delegado encadena treinta llamadas.
 */
export function punteroDeRelectura(nombre: string, caracteres: number): string {
  return (
    `Ya hiciste esta misma lectura en este turno: el resultado completo ` +
    `(${caracteres.toLocaleString("es-AR")} caracteres) está más arriba en esta ` +
    `conversación. Usalo de ahí en vez de volver a pedirlo — repetir la lectura no trae ` +
    `nada nuevo y reenvía el texto entero en cada vuelta que queda del turno. Si querés ` +
    `otra parte, cambiá los argumentos de ${nombre}; si intentaste paginar con un ` +
    `argumento que la herramienta no declara, ese argumento se ignora y devuelve todo igual.`
  );
}
