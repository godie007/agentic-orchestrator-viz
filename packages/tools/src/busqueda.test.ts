import { describe, expect, it } from "vitest";
import { bloques, buscarEnEntregables, secciones } from "./busqueda.js";
import { coordinationTools } from "./coordination.js";
import type { AgentWorkspace, ToolContext } from "./types.js";

/**
 * El caso real: un agente necesita el margen de una propuesta de 21.000
 * caracteres. Hoy la lee entera —y se la reenvía a sí mismo en cada vuelta del
 * turno— o le pregunta a un colega, que le cuesta un ciclo de reloj.
 */

const PROPUESTA = `# Propuesta Comercial Muebles El Roble

## 1. Resumen Ejecutivo
El cliente pierde ventas por falta de seguimiento y procesos manuales.
${"Relleno que no aporta nada a la búsqueda. ".repeat(120)}

## 4.3 Precio al cliente
Costo interno $ 27.190.000. Precio con margen bruto del 35%: $ 41.830.800.
El soporte mensual se cotiza aparte en $ 1.407.700.

## 5. Retorno de la inversión
El repago global es de 9,3 meses contando el ahorro neto mensual.
`;

function contexto(contenido: string = PROPUESTA): ToolContext {
  const workspace = {
    listArtifacts: async () => [
      { key: "propuesta-el-roble", title: "Propuesta", version: 3, deOtraCorrida: false },
    ],
    readArtifact: async () => ({ key: "propuesta-el-roble", content: contenido, version: 3 }),
  } as unknown as AgentWorkspace;
  return { workspace } as ToolContext;
}

describe("cortar en bloques", () => {
  it("cada fragmento viaja con su encabezado", () => {
    const bs = bloques(PROPUESTA);
    expect(bs.some((b) => b.titulo === "4.3 Precio al cliente")).toBe(true);
  });
});

describe("buscar en vez de leer todo", () => {
  it("devuelve el fragmento del margen, no el documento entero", async () => {
    const r = await buscarEnEntregables.execute({ pregunta: "margen y precio final" }, contexto());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("41.830.800");
    expect(r.content).toContain("4.3 Precio al cliente");
    // Lo que importa: devuelve una fracción de los 5.000+ caracteres del original.
    expect(r.content.length).toBeLessThan(PROPUESTA.length / 2);
  });

  it("dice que no está en vez de inventar, y sugiere dónde buscar", async () => {
    const r = await buscarEnEntregables.execute(
      { pregunta: "cronograma de capacitación presencial" },
      contexto(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("web_search");
  });

  it("rechaza una pregunta sin términos con los que buscar", async () => {
    const r = await buscarEnEntregables.execute({ pregunta: "eso" }, contexto());
    expect(r.ok).toBe(false);
  });
});

/**
 * Medimos a un auditor leer los mismos tres entregables enteros en dos ciclos
 * seguidos —el memo de lecturas es por turno, y entre turnos la conversación se
 * reinicia— y quedarse sin iteraciones antes de verificar una sola cifra.
 */
describe("read_artifact no vuelca documentos largos", () => {
  const tool = coordinationTools.find((t) => t.name === "read_artifact")!;

  it("un entregable de trabajo llega entero: pedirlo por partes cuesta más", async () => {
    // Esta propuesta entra bajo el tope, así que viaja completa. Devolverle el
    // índice obligaba a pedir sección por sección, y en un turno delegado cada
    // llamada cuesta una vuelta entera —el prefijo se reenvía— así que las
    // ocho vueltas salían mucho más caras que los caracteres que ahorraban.
    const r = await tool.execute({ key: "propuesta-el-roble" }, contexto());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("4.3 Precio al cliente");
    expect(r.content).toContain("41.830.800");
  });

  it("uno realmente grande sí devuelve el índice y cómo pedir lo que falta", async () => {
    // Arriba del tope el índice vuelve a ser lo correcto: más que esto no pasa
    // por `acotar.ts` de todos modos, así que mandarlo sería mandar algo que
    // llega cortado.
    const enorme = `${PROPUESTA}\n\n${"## Anexo\n\nrelleno largo.\n\n".repeat(900)}`;
    const r = await tool.execute({ key: "propuesta-el-roble" }, contexto(enorme));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("buscar_en_entregables");
    // El texto completo no viaja: eso es lo que gastaba el turno.
    expect(r.content).not.toContain("41.830.800");
    expect(r.content.length).toBeLessThan(enorme.length / 3);
  });

  it("entrega la sección pedida, con coincidencia parcial", async () => {
    const r = await tool.execute(
      { key: "propuesta-el-roble", seccion: "precio al cliente" },
      contexto(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("41.830.800");
  });

  it("si la sección no existe, dice cuáles hay", async () => {
    const r = await tool.execute({ key: "propuesta-el-roble", seccion: "garantías" }, contexto());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("4.3 Precio al cliente");
  });
});

/**
 * El índice de un entregable no puede inventar secciones.
 *
 * `bloques` parte los tramos de más de 1.200 caracteres y repite el título en
 * cada uno, que para **buscar** está bien y para **mostrar** miente. Lo
 * medimos: un informe de 18 encabezados anunciado como 23 secciones, con cinco
 * títulos apareciendo dos veces; dos agentes gastaron nueve llamadas fallidas y
 * una reescritura completa del documento en desduplicar encabezados que nunca
 * estuvieron duplicados, y uno grabó como lección de la empresa que
 * `edit_artifact` estaba rota.
 */
describe("secciones", () => {
  // Párrafos y no un chorizo de una línea: `bloques` corta contando el buffer
  // línea por línea, que es como viene un informe de verdad.
  const PARRAFO = `${"palabra ".repeat(30)}\n`;
  const LARGA =
    "# Informe\n\nPreámbulo.\n\n" +
    `## Resumen ejecutivo\n\n${PARRAFO.repeat(10)}\n` +
    "## Fuentes\n\n- una\n- otra\n";

  it("una sección larga sigue siendo una sola", () => {
    // `bloques` la parte y repite el título; el índice del entregable no puede.
    expect(bloques(LARGA).filter((b) => b.titulo === "Resumen ejecutivo").length).toBeGreaterThan(1);
    expect(secciones(LARGA).filter((s) => s.titulo === "Resumen ejecutivo")).toHaveLength(1);
    expect(secciones(LARGA).map((s) => s.titulo)).toEqual([
      "Informe",
      "Resumen ejecutivo",
      "Fuentes",
    ]);
  });

  it("el texto es un recorte literal, así que se puede copiar a un buscar", () => {
    // La razón de ser del cambio: lo que el agente lee tiene que existir tal
    // cual en el documento, o `edit_artifact` no lo encuentra nunca.
    for (const seccion of secciones(LARGA)) {
      expect(LARGA).toContain(seccion.texto);
    }
  });

  it("el encabezado viaja con su nivel, no reponado a mano", () => {
    const doc = "# Título\n\ntexto\n\n### Detalle fino\n\nmás texto\n";
    const detalle = secciones(doc).find((s) => s.titulo === "Detalle fino")!;
    // Reponerlo como `##` daba un encabezado que el documento no tiene.
    expect(detalle.encabezado).toBe("### Detalle fino");
    expect(doc).toContain(detalle.texto);
  });

  it("lo que va antes del primer encabezado no se pierde en una sección falsa", () => {
    const doc = "Nota suelta arriba de todo.\n\n## Sección\n\ncuerpo\n";
    expect(secciones(doc).map((s) => s.titulo)).toEqual(["Sección"]);
  });

  it("un documento sin encabezados no tiene secciones", () => {
    expect(secciones("Sólo texto plano, sin un solo título.")).toEqual([]);
  });
});
