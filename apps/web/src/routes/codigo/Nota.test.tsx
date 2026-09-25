import { describe, expect, it, vi } from "vitest";

vi.mock("./monaco.js", () => ({
  lenguajeDe: () => "plaintext",
  useTemaMonaco: () => "orq-oscuro",
  monaco: { editor: { colorize: () => Promise.resolve(""), setTheme: () => {} } },
}));

const { prepararNota, resolverNota } = await import("./Nota.js");

/**
 * Las notas de Obsidian de un proyecto (en INSPIA, `inspia-obsidian/`) se leen
 * en el IDE con sus enlaces andando. Lo que se fija: que un `[[enlace]]`
 * encuentre su nota aunque esté en otra carpeta, y que el frontmatter no se
 * dibuje como un bloque de texto.
 */
const ARCHIVOS = [
  "inspia-obsidian/00 - Inicio.md",
  "inspia-obsidian/01 - Arquitectura/Backend.md",
  "inspia-obsidian/04 - API REST/Backend.md",
  "inspia-obsidian/Glosario.md",
  "inspia-obsidian/img/flujo.png",
];

describe("resolverNota", () => {
  it("encuentra la nota por nombre, prefiriendo la de la misma carpeta", () => {
    expect(resolverNota("Glosario", "inspia-obsidian/00 - Inicio.md", ARCHIVOS)).toBe("inspia-obsidian/Glosario.md");
    expect(resolverNota("Backend", "inspia-obsidian/04 - API REST/Endpoints.md", ARCHIVOS)).toBe("inspia-obsidian/04 - API REST/Backend.md");
    expect(resolverNota("01 - Arquitectura/Backend#Capas", "inspia-obsidian/00 - Inicio.md", ARCHIVOS)).toBe("inspia-obsidian/01 - Arquitectura/Backend.md");
    expect(resolverNota("glosario|el glosario", "x.md", ARCHIVOS)).toBe("inspia-obsidian/Glosario.md");
    expect(resolverNota("No existe", "x.md", ARCHIVOS)).toBeNull();
  });
});

describe("prepararNota", () => {
  it("separa el frontmatter y pasa la sintaxis de Obsidian a markdown común", () => {
    const { propiedades, cuerpo } = prepararNota(
      '---\ntags: arquitectura\nestado: "vigente"\n---\n# Inicio\nVer [[Glosario]] y [[Backend|el backend]].\n![[flujo.png]]\n',
    );
    expect(propiedades).toEqual([
      ["tags", "arquitectura"],
      ["estado", "vigente"],
    ]);
    expect(cuerpo).toContain("[Glosario](#wiki:Glosario)");
    expect(cuerpo).toContain("[el backend](#wiki:Backend)");
    expect(cuerpo).toContain("![flujo.png](#wiki-img:flujo.png)");
    expect(cuerpo.startsWith("# Inicio")).toBe(true);
  });

  it("no toca el código, arma los callouts y junta las listas del frontmatter", () => {
    const { propiedades, cuerpo } = prepararNota(
      "---\ntags:\n  - moc\n  - inicio\n---\n> [!info] ¿Qué es?\n> Un sistema.\n\nLos enlaces `[[wikilink]]` saltan.\n\n```\n[[no]]\n```\n",
    );
    expect(propiedades).toEqual([["tags", "moc, inicio"]]);
    expect(cuerpo).toContain("`[[wikilink]]`");
    expect(cuerpo).toContain("```\n[[no]]\n```");
    expect(cuerpo).toContain("> ℹ️ **¿Qué es?**");
  });
});
