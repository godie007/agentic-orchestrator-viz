import { describe, expect, it } from "vitest";
import { cuadrosPorSegundo, describirFicha, leerFicha } from "./medios.js";

describe("cuadrosPorSegundo", () => {
  it("resuelve la fracción que devuelve ffprobe", () => {
    expect(cuadrosPorSegundo("30/1")).toBe(30);
    expect(cuadrosPorSegundo("30000/1001")).toBe(30);
  });

  it("una imagen fija no tiene velocidad: `0/0` no es cero cuadros, es ninguno", () => {
    expect(cuadrosPorSegundo("0/0")).toBeUndefined();
    expect(cuadrosPorSegundo(undefined)).toBeUndefined();
  });
});

describe("leerFicha", () => {
  const video = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac", channels: 2 },
    ],
    format: { duration: "75.70" },
  };

  it("lee un video con su duración, resolución y códecs", () => {
    const ficha = leerFicha(video, 7_751_595);
    expect(ficha).toMatchObject({
      tipo: "video",
      segundos: 75.7,
      ancho: 1920,
      alto: 1080,
      fps: 30,
      codecVideo: "h264",
      codecAudio: "aac",
      canales: 2,
    });
  });

  it("una imagen no es un video de un cuadro: no tiene duración ni velocidad", () => {
    const ficha = leerFicha(
      {
        streams: [
          { codec_type: "video", codec_name: "png", width: 1920, height: 1080, avg_frame_rate: "0/0" },
        ],
        format: {},
      },
      231_000,
    );
    expect(ficha.tipo).toBe("imagen");
    expect(ficha.segundos).toBeUndefined();
    expect(ficha.fps).toBeUndefined();
    expect(ficha.ancho).toBe(1920);
  });

  it("un archivo sin streams degrada a su tamaño, que ya es un dato", () => {
    expect(leerFicha({}, 4096)).toEqual({ tipo: "otro", bytes: 4096 });
  });
});

describe("describirFicha", () => {
  it("dice la duración en minutos y también exacta, para poder compararla", () => {
    const texto = describirFicha({ tipo: "video", bytes: 1024 * 1024, segundos: 131.27 });
    expect(texto).toContain("2 min 11 s");
    expect(texto).toContain("131.27 segundos exactos");
  });

  it("avisa fuerte cuando un video salió sin audio", () => {
    // Es la falla que más cuesta notar: se ve perfecto y se manda mudo.
    const texto = describirFicha({ tipo: "video", bytes: 1024, segundos: 10, codecVideo: "h264" });
    expect(texto).toContain("SIN PISTA DE AUDIO");
  });

  it("un video con audio no lleva ese aviso", () => {
    const texto = describirFicha({
      tipo: "video",
      bytes: 1024,
      segundos: 10,
      codecVideo: "h264",
      codecAudio: "aac",
      canales: 2,
    });
    expect(texto).not.toContain("SIN PISTA");
    expect(texto).toContain("estéreo");
  });

  it("una mezcla que quedó en un canal se nota", () => {
    const texto = describirFicha({ tipo: "audio", bytes: 1024, segundos: 3, codecAudio: "aac", canales: 1 });
    expect(texto).toContain("mono");
  });
});
