/**
 * Visuales dibujados, para las láminas que necesitan algo más que texto.
 *
 * Una presentación de venta sin imágenes es una lista de viñetas, y una lista de
 * viñetas no vende. Pero "imagen" no quiere decir fotografía: cuando lo que hay
 * que mostrar es **un proceso** —de dónde sale un dato y a dónde llega— una foto
 * de gente en una oficina no dice nada y un diagrama lo dice todo. Estos se
 * dibujan, así que no dependen de ningún proveedor, no cuestan nada, salen
 * siempre en la paleta de la marca y no envejecen como una foto de banco.
 *
 * El guion los pide con `![lo que muestra](visual:flujo)`, igual que una imagen.
 *
 * Cada visual se define **una vez** en una caja de 100×100 y se emite en los dos
 * formatos: SVG para el deck y trazos de ASS para el video. Es el mismo criterio
 * que en `iconos.ts` —y por la misma razón: dos versiones dibujadas aparte se
 * desincronizan a la primera corrección—, con una diferencia que importa: acá
 * hay **texto adentro** del dibujo, y el texto se coloca aparte en cada medio
 * porque ASS no sabe poner una palabra dentro de una forma.
 */

export type Pieza =
  /**
   * Un trazo libre, en sintaxis SVG y **sólo** con `M`, `L`, `C` y `Z`
   * absolutos.
   *
   * Es la única forma de dibujar una persona: un cuerpo son curvas, y con
   * rectángulos y círculos sale un muñeco de bloques. La restricción a cuatro
   * comandos no es pereza — es lo que permite convertir el mismo trazo a ASS
   * para el video sin escribir un intérprete de SVG.
   */
  | { forma: "trazo"; d: string; color: Tinte; opacidad?: number }
  | { forma: "rect"; x: number; y: number; ancho: number; alto: number; radio?: number; color: Tinte; opacidad?: number }
  | { forma: "linea"; x1: number; y1: number; x2: number; y2: number; color: Tinte }
  | { forma: "circulo"; cx: number; cy: number; r: number; color: Tinte; opacidad?: number }
  | { forma: "texto"; x: number; y: number; texto: string; cuerpo: number; color: Tinte; centrado?: boolean; peso?: "normal" | "fuerte" };

/**
 * Los nombres de color se resuelven distinto en cada medio; acá van simbólicos.
 *
 * `piel` y `pelo` existen para las personas y son deliberadamente **dos tonos y
 * no una paleta de skin tones**: un ilustrador puede matizar, un generador no, y
 * media docena de tonos elegidos por un programa terminan en un reparto que
 * parece un folleto de diversidad. Dos tonos neutros, dos siluetas distintas.
 */
export type Tinte =
  | "acento"
  | "realce"
  | "violeta"
  | "tinta"
  | "tenue"
  | "panel"
  | "linea"
  | "piel"
  | "pielAlt"
  | "pelo"
  | "ropa"
  | "ropaAlt";

export interface Visual {
  /** Qué muestra, para el epígrafe y para quien lea el guion. */
  descripcion: string;
  /**
   * El dibujo, armado con lo que el guion haya escrito después del `|`.
   *
   * Es una función y no una lista fija porque los visuales con personas
   * necesitan **lo que esa persona dice**: un personaje con un globo vacío no
   * es un personaje hablando, es un maniquí.
   */
  construir: (texto: string) => Pieza[];
}

const fijo = (descripcion: string, piezas: Pieza[]): Visual => ({
  descripcion,
  construir: () => piezas,
});

const rect = (
  x: number,
  y: number,
  ancho: number,
  alto: number,
  color: Tinte,
  extra: { radio?: number; opacidad?: number } = {},
): Pieza => ({ forma: "rect", x, y, ancho, alto, color, ...extra });

const texto = (
  x: number,
  y: number,
  contenido: string,
  cuerpo: number,
  color: Tinte,
  extra: { centrado?: boolean; peso?: "normal" | "fuerte" } = {},
): Pieza => ({ forma: "texto", x, y, texto: contenido, cuerpo, color, ...extra });

/**
 * Una burbuja de chat.
 *
 * Es el visual que más trabaja de todos: la historia entera se apoya en que
 * quien mira reconozca, sin que nadie se lo explique, que eso que aparece en
 * pantalla es el WhatsApp que él mismo usa todos los días.
 */
const burbuja = (
  y: number,
  ancho: number,
  propia: boolean,
  etiqueta: string,
  /** Dónde arranca el texto, para dejarle lugar a lo que va adentro. */
  sangria = 6,
): Pieza[] => [
  rect(propia ? 100 - ancho - 6 : 6, y, ancho, 13, propia ? "acento" : "panel", {
    radio: 4,
    opacidad: propia ? 0.9 : 1,
  }),
  texto(
    (propia ? 100 - ancho - 6 : 6) + sangria,
    y + 8.6,
    etiqueta,
    5.2,
    propia ? "tinta" : "tenue",
  ),
];

const trazo = (d: string, color: Tinte, opacidad?: number): Pieza => ({
  forma: "trazo",
  d,
  color,
  ...(opacidad !== undefined ? { opacidad } : {}),
});

interface Persona {
  /** Centro de la cabeza. El resto del cuerpo cuelga de ahí. */
  x: number;
  y: number;
  /** Alto de la figura visible, de la coronilla al corte inferior. */
  alto: number;
  piel: Tinte;
  ropa: Tinte;
  /** La silueta del pelo es lo que distingue a una persona de otra. */
  peinado: "corto" | "recogido" | "ondulado";
  /** Hacia dónde mira. Define de qué lado sale el brazo. */
  mira: "izquierda" | "derecha";
}

/**
 * Una persona de medio cuerpo.
 *
 * Se arma con curvas y no con círculos y rectángulos porque un cuerpo hecho de
 * cajas se lee como un muñeco de bloques, y una lámina de venta con muñecos de
 * bloques se ve como una plantilla gratis. Las proporciones están dibujadas
 * sobre una figura de 100 de alto y después se escalan: así una persona chica
 * en una esquina y otra grande en el centro son la misma persona.
 */
function persona(p: Persona): Pieza[] {
  const k = p.alto / 100;
  const u = (v: number): number => v * k;
  // Todo se dibuja alrededor de la cabeza, que es de donde cuelga la figura.
  const X = (v: number): number => p.x + u(v - 50);
  const Y = (v: number): number => p.y + u(v - 22);
  const espejo = p.mira === "izquierda" ? -1 : 1;
  const Xe = (v: number): number => p.x + u((v - 50) * espejo);

  const piezas: Pieza[] = [];

  // Torso: hombros anchos que se abren hacia abajo. La curva de arriba es la
  // que da la sensación de hombro; sin ella la figura parece un buzo colgado.
  piezas.push(
    trazo(
      `M ${X(26)} ${Y(100)} C ${X(26)} ${Y(66)} ${X(35)} ${Y(54)} ${X(50)} ${Y(54)} ` +
        `C ${X(65)} ${Y(54)} ${X(74)} ${Y(66)} ${X(74)} ${Y(100)} Z`,
      p.ropa,
    ),
  );
  // Cuello, apenas insinuado detrás del cuello de la ropa.
  piezas.push(trazo(`M ${X(45)} ${Y(38)} L ${X(55)} ${Y(38)} L ${X(55)} ${Y(56)} L ${X(45)} ${Y(56)} Z`, p.piel));
  // Escote en V: separa la cabeza del torso sin dibujar una línea.
  piezas.push(
    trazo(
      `M ${X(42)} ${Y(56)} C ${X(45)} ${Y(64)} ${X(55)} ${Y(64)} ${X(58)} ${Y(56)} ` +
        `C ${X(55)} ${Y(53)} ${X(45)} ${Y(53)} ${X(42)} ${Y(56)} Z`,
      "panel",
      0.35,
    ),
  );

  // Cabeza: un óvalo, no un círculo. Un círculo perfecto lee como emoji.
  piezas.push(
    trazo(
      `M ${X(50)} ${Y(6)} C ${X(61)} ${Y(6)} ${X(66)} ${Y(15)} ${X(66)} ${Y(24)} ` +
        `C ${X(66)} ${Y(35)} ${X(59)} ${Y(42)} ${X(50)} ${Y(42)} ` +
        `C ${X(41)} ${Y(42)} ${X(34)} ${Y(35)} ${X(34)} ${Y(24)} ` +
        `C ${X(34)} ${Y(15)} ${X(39)} ${Y(6)} ${X(50)} ${Y(6)} Z`,
      p.piel,
    ),
  );

  if (p.peinado === "corto") {
    piezas.push(
      trazo(
        `M ${X(34)} ${Y(24)} C ${X(33)} ${Y(10)} ${X(41)} ${Y(3)} ${X(50)} ${Y(3)} ` +
          `C ${X(60)} ${Y(3)} ${X(67)} ${Y(11)} ${X(66)} ${Y(24)} ` +
          `C ${X(64)} ${Y(17)} ${X(60)} ${Y(14)} ${X(50)} ${Y(14)} ` +
          `C ${X(41)} ${Y(14)} ${X(36)} ${Y(17)} ${X(34)} ${Y(24)} Z`,
        "pelo",
      ),
    );
  } else if (p.peinado === "recogido") {
    piezas.push(
      trazo(
        `M ${X(33)} ${Y(26)} C ${X(31)} ${Y(9)} ${X(41)} ${Y(2)} ${X(50)} ${Y(2)} ` +
          `C ${X(60)} ${Y(2)} ${X(69)} ${Y(9)} ${X(67)} ${Y(26)} ` +
          `C ${X(65)} ${Y(16)} ${X(60)} ${Y(12)} ${X(50)} ${Y(12)} ` +
          `C ${X(40)} ${Y(12)} ${X(35)} ${Y(16)} ${X(33)} ${Y(26)} Z`,
        "pelo",
      ),
    );
    // El rodete: es lo que hace reconocible el peinado de lejos.
    piezas.push(
      trazo(
        `M ${X(66)} ${Y(12)} C ${X(75)} ${Y(10)} ${X(78)} ${Y(18)} ${X(73)} ${Y(22)} ` +
          `C ${X(69)} ${Y(24)} ${X(65)} ${Y(19)} ${X(66)} ${Y(12)} Z`,
        "pelo",
      ),
    );
  } else {
    piezas.push(
      trazo(
        `M ${X(32)} ${Y(30)} C ${X(29)} ${Y(10)} ${X(40)} ${Y(1)} ${X(50)} ${Y(1)} ` +
          `C ${X(61)} ${Y(1)} ${X(71)} ${Y(10)} ${X(68)} ${Y(30)} ` +
          `C ${X(72)} ${Y(38)} ${X(66)} ${Y(44)} ${X(64)} ${Y(38)} ` +
          `C ${X(66)} ${Y(24)} ${X(60)} ${Y(15)} ${X(50)} ${Y(15)} ` +
          `C ${X(40)} ${Y(15)} ${X(34)} ${Y(24)} ${X(36)} ${Y(38)} ` +
          `C ${X(34)} ${Y(44)} ${X(28)} ${Y(38)} ${X(32)} ${Y(30)} Z`,
        "pelo",
      ),
    );
  }

  // Brazo que se levanta hacia la cara: sostiene el teléfono o el auricular.
  piezas.push(
    trazo(
      `M ${Xe(70)} ${Y(70)} C ${Xe(80)} ${Y(66)} ${Xe(84)} ${Y(52)} ${Xe(76)} ${Y(44)} ` +
        `C ${Xe(72)} ${Y(41)} ${Xe(66)} ${Y(45)} ${Xe(69)} ${Y(50)} ` +
        `C ${Xe(73)} ${Y(56)} ${Xe(70)} ${Y(62)} ${Xe(63)} ${Y(64)} Z`,
      p.ropa,
    ),
  );
  // La mano, en tono piel: sin ella el brazo termina en un muñón de tela.
  piezas.push(
    trazo(
      `M ${Xe(76)} ${Y(44)} C ${Xe(82)} ${Y(41)} ${Xe(82)} ${Y(33)} ${Xe(76)} ${Y(32)} ` +
        `C ${Xe(70)} ${Y(31)} ${Xe(68)} ${Y(39)} ${Xe(72)} ${Y(43)} Z`,
      p.piel,
    ),
  );

  return piezas;
}

/** Una burbuja de diálogo con la punta apuntando a quien habla. */
function globo(
  x: number,
  y: number,
  ancho: number,
  frase: string,
  desde: "izquierda" | "derecha",
): Pieza[] {
  const cuerpo = 5;
  // El corte lo decide el globo y no quien lo llama: pasarle un número de
  // caracteres a ojo es lo que hacía que la frase se saliera por el costado.
  // El ancho medio de un carácter es la mitad del cuerpo.
  const porRenglon = Math.max(8, Math.floor((ancho - 12) / (cuerpo * 0.5)));
  const lineas = renglones(frase, porRenglon);
  const alto = 12 + lineas.length * 8;
  const puntaX = desde === "izquierda" ? x + 10 : x + ancho - 10;
  return [
    { forma: "rect", x, y, ancho, alto, radio: 5, color: "panel", opacidad: 0.96 },
    trazo(
      `M ${puntaX - 5} ${y + alto} L ${puntaX + 5} ${y + alto} L ${desde === "izquierda" ? puntaX - 7 : puntaX + 7} ${y + alto + 7} Z`,
      "panel",
      0.96,
    ),
    ...lineas.map((linea, i) => texto(x + 6, y + 12 + i * 8, linea, cuerpo, "tinta")),
  ];
}

/** Parte un texto en renglones que entran en el globo. */
function renglones(frase: string, porRenglon: number, maximo = 3): string[] {
  const palabras = frase.split(/\s+/).filter(Boolean);
  const salida: string[] = [];
  let actual = "";
  for (const palabra of palabras) {
    const tentativa = actual ? `${actual} ${palabra}` : palabra;
    if (tentativa.length > porRenglon && actual) {
      salida.push(actual);
      actual = palabra;
    } else {
      actual = tentativa;
    }
  }
  if (actual) salida.push(actual);
  // Lo que no entra se corta con puntos suspensivos: un globo que crece hasta
  // taparle la cara al personaje es peor que una frase recortada.
  if (salida.length > maximo) {
    const recortado = salida.slice(0, maximo);
    recortado[maximo - 1] = `${recortado[maximo - 1]!.slice(0, porRenglon - 1)}…`;
    return recortado;
  }
  return salida;
}

const CATALOGO: Record<string, Visual> = {
  /** El origen del dato: un chat con un audio, una foto y un texto. */
  chat: fijo(
    "Un chat de trabajo con un audio, una foto de planilla y un mensaje",
    [
      rect(0, 0, 100, 100, "panel", { radio: 6, opacidad: 0.5 }),
      rect(0, 0, 100, 12, "violeta", { radio: 6, opacidad: 0.85 }),
      texto(6, 8, "Reporte del día", 5.4, "tinta", { peso: "fuerte" }),
      // La onda va **adentro** de la burbuja y el texto empieza después: con el
      // rótulo pegado al borde, las barras le pasaban por encima a la palabra.
      ...burbuja(18, 62, false, "Audio  0:41", 22),
      rect(10, 21, 2, 7, "realce"),
      rect(13.5, 19.5, 2, 10, "realce"),
      rect(17, 22, 2, 5, "realce"),
      rect(20.5, 20.5, 2, 8, "realce"),
      ...burbuja(35, 58, false, "Foto de la planilla", 22),
      rect(10, 37.5, 9, 8, "acento", { radio: 1, opacidad: 0.55 }),
      ...burbuja(52, 46, true, "Listo, ya quedó"),
      ...burbuja(69, 58, false, "Van 240 bultos"),
      rect(0, 88, 100, 12, "panel", { radio: 6 }),
      texto(6, 96, "Escribí un mensaje", 5, "tenue"),
    ],
  ),

  /** El proceso completo: una entrada, el sistema, cuatro salidas. */
  flujo: fijo(
    "Del mensaje al registro, el correo, la agenda y el aviso",
    [
      // La caja de entrada es ancha porque adentro va la enumeración completa:
      // "audio · foto · texto" **es** el argumento, y recortarlo a una palabra
      // deja el diagrama diciendo menos que la viñeta de al lado.
      rect(0, 40, 30, 20, "panel", { radio: 3 }),
      texto(15, 48, "Mensaje", 5.2, "tinta", { centrado: true, peso: "fuerte" }),
      texto(15, 55, "audio · foto · texto", 3.2, "tenue", { centrado: true }),
      { forma: "linea", x1: 30, y1: 50, x2: 38, y2: 50, color: "acento" },
      rect(38, 34, 26, 32, "violeta", { radio: 3, opacidad: 0.9 }),
      // La caja del medio dice "El sistema" y no el nombre de una empresa: el
      // catálogo de visuales lo comparten todas, así que un nombre propio acá
      // se cuela en el video de otra marca. Pasó: un video de INSPIA salió con
      // "Codytion" dibujado en el medio del diagrama.
      texto(51, 46, "El sistema", 5.6, "tinta", { centrado: true, peso: "fuerte" }),
      texto(51, 54, "entiende y", 4.4, "tinta", { centrado: true }),
      texto(51, 60, "clasifica", 4.4, "tinta", { centrado: true }),
      // Las cuatro salidas en abanico: se ve de un vistazo que de un solo
      // mensaje salen cuatro cosas, que es exactamente el argumento.
      { forma: "linea", x1: 64, y1: 50, x2: 72, y2: 14, color: "realce" },
      { forma: "linea", x1: 64, y1: 50, x2: 72, y2: 38, color: "realce" },
      { forma: "linea", x1: 64, y1: 50, x2: 72, y2: 62, color: "realce" },
      { forma: "linea", x1: 64, y1: 50, x2: 72, y2: 86, color: "realce" },
      rect(72, 8, 26, 13, "panel", { radio: 2 }),
      texto(76, 16.5, "Planilla", 4.8, "tinta"),
      rect(72, 32, 26, 13, "panel", { radio: 2 }),
      texto(76, 40.5, "Correo", 4.8, "tinta"),
      rect(72, 56, 26, 13, "panel", { radio: 2 }),
      texto(76, 64.5, "Agenda", 4.8, "tinta"),
      rect(72, 80, 26, 13, "panel", { radio: 2 }),
      texto(76, 88.5, "Aviso", 4.8, "tinta"),
    ],
  ),

  /** Los números que sostienen la propuesta. */
  datos: fijo(
    "Diez años, tres países, más de veinte proyectos",
    [
      rect(0, 4, 100, 26, "panel", { radio: 3 }),
      texto(8, 20, "10+", 13, "realce", { peso: "fuerte" }),
      texto(34, 19, "años construyendo software", 5, "tenue"),
      rect(0, 37, 100, 26, "panel", { radio: 3 }),
      texto(8, 53, "3", 13, "acento", { peso: "fuerte" }),
      texto(34, 52, "países", 5, "tenue"),
      rect(0, 70, 100, 26, "panel", { radio: 3 }),
      texto(8, 86, "20+", 13, "realce", { peso: "fuerte" }),
      texto(34, 85, "proyectos entregados", 5, "tenue"),
    ],
  ),

  /** Lo que se vigila cuando el sistema ya está andando. */
  monitoreo: fijo(
    "Un tablero de monitoreo con la operación en verde",
    [
      rect(0, 0, 100, 100, "panel", { radio: 4, opacidad: 0.6 }),
      texto(6, 12, "Operación", 6, "tinta", { peso: "fuerte" }),
      { forma: "circulo", cx: 92, cy: 9, r: 3, color: "realce" },
      // Una línea que sube, dibujada a mano: es el gesto de "todo bien".
      { forma: "linea", x1: 8, y1: 62, x2: 24, y2: 54, color: "acento" },
      { forma: "linea", x1: 24, y1: 54, x2: 40, y2: 58, color: "acento" },
      { forma: "linea", x1: 40, y1: 58, x2: 56, y2: 40, color: "acento" },
      { forma: "linea", x1: 56, y1: 40, x2: 72, y2: 44, color: "acento" },
      { forma: "linea", x1: 72, y1: 44, x2: 92, y2: 26, color: "acento" },
      rect(6, 72, 27, 20, "violeta", { radio: 2, opacidad: 0.8 }),
      texto(19.5, 82, "Nube", 4.6, "tinta", { centrado: true }),
      texto(19.5, 88, "en línea", 4, "tenue", { centrado: true }),
      rect(36.5, 72, 27, 20, "violeta", { radio: 2, opacidad: 0.8 }),
      texto(50, 82, "Respaldos", 4.6, "tinta", { centrado: true }),
      texto(50, 88, "al día", 4, "tenue", { centrado: true }),
      rect(67, 72, 27, 20, "violeta", { radio: 2, opacidad: 0.8 }),
      texto(80.5, 82, "Alertas", 4.6, "tinta", { centrado: true }),
      texto(80.5, 88, "activas", 4, "tenue", { centrado: true }),
    ],
  ),

  /**
   * Una operaria reportando desde la bodega.
   *
   * El escenario importa tanto como la persona: el estante y las cajas son lo
   * que convierte "alguien con un teléfono" en "alguien trabajando en un
   * depósito", que es donde ocurre el problema que vende la pieza.
   */
  bodega: {
    descripcion: "Una operaria reportando por el celular desde la bodega",
    construir: (frase) => [
      // Estantería al fondo, en tono apagado: escenario, no protagonista.
      rect(4, 22, 44, 4, "linea"),
      rect(4, 48, 44, 4, "linea"),
      rect(6, 26, 14, 22, "panel", { radio: 1, opacidad: 0.75 }),
      rect(22, 30, 12, 18, "violeta", { radio: 1, opacidad: 0.35 }),
      rect(36, 28, 10, 20, "panel", { radio: 1, opacidad: 0.6 }),
      rect(8, 52, 16, 20, "panel", { radio: 1, opacidad: 0.5 }),
      ...persona({ x: 30, y: 46, alto: 64, piel: "piel", ropa: "ropa", peinado: "recogido", mira: "derecha" }),
      // El teléfono, pegado a la mano que sube hacia la cara.
      rect(44, 47, 8, 12, "tinta", { radio: 1.5, opacidad: 0.92 }),
      rect(44.9, 48.7, 6.2, 8.6, "acento", { radio: 0.6 }),
      ...globo(50, 4, 48, frase || "Mando el reporte por audio", "izquierda"),
    ],
  },

  /**
   * El gerente mirando el resultado, que es el otro lado de la misma historia.
   */
  escritorio: {
    descripcion: "El gerente revisando el tablero en su escritorio",
    construir: (frase) => [
      // Ventana: da profundidad y ubica la escena en una oficina sin dibujarla.
      rect(4, 6, 30, 34, "violeta", { radio: 2, opacidad: 0.25 }),
      { forma: "linea", x1: 19, y1: 6, x2: 19, y2: 40, color: "linea" },
      { forma: "linea", x1: 4, y1: 23, x2: 34, y2: 23, color: "linea" },
      ...persona({ x: 64, y: 34, alto: 62, piel: "pielAlt", ropa: "ropaAlt", peinado: "corto", mira: "izquierda" }),
      // El escritorio corta la figura a la altura del pecho: es lo que hace que
      // se lea "sentado" sin tener que dibujar una silla ni unas piernas.
      rect(0, 78, 100, 5, "panel"),
      rect(0, 83, 100, 17, "panel", { opacidad: 0.55 }),
      // Portátil abierto, de perfil.
      trazo("M 30 78 L 44 78 L 47 62 L 33 62 Z", "tinta", 0.85),
      trazo("M 33 63 L 46 63 L 44 76 L 32 76 Z", "acento", 0.5),
      rect(26, 74, 22, 4, "tinta", { radio: 1, opacidad: 0.6 }),
      // Una planta: el detalle que separa una escena de un diagrama.
      trazo("M 90 78 C 86 68 88 60 92 58 C 94 63 93 71 91 78 Z", "realce", 0.75),
      rect(87, 78, 8, 8, "panel", { radio: 1 }),
      ...globo(2, 40, 46, frase || "Ya sé lo que pasó ayer", "derecha"),
    ],
  },

  /**
   * El primer contacto: la persona que llama, con auricular.
   */
  llamada: {
    descripcion: "La especialista haciendo el primer contacto por teléfono",
    construir: (frase) => [
      // El fondo va abajo a la izquierda, detrás de la figura: arriba a la
      // derecha le pisaba el globo y parecían dos burbujas superpuestas.
      rect(2, 44, 42, 56, "violeta", { radio: 3, opacidad: 0.18 }),
      ...persona({ x: 30, y: 44, alto: 66, piel: "piel", ropa: "acento", peinado: "ondulado", mira: "derecha" }),
      // La vincha del auricular pasa por encima del pelo, y el micrófono baja
      // hasta la altura de la boca: sin el brazo del micrófono es una diadema.
      trazo("M 19 47 C 19 33 24 27 30 27 C 37 27 42 33 42 47 L 39 47 C 39 36 35 32 30 32 C 26 32 22 36 22 47 Z", "tinta", 0.85),
      rect(38, 43, 5.5, 6, "tinta", { radio: 1.5, opacidad: 0.92 }),
      trazo("M 41 49 C 44 55 42 60 38 61 L 37 58 C 40 57 41 53 39 50 Z", "tinta", 0.8),
      ...globo(46, 4, 52, frase || "Cuénteme cómo cierra el día", "izquierda"),
    ],
  },

  /** La persona con la que se habla primero. */
  contacto: fijo(
    "La tarjeta de quien atiende el primer contacto",
    [
      rect(4, 10, 92, 80, "panel", { radio: 5 }),
      { forma: "circulo", cx: 50, cy: 34, r: 15, color: "violeta" },
      texto(50, 39, "YS", 12, "tinta", { centrado: true, peso: "fuerte" }),
      texto(50, 60, "Yoselin Saldaña", 7, "tinta", { centrado: true, peso: "fuerte" }),
      texto(50, 69, "Economista", 5, "realce", { centrado: true }),
      { forma: "linea", x1: 30, y1: 75, x2: 70, y2: 75, color: "linea" },
      texto(50, 84, "admin@codytion.com", 4.6, "tenue", { centrado: true }),
    ],
  ),
};

export const VISUALES_DISPONIBLES = Object.keys(CATALOGO).sort();

/**
 * `visual:flujo` o `visual:bodega|Mando el reporte por audio`.
 *
 * Lo que va después de la barra es **lo que dice el personaje**. Se escribe en
 * el guion y no en el catálogo porque cambia con cada pieza: el mismo escenario
 * de bodega sirve para dos campañas distintas si la frase la pone el guion.
 */
const partir = (spec: string): { nombre: string; texto: string } => {
  const [crudo = "", ...resto] = spec.split("|");
  return { nombre: crudo.trim().toLowerCase(), texto: resto.join("|").trim() };
};

export const nombreDeVisual = (src: string): string | null => {
  const marca = /^visual:\s*(.+)$/i.exec(src.trim());
  if (!marca) return null;
  const { nombre, texto } = partir(marca[1]!);
  if (!CATALOGO[nombre]) return null;
  return texto ? `${nombre}|${texto}` : nombre;
};

export const visualDe = (spec: string): Visual | null => CATALOGO[partir(spec).nombre] ?? null;

/** Las piezas ya construidas, con la frase que traiga el `spec`. */
const piezasDe = (spec: string): Pieza[] | null => {
  const visual = visualDe(spec);
  return visual ? visual.construir(partir(spec).texto) : null;
};

/**
 * Un trazo de SVG llevado a ASS.
 *
 * Los dos lenguajes dicen lo mismo con otras letras —`M`/`L`/`C` contra
 * `m`/`l`/`b`— y ASS cierra cada contorno solo, así que la `Z` se descarta. Por
 * eso los trazos se autorizan **sólo** con esos cuatro comandos: en cuanto
 * entra un arco o una curva cuadrática hay que escribir un intérprete.
 */
function trazoAAss(d: string, escala: number, dx: number, dy: number): string {
  const piezas = d.trim().split(/[\s,]+/);
  const salida: string[] = [];
  let i = 0;
  let comando = "";
  const numero = (eje: "x" | "y"): string => {
    const valor = Number(piezas[i++] ?? 0) * escala + (eje === "x" ? dx : dy);
    return n(valor);
  };
  while (i < piezas.length) {
    const actual = piezas[i]!;
    if (/^[MLCZ]$/i.test(actual)) {
      comando = actual.toUpperCase();
      i++;
      if (comando === "Z") continue;
    }
    if (comando === "M") salida.push(`m ${numero("x")} ${numero("y")}`);
    else if (comando === "L") salida.push(`l ${numero("x")} ${numero("y")}`);
    else if (comando === "C")
      salida.push(
        `b ${numero("x")} ${numero("y")} ${numero("x")} ${numero("y")} ${numero("x")} ${numero("y")}`,
      );
    else i++;
  }
  return salida.join(" ");
}

/** Redondeo corto: dos decimales alcanzan y el archivo no se infla. */
const n = (valor: number): string => {
  const r = Math.round(valor * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};

const escaparXml = (t: string): string =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * El visual como SVG, para el deck.
 *
 * `paleta` traduce los nombres simbólicos a los colores del medio: el mismo
 * dibujo se ve igual en el HTML y en el video sin repetir los hexadecimales en
 * dos archivos que después nadie sincroniza.
 */
export function visualSvg(spec: string, paleta: Record<Tinte, string>): string | null {
  const visual = visualDe(spec);
  const piezas = piezasDe(spec);
  if (!visual || !piezas) return null;

  const partes = piezas.map((pieza) => {
    const color = paleta[pieza.color];
    const opacidad = "opacidad" in pieza && pieza.opacidad !== undefined ? ` opacity="${pieza.opacidad}"` : "";
    if (pieza.forma === "trazo") {
      return `<path d="${pieza.d}" fill="${color}"${opacidad}/>`;
    }
    if (pieza.forma === "rect") {
      return (
        `<rect x="${n(pieza.x)}" y="${n(pieza.y)}" width="${n(pieza.ancho)}" height="${n(pieza.alto)}"` +
        `${pieza.radio ? ` rx="${n(pieza.radio)}"` : ""} fill="${color}"${opacidad}/>`
      );
    }
    if (pieza.forma === "circulo") {
      return `<circle cx="${n(pieza.cx)}" cy="${n(pieza.cy)}" r="${n(pieza.r)}" fill="${color}"${opacidad}/>`;
    }
    if (pieza.forma === "linea") {
      return (
        `<line x1="${n(pieza.x1)}" y1="${n(pieza.y1)}" x2="${n(pieza.x2)}" y2="${n(pieza.y2)}" ` +
        `stroke="${color}" stroke-width="0.7" stroke-linecap="round"/>`
      );
    }
    return (
      `<text x="${n(pieza.x)}" y="${n(pieza.y)}" fill="${color}" font-size="${n(pieza.cuerpo)}"` +
      `${pieza.peso === "fuerte" ? ' font-weight="700"' : ""}` +
      `${pieza.centrado ? ' text-anchor="middle"' : ""}>${escaparXml(pieza.texto)}</text>`
    );
  });

  return (
    `<svg class="visual" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="${escaparXml(visual.descripcion)}">${partes.join("")}</svg>`
  );
}

/** Una pieza del visual, ya convertida a algo que el render de video sabe poner. */
export type PiezaAss =
  | { tipo: "forma"; trazo: string; color: Tinte; opacidad: number; x: number; y: number }
  | { tipo: "texto"; texto: string; color: Tinte; cuerpo: number; x: number; y: number; centrado: boolean; peso: boolean };

/**
 * El visual llevado a la escala del video.
 *
 * ASS no puede meter una palabra adentro de una forma, así que el dibujo se
 * devuelve **despiezado**: las formas por un lado y los textos por otro, cada
 * uno con su posición ya en píxeles del lienzo. Quien renderiza los emite en ese
 * orden y el texto queda encima, que es lo único que hace falta.
 */
export function visualAss(spec: string, x0: number, y0: number, lado: number): PiezaAss[] | null {
  const piezas = piezasDe(spec);
  if (!piezas) return null;

  const k = lado / 100;
  const px = (v: number): number => x0 + v * k;
  const py = (v: number): number => y0 + v * k;
  const salida: PiezaAss[] = [];

  for (const pieza of piezas) {
    if (pieza.forma === "trazo") {
      // El trazo ya trae coordenadas absolutas de la caja: se escala entero y
      // se ancla en el origen del visual, no en un punto propio.
      salida.push({
        tipo: "forma",
        trazo: trazoAAss(pieza.d, k, 0, 0),
        color: pieza.color,
        opacidad: pieza.opacidad ?? 1,
        x: x0,
        y: y0,
      });
      continue;
    }
    if (pieza.forma === "rect") {
      const ancho = pieza.ancho * k;
      const alto = pieza.alto * k;
      salida.push({
        tipo: "forma",
        trazo: `m 0 0 l ${n(ancho)} 0 l ${n(ancho)} ${n(alto)} l 0 ${n(alto)}`,
        color: pieza.color,
        opacidad: pieza.opacidad ?? 1,
        x: px(pieza.x),
        y: py(pieza.y),
      });
      continue;
    }
    if (pieza.forma === "linea") {
      // Una línea en ASS es un rectángulo finito rotado; para los ángulos
      // suaves de estos diagramas alcanza con un polígono de cuatro puntos.
      const x1 = px(pieza.x1);
      const y1 = py(pieza.y1);
      const x2 = px(pieza.x2);
      const y2 = py(pieza.y2);
      const largo = Math.hypot(x2 - x1, y2 - y1) || 1;
      const grosor = Math.max(2, 0.7 * k);
      const nx = ((y2 - y1) / largo) * (grosor / 2);
      const ny = (-(x2 - x1) / largo) * (grosor / 2);
      salida.push({
        tipo: "forma",
        trazo:
          `m ${n(nx)} ${n(ny)} l ${n(x2 - x1 + nx)} ${n(y2 - y1 + ny)} ` +
          `l ${n(x2 - x1 - nx)} ${n(y2 - y1 - ny)} l ${n(-nx)} ${n(-ny)}`,
        color: pieza.color,
        opacidad: 1,
        x: x1,
        y: y1,
      });
      continue;
    }
    if (pieza.forma === "circulo") {
      const r = pieza.r * k;
      const c = r * 0.5523;
      salida.push({
        tipo: "forma",
        trazo:
          `m 0 ${n(-r)} b ${n(c)} ${n(-r)} ${n(r)} ${n(-c)} ${n(r)} 0 ` +
          `b ${n(r)} ${n(c)} ${n(c)} ${n(r)} 0 ${n(r)} ` +
          `b ${n(-c)} ${n(r)} ${n(-r)} ${n(c)} ${n(-r)} 0 ` +
          `b ${n(-r)} ${n(-c)} ${n(-c)} ${n(-r)} 0 ${n(-r)}`,
        color: pieza.color,
        opacidad: pieza.opacidad ?? 1,
        x: px(pieza.cx),
        y: py(pieza.cy),
      });
      continue;
    }
    salida.push({
      tipo: "texto",
      texto: pieza.texto,
      color: pieza.color,
      // El cuerpo del SVG está en unidades de la caja; acá se lleva a píxeles.
      cuerpo: Math.round(pieza.cuerpo * k),
      x: px(pieza.x),
      // En SVG la `y` del texto es la línea de base; en ASS con alineación
      // superior es el techo. Se sube un cuerpo para que caigan en el mismo
      // lugar: sin esto los rótulos quedan un renglón más abajo que su caja.
      y: py(pieza.y) - pieza.cuerpo * k,
      centrado: pieza.centrado ?? false,
      peso: pieza.peso === "fuerte",
    });
  }

  return salida;
}
