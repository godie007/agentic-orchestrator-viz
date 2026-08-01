/**
 * Íconos vectoriales para el video.
 *
 * Un ícono al lado de una viñeta es la diferencia entre una lista y una placa
 * que se entiende de un vistazo. Se dibujan como **trazos de ASS** —el mismo
 * `{\p1}` con el que ya se dibujan la regla y la barra de progreso— y no como
 * archivos: no hay assets que empaquetar, escalan sin perder nitidez y toman el
 * color del estilo, así que un ícono nunca desentona con la paleta.
 *
 * Los emojis quedaron descartados a propósito: libass los dibuja en monocromo o
 * los saltea según la fuente instalada, y un video que en una máquina muestra un
 * cohete y en otra un cuadrado vacío no es una salida confiable.
 *
 * Las coordenadas se escriben en una caja de 100×100 con el eje Y hacia abajo, y
 * se escalan al tamaño pedido al emitir. Los agujeros —el `!` de la alerta, el
 * centro del engranaje— se dibujan **en sentido contrario** al contorno que los
 * contiene: ASS rellena por regla non-zero, así que un contorno invertido resta
 * en vez de sumar. Sin eso, un candado es una mancha con forma de candado.
 */

/** Redondeo corto: dos decimales alcanzan y el archivo ASS no se infla. */
const n = (valor: number): string => {
  const redondeado = Math.round(valor * 100) / 100;
  return Number.isInteger(redondeado) ? String(redondeado) : redondeado.toFixed(2);
};

/** Constante de Bézier para aproximar un cuarto de círculo. */
const K = 0.5523;

/** Círculo en cuatro curvas. `sentido: -1` lo invierte, y entonces perfora. */
function circulo(cx: number, cy: number, r: number, sentido: 1 | -1 = 1): string {
  const c = r * K;
  const p = (x: number, y: number): string => `${n(cx + x * sentido)} ${n(cy + y)}`;
  return (
    `m ${p(0, -r)} ` +
    `b ${p(c, -r)} ${p(r, -c)} ${p(r, 0)} ` +
    `b ${p(r, c)} ${p(c, r)} ${p(0, r)} ` +
    `b ${p(-c, r)} ${p(-r, c)} ${p(-r, 0)} ` +
    `b ${p(-r, -c)} ${p(-c, -r)} ${p(0, -r)}`
  );
}

/** Rectángulo, con esquinas rectas. `sentido: -1` perfora. */
function rect(x: number, y: number, ancho: number, alto: number, sentido: 1 | -1 = 1): string {
  const puntos =
    sentido === 1
      ? [
          [x, y],
          [x + ancho, y],
          [x + ancho, y + alto],
          [x, y + alto],
        ]
      : [
          [x, y],
          [x, y + alto],
          [x + ancho, y + alto],
          [x + ancho, y],
        ];
  const [primero, ...resto] = puntos as Array<[number, number]>;
  return `m ${n(primero![0])} ${n(primero![1])} ${resto
    .map(([px, py]) => `l ${n(px)} ${n(py)}`)
    .join(" ")}`;
}

/** Polígono cerrado a partir de pares x,y. */
const poli = (...puntos: Array<[number, number]>): string => {
  const [primero, ...resto] = puntos;
  return `m ${n(primero![0])} ${n(primero![1])} ${resto
    .map(([x, y]) => `l ${n(x)} ${n(y)}`)
    .join(" ")}`;
};

/**
 * El catálogo.
 *
 * Corto y a propósito: un set de doscientos íconos obliga al agente a elegir, y
 * elige mal. Estos cubren lo que aparece en un video de empresa —una meta, un
 * plazo, un riesgo, un número que sube— y cada nombre está en castellano porque
 * lo escribe el agente dentro del guion.
 */
const CATALOGO: Record<string, string> = {
  // Un tilde: lo hecho, lo que cumple.
  chequeo: poli([8, 52], [22, 38], [40, 56], [78, 18], [92, 32], [40, 84]),

  // Diana: anillo, anillo y centro. Cada anillo son dos círculos, el de adentro
  // invertido para que quede el hueco.
  objetivo: [
    circulo(50, 50, 46),
    circulo(50, 50, 36, -1),
    circulo(50, 50, 28),
    circulo(50, 50, 18, -1),
    circulo(50, 50, 10),
  ].join(" "),

  // Reloj: caja circular y dos agujas.
  reloj: [
    circulo(50, 50, 46),
    circulo(50, 50, 38, -1),
    rect(46, 20, 8, 34),
    rect(46, 46, 28, 8),
  ].join(" "),

  // Alerta: triángulo con el signo calado.
  alerta: [
    poli([50, 6], [98, 90], [2, 90]),
    rect(45, 36, 10, 30, -1),
    rect(45, 72, 10, 10, -1),
  ].join(" "),

  // Tres barras que suben: un resultado que se mide.
  grafico: [rect(6, 60, 22, 34), rect(39, 38, 22, 56), rect(72, 16, 22, 78)].join(" "),

  // Flecha en diagonal: la tendencia, el crecimiento.
  tendencia: [
    poli([4, 78], [36, 46], [56, 66], [86, 36], [94, 44], [56, 82], [36, 62], [12, 86]),
    poli([98, 22], [98, 54], [66, 22]),
  ].join(" "),

  // Una persona: cabeza y hombros.
  persona: [circulo(50, 26, 22), poli([50, 54], [82, 74], [86, 96], [14, 96], [18, 74])].join(" "),

  // Dos personas: el equipo, el área, la reunión.
  equipo: [
    circulo(34, 30, 18),
    poli([34, 54], [60, 70], [62, 92], [6, 92], [8, 70]),
    circulo(74, 34, 14),
    poli([74, 54], [94, 68], [96, 92], [66, 92], [66, 70]),
  ].join(" "),

  // Engranaje: proceso, sistema, lo que funciona solo.
  engranaje: [
    circulo(50, 50, 40),
    rect(42, 0, 16, 16),
    rect(42, 84, 16, 16),
    rect(0, 42, 16, 16),
    rect(84, 42, 16, 16),
    circulo(50, 50, 16, -1),
  ].join(" "),

  // Lamparita: la idea, la propuesta.
  idea: [
    circulo(50, 38, 30),
    poli([36, 60], [64, 60], [62, 80], [38, 80]),
    rect(38, 84, 24, 6),
    rect(42, 93, 16, 6),
  ].join(" "),

  // Un billete: plata, costo, ahorro.
  dinero: [rect(2, 24, 96, 52), circulo(50, 50, 15, -1), rect(10, 32, 6, 36, -1), rect(84, 32, 6, 36, -1)].join(" "),

  // Escudo con un tilde calado: seguridad, cumplimiento, garantía.
  escudo: [
    poli([50, 4], [94, 20], [94, 54], [50, 96], [6, 54], [6, 20]),
    // Al revés que el contorno: es lo que abre el hueco donde entra el tilde.
    poli([50, 18], [18, 30], [18, 52], [50, 80], [82, 52], [82, 30]),
    poli([30, 48], [40, 38], [46, 44], [64, 26], [74, 36], [46, 64]),
  ].join(" "),

  // Cohete: lanzamiento, arranque, algo nuevo.
  cohete: [
    poli([50, 2], [70, 30], [70, 66], [30, 66], [30, 30]),
    circulo(50, 34, 11, -1),
    poli([28, 42], [28, 76], [10, 90], [16, 56]),
    poli([72, 42], [72, 76], [90, 90], [84, 56]),
    poli([40, 70], [60, 70], [50, 98]),
  ].join(" "),

  // Hoja con una esquina doblada: el documento, el informe.
  documento: [
    poli([12, 2], [64, 2], [88, 26], [88, 98], [12, 98]),
    poli([62, 6], [62, 28], [84, 28]),
    rect(26, 44, 48, 7, -1),
    rect(26, 60, 48, 7, -1),
    rect(26, 76, 30, 7, -1),
  ].join(" "),

  // Candado: lo reservado, lo aprobado, lo que no se toca. El arco va **arriba**
  // del cuerpo: si se superponen, el hueco del arco perfora la tapa y el candado
  // termina pareciendo un bolso.
  candado: [
    circulo(50, 42, 22),
    circulo(50, 42, 13, -1),
    rect(14, 56, 72, 42),
    circulo(50, 76, 8, -1),
  ].join(" "),

  // Calendario: la fecha, el plazo, la misión programada.
  calendario: [
    rect(6, 14, 88, 84),
    rect(14, 40, 72, 50, -1),
    rect(24, 2, 12, 22),
    rect(64, 2, 12, 22),
    rect(24, 50, 16, 14),
    rect(46, 50, 16, 14),
    rect(24, 70, 16, 14),
    rect(46, 70, 16, 14),
  ].join(" "),

  // Rayo: velocidad, urgencia, energía.
  rayo: poli([58, 2], [16, 56], [44, 56], [36, 98], [84, 42], [54, 42]),

  // Lupa: análisis, auditoría, revisión.
  lupa: [
    circulo(42, 42, 38),
    circulo(42, 42, 28, -1),
    poli([68, 74], [80, 62], [98, 84], [88, 94]),
  ].join(" "),

  // Sobre: la comunicación, el aviso, el correo.
  correo: [
    rect(2, 20, 96, 62),
    rect(10, 28, 80, 46, -1),
    poli([10, 28], [90, 28], [50, 62]),
  ].join(" "),

  // Globo de diálogo: lo que alguien dice, la conversación.
  conversacion: [
    rect(4, 12, 92, 62),
    rect(14, 22, 72, 42, -1),
    poli([26, 70], [50, 70], [26, 96]),
  ].join(" "),
};

/** Los nombres que el guion puede usar, para poder listarlos en un error. */
export const ICONOS_DISPONIBLES = Object.keys(CATALOGO).sort();

/** Normaliza el nombre escrito por el agente: sin tildes, sin mayúsculas. */
const normalizar = (nombre: string): string =>
  nombre
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Sinónimos que los agentes escriben igual de seguido que el nombre canónico.
 *
 * Vale más una tabla corta que un ícono que no aparece: un guion que pide
 * `:tiempo:` y no recibe nada deja la viñeta desalineada respecto de las otras.
 */
const SINONIMOS: Record<string, string> = {
  meta: "objetivo",
  blanco: "objetivo",
  tiempo: "reloj",
  plazo: "reloj",
  riesgo: "alerta",
  advertencia: "alerta",
  peligro: "alerta",
  ok: "chequeo",
  listo: "chequeo",
  hecho: "chequeo",
  check: "chequeo",
  datos: "grafico",
  metricas: "grafico",
  resultados: "grafico",
  crecimiento: "tendencia",
  ventas: "tendencia",
  cliente: "persona",
  usuario: "persona",
  gente: "equipo",
  personas: "equipo",
  proceso: "engranaje",
  sistema: "engranaje",
  config: "engranaje",
  innovacion: "idea",
  propuesta: "idea",
  plata: "dinero",
  costo: "dinero",
  precio: "dinero",
  ahorro: "dinero",
  seguridad: "escudo",
  calidad: "escudo",
  lanzamiento: "cohete",
  inicio: "cohete",
  informe: "documento",
  archivo: "documento",
  contrato: "documento",
  privado: "candado",
  aprobado: "candado",
  fecha: "calendario",
  agenda: "calendario",
  cronograma: "calendario",
  energia: "rayo",
  rapido: "rayo",
  urgente: "rayo",
  analisis: "lupa",
  auditoria: "lupa",
  revision: "lupa",
  mail: "correo",
  mensaje: "correo",
  dialogo: "conversacion",
  charla: "conversacion",
};

/** `:nombre:` al principio de un texto. Devuelve el ícono y lo que queda. */
export function separarIcono(texto: string): { icono: string; resto: string } {
  const marca = /^\s*:([a-zA-ZáéíóúñÁÉÍÓÚÑ_-]{2,24}):\s*/.exec(texto);
  if (!marca) return { icono: "", resto: texto };

  const pedido = normalizar(marca[1]!);
  const nombre = CATALOGO[pedido] ? pedido : (SINONIMOS[pedido] ?? "");
  // Un nombre que no existe **no** se come la marca: si la dejáramos afuera, el
  // agente no tendría cómo darse cuenta de que escribió `:crecimiiento:`.
  if (!nombre) return { icono: "", resto: texto };
  return { icono: nombre, resto: texto.slice(marca[0].length) };
}

/**
 * El mismo trazo, en SVG.
 *
 * El deck HTML y el video tienen que mostrar el mismo ícono: un segundo set
 * dibujado aparte se desincroniza a la primera corrección. Los dos formatos son
 * casi el mismo lenguaje —`m`/`l`/`b` contra `M`/`L`/`C`— y ambos rellenan por
 * regla non-zero, así que los agujeros siguen siendo agujeros. La única
 * diferencia real es que ASS cierra cada contorno solo y SVG necesita su `Z`.
 */
export function iconoSvg(nombre: string): string | null {
  const pedido = normalizar(nombre);
  const clave = CATALOGO[pedido] ? pedido : SINONIMOS[pedido];
  const trazo = clave ? CATALOGO[clave] : undefined;
  if (!trazo) return null;

  const piezas = trazo.split(/\s+/).filter(Boolean);
  const salida: string[] = [];
  let i = 0;
  let abierto = false;
  const numero = (): string => piezas[i++] ?? "0";

  while (i < piezas.length) {
    const comando = piezas[i++];
    if (comando === "m") {
      if (abierto) salida.push("Z");
      salida.push(`M${numero()} ${numero()}`);
      abierto = true;
    } else if (comando === "l") {
      salida.push(`L${numero()} ${numero()}`);
    } else if (comando === "b") {
      salida.push(`C${numero()} ${numero()} ${numero()} ${numero()} ${numero()} ${numero()}`);
    }
  }
  if (abierto) salida.push("Z");
  return salida.join(" ");
}

export interface DibujoIcono {
  /** El trazo listo para meter en un `Dialogue` con `{\p1}`. */
  trazo: string;
  /** Alto y ancho reales del ícono en píxeles del lienzo. */
  tamaño: number;
}

/**
 * El trazo de un ícono, escalado y ubicado con su esquina en el origen.
 *
 * Devuelve `null` para un nombre que no está: quien llama decide si dibuja la
 * viñeta cuadrada de siempre, y así un ícono mal escrito degrada a lo anterior
 * en vez de romper la escena.
 */
export function iconoAss(nombre: string, tamaño: number): DibujoIcono | null {
  const pedido = normalizar(nombre);
  const clave = CATALOGO[pedido] ? pedido : SINONIMOS[pedido];
  const trazoBase = clave ? CATALOGO[clave] : undefined;
  if (!trazoBase) return null;

  const escala = tamaño / 100;
  // Se escalan sólo los números: los comandos de ASS son letras (`m`, `l`, `b`)
  // y no hay dígitos entre ellos, así que un reemplazo global es exacto.
  const trazo = trazoBase.replace(/-?\d+(?:\.\d+)?/g, (crudo) => n(Number(crudo) * escala));
  return { trazo, tamaño };
}
