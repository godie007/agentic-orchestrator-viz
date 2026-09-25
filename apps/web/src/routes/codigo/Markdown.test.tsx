import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Monaco trae workers de Vite que no existen en Node: el coloreado se prueba
// en el navegador; acá importa qué se dibuja y qué no.
vi.mock("./monaco.js", () => ({
  lenguajeDe: () => "plaintext",
  useTemaMonaco: () => "orq-oscuro",
  monaco: { editor: { colorize: () => Promise.resolve(""), setTheme: () => {} } },
}));

const { Markdown } = await import("./Markdown.js");

const dibujar = (texto: string, archivos: string[] = []) =>
  renderToStaticMarkup(<Markdown texto={texto} archivos={archivos} onAbrirArchivo={() => {}} />);

/**
 * El chat dibuja el markdown que escribe un agente. Lo que se fija acá es lo
 * que no puede pasar: HTML crudo que se ejecute, o un enlace `javascript:`.
 */
describe("Markdown del chat", () => {
  it("dibuja negritas, listas, tablas y bloques de código", () => {
    const html = dibujar(
      "**Qué cambié**\n\n- uno\n- dos\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```",
    );
    expect(html).toContain("<strong");
    expect(html).toContain("<ul");
    expect(html).toContain("<table");
    expect(html).toContain("const x = 1;");
    expect(html).toContain("copiar");
  });

  it("una ruta del repo en `código` es un enlace para abrirla; una que no existe, no", () => {
    const html = dibujar("Cambié `src/shader.js:143` y `src/no-existe.js`", ["src/shader.js"]);
    expect(html).toMatch(/<button[^>]*title="Abrir src\/shader\.js en la línea 143"/);
    expect(html).toMatch(/<code[^>]*>src\/no-existe\.js<\/code>/);
  });

  it("no ejecuta HTML crudo ni enlaces javascript: —el texto lo escribe un agente—", () => {
    const html = dibujar('Hola <img src=x onerror="alert(1)"> [click](javascript:alert(1)) [ok](https://example.com)');
    // El HTML queda como texto visible, escapado: no se crea ningún elemento.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });
});
