import { describe, expect, it } from "vitest";
import { atarLaminas, planificar } from "./estudio.js";
import { parseGuion, ubicarEscenas } from "./guion.js";
import { construirSonido } from "./sonido.js";
import { laminaDeEscena } from "./tema.js";

describe("atarLaminas", () => {
  it("ata cada lámina a su escena por el número del nombre", () => {
    const atadas = atarLaminas(
      ["escenas/01-portada.html", "escenas/03-cierre.html"],
      3,
    );
    expect(atadas).toEqual(["escenas/01-portada.html", null, "escenas/03-cierre.html"]);
  });

  it("una escena sin lámina propia queda en null y se maqueta con la plantilla", () => {
    expect(atarLaminas([], 2)).toEqual([null, null]);
  });

  it("ignora lo que no es una lámina numerada", () => {
    const atadas = atarLaminas(
      ["escenas/tema.css", "escenas/portada.html", "escenas/2-que-hacemos.html"],
      2,
    );
    expect(atadas).toEqual([null, "escenas/2-que-hacemos.html"]);
  });

  it("descarta un número que no corresponde a ninguna escena", () => {
    // Sin este corte, una lámina vieja de un guion más largo se colaba en un
    // video nuevo y la escena salía hablando de otra cosa.
    expect(atarLaminas(["escenas/09-vieja.html"], 2)).toEqual([null, null]);
  });

  it("ante dos láminas con el mismo número gana la primera, y siempre la misma", () => {
    const laminas = ["escenas/01-a.html", "escenas/01-b.html"];
    expect(atarLaminas(laminas, 1)).toEqual(["escenas/01-a.html"]);
  });
});

describe("planificar", () => {
  const guion = parseGuion(`# Portada

Bienvenidos.

## Uno

Primera escena.

## Dos

Segunda escena.
`);
  const { escenas, total } = ubicarEscenas(guion, [2, 3, 4]);

  it("las ventanas se pisan, que es lo que hace posible el encadenado", () => {
    const planos = planificar(escenas, total, [1, 1, 1]);
    expect(planos[0]!.fin).toBeGreaterThan(escenas[1]!.inicio);
    expect(planos[1]!.fin).toBeGreaterThan(escenas[2]!.inicio);
  });

  it("la última escena se estira hasta el final del video", () => {
    // Si terminara con su escena, la cola de silencio quedaría con el fondo
    // pelado y el video parecería cortado.
    const planos = planificar(escenas, total, [1, 1, 1]);
    expect(planos.at(-1)!.fin).toBe(total);
  });

  it("sostener cubre todo lo que va después de la entrada", () => {
    const planos = planificar(escenas, total, [1.5, 1.5, 1.5]);
    for (const [i, plano] of planos.entries()) {
      expect(plano.animacion + plano.sostener).toBeGreaterThanOrEqual(
        plano.fin - escenas[i]!.inicio,
      );
    }
  });

  it("una lámina sin animación igual se sostiene, no dura cero", () => {
    const planos = planificar(escenas, total, [0, 0, 0]);
    expect(planos.every((plano) => plano.sostener > 0)).toBe(true);
  });
});

describe("laminaDeEscena", () => {
  const guion = parseGuion(`# Codytion

Lo que dice la portada.

## :chequeo: Lo que hacemos

Voz en off.

- :reloj: Entrega rápida
- Sin ícono

## Cierre

> Una frase grande.
`);

  it("la portada usa el título grande y la primera línea como bajada", () => {
    const html = laminaDeEscena(guion.escenas[0]!, {
      empresa: "Codytion",
      indice: 0,
      total: 3,
    });
    expect(html).toContain('class="titulo grande');
    expect(html).toContain("Lo que dice la portada.");
  });

  it("una viñeta con ícono conocido sale como SVG y una sin ícono como punto", () => {
    const html = laminaDeEscena(guion.escenas[1]!, {
      empresa: "Codytion",
      indice: 1,
      total: 3,
    });
    expect(html).toContain("<svg class=\"icono\"");
    expect(html).toContain('<span class="punto">');
  });

  it("la cita se maqueta como destacado", () => {
    const html = laminaDeEscena(guion.escenas[2]!, {
      empresa: "Codytion",
      indice: 2,
      total: 3,
    });
    expect(html).toContain('class="cita');
    expect(html).toContain("Una frase grande.");
  });

  it("marca en qué escena está y cuántas hay", () => {
    const html = laminaDeEscena(guion.escenas[1]!, {
      empresa: "Codytion",
      indice: 1,
      total: 3,
    });
    // Tres pasos, y el del medio es el que está marcado.
    expect(html.match(/<i /g) ?? []).toHaveLength(3);
    expect(html).toContain('<i class=""></i><i class="aqui"></i>');
  });

  it("escapa el texto del guion: un título con < no puede abrir una etiqueta", () => {
    const suelto = parseGuion("# Uno\n\n## <script>alert(1)</script>\n\nHola.\n");
    const html = laminaDeEscena(suelto.escenas[1]!, {
      empresa: "Codytion",
      indice: 1,
      total: 2,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sin logo no lo inventa; con logo lo firma", () => {
    const sin = laminaDeEscena(guion.escenas[0]!, { empresa: "C", indice: 0, total: 1 });
    expect(sin).not.toContain("class=\"marca");
    const con = laminaDeEscena(guion.escenas[0]!, {
      empresa: "C",
      indice: 0,
      total: 1,
      logo: "file:///tmp/logo.png",
    });
    expect(con).toContain("file:///tmp/logo.png");
  });
});

describe("construirSonido", () => {
  it("coloca cada voz en su instante, en milisegundos", () => {
    const filtro = construirSonido({ inicios: [0, 2.5], total: 10, indiceMusica: -1 });
    expect(filtro).toContain("[1:a]aresample=44100,adelay=delays=0:all=1[v0]");
    expect(filtro).toContain("[2:a]aresample=44100,adelay=delays=2500:all=1[v1]");
  });

  it("sin voces igual entrega una pista: un video mudo no puede quedarse sin audio", () => {
    const filtro = construirSonido({ inicios: [], total: 5, indiceMusica: -1 });
    expect(filtro).toContain("anullsrc");
    expect(filtro).toContain("[aud]");
  });

  it("el aresample va DESPUÉS del loudnorm, que siempre devuelve 192 kHz", () => {
    // Al revés, la cama entraba a la mezcla al triple de velocidad de muestreo
    // y sonaba como una cinta acelerada.
    const filtro = construirSonido({ inicios: [0], total: 10, indiceMusica: 2 });
    const norm = filtro.indexOf("loudnorm=");
    const resample = filtro.indexOf("aresample=44100", norm);
    expect(norm).toBeGreaterThan(-1);
    expect(resample).toBeGreaterThan(norm);
  });

  it("la cama se aparta sola cuando alguien habla", () => {
    const filtro = construirSonido({ inicios: [0], total: 10, indiceMusica: 2 });
    expect(filtro).toContain("sidechaincompress");
    expect(filtro).toContain("[cama][vozlado]");
  });

  it("sin música no hay compresor de cadena lateral que comprimir", () => {
    const filtro = construirSonido({ inicios: [0], total: 10, indiceMusica: -1 });
    expect(filtro).not.toContain("sidechaincompress");
  });
});
