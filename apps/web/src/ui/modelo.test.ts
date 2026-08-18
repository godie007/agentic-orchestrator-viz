import { describe, expect, it } from "vitest";
import { familiaDeModelo, nombreCortoDeModelo } from "./modelo.js";

describe("familiaDeModelo", () => {
  it("reconoce las familias de Claude por el slug", () => {
    expect(familiaDeModelo("claude-code/opus")).toBe("smart");
    expect(familiaDeModelo("claude-code/sonnet")).toBe("standard");
    expect(familiaDeModelo("claude-code/haiku")).toBe("cheap");
    expect(familiaDeModelo("claude-sonnet-4-5-20250929")).toBe("standard");
  });

  it("lo gratuito gana sobre la familia del modelo", () => {
    // Un mismo modelo gratis y pago no cuestan lo mismo: si el sufijo no
    // ganara, un `-free` de gama alta se dibujaría como el modelo más caro.
    expect(familiaDeModelo("opencode/deepseek-v4-flash-free")).toBe("free");
    expect(familiaDeModelo("nvidia/nemotron-3-ultra-550b:free")).toBe("free");
  });

  it("cae al tier cuando el slug no dice nada", () => {
    expect(familiaDeModelo(null, "smart")).toBe("smart");
    expect(familiaDeModelo("algun/modelo-raro", "cheap")).toBe("cheap");
    expect(familiaDeModelo(null, null)).toBe("desconocido");
  });

  it("el slug manda sobre el tier: el tier es lo que se pidió", () => {
    expect(familiaDeModelo("claude-code/opus", "standard")).toBe("smart");
  });
});

describe("nombreCortoDeModelo", () => {
  it("se queda con el último segmento y sin la fecha del snapshot", () => {
    expect(nombreCortoDeModelo("claude-code/sonnet")).toBe("sonnet");
    expect(nombreCortoDeModelo("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(nombreCortoDeModelo("opencode/deepseek-v4-flash-free")).toBe("deepseek-v4-flash");
  });

  it("un rol que todavía no corrió lo dice", () => {
    expect(nombreCortoDeModelo(null)).toBe("sin correr");
  });
});
