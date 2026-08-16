import { describe, expect, it } from "vitest";
import { parseGuion, type EscenaUbicada } from "./guion.js";
import { atarClips, clipDePortada, filtroDeEscena, planificarCortes } from "./clips.js";

/**
 * El reloj del empalme es la única cuenta con la que se puede equivocar el
 * motor entero, y la atadura por número es lo que evita que el guion mantenga
 * dos listas sincronizadas: las dos se fijan acá sin abrir ffmpeg.
 */

const ubicada = (inicio: number): EscenaUbicada =>
  ({ inicio, lineas: [], escena: {} }) as unknown as EscenaUbicada;

describe("atarClips", () => {
  it("ata por el número del nombre, con o sin prefijo escena-", () => {
    const atados = atarClips(
      ["clips/02-formatos.mp4", "clips/escena-01.mp4", "clips/03-aplicar.webm"],
      3,
    );
    expect(atados).toEqual(["clips/escena-01.mp4", "clips/02-formatos.mp4", "clips/03-aplicar.webm"]);
  });

  it("la escena sin clip queda en null y un número fuera de rango se ignora", () => {
    const atados = atarClips(["clips/07-nada.mp4", "clips/01-intro.mp4"], 3);
    expect(atados).toEqual(["clips/01-intro.mp4", null, null]);
  });

  it("no ata lo que no es video", () => {
    expect(atarClips(["clips/01-intro.png", "clips/01-intro.txt"], 1)).toEqual([null]);
  });

  it("el 00 es portada, no la escena 1: no entra al mapa de escenas", () => {
    expect(atarClips(["clips/00-portada.mp4", "clips/01-intro.mp4"], 1)).toEqual([
      "clips/01-intro.mp4",
    ]);
  });
});

describe("texto suelto bajo el título", () => {
  it("una nota de producción se vuelve narración de portada — la condición que dispara el aviso del motor", () => {
    // Es la trampa que desalineó un video entero: "Personajes: … Tono: …" entre
    // el `#` y la primera `##` se leía en voz alta al abrir el video.
    const guion = parseGuion(
      "# Mi video\n\nPersonajes: Ana y Bruno. Tono: neutro.\n\n## 01 — Apertura\n\nHola.\n",
    );
    expect(guion.escenas[0]!.esPortada).toBe(true);
    expect(guion.escenas[0]!.lineas.length).toBeGreaterThan(0);
    // Una portada limpia no narra nada: sólo el título.
    const limpio = parseGuion("# Mi video\n\n## 01 — Apertura\n\nHola.\n");
    expect(limpio.escenas[0]!.esPortada).toBe(true);
    expect(limpio.escenas[0]!.lineas).toHaveLength(0);
  });
});

describe("clipDePortada", () => {
  it("encuentra el clip 00 y sólo el 00", () => {
    expect(clipDePortada(["clips/01-intro.mp4", "clips/00-portada.mp4"])).toBe(
      "clips/00-portada.mp4",
    );
    expect(clipDePortada(["clips/01-intro.mp4"])).toBeNull();
    // "007-espia.mp4" no es portada: el número tiene que ser el cero.
    expect(clipDePortada(["clips/007-espia.mp4"])).toBeNull();
  });
});

describe("planificarCortes", () => {
  it("cada escena dura hasta la siguiente y la última hasta el total", () => {
    const cortes = planificarCortes([ubicada(0), ubicada(12.5), ubicada(30)], 45);
    expect(cortes).toEqual([
      { inicio: 0, duracion: 12.5 },
      { inicio: 12.5, duracion: 17.5 },
      { inicio: 30, duracion: 15 },
    ]);
  });

  it("una escena degenerada no puede durar cero: rompería el concat", () => {
    const cortes = planificarCortes([ubicada(10), ubicada(10.1)], 10.2);
    expect(cortes[0]!.duracion).toBeGreaterThanOrEqual(0.5);
  });
});

describe("filtroDeEscena", () => {
  it("estira primero y corta después, a la duración exacta de la narración", () => {
    const filtro = filtroDeEscena(3, { inicio: 0, duracion: 14.25 }, "e0");
    // El orden tpad→trim es lo que garantiza la duración exacta: al revés, un
    // clip corto quedaría corto y el corte siguiente entraría antes que su voz.
    expect(filtro.indexOf("tpad=")).toBeLessThan(filtro.indexOf("trim=duration=14.250"));
    expect(filtro).toContain("[3:v]");
    expect(filtro).toContain("force_original_aspect_ratio=decrease");
    expect(filtro).toContain("pad=1920:1080");
    expect(filtro).toContain("[e0]");
  });
});
