/**
 * El sistema de diseño de las láminas, y la lámina de respaldo.
 *
 * Una lámina programada por un agente sin vocabulario común sale distinta cada
 * vez: otro azul, otro cuerpo de letra, otra manera de entrar. Seis láminas así
 * no son un video, son seis plantillas gratis puestas en fila. Acá vive el
 * vocabulario —paleta, escala tipográfica, retículas, cómo entra cada cosa— y
 * el agente escribe HTML *usando* esas clases en vez de inventarlas.
 *
 * La hoja se **escribe en el directorio de salida en cada render**, así que
 * siempre es la de esta versión del sistema: una copia vieja pegada por un
 * agente en su primera corrida no puede quedar mandando meses después.
 *
 * ## El contrato de animación
 *
 * Todo lo que se mueve tiene que terminar. `chrome.ts` mide cuánto dura la
 * animación más larga y filma exactamente eso; un bucle infinito no se puede
 * filmar sin capturar el video entero cuadro por cuadro, que es justo lo que
 * este diseño evita. El movimiento continuo lo pone el fondo de ffmpeg, que
 * cuesta cero. Por eso todas las animaciones de acá son finitas y con
 * `fill: both`: entran, se acomodan y se quedan.
 *
 * Y se animan con CSS o con la API de animaciones del navegador, nunca con
 * SMIL (`<animate>`): SMIL no aparece en `document.getAnimations()`, así que no
 * se puede pausar ni adelantar, y sale a tirones o directamente no sale.
 */

import { iconoSvg } from "./iconos.js";
import type { Escena } from "./guion.js";

/** Dónde vive el kit dentro del directorio de salida. */
export const RUTA_TEMA = "estudio/tema.css";
export const RUTA_GUIA = "estudio/GUIA.md";
/** Carpeta donde el agente deja las láminas, una por escena. */
export const CARPETA_ESCENAS = "escenas";

/**
 * La paleta sale del **logo**, igual que en el video: violeta `#5058e8`,
 * turquesa `#40f8c0` y azul `#40a0f8`. Que las dos salidas compartan estos
 * valores es lo que hace que una lámina y una placa de ASS se vean de la misma
 * empresa.
 */
export const PALETA = {
  fondo: "#0a0e1a",
  tinta: "#f8fafc",
  tenue: "#94a3b8",
  debil: "#64748b",
  acento: "#40a0f8",
  realce: "#3ee8b4",
  violeta: "#5058e8",
  panel: "#232f4d",
  linea: "#1e293b",
} as const;

export const TEMA_CSS = `/* Kit de estudio — generado por export_video_estudio. No lo edites a mano:
   se reescribe en cada render. */

:root {
  --fondo: ${PALETA.fondo};
  --tinta: ${PALETA.tinta};
  --tenue: ${PALETA.tenue};
  --debil: ${PALETA.debil};
  --acento: ${PALETA.acento};
  --realce: ${PALETA.realce};
  --violeta: ${PALETA.violeta};
  --panel: ${PALETA.panel};
  --linea: ${PALETA.linea};

  --margen: 180px;
  --titulo: 'Avenir Next Demi Bold', 'Avenir Next', 'Helvetica Neue', system-ui, sans-serif;
  --cuerpo: 'Avenir Next', 'Helvetica Neue', system-ui, sans-serif;

  --entrada: 620ms;
  --escalon: 110ms;
  --curva: cubic-bezier(0.22, 1, 0.36, 1);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

/* El fondo lo pone ffmpeg por detrás y es lo único que se mueve todo el tiempo.
   Una lámina que quiera el suyo usa .lamina.opaca y lo tapa. */
html, body { width: 1920px; height: 1080px; overflow: hidden; background: transparent; }

body {
  font-family: var(--cuerpo);
  color: var(--tinta);
  -webkit-font-smoothing: antialiased;
}

.lamina {
  position: relative;
  width: 1920px; height: 1080px;
  padding: 140px var(--margen) 120px;
  display: flex; flex-direction: column;
}
.lamina.opaca { background: radial-gradient(120% 140% at 78% 8%, #1a1f45 0%, var(--fondo) 62%); }
.lamina.centrada { justify-content: center; }

/* --- Encabezado ------------------------------------------------------- */

.ceja {
  font-size: 26px; font-weight: 600; letter-spacing: 0.34em; text-transform: uppercase;
  color: var(--acento);
}
.regla {
  width: 84px; height: 4px; margin-top: 22px; border-radius: 2px;
  background: linear-gradient(90deg, var(--realce), var(--acento));
  transform-origin: left center;
}
.titulo {
  font-family: var(--titulo);
  font-size: 92px; line-height: 1.06; letter-spacing: -0.018em;
  margin-top: 40px; max-width: 21ch;
}
.titulo.grande { font-size: 132px; max-width: 15ch; }
.bajada {
  font-size: 40px; line-height: 1.34; color: var(--tenue);
  margin-top: 34px; max-width: 30ch;
}

/* --- Listas ----------------------------------------------------------- */

/* Las viñetas cuelgan del título, no del pie: ancladas abajo dejaban un pozo
   vacío en el medio del cuadro que se lee como una lámina a medio terminar.
   La clase .abajo sigue disponible para cuando esa es la intención. */
.lista { margin-top: 76px; display: flex; flex-direction: column; gap: 30px; }
.lista.abajo { margin-top: auto; }
.item {
  display: flex; align-items: center; gap: 28px;
  font-size: 42px; line-height: 1.24; color: var(--tinta);
}
.item .icono { flex: none; width: 46px; height: 46px; fill: var(--acento); }
.item .punto {
  flex: none; width: 14px; height: 14px; border-radius: 4px;
  background: var(--acento); transform: rotate(45deg);
}

/* --- Bloques ---------------------------------------------------------- */

.dos { display: grid; grid-template-columns: 1fr 1fr; gap: 72px; align-items: center; flex: 1; }
.tres { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; margin-top: auto; }

.tarjeta {
  padding: 44px 40px; border-radius: 22px;
  background: linear-gradient(160deg, rgba(80, 88, 232, 0.20), rgba(35, 47, 77, 0.42));
  border: 1px solid rgba(148, 163, 184, 0.20);
  box-shadow: inset 0 1px 0 rgba(248, 250, 252, 0.10);
}
.tarjeta .rotulo {
  font-size: 24px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--realce);
}
.tarjeta .texto { font-size: 34px; line-height: 1.3; margin-top: 18px; color: var(--tinta); }

.dato { font-family: var(--titulo); font-size: 118px; line-height: 1; color: var(--realce); }
.dato + .rotulo { margin-top: 14px; }

.cita {
  font-family: var(--titulo); font-size: 68px; line-height: 1.24;
  max-width: 26ch; margin: auto 0;
  border-left: 6px solid var(--realce); padding-left: 44px;
}

.figura { width: 100%; border-radius: 20px; overflow: hidden; }
.figura img, .figura svg { display: block; width: 100%; height: auto; }

/* --- Pie -------------------------------------------------------------- */

.pie {
  position: absolute; left: var(--margen); right: var(--margen); bottom: 64px;
  display: flex; justify-content: space-between; align-items: center;
  font-size: 24px; color: var(--debil); letter-spacing: 0.08em;
}
.pasos { display: flex; gap: 10px; }
.pasos i { width: 26px; height: 4px; border-radius: 2px; background: var(--linea); }
.pasos i.aqui { background: var(--acento); width: 46px; }

/* El logo va chico y quieto, y nunca estirado: se le fija el alto y el ancho
   sale solo. Un logo deformado es peor que ningún logo. */
.marca { position: absolute; right: var(--margen); top: 92px; height: 62px; width: auto; }
.lamina.centrada .marca { position: static; height: 190px; margin-bottom: 56px; }

/* --- Movimiento -------------------------------------------------------
   Todo termina. Nada de bucles infinitos: ver el encabezado del archivo. */

@keyframes subir { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: none; } }
@keyframes aparecer { from { opacity: 0; } to { opacity: 1; } }
@keyframes estirar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes revelar { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes trazar { from { stroke-dashoffset: var(--largo, 400); } to { stroke-dashoffset: 0; } }

.anima { animation: subir var(--entrada) var(--curva) both; }
.anima.suave { animation-name: aparecer; }
.anima.barre { animation-name: revelar; }
.regla { animation: estirar 520ms var(--curva) both 180ms; }

/* El escalonado viene solo: el agente escribe la lista y las viñetas entran
   una detrás de otra sin que tenga que numerarlas. --i lo puede pisar. */
.escalona > * { animation: subir var(--entrada) var(--curva) both; }
.escalona > *:nth-child(1) { animation-delay: calc(var(--i, 0) * var(--escalon) + 260ms); }
.escalona > *:nth-child(2) { animation-delay: calc(var(--i, 1) * var(--escalon) + 260ms); }
.escalona > *:nth-child(3) { animation-delay: calc(var(--i, 2) * var(--escalon) + 260ms); }
.escalona > *:nth-child(4) { animation-delay: calc(var(--i, 3) * var(--escalon) + 260ms); }
.escalona > *:nth-child(5) { animation-delay: calc(var(--i, 4) * var(--escalon) + 260ms); }
.escalona > *:nth-child(6) { animation-delay: calc(var(--i, 5) * var(--escalon) + 260ms); }
.escalona > *:nth-child(7) { animation-delay: calc(var(--i, 6) * var(--escalon) + 260ms); }
.escalona > *:nth-child(8) { animation-delay: calc(var(--i, 7) * var(--escalon) + 260ms); }

.tarde { animation-delay: 420ms; }
.mas-tarde { animation-delay: 640ms; }

/* Un trazo de SVG que se dibuja solo. --largo es el largo del path. */
.traza { stroke-dasharray: var(--largo, 400); animation: trazar 900ms var(--curva) both 300ms; }
`;

/**
 * La guía que lee el agente que programa las láminas.
 *
 * Va como archivo en el directorio de salida y no sólo en la descripción de la
 * herramienta: una descripción larga se paga en cada turno de cada agente de la
 * empresa, y esto lo necesita uno solo.
 *
 * **Está en inglés a propósito**, como las instrucciones de rol: un modelo sigue
 * una especificación técnica larga con más precisión en el idioma en el que fue
 * entrenado mayoritariamente. Y dice explícitamente que lo que **sale** va en el
 * idioma de la empresa, porque una instrucción en inglés arrastra la respuesta al
 * inglés si nadie la sujeta.
 *
 * Cuál es ese idioma no se decide acá: el kit lo comparten todas las empresas, y
 * una que le habla a clientes en Bogotá no escribe como una de Buenos Aires. La
 * variante es un dato de la empresa —vive en su contexto, como la pronunciación—
 * y el guion ya viene escrito en ella; el diseñador copia, no traduce. Tener el
 * rioplatense clavado acá hacía que el kit le impusiera su acento a todo el
 * mundo.
 *
 * Los nombres de clase siguen en castellano: son la API del kit, no instrucciones.
 */
export const GUIA_ESTUDIO = `# Programming a slide

Each scene of the script is one HTML file in \`${CARPETA_ESCENAS}/\`, numbered by
scene order: \`01-portada.html\`, \`02-que-hacemos.html\`, … The **number** is what
binds a slide to its scene; the rest of the name is for you.

A scene with no slide of its own falls back to the system template, so you can
program only the ones worth programming and leave the rest.

## Output language — read this first

These instructions are in English so you follow them precisely. They are **not**
the language of the product: every word a viewer reads or hears — headings,
bullets, captions, narration — is written in the company's own language and
register, exactly as its context and its script define them. Copy comes from the
script; do not translate it, do not "improve" it into another variety of the
language, and never put English on a slide.

## Canvas rules

- The frame is **exactly 1920×1080**. Anything outside is not rendered, and it
  comes back as a warning in the tool result.
- The background is drawn behind you by the renderer and **moves for the whole
  scene**. Keep your background transparent unless you mean to cover it:
  \`<div class="lamina opaca">\`.
- Scene length is set by the narration audio, not by the slide. Program the
  **entrance**; after that the slide holds still.

## Skeleton

\`\`\`html
<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="../${RUTA_TEMA}">
<div class="lamina">
  <div class="ceja anima">Codytion</div>
  <div class="regla"></div>
  <h1 class="titulo anima tarde">Lo que hacemos</h1>
  <div class="lista escalona">
    <div class="item"><span class="punto"></span>Una idea por renglón</div>
    <div class="item"><span class="punto"></span>Menos de siete palabras</div>
  </div>
  <div class="pie"><span>Codytion</span><span class="pasos"><i class="aqui"></i><i></i></span></div>
</div>
\`\`\`

## Vocabulary (class names are Spanish — they are the kit's API)

- Structure: \`.lamina\` (\`.opaca\`, \`.centrada\`), \`.ceja\` (eyebrow),
  \`.regla\` (rule), \`.titulo\` (\`.grande\`), \`.bajada\` (standfirst),
  \`.pie\` (footer), \`.pasos\` (progress dots).
- Blocks: \`.lista\` + \`.item\`, \`.dos\` (two columns), \`.tres\` (three up),
  \`.tarjeta\` (\`.rotulo\`, \`.texto\`), \`.dato\` (big figure), \`.cita\` (pull
  quote), \`.figura\` (image or inline SVG).
- Motion: \`.anima\` (\`.suave\` fade, \`.barre\` wipe), \`.escalona\` on the
  container to stagger its children, \`.tarde\` / \`.mas-tarde\` to delay,
  \`.traza\` for a self-drawing SVG stroke (set \`style="--largo: 620"\` to the
  path length).

## Hard constraints

- **No infinite loops** (\`animation-iteration-count: infinite\`). They cannot be
  filmed, and the slide freezes on its first frame.
- **No SVG \`<animate>\`** (SMIL). The renderer cannot seek it. Animate with CSS.
- **No network requests**: no web fonts, no scripts, no remote images. Rendering
  happens offline. Reference photos relatively: \`../fotos/x.jpg\`.
- Use the system typeface (Avenir Next). Do not load another one.

## How to test

\`revisar_lamina\` with the file path renders **one** slide to PNG and returns
its errors and overflows. Use it before filming the whole video: a full video
run costs a minute, a single slide costs three seconds.
`;

const escapar = (texto: string): string =>
  texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** El ícono del catálogo como SVG, o el rombo de siempre si el nombre no está. */
function viñeta(nombre: string): string {
  const trazo = nombre ? iconoSvg(nombre) : null;
  if (!trazo) return `<span class="punto"></span>`;
  return `<svg class="icono" viewBox="0 0 100 100" aria-hidden="true"><path d="${trazo}"/></svg>`;
}

export interface DatosLamina {
  empresa: string;
  /** Qué número de escena es y cuántas hay, para los pasos del pie. */
  indice: number;
  total: number;
  /** URL del logo, ya resuelta por quien llama. Sin esto la lámina no lo firma. */
  logo?: string;
}

/**
 * La lámina de respaldo: la escena del guion, maquetada con el mismo kit.
 *
 * No es un modo degradado sino el piso: un guion sin una sola línea de HTML
 * tiene que dar un video presentable, y una lámina programada tiene que verse
 * como una mejora de esto y no como otra cosa. Por eso usa exactamente las
 * mismas clases que le pedimos al agente.
 */
export function laminaDeEscena(escena: Escena, datos: DatosLamina): string {
  const pasos = Array.from(
    { length: datos.total },
    (_, i) => `<i class="${i === datos.indice ? "aqui" : ""}"></i>`,
  ).join("");

  const cuerpo: string[] = [];
  if (datos.logo) {
    cuerpo.push(`<img class="marca anima suave" src="${escapar(datos.logo)}" alt="">`);
  }
  cuerpo.push(`<div class="ceja anima">${escapar(datos.empresa)}</div>`);
  cuerpo.push(`<div class="regla"></div>`);

  if (escena.titulo) {
    const grande = escena.esPortada ? " grande" : "";
    cuerpo.push(`<h1 class="titulo${grande} anima tarde">${escapar(escena.titulo)}</h1>`);
  }

  // En la portada, la primera línea hablada hace de bajada: el nombre solo en
  // pantalla durante cuatro segundos es una placa vacía.
  const bajada = escena.esPortada ? escena.lineas[0]?.texto : undefined;
  if (bajada) cuerpo.push(`<p class="bajada anima mas-tarde">${escapar(bajada)}</p>`);

  if (escena.destacado) {
    cuerpo.push(`<blockquote class="cita anima barre tarde">${escapar(escena.destacado)}</blockquote>`);
  }

  if (escena.balas.length > 0) {
    const items = escena.balas
      .map((bala) => `<div class="item">${viñeta(bala.icono)}<span>${escapar(bala.texto)}</span></div>`)
      .join("\n      ");
    cuerpo.push(`<div class="lista escalona">\n      ${items}\n    </div>`);
  }

  cuerpo.push(
    `<div class="pie"><span>${escapar(datos.empresa)}</span><span class="pasos">${pasos}</span></div>`,
  );

  return `<!doctype html>
<meta charset="utf-8">
<title>${escapar(escena.titulo || datos.empresa)}</title>
<link rel="stylesheet" href="../${RUTA_TEMA}">
<div class="lamina${escena.esPortada ? " centrada" : ""}">
    ${cuerpo.join("\n    ")}
</div>
`;
}
