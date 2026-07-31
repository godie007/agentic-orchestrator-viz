import { describe, expect, it } from "vitest";
import { caracteresHablados, parseGuion } from "./guion.js";
import { crearNarrador } from "./narracion.js";
import { createSkillTools, type SkillStorage } from "./index.js";
import type { ToolContext } from "../types.js";

/**
 * El guion es la única fuente de verdad del video: si acá una línea se atribuye
 * al personaje equivocado o una escena se parte al medio, no hay render que lo
 * arregle después. Se testea sin sintetizar audio ni llamar a ffmpeg —eso es
 * lento y depende de la máquina—, que es justamente por qué el parseo vive
 * separado del render.
 */

describe("parseGuion", () => {
  it("el título con # es la portada y titula el video", () => {
    const guion = parseGuion(`# Invitación\n\nHola a todos.`);

    expect(guion.titulo).toBe("Invitación");
    expect(guion.escenas).toHaveLength(1);
    expect(guion.escenas[0]?.esPortada).toBe(true);
    expect(guion.escenas[0]?.lineas).toEqual([{ kind: "narracion", texto: "Hola a todos." }]);
  });

  it("cada ## abre una escena y su texto es la placa", () => {
    const guion = parseGuion(`# T\n\nUno.\n\n## Segunda\n\nDos.\n\n## Tercera\n\nTres.`);

    expect(guion.escenas.map((escena) => escena.titulo)).toEqual(["T", "Segunda", "Tercera"]);
    expect(guion.escenas.filter((escena) => escena.esPortada)).toHaveLength(1);
  });

  it("**Nombre:** convierte la línea en diálogo y registra al personaje", () => {
    const guion = parseGuion(
      `# T\n\n## Charla\n\n**Ana:** ¿Cuánto tarda?\n\n**Beto:** Dos semanas.\n\n**Ana:** Perfecto.`,
    );

    expect(guion.personajes).toEqual(["Ana", "Beto"]);
    expect(guion.escenas[1]?.lineas).toEqual([
      { kind: "dialogo", personaje: "Ana", texto: "¿Cuánto tarda?" },
      { kind: "dialogo", personaje: "Beto", texto: "Dos semanas." },
      { kind: "dialogo", personaje: "Ana", texto: "Perfecto." },
    ]);
  });

  it("un diálogo escrito sin renglones en blanco se parte igual", () => {
    // Así se escribe un guion —una línea por personaje, sin espacios—, pero en
    // markdown eso es un solo párrafo. Sin volver a partirlo, las cuatro
    // intervenciones las decía de corrido el primero que hablaba, leyendo en
    // voz alta los nombres de los demás. Lo vimos en el video de Codytion.
    const guion = parseGuion(
      `# T\n\n## Charla\n**Cliente:** Tenemos un sistema viejo.\n**Codytion:** Por eso existimos.\n**Cliente:** ¿Cómo arrancamos?\n**Codytion:** Con una reunión.`,
    );

    expect(guion.personajes).toEqual(["Cliente", "Codytion"]);
    expect(guion.escenas[1]?.lineas).toEqual([
      { kind: "dialogo", personaje: "Cliente", texto: "Tenemos un sistema viejo." },
      { kind: "dialogo", personaje: "Codytion", texto: "Por eso existimos." },
      { kind: "dialogo", personaje: "Cliente", texto: "¿Cómo arrancamos?" },
      { kind: "dialogo", personaje: "Codytion", texto: "Con una reunión." },
    ]);
  });

  it("una oración destacada en negrita no es un personaje", () => {
    // Sin este corte, cualquier párrafo que arranque enfatizando una idea se
    // convertía en un personaje nuevo, con voz propia y todo.
    const guion = parseGuion(
      `# T\n\n## Nota\n\n**Esto no es un nombre sino una frase larga:** sigue el texto.`,
    );

    expect(guion.personajes).toEqual([]);
    expect(guion.escenas[1]?.lineas[0]?.kind).toBe("narracion");
  });

  it("las viñetas y las citas se muestran, no se dicen", () => {
    const guion = parseGuion(`# T\n\n## Datos\n\nLo hablado.\n\n- Uno\n- Dos\n\n> Una frase fuerte`);
    const escena = guion.escenas[1]!;

    expect(escena.balas).toEqual(["Uno", "Dos"]);
    expect(escena.destacado).toBe("Una frase fuerte");
    expect(escena.lineas).toHaveLength(1);
  });

  it("una tabla entra como viñetas: en pantalla no se lee una grilla", () => {
    const guion = parseGuion(
      `# T\n\n## Planes\n\n| Plan | Plazo |\n| --- | --- |\n| Base | 4 semanas |\n| Full | 8 semanas |`,
    );

    expect(guion.escenas[1]?.balas).toEqual(["Base — 4 semanas", "Full — 8 semanas"]);
  });

  it("un separador debajo del título no parte la escena en dos", () => {
    // Los agentes escriben `---` por costumbre tipográfica, no para cortar.
    const guion = parseGuion(`# T\n\n---\n\n## Una\n\nTexto.`);

    expect(guion.escenas).toHaveLength(2);
    expect(guion.escenas[1]?.titulo).toBe("Una");
  });

  it("el separador sí corta cuando ya hay algo que cerrar", () => {
    const guion = parseGuion(`# T\n\nUno.\n\n---\n\nDos.`);

    expect(guion.escenas).toHaveLength(2);
    expect(guion.escenas[1]?.lineas[0]?.texto).toBe("Dos.");
  });

  it("el código no se dice ni se muestra", () => {
    const guion = parseGuion(`# T\n\n## Demo\n\nMirá esto.\n\n\`\`\`\nnpm run dev\n\`\`\``);

    expect(guion.escenas[1]?.lineas).toHaveLength(1);
    expect(guion.escenas[1]?.balas).toEqual([]);
  });

  it("un guion sin escenas no inventa ninguna", () => {
    expect(parseGuion("").escenas).toEqual([]);
    expect(parseGuion("   \n\n  ").escenas).toEqual([]);
  });

  it("cuenta lo hablado sin contar lo que solo se ve", () => {
    const guion = parseGuion(`# T\n\n## Uno\n\nabc\n\n- viñeta que no se dice`);

    expect(caracteresHablados(guion)).toBe(3);
  });
});

describe("herramienta export_video", () => {
  const almacenamiento = {
    save: async () => ({ url: "/v.mp4", path: "v.mp4", sizeBytes: 10 }),
    list: async () => [],
    remove: async () => ({ ok: true }) as const,
  } as unknown as SkillStorage;

  const ctxCon = (artefactos: Array<{ key: string; content: string }>): ToolContext =>
    ({
      workspace: {
        readArtifact: async (key: string) => {
          const encontrado = artefactos.find((a) => a.key === key);
          return encontrado ? { ...encontrado, title: "Guion", version: 1, createdAt: 0 } : null;
        },
        listArtifacts: async () => artefactos.map((a) => ({ ...a, title: "Guion", version: 1 })),
        verificacionDe: () => undefined,
        company: { name: "Codytion S.A." },
      },
      actor: { name: "Nadia", title: "Realizadora", authority: "executive" },
    }) as unknown as ToolContext;

  const video = createSkillTools(almacenamiento).find((skill) => skill.name === "export_video")!;

  it("se registra como habilidad asignable", () => {
    expect(video).toBeDefined();
    expect(video.origin).toBe("skill");
    expect(video.readOnly).toBe(false);
  });

  it("cuando la clave no existe, dice cuáles hay", async () => {
    const resultado = await video.execute(
      { artifact_key: "inventada" },
      ctxCon([{ key: "guion-real", content: "# T" }]),
    );

    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("guion-real");
  });

  it("un guion sin escenas se rechaza con una explicación, no con un stack trace", async () => {
    const resultado = await video.execute(
      { artifact_key: "vacio" },
      ctxCon([{ key: "vacio", content: "   " }]),
    );

    expect(resultado.ok).toBe(false);
    expect(resultado.content).toContain("##");
  });
});

describe("reparto de voces", () => {
  it("el narrador nunca suena igual que un personaje", () => {
    const narrador = crearNarrador({ personajes: ["Ana", "Beto"], motor: "say" });

    expect(narrador.voces.get("Ana")).not.toBe(narrador.voces.get(""));
    expect(narrador.voces.get("Beto")).not.toBe(narrador.voces.get(""));
  });

  it("dos personajes distintos reciben voces distintas", () => {
    const narrador = crearNarrador({ personajes: ["Ana", "Beto"], motor: "say" });

    expect(narrador.voces.get("Ana")).not.toBe(narrador.voces.get("Beto"));
  });

  it("con más personajes que voces reparte en ciclo en vez de fallar", () => {
    const narrador = crearNarrador({
      personajes: ["Ana", "Beto", "Caro", "Dani", "Eze"],
      motor: "say",
    });

    // Preferimos que dos personajes compartan voz antes que no producir el video.
    expect(narrador.voces.size).toBe(6);
    for (const personaje of ["Ana", "Beto", "Caro", "Dani", "Eze"]) {
      expect(narrador.voces.get(personaje)).toBeTruthy();
    }
  });
});
