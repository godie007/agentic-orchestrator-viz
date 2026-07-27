import { describe, expect, it } from "vitest";
import { selectTools } from "./router.js";
import type { RegisteredTool } from "./types.js";

/**
 * El router decide qué herramientas ve el modelo en un turno. Si deja afuera la
 * que el agente necesita, el agente responde que no la tiene —y tiene razón—:
 * el turno se pierde y parece un problema del modelo cuando es de la selección.
 */

const tool = (name: string, origin: RegisteredTool["origin"], description = ""): RegisteredTool => ({
  name,
  origin,
  description,
  inputSchema: {},
  readOnly: true,
  requiresApproval: false,
  execute: async () => ({ ok: true, content: "" }),
});

/** Las 15 de coordinación reales: son las que llenaban el presupuesto. */
const coordinacion = Array.from({ length: 15 }, (_, i) => tool(`coord_${i}`, "coordination"));
const habilidades = [
  tool("export_docx", "skill", "Convierte un entregable en un documento Word descargable."),
  tool("export_pdf", "skill", "Convierte un entregable en un documento PDF descargable."),
];
const mcp = Array.from({ length: 20 }, (_, i) => tool(`mcp__obsidian__vault_${i}`, "mcp", "Lee la bóveda."));

describe("selección de herramientas", () => {
  it("expone todas cuando son pocas", () => {
    const seleccion = selectTools([...coordinacion.slice(0, 5), ...habilidades], "cualquier cosa");
    expect(seleccion.strategy).toBe("all");
    expect(seleccion.exposed).toHaveLength(7);
  });

  it("las de coordinación no compiten por los lugares del ranking", () => {
    // Antes el límite era el total: 15 de coordinación dejaban 5 lugares para
    // 22 opcionales, y el agente se quedaba casi sin capacidades.
    const seleccion = selectTools([...coordinacion, ...habilidades, ...mcp], "leer la bóveda");

    expect(seleccion.strategy).toBe("ranked");
    for (const fija of coordinacion) expect(seleccion.exposed).toContain(fija.name);

    const opcionalesExpuestas = seleccion.exposed.filter((name) => name.startsWith("mcp__"));
    expect(opcionalesExpuestas.length).toBeGreaterThan(5);
  });

  it("una habilidad asignada nunca se rankea fuera", () => {
    // El caso real: a Lucas le pidieron exportar un PDF y `export_pdf` no
    // estaba en su lista, tapada por veinte tools de MCP.
    const seleccion = selectTools(
      [...coordinacion, ...habilidades, ...mcp],
      "consultar la bóveda de Obsidian y leer las reglas de negocio",
    );

    expect(seleccion.exposed).toContain("export_pdf");
    expect(seleccion.exposed).toContain("export_docx");
  });

  it("sigue acotando: no expone todo el catálogo", () => {
    const todas = [...coordinacion, ...habilidades, ...mcp];
    const seleccion = selectTools(todas, "leer la bóveda");
    expect(seleccion.exposed.length).toBeLessThan(todas.length);
  });

  it("prioriza por relevancia contra la tarea", () => {
    const especifica = tool("buscar_normativa_retie", "mcp", "Busca normativa RETIE.");
    const seleccion = selectTools(
      [...coordinacion, especifica, ...mcp],
      "necesito la normativa retie para el dictamen",
      { limit: 3 },
    );
    expect(seleccion.exposed).toContain("buscar_normativa_retie");
  });

  it("deja la decisión a la vista, no oculta", () => {
    const seleccion = selectTools([...coordinacion, ...habilidades, ...mcp], "leer la bóveda");
    // La UI muestra este motivo como "por qué tenía esta herramienta a mano".
    expect(seleccion.reason).toContain("habilidades");
    expect(seleccion.candidates.length).toBeGreaterThan(seleccion.exposed.length);
  });
});
