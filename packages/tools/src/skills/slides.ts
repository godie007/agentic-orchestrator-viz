/**
 * Guion → deck HTML.
 *
 * El mismo guion que se filma se publica también como una presentación que se
 * abre en cualquier navegador. No es un formato más "por si acaso": un video no
 * se puede citar, ni copiar una frase, ni saltar a la escena siete, y la mitad
 * de las veces lo que hace falta es exactamente eso —mandarle a alguien la
 * lámina donde están los números—.
 *
 * Sale del mismo `parseGuion` que el video, así que las dos salidas no pueden
 * decir cosas distintas: si el guion cambia, cambian las dos. Lo que en el video
 * es voz en off acá es la nota al pie de la lámina, porque en pantalla nadie la
 * escucha pero sí la lee.
 *
 * El archivo es **uno solo y sin pedidos a la red**: las imágenes viajan como
 * `data:` adentro del HTML. Un deck que depende de rutas relativas se rompe
 * apenas alguien lo adjunta a un correo, que es justo lo que se hace con un
 * deck. La tipografía es la misma pila del sitio y degrada a Helvetica.
 */

import { readFile } from "node:fs/promises";
import { parseGuion, type Escena, type Guion, type ImagenGuion } from "./guion.js";
import { iconoSvg } from "./iconos.js";
import { visualSvg, type Tinte } from "./visuales.js";
import type { DocumentMeta } from "./render.js";

/**
 * La paleta del logo, en OKLCH.
 *
 * No es un capricho de formato: OKLCH es perceptualmente uniforme, así que dos
 * colores con la misma `L` pesan igual en pantalla y un degradado entre dos
 * tonos no vira por el medio —que es exactamente lo que le pasa a un degradado
 * en hexadecimal entre el violeta y el turquesa de esta marca—. Además deja
 * derivar variantes con `color-mix()` sin agregar una constante más.
 *
 * Los valores salen de convertir los tres colores muestreados del logo:
 * violeta `#5058e8`, turquesa `#40f8c0`, azul `#40a0f8`.
 */
const COLOR = {
  fondo: "oklch(14% 0.028 265)",
  panel: "oklch(21% 0.035 265)",
  panelAlto: "oklch(26% 0.042 268)",
  borde: "oklch(30% 0.03 265)",
  tinta: "oklch(97% 0.006 250)",
  tintaTenue: "oklch(72% 0.025 255)",
  tintaDebil: "oklch(56% 0.028 258)",
  acento: "oklch(70% 0.14 250)",
  realce: "oklch(85% 0.16 168)",
  violeta: "oklch(55% 0.22 274)",
} as const;

/**
 * Cómo se traducen los nombres simbólicos de un visual a esta paleta.
 *
 * Los tonos de piel son dos y deliberadamente cálidos y desaturados: sobre un
 * fondo azul oscuro, una piel muy saturada se lee como plástico.
 */
const TINTES: Record<Tinte, string> = {
  acento: COLOR.acento,
  realce: COLOR.realce,
  violeta: COLOR.violeta,
  tinta: COLOR.tinta,
  tenue: COLOR.tintaTenue,
  panel: COLOR.panelAlto,
  linea: COLOR.borde,
  piel: "oklch(78% 0.075 62)",
  pielAlt: "oklch(62% 0.075 52)",
  pelo: "oklch(32% 0.045 42)",
  ropa: "oklch(58% 0.16 205)",
  ropaAlt: "oklch(45% 0.09 268)",
};

/** Lo mínimo para que un texto no pueda cerrar una etiqueta ni abrir un script. */
const esc = (texto: string): string =>
  texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const icono = (nombre: string, clase: string): string => {
  const trazo = nombre ? iconoSvg(nombre) : null;
  if (!trazo) return "";
  return (
    `<svg class="${clase}" viewBox="0 0 100 100" aria-hidden="true">` +
    `<path d="${trazo}" fill="currentColor"/></svg>`
  );
};

/** Extensión → tipo MIME, para el `data:` de la imagen incrustada. */
const tipoDe = (ruta: string): string => {
  const extension = ruta.slice(ruta.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
};

export interface OpcionesSlides {
  /** Igual que en el video: quién resuelve una imagen del guion a una ruta. */
  resolverImagen?: (imagen: ImagenGuion) => Promise<string | null>;
  /** El logo de la empresa, ya resuelto a una ruta. Firma la portada y el pie. */
  logo?: string;
}

/**
 * Lo que ocupa el lugar de la imagen en una lámina.
 *
 * Una foto y un diagrama no son la misma cosa aunque los dos "sean la imagen":
 * la foto se recorta para llenar el hueco y el diagrama tiene que entrar entero
 * o deja de leerse. Por eso se distinguen acá y no se emparejan en un `src`.
 */
type Medio = { kind: "foto"; datos: string } | { kind: "visual"; svg: string } | null;

export interface ResultadoSlides {
  html: string;
  laminas: number;
  imagenes: number;
  avisos: string[];
}

/** Lo que se dice en una escena, para la nota al pie de la lámina. */
const narracionDe = (escena: Escena): string =>
  escena.lineas
    .filter((linea) => linea.kind === "narracion")
    .map((linea) => linea.texto)
    .join(" ");

function laminaPortada(
  escena: Escena,
  guion: Guion,
  meta: DocumentMeta,
  fondo: string,
  logo: string,
): string {
  const clase = fondo ? "lamina portada con-imagen" : "lamina portada";
  const estilo = fondo ? ` style="--foto:url('${fondo}')"` : "";
  return (
    `<section class="${clase}"${estilo}>` +
    `<div class="marco">` +
    (logo ? `<img class="logo" src="${logo}" alt="${esc(meta.company ?? "")}">` : "") +
    (meta.company ? `<p class="ceja">${esc(meta.company)}</p>` : "") +
    `<h1>${esc(escena.titulo || guion.titulo)}</h1>` +
    (narracionDe(escena) ? `<p class="bajada">${esc(narracionDe(escena))}</p>` : "") +
    `</div></section>`
  );
}

function laminaEscena(escena: Escena, indice: number, medio: Medio): string {
  const partes: string[] = [];

  const dialogos = escena.lineas.filter((linea) => linea.kind === "dialogo");
  if (dialogos.length > 0) {
    partes.push(
      `<dl class="dialogo">` +
        dialogos
          .map(
            (linea) =>
              `<dt>${esc(linea.kind === "dialogo" ? linea.personaje : "")}</dt>` +
              `<dd>${esc(linea.texto)}</dd>`,
          )
          .join("") +
        `</dl>`,
    );
  }

  if (escena.destacado) {
    partes.push(`<blockquote>${esc(escena.destacado)}</blockquote>`);
  }

  if (escena.balas.length > 0) {
    partes.push(
      `<ul class="balas">` +
        escena.balas
          .map(
            (bala) =>
              `<li>${bala.icono ? icono(bala.icono, "icono-bala") : '<span class="punto"></span>'}` +
              `<span>${esc(bala.texto)}</span></li>`,
          )
          .join("") +
        `</ul>`,
    );
  }

  // Una escena que sólo se narra no puede quedar como un título sobre el vacío:
  // ahí la voz en off pasa a ser el cuerpo de la lámina, no una nota al pie.
  const narracion = narracionDe(escena);
  const soloNarrada = partes.length === 0 && narracion !== "";
  if (soloNarrada) partes.push(`<p class="relato">${esc(narracion)}</p>`);

  const figura =
    medio === null
      ? ""
      : medio.kind === "foto"
        ? `<figure class="foto"><img src="${medio.datos}" alt=""></figure>`
        : `<figure class="lienzo">${medio.svg}</figure>`;

  return (
    `<section class="lamina${medio ? " con-foto" : ""}">` +
    `<div class="marco">` +
    `<header>` +
    (escena.icono ? icono(escena.icono, "icono-escena") : "") +
    (escena.titulo ? `<h2>${esc(escena.titulo)}</h2>` : "") +
    `</header>` +
    `<div class="cuerpo">${partes.join("")}</div>` +
    (!soloNarrada && narracion ? `<p class="off">${esc(narracion)}</p>` : "") +
    `</div>` +
    figura +
    `<span class="folio">${String(indice).padStart(2, "0")}</span>` +
    `</section>`
  );
}

const ESTILOS = `
:root {
  color-scheme: dark;
  --bg: var(--bg);
  --surface: ${COLOR.panel};
  --surface-up: ${COLOR.panelAlto};
  --fg: var(--fg);
  --fg-muted: var(--fg-muted);
  --fg-dim: var(--fg-dim);
  --primary: var(--primary);
  --accent: var(--accent);
  --violet: ${COLOR.violeta};
  --border: var(--border);
  --r: 1rem;
  --r-lg: 1.25rem;
  --r-full: 9999px;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-base: 250ms;
  --dur-slow: 520ms;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
/* Grano: una capa de ruido al 3% que le saca el plano digital al fondo. Va en
   un SVG embebido para no pedirle un archivo a nadie. */
body::after {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 100;
  opacity: 0.035;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}
/* Barra de lectura: sin JavaScript, atada al scroll del documento. */
.progreso {
  position: fixed; top: 0; left: 0; height: 2px; width: 100%; transform-origin: 0 50%;
  background: linear-gradient(90deg, var(--primary), var(--accent));
  z-index: 101;
  animation: avanzar linear;
  animation-timeline: scroll();
}
@keyframes avanzar { from { transform: scaleX(0) } to { transform: scaleX(1) } }
/* Cada lámina es un 16:9 que se achica con la ventana: el deck se mira en una
   pantalla de sala y también en un teléfono, y no puede pedir scroll lateral. */
.mazo { display: flex; flex-direction: column; align-items: center; gap: 28px; padding: 28px 16px 64px; }
/* Vidrio líquido: la superficie estándar de todo lo que flota. Un
   backdrop-filter sobre un fondo casi liso aporta poco, así que el efecto lo
   hace el degradado de luz de arriba más el borde claro de un píxel. */
.lamina {
  position: relative; width: min(1200px, 100%); aspect-ratio: 16 / 9;
  background:
    radial-gradient(120% 90% at 88% 8%, color-mix(in oklch, var(--violet) 26%, transparent) 0%, transparent 62%),
    linear-gradient(155deg, var(--surface) 0%, var(--bg) 62%);
  border: 1px solid color-mix(in oklch, var(--fg) 10%, transparent);
  border-radius: var(--r-lg); overflow: hidden;
  box-shadow:
    inset 0 1px 0 color-mix(in oklch, var(--fg) 12%, transparent),
    0 18px 50px oklch(0% 0 0 / 0.35);
  display: grid; grid-template-columns: 1fr; align-items: center;
}
.lamina.con-foto { grid-template-columns: 1fr 38%; }
.marco { padding: clamp(24px, 4.4%, 64px); min-width: 0; }
.ceja {
  color: var(--primary); font-size: clamp(10px, 1.05vw, 14px); font-weight: 700;
  letter-spacing: .18em; text-transform: uppercase; margin-bottom: 18px;
}
.ceja::before {
  content: ""; display: block; width: 54px; height: 3px;
  background: var(--primary); margin-bottom: 16px;
}
h1 {
  font-size: clamp(30px, 4.8vw, 66px); font-weight: 800;
  letter-spacing: -.035em; line-height: 1.04;
  background: linear-gradient(122deg, var(--fg) 12%, color-mix(in oklch, var(--accent) 70%, var(--fg)) 96%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.bajada { margin-top: 20px; color: var(--fg-muted); font-size: clamp(13px, 1.5vw, 21px); max-width: 34ch; }
header { display: flex; align-items: center; gap: 14px; margin-bottom: clamp(14px, 2.4%, 30px); }
h2 { font-size: clamp(20px, 2.7vw, 38px); font-weight: 800; letter-spacing: -.02em; }
.icono-escena { width: clamp(22px, 2.5vw, 34px); height: clamp(22px, 2.5vw, 34px); color: var(--accent); flex: none; }
.icono-bala { width: 1.15em; height: 1.15em; color: var(--primary); flex: none; margin-top: .1em; }
.balas { list-style: none; display: flex; flex-direction: column; gap: clamp(8px, 1.4vw, 16px); }
.balas li {
  display: flex; gap: 14px; align-items: flex-start;
  font-size: clamp(13px, 1.55vw, 22px); color: var(--fg);
}
.punto { width: .5em; height: .5em; background: var(--primary); flex: none; margin-top: .5em; }
blockquote {
  border-left: 3px solid var(--accent); padding-left: 20px;
  font-size: clamp(17px, 2.2vw, 32px); font-weight: 700; line-height: 1.28; letter-spacing: -.015em;
}
.relato { font-size: clamp(14px, 1.7vw, 25px); line-height: 1.45; color: var(--fg); max-width: 42ch; }
.dialogo dt {
  color: var(--primary); font-size: clamp(9px, 1vw, 13px); font-weight: 700;
  letter-spacing: .16em; text-transform: uppercase; margin-top: 16px;
}
.dialogo dt:first-child { margin-top: 0; }
.dialogo dd { font-size: clamp(13px, 1.55vw, 22px); margin-top: 4px; }
.off {
  margin-top: clamp(14px, 2.6%, 30px); padding-top: 14px; border-top: 1px solid var(--border);
  color: var(--fg-dim); font-size: clamp(10px, 1.15vw, 15px); line-height: 1.5; max-width: 62ch;
}
.off::before { content: "Voz en off — "; color: var(--fg-dim); font-weight: 700; }
.pie {
  text-align: center; padding: 0 16px 40px;
  color: var(--fg-dim); font-size: 12px; letter-spacing: .04em;
}
figure { height: 100%; min-width: 0; }
/* La foto llena el hueco y se recorta; el diagrama entra entero o no se lee. */
figure.foto img { width: 100%; height: 100%; object-fit: cover; display: block; }
figure.lienzo {
  display: flex; align-items: center; justify-content: center;
  padding: clamp(16px, 2.6%, 40px) clamp(20px, 3%, 48px) clamp(16px, 2.6%, 40px) 0;
}
figure.lienzo .visual { width: 100%; height: 100%; max-height: 100%; }
.visual text { font-family: Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif; }
.portada .logo {
  display: block; height: clamp(52px, 6.6vw, 92px); width: auto; margin-bottom: 26px;
}
/* El folio va del lado del texto, no sobre la foto: encima de una imagen clara
   desaparece, y encima de una oscura parece basura. */
.folio {
  position: absolute; left: clamp(24px, 4.4%, 64px); bottom: 18px;
  color: var(--fg-dim); font-size: 12px; font-weight: 700; letter-spacing: .1em;
}
/* La portada con foto la usa entera, con el mismo velo que en el video: sin él
   una foto clara se lleva puesto el título. */
.portada.con-imagen::before {
  content: ""; position: absolute; inset: 0;
  background: var(--foto) center / cover no-repeat;
}
.portada.con-imagen::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, var(--bg) 12%, rgba(10,14,26,.72) 62%, rgba(10,14,26,.5) 100%);
}
.portada .marco { position: relative; z-index: 1; }
/* Aparición al entrar en pantalla.
   La regla animation-timeline: view() lo hace sin una línea de JavaScript, y
   donde no está soportada el @supports deja todo visible: una lámina que no
   aparece porque el navegador es viejo es peor que una sin animación. */
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .lamina .marco > *, .lamina figure, .balas li, .dialogo dt, .dialogo dd {
      animation: entrar linear both;
      animation-timeline: view();
      animation-range: entry 8% cover 26%;
    }
    /* Cada elemento entra un poco después que el anterior: es lo que hace que
       una lámina se lea en orden en vez de aparecer de golpe. */
    .balas li:nth-child(2) { animation-range: entry 12% cover 30%; }
    .balas li:nth-child(3) { animation-range: entry 16% cover 34%; }
    .balas li:nth-child(4) { animation-range: entry 20% cover 38%; }
    .dialogo dd { animation-range: entry 14% cover 32%; }
    .lamina figure { animation-range: entry 6% cover 30%; }
  }
}
@keyframes entrar {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: none; }
}
/* La primera lámina entra al cargar, sin depender del scroll: con
   la regla starting-style no hay destello del estado final antes de animar. */
.lamina:first-child {
  opacity: 1; transform: none;
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-expo);
}
@starting-style {
  .lamina:first-child { opacity: 0; transform: translateY(26px); }
}
/* La foto de la portada entra con un acercamiento apenas perceptible. */
.portada.con-imagen::before { animation: acercar 14s var(--ease-out) both; }
@keyframes acercar { from { transform: scale(1.06) } to { transform: scale(1) } }
@media (max-width: 720px) {
  .lamina.con-foto { grid-template-columns: 1fr; }
  .lamina.con-foto figure { display: none; }
}
@media print {
  body { background: #fff; }
  .mazo { padding: 0; gap: 0; }
  .lamina { width: 100%; border: 0; border-radius: 0; break-after: page; }
}
`;

/**
 * Arma el deck.
 *
 * Devuelve el HTML como texto y no lo escribe: dónde va el archivo lo decide el
 * `SkillStorage`, igual que con Word, PDF y video.
 */
export async function renderSlides(
  markdown: string,
  meta: DocumentMeta,
  opciones: OpcionesSlides = {},
): Promise<ResultadoSlides> {
  const guion = parseGuion(markdown);
  if (guion.escenas.length === 0) {
    throw new Error(
      "El guion no tiene ninguna escena. Un guion es un título con `#`, y después " +
        "una escena por cada `##` con lo que se dice debajo.",
    );
  }

  const avisos: string[] = [];
  let incrustadas = 0;

  const comoDatos = async (ruta: string): Promise<string> =>
    `data:${tipoDe(ruta)};base64,${(await readFile(ruta)).toString("base64")}`;

  const logo = opciones.logo ? await comoDatos(opciones.logo).catch(() => "") : "";

  // Se muestra la primera imagen de cada escena: dos figuras en una lámina no es
  // una lámina, es un collage. Las demás quedan para el video, que sí puede
  // mostrarlas una después de la otra.
  const medios: Medio[] = [];
  for (const escena of guion.escenas) {
    const imagen = escena.imagenes[0];
    if (!imagen) {
      medios.push(null);
      continue;
    }
    // Un visual no se resuelve ni se lee del disco: se dibuja acá mismo.
    if (imagen.visual) {
      const svg = visualSvg(imagen.visual, TINTES);
      medios.push(svg ? { kind: "visual", svg } : null);
      if (svg) incrustadas++;
      else avisos.push(`No existe el visual "${imagen.visual}".`);
      continue;
    }
    if (!opciones.resolverImagen) {
      medios.push(null);
      continue;
    }
    try {
      const ruta = await opciones.resolverImagen(imagen);
      if (!ruta) {
        avisos.push(`No se pudo incrustar la imagen "${imagen.alt || imagen.src}".`);
        medios.push(null);
        continue;
      }
      medios.push({ kind: "foto", datos: await comoDatos(ruta) });
      incrustadas++;
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      avisos.push(`No se pudo incrustar "${imagen.alt || imagen.src}": ${detalle}`);
      medios.push(null);
    }
  }

  const laminas = guion.escenas.map((escena, i) => {
    const medio = medios[i] ?? null;
    return escena.esPortada
      ? laminaPortada(escena, guion, meta, medio?.kind === "foto" ? medio.datos : "", logo)
      : laminaEscena(escena, i, medio);
  });

  // Firma la empresa, no quien la produjo. Un Word interno lleva el nombre de
  // quien lo escribió porque alguien tiene que responder por él; una pieza que
  // se le manda a un cliente, no: ahí el autor es la marca, y el nombre del rol
  // que la generó no le dice nada a quien la recibe.
  const pie = [meta.company, meta.date].filter(Boolean).join(" · ");
  const html = [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(guion.titulo || meta.title)}</title>`,
    `<style>${ESTILOS}</style>`,
    "</head>",
    "<body>",
    '<div class="progreso" aria-hidden="true"></div>',
    `<main class="mazo">${laminas.join("")}</main>`,
    pie ? `<footer class="pie">${esc(pie)}</footer>` : "",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return { html, laminas: laminas.length, imagenes: incrustadas, avisos };
}
