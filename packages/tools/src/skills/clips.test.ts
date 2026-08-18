import { describe, expect, it } from "vitest";
import { parseGuion, type EscenaUbicada } from "./guion.js";
import { atarClips, clipDePortada, filtroDeEscena, planificarCortes } from "./clips.js";
import { informeDeExploracion, tomarSesion } from "./index.js";

/**
 * El reloj del empalme es la única cuenta con la que se puede equivocar el
 * motor entero, y la atadura por número es lo que evita que el guion mantenga
 * dos listas sincronizadas: las dos se fijan acá sin abrir ffmpeg.
 */

const ubicada = (inicio: number): EscenaUbicada =>
  ({ inicio, lineas: [], escena: {} }) as unknown as EscenaUbicada;

describe("atarClips", () => {
  it("ata por el número del nombre, con o sin prefijo escena-", () => {
    const { clips } = atarClips(
      ["clips/02-formatos.mp4", "clips/escena-01.mp4", "clips/03-aplicar.webm"],
      3,
    );
    expect(clips).toEqual(["clips/escena-01.mp4", "clips/02-formatos.mp4", "clips/03-aplicar.webm"]);
  });

  it("la escena sin clip queda en null y un número fuera de rango se ignora", () => {
    const { clips } = atarClips(["clips/07-nada.mp4", "clips/01-intro.mp4"], 3);
    expect(clips).toEqual(["clips/01-intro.mp4", null, null]);
  });

  it("no ata lo que no es video", () => {
    expect(atarClips(["clips/01-intro.png", "clips/01-intro.txt"], 1).clips).toEqual([null]);
  });

  it("el 00 es portada, no la escena 1: no entra al mapa de escenas", () => {
    expect(atarClips(["clips/00-portada.mp4", "clips/01-intro.mp4"], 1).clips).toEqual([
      "clips/01-intro.mp4",
    ]);
  });

  /**
   * Pasó filmando de verdad: al regrabar una escena con otro nombre quedaron
   * las dos tomas, y el motor eligió la vieja en silencio porque alfabéticamente
   * iba primero. El video se armaba con la pantalla que se quería reemplazar y
   * no había forma de notarlo salvo mirándolo cuadro por cuadro.
   */
  it("avisa cuando hay dos clips para la misma escena y dice cuál usó", () => {
    const { clips, avisos } = atarClips(
      ["clips/07-mis-proyectos.mp4", "clips/07-no-conformidad.mp4", "clips/01-intro.mp4"],
      7,
    );
    expect(clips[6]).toBe("clips/07-mis-proyectos.mp4");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("escena 7");
    expect(avisos[0]).toContain("07-mis-proyectos.mp4");
    expect(avisos[0]).toContain("07-no-conformidad.mp4");
    expect(avisos[0]).toContain("delete_files");
  });

  it("sin repetidos no inventa avisos", () => {
    expect(atarClips(["clips/01-intro.mp4", "clips/02-fin.mp4"], 2).avisos).toEqual([]);
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

describe("tomarSesion", () => {
  it("sin nombre no hay perfil: la grabación se comporta como siempre", () => {
    expect(tomarSesion(undefined).perfil).toBeNull();
    expect(tomarSesion("   ").perfil).toBeNull();
  });

  it("sanea el nombre: el perfil es una ruta, no lo que escribió un modelo", () => {
    const s = tomarSesion("Inspector / Electrovatio!!");
    expect(s.perfil).toContain("orq-sesiones");
    expect(s.perfil?.split("/").pop()).toBe("inspector-electrovatio");
    s.soltar();
  });

  it("dos tomas a la vez sobre la misma sesión: la segunda graba igual y avisa", () => {
    // Dos Chrome sobre el mismo --user-data-dir no conviven. Fallar sería peor
    // que grabar con un navegador nuevo: el clip es lo que importa.
    const primera = tomarSesion("inspector");
    const segunda = tomarSesion("inspector");
    expect(primera.perfil).not.toBeNull();
    expect(segunda.perfil).toBeNull();
    expect(segunda.avisos.join(" ")).toMatch(/ya está grabando/);
    primera.soltar();
    // Soltada la primera, la sesión vuelve a estar disponible.
    const tercera = tomarSesion("inspector");
    expect(tercera.perfil).toBe(primera.perfil);
    tercera.soltar();
  });
});

describe("informeDeExploracion", () => {
  const vista = (encontrados: Array<{ texto: string; visible: boolean; estable: boolean }>) => ({
    url: "https://app/inspector/nc",
    titulo: "No conformidades",
    encontrados,
    clickeables: ["Abierta", "Solicitar cierre"],
    pantalla: "NC-2026-014 · Abierta · Art. 210.52 (d)",
  });

  it("avisa fuerte del texto que aparece y se borra: es la trampa que cuesta la toma", () => {
    const informe = informeDeExploracion(
      vista([{ texto: "Cargando proyectos", visible: true, estable: false }]),
    );
    expect(informe).toContain("APARECEN Y SE BORRAN");
    expect(informe).toContain("Cargando proyectos");
    expect(informe).toContain("NO los uses como ancla");
  });

  it("separa lo que sirve de ancla de lo que no está", () => {
    const informe = informeDeExploracion(
      vista([
        { texto: "Abierta", visible: true, estable: true },
        { texto: "Sin requisitos", visible: false, estable: false },
      ]),
    );
    expect(informe).toMatch(/Sirven como ancla[^\n]*"Abierta"/);
    expect(informe).toMatch(/No están en esta pantalla[^\n]*"Sin requisitos"/);
  });

  it("trae la URL, para que la preparación de grabar_clip no se adivine", () => {
    expect(informeDeExploracion(vista([]))).toContain("https://app/inspector/nc");
  });

  it("el aviso de sesión ocupada llega al agente", () => {
    const informe = informeDeExploracion(vista([]), ["La sesión ya está grabando otra toma."]);
    expect(informe).toContain("Atención:");
  });
});
