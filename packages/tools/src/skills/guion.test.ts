import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { caracteresHablados, parseGuion } from "./guion.js";
import { elegirMusica } from "./musica.js";
import { iconoAss, iconoSvg, separarIcono } from "./iconos.js";
import { renderSlides } from "./slides.js";
import { visualAss, visualSvg } from "./visuales.js";
import { crearNarrador, pronunciar } from "./narracion.js";
import { createSkillTools, crearResolutorImagenes, type SkillStorage } from "./index.js";
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

  it("el encabezado del documento no se convierte en la portada", () => {
    // Observado: el guionista escribe "# Guion video institucional (v4)" arriba
    // del título de verdad. Sin esta regla la portada anunciaba el número de
    // versión del borrador y el título real quedaba como una placa del medio.
    const guion = parseGuion(
      `# Guion video institucional Codytion (v4)\n\n# Codytion — Software a medida\n\n## Uno\n\nTexto.`,
    );

    expect(guion.titulo).toBe("Codytion — Software a medida");
    expect(guion.escenas[0]?.titulo).toBe("Codytion — Software a medida");
    expect(guion.escenas.map((escena) => escena.titulo)).toEqual([
      "Codytion — Software a medida",
      "Uno",
    ]);
  });

  it("un segundo # después de contenido sí abre escena", () => {
    // La regla anterior no puede tragarse un `#` legítimo: si la portada ya dijo
    // algo, el título que sigue es una escena nueva.
    const guion = parseGuion(`# Uno\n\nLo dicho en portada.\n\n# Dos\n\nMás texto.`);

    expect(guion.titulo).toBe("Uno");
    expect(guion.escenas.map((escena) => escena.titulo)).toEqual(["Uno", "Dos"]);
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

    expect(escena.balas.map((bala) => bala.texto)).toEqual(["Uno", "Dos"]);
    expect(escena.destacado).toBe("Una frase fuerte");
    expect(escena.lineas).toHaveLength(1);
  });

  it("una tabla entra como viñetas: en pantalla no se lee una grilla", () => {
    const guion = parseGuion(
      `# T\n\n## Planes\n\n| Plan | Plazo |\n| --- | --- |\n| Base | 4 semanas |\n| Full | 8 semanas |`,
    );

    expect(guion.escenas[1]?.balas.map((bala) => bala.texto)).toEqual([
      "Base — 4 semanas",
      "Full — 8 semanas",
    ]);
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
    resolve: async () => null,
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

describe("íconos, imágenes y música", () => {
  it("una viñeta con :nombre: se queda con el ícono y suelta la marca", () => {
    const guion = parseGuion(`# T\n\n## Estado\n\n- :chequeo: Ya está listo\n- Todavía no`);
    const [primera, segunda] = guion.escenas[1]!.balas;

    expect(primera).toEqual({ icono: "chequeo", texto: "Ya está listo" });
    // Sin ícono la viñeta sigue existiendo igual: el ícono es opcional.
    expect(segunda).toEqual({ icono: "", texto: "Todavía no" });
  });

  it("un sinónimo resuelve al mismo ícono, porque el agente escribe el que se le ocurre", () => {
    const guion = parseGuion(`# T\n\n## Plazos\n\n- :plazo: Dos semanas`);

    expect(guion.escenas[1]!.balas[0]!.icono).toBe("reloj");
  });

  it("un ícono que no existe deja la marca a la vista en vez de tragársela", () => {
    // Si la escondiéramos, el agente no tendría cómo enterarse del error de
    // tipeo: vería una viñeta sin ícono y la daría por buena.
    const guion = parseGuion(`# T\n\n## Nota\n\n- :crecimiiento: Subió`);

    expect(guion.escenas[1]!.balas[0]).toEqual({
      icono: "",
      texto: ":crecimiiento: Subió",
    });
  });

  it("una marca de ícono sola en su renglón no la dice la voz en off", () => {
    // Los modelos la escriben así, debajo del título, en vez de al principio del
    // `##`. Sin esta regla la narración pronuncia ":objetivo:" en medio del video.
    const guion = parseGuion(`# T\n\n## Qué hacemos\n\n:objetivo:\n\nLo que sí se dice.`);
    const escena = guion.escenas[1]!;

    expect(escena.icono).toBe("objetivo");
    expect(escena.lineas.map((linea) => linea.texto)).toEqual(["Lo que sí se dice."]);
  });

  it("una marca desconocida sola sí se dice, para que el error se note", () => {
    const guion = parseGuion(`# T\n\n## Uno\n\n:inventado:`);

    expect(guion.escenas[1]!.icono).toBe("");
    expect(guion.escenas[1]!.lineas[0]?.texto).toBe(":inventado:");
  });

  it("el ícono del título de escena no queda pegado al texto de la placa", () => {
    const guion = parseGuion(`# T\n\n## :grafico: Resultados\n\nLo hablado.`);
    const escena = guion.escenas[1]!;

    expect(escena.icono).toBe("grafico");
    expect(escena.titulo).toBe("Resultados");
  });

  it("el trazo se escala al tamaño pedido, que es lo que hace que no haya assets", () => {
    const chico = iconoAss("chequeo", 20)!;
    const grande = iconoAss("chequeo", 40)!;
    const mayor = (trazo: string): number =>
      Math.max(...trazo.match(/\d+(?:\.\d+)?/g)!.map(Number));

    expect(mayor(grande.trazo)).toBeCloseTo(mayor(chico.trazo) * 2, 1);
    // Un nombre que no está devuelve null y quien llama dibuja la viñeta de
    // siempre: un ícono mal escrito degrada, no rompe la escena.
    expect(iconoAss("no-existe", 20)).toBeNull();
    expect(separarIcono("Sin marca")).toEqual({ icono: "", resto: "Sin marca" });
  });

  it("una imagen de archivo y una a generar se distinguen por su origen", () => {
    const guion = parseGuion(
      `# T\n\n## Taller\n\n![El taller al amanecer](fotos/taller.jpg)\n\n## Idea\n\n![Un tablero abierto](generar)`,
    );

    expect(guion.escenas[1]!.imagenes).toEqual([
      { alt: "El taller al amanecer", src: "fotos/taller.jpg", generar: false },
    ]);
    expect(guion.escenas[2]!.imagenes[0]?.generar).toBe(true);
    // El prompt es la descripción: sin ella no hay nada que generar.
    expect(guion.escenas[2]!.imagenes[0]?.alt).toBe("Un tablero abierto");
  });

  it("la voz en off no lee la ruta de la imagen", () => {
    // La sintaxis de imagen y la de enlace sólo se diferencian en el `!`: con la
    // regla de enlaces, la narración decía "fotos barra taller punto jpg".
    const guion = parseGuion(`# T\n\n## Taller\n\n![El taller](fotos/taller.jpg)\n\nLo que se dice.`);
    const dicho = guion.escenas[1]!.lineas.map((linea) => linea.texto).join(" ");

    expect(dicho).toBe("Lo que se dice.");
    expect(dicho).not.toContain("taller.jpg");
  });

  it("una imagen suelta en un párrafo no se pronuncia", () => {
    const guion = parseGuion(`# T\n\n## Nota\n\nMirá esto ![un plano](fotos/plano.png) y seguimos.`);

    expect(guion.escenas[1]!.lineas[0]?.texto).toBe("Mirá esto  y seguimos.");
  });

  it("sin biblioteca de música el video se filma igual, y lo dice", async () => {
    const eleccion = await elegirMusica(undefined, "corporativo");

    expect(eleccion.pista).toBeNull();
    expect(eleccion.aviso).toContain("MUSICA_DIR");
  });

  it('"ninguna" apaga la música sin quejarse de nada', async () => {
    const eleccion = await elegirMusica("/no/existe", "ninguna");

    expect(eleccion.pista).toBeNull();
    expect(eleccion.aviso).toBe("");
  });

  it("elige la pista cuyo nombre comparte más palabras con el pedido", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-musica-"));
    try {
      for (const nombre of ["corporativo-energico.mp3", "corporativo-calmo.mp3", "notas.txt"]) {
        await writeFile(join(dir, nombre), "x");
      }

      const elegida = await elegirMusica(dir, "corporativo calmo");
      expect(elegida.pista?.nombre).toBe("corporativo-calmo.mp3");

      // Un pedido que no existe no cae en cualquier pista: nombra las que hay.
      const fallida = await elegirMusica(dir, "cumbia");
      expect(fallida.pista).toBeNull();
      expect(fallida.aviso).toContain("corporativo-calmo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("de dónde sale cada imagen del guion", () => {
  const almacenamientoQueRegistra = (): {
    storage: SkillStorage;
    guardados: string[];
    enDisco: Set<string>;
  } => {
    const guardados: string[] = [];
    const enDisco = new Set<string>();
    const storage = {
      save: async (input: { filename: string; folder?: string; bytes: Buffer }) => {
        const path = input.folder ? `${input.folder}/${input.filename}` : input.filename;
        guardados.push(path);
        enDisco.add(path);
        return { url: `/x/${path}`, path, sizeBytes: input.bytes.length };
      },
      resolve: async (path: string) => (enDisco.has(path) ? `/abs/${path}` : null),
      list: async () => [],
      remove: async () => ({ ok: true }) as const,
      removeMany: async () => ({ borrados: [], fallidos: [] }),
      writeText: async () => ({ ok: true, path: "", sizeBytes: 0 }) as const,
    } as unknown as SkillStorage;
    return { storage, guardados, enDisco };
  };

  const generadorDePrueba = (llamadas: string[]) => ({
    proveedor: "prueba",
    modelo: "prueba-1",
    generar: async ({ prompt }: { prompt: string }) => {
      llamadas.push(prompt);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
  });

  const ctx = {} as ToolContext;

  it("una imagen que ya está en el directorio se usa tal cual, sin generar nada", async () => {
    const { storage, enDisco } = almacenamientoQueRegistra();
    enDisco.add("fotos/taller.jpg");
    const llamadas: string[] = [];
    const resolver = crearResolutorImagenes(storage, generadorDePrueba(llamadas), "", ctx);

    const ruta = await resolver({ alt: "El taller", src: "fotos/taller.jpg", generar: false });

    expect(ruta).toBe("/abs/fotos/taller.jpg");
    expect(llamadas).toEqual([]);
  });

  it("la misma descripción no se paga dos veces", async () => {
    // Sin este caché, re-exportar un guion vuelve a comprar todas las imágenes y
    // además cambia el aspecto del video sin que nadie lo haya tocado.
    const { storage, guardados } = almacenamientoQueRegistra();
    const llamadas: string[] = [];
    const resolver = crearResolutorImagenes(
      storage,
      generadorDePrueba(llamadas),
      "marketing/videos",
      ctx,
    );
    const imagen = { alt: "Un tablero abierto", src: "generar", generar: true };

    const primera = await resolver(imagen);
    const segunda = await resolver(imagen);

    expect(llamadas).toHaveLength(1);
    expect(guardados).toHaveLength(1);
    expect(primera).toBe(segunda);
    // Queda dentro del directorio de salida, al lado del video: alguien tiene
    // que poder verla y reemplazarla.
    expect(guardados[0]).toMatch(/^marketing\/videos\/imagenes\/un-tablero-abierto-[0-9a-f]{8}\.png$/);
  });

  it("sin proveedor configurado, el error dice qué hacer en vez de romper el video", async () => {
    const { storage } = almacenamientoQueRegistra();
    const resolver = crearResolutorImagenes(storage, null, "", ctx);

    await expect(resolver({ alt: "Algo", src: "generar", generar: true })).rejects.toThrow(
      /proveedor de imágenes/,
    );
  });
});

describe("visuales dibujados", () => {
  const paleta = Object.fromEntries(
    ["acento", "realce", "violeta", "tinta", "tenue", "panel", "linea", "piel", "pielAlt", "pelo", "ropa", "ropaAlt"].map(
      (t) => [t, "#123456"],
    ),
  ) as Parameters<typeof visualSvg>[1];

  it("un visual con personaje dice lo que le escribe el guion", () => {
    const guion = parseGuion(`# T\n\n## Uno\n\n![Yoselin llama](visual:llamada|Hola, ¿cómo cierra el día?)`);

    expect(guion.escenas[1]!.imagenes[0]?.visual).toBe("llamada|Hola, ¿cómo cierra el día?");
    const svg = visualSvg(guion.escenas[1]!.imagenes[0]!.visual!, paleta)!;
    expect(svg).toContain("cierra el");
    // Y dibuja una persona: sin trazos es una caja con una frase adentro.
    expect(svg).toContain("<path");
  });

  it("un nombre que no existe no se toma por visual", () => {
    const guion = parseGuion(`# T\n\n## Uno\n\n![x](visual:inventado|hola)`);

    expect(guion.escenas[1]!.imagenes[0]?.visual).toBeUndefined();
  });

  it("el trazo de SVG se traduce a ASS sin dejar comandos de SVG", () => {
    // Es la conversión que permite que el mismo personaje salga en el video.
    const piezas = visualAss("llamada|Hola", 0, 0, 620)!;
    const formas = piezas.filter((p) => p.tipo === "forma");

    expect(formas.length).toBeGreaterThan(5);
    for (const forma of formas) {
      // Sólo `m`, `l` y `b`: si sobrevive una `M` o una `C`, libass descarta
      // el dibujo entero y la persona no aparece.
      expect(forma.tipo === "forma" && /^[mlb\s\d.-]+$/.test(forma.trazo)).toBe(true);
    }
    // Y el globo llega como texto aparte, porque ASS no mete palabras en formas.
    expect(piezas.some((p) => p.tipo === "texto" && p.texto.includes("Hola"))).toBe(true);
  });

  it("una frase larga se corta y no se sale del globo", () => {
    const larga = "Esta es una frase larguísima que no entra de ninguna manera dentro de un globo de diálogo chico";
    const svg = visualSvg(`llamada|${larga}`, paleta)!;

    expect(svg).toContain("…");
  });
});

describe("deck HTML", () => {
  const meta = {
    title: "Guion",
    company: "Codytion S.A.",
    author: "Nadia",
    authorTitle: "Realizadora",
    version: 1,
    date: "31 de julio de 2026",
  };

  it("una lámina por escena, con el mismo ícono que el video", async () => {
    const deck = await renderSlides(
      `# Codytion\n\nLa bajada.\n\n## :grafico: Resultados\n\nLo que se dice.\n\n- :chequeo: Uno\n- Dos`,
      meta,
    );

    expect(deck.laminas).toBe(2);
    // El ícono sale del mismo catálogo: si se corrige uno, se corrigen los dos.
    expect(deck.html).toContain(iconoSvg("grafico")!);
    expect(deck.html).toContain(iconoSvg("chequeo")!);
    expect(deck.html).toContain("Resultados");
  });

  it("el pie lo firma la empresa, no el rol que lo produjo", async () => {
    // Una pieza que se le manda a un cliente la firma la marca. El nombre del
    // agente que la generó no le dice nada a quien la recibe.
    const deck = await renderSlides(`# T\n\n## Uno\n\nTexto.`, meta);

    expect(deck.html).toContain("Codytion S.A.");
    expect(deck.html).not.toContain("Nadia");
    expect(deck.html).not.toContain("Realizadora");
  });

  it("la voz en off queda escrita, porque una lámina no se escucha", async () => {
    const deck = await renderSlides(`# T\n\n## Uno\n\nEsto lo dice la voz.\n\n- Viñeta`, meta);

    expect(deck.html).toContain("Esto lo dice la voz.");
    expect(deck.html).toContain('class="off"');
  });

  it("una escena sin nada que mostrar convierte la narración en el cuerpo", async () => {
    // Si no, queda un título sobre una lámina vacía y la frase escondida al pie.
    const deck = await renderSlides(`# T\n\n## Uno\n\nLo único que hay.`, meta);

    expect(deck.html).toContain('class="relato"');
    expect(deck.html).not.toContain('class="off"');
  });

  it("el texto del guion no puede inyectar etiquetas", async () => {
    const deck = await renderSlides(
      `# T\n\n## <img src=x onerror=alert(1)>\n\n- "comillas" & <b>negrita</b>`,
      meta,
    );

    expect(deck.html).not.toContain("<img src=x");
    expect(deck.html).not.toContain("<b>negrita</b>");
    expect(deck.html).toContain("&lt;img src=x");
  });

  it("un guion sin escenas se rechaza igual que en el video", async () => {
    await expect(renderSlides("   ", meta)).rejects.toThrow(/escena/);
  });
});

describe("cómo suena la marca", () => {
  const lexico = { Codytion: "códishon", IA: "i a" };

  it("reemplaza el nombre por su pronunciación, sin importar mayúsculas", () => {
    expect(pronunciar("En Codytion trabajamos así.", lexico)).toBe(
      "En códishon trabajamos así.",
    );
    expect(pronunciar("CODYTION entrega rápido", lexico)).toBe("códishon entrega rápido");
  });

  it("sólo toca la palabra entera, o una sigla rompe cualquier texto", () => {
    // Sin el corte de palabra, la regla de "IA" reescribe "familia" por dentro
    // y la voz en off dice "famili a".
    expect(pronunciar("La familia y la IA.", lexico)).toBe("La familia y la i a.");
  });

  it("una palabra pegada a un signo también se pronuncia bien", () => {
    expect(pronunciar("¿Conocés Codytion? Sí, Codytion.", lexico)).toBe(
      "¿Conocés códishon? Sí, códishon.",
    );
  });

  it("sin léxico el texto pasa intacto", () => {
    expect(pronunciar("Codytion", undefined)).toBe("Codytion");
  });

  it("con una sola voz, los personajes suenan igual que el narrador", () => {
    const narrador = crearNarrador({
      personajes: ["Ana", "Beto"],
      motor: "say",
      unaSolaVoz: true,
    });

    expect(narrador.voces.get("Ana")).toBe(narrador.voces.get(""));
    expect(narrador.voces.get("Beto")).toBe(narrador.voces.get(""));
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
