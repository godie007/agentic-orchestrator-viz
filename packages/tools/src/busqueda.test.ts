import { describe, expect, it } from "vitest";
import { bloques, buscarEnEntregables } from "./busqueda.js";
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

function contexto(): ToolContext {
  const workspace = {
    listArtifacts: async () => [
      { key: "propuesta-el-roble", title: "Propuesta", version: 3, deOtraCorrida: false },
    ],
    readArtifact: async () => ({ key: "propuesta-el-roble", content: PROPUESTA, version: 3 }),
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

  it("devuelve el índice y cómo pedir lo que falta", async () => {
    const r = await tool.execute({ key: "propuesta-el-roble" }, contexto());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("4.3 Precio al cliente");
    expect(r.content).toContain("buscar_en_entregables");
    // El texto completo no viaja: eso es lo que gastaba el turno.
    expect(r.content).not.toContain("41.830.800");
    expect(r.content.length).toBeLessThan(PROPUESTA.length / 3);
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
