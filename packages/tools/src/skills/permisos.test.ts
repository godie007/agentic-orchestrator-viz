import { describe, expect, it } from "vitest";
import { puedeBorrar } from "./permisos.js";
import { createSkillTools, type SkillStorage } from "./index.js";
import type { ToolContext } from "../types.js";

/**
 * Borrar es lo único del directorio de salida que no se puede deshacer, así que
 * es lo único que mira la jerarquía. Un rechazo tiene que nombrar a quién
 * escalarle: si solo dice "no podés", el agente se queda trabado.
 */

const multimedia = { path: "media/captura.png", esMultimedia: true };
const entregable = { path: "informes/plan-v1.pdf", esMultimedia: false };
const apoyo = { path: "informes/notas.md", esMultimedia: false };

describe("quién puede borrar qué", () => {
  it("un ejecutivo da de baja cualquier cosa", () => {
    for (const archivo of [multimedia, entregable, apoyo]) {
      expect(puedeBorrar("executive", archivo).permitido).toBe(true);
    }
  });

  it("quien dirige un área borra apoyo pero no el entregable", () => {
    expect(puedeBorrar("manager", multimedia).permitido).toBe(true);
    expect(puedeBorrar("manager", apoyo).permitido).toBe(true);

    const veredicto = puedeBorrar("manager", entregable);
    expect(veredicto.permitido).toBe(false);
    expect(veredicto.requiere).toBe("executive");
  });

  it("un ejecutor no borra nada", () => {
    // Es el rol que más turnos gasta y el que más fácil interpreta de más una
    // instrucción de limpieza.
    for (const archivo of [multimedia, entregable, apoyo]) {
      expect(puedeBorrar("executor", archivo).permitido).toBe(false);
    }
  });

  it("el rechazo dice a quién escalarle, no solo que no se puede", () => {
    const deEjecutor = puedeBorrar("executor", multimedia);
    expect(deEjecutor.requiere).toBe("manager");
    expect(deEjecutor.motivo).toMatch(/escalate|send_message/);

    expect(puedeBorrar("manager", entregable).motivo).toContain("ejecutivo");
  });

  it("un .docx cuenta como entregable igual que un .pdf", () => {
    expect(puedeBorrar("manager", { path: "informe.docx", esMultimedia: false }).permitido).toBe(
      false,
    );
    expect(puedeBorrar("manager", { path: "datos.csv", esMultimedia: false }).permitido).toBe(true);
  });
});

describe("la herramienta aplica la jerarquía", () => {
  function conRol(authority: "executor" | "manager" | "executive") {
    const enDisco = new Map<string, boolean>([
      ["media/captura.png", true],
      ["informes/notas.md", false],
      ["informes/plan-v1.pdf", false],
    ]);

    const storage: SkillStorage = {
      async save() {
        throw new Error("no esperado");
      },
      async list() {
        return [...enDisco].map(([path, esMultimedia]) => ({
          path,
          sizeBytes: 1024,
          esMultimedia,
          generadoPorAgente: true,
        }));
      },
      async remove(path) {
        if (!enDisco.has(path)) return { ok: false, motivo: "El archivo no existe." };
        enDisco.delete(path);
        return { ok: true };
      },
      async removeMany({ kind, excluir }) {
        const fuera = new Set(excluir ?? []);
        const objetivo = [...enDisco].filter(([path, esMultimedia]) => {
          if (fuera.has(path)) return false;
          if (kind === "all") return true;
          return kind === "multimedia" ? esMultimedia : !esMultimedia;
        });
        objetivo.forEach(([path]) => enDisco.delete(path));
        return { borrados: objetivo.map(([path]) => path), fallidos: [] };
      },
      async writeText(path, content) {
        enDisco.set(path, false);
        return { ok: true, path, sizeBytes: content.length };
      },
    };

    const tools = createSkillTools(storage);
    const ctx = { actor: { authority } } as unknown as ToolContext;
    return {
      enDisco,
      borrar: (args: Record<string, unknown>) =>
        tools.find((t) => t.name === "delete_files")!.execute(args, ctx),
      escribir: (args: Record<string, unknown>) =>
        tools.find((t) => t.name === "write_output_file")!.execute(args, ctx),
    };
  }

  it("el ejecutor recibe el rechazo y el archivo queda", async () => {
    const { enDisco, borrar } = conRol("executor");
    const result = await borrar({ path: "media/captura.png" });

    expect(result.ok).toBe(false);
    expect(enDisco.has("media/captura.png")).toBe(true);
  });

  it("pero sí puede crear y modificar: producir no necesita permiso", async () => {
    const { escribir } = conRol("executor");
    expect((await escribir({ path: "informes/nuevo.md", content: "algo" })).ok).toBe(true);
  });

  it("un borrado en lote no es la vía para saltear la jerarquía", async () => {
    // "Borrá todo" desde un manager tiene que respetar el entregable igual.
    const { enDisco, borrar } = conRol("manager");
    const result = await borrar({ kind: "all" });

    expect(result.ok).toBe(true);
    expect([...enDisco.keys()]).toEqual(["informes/plan-v1.pdf"]);
    expect(result.content).toContain("No se pudieron borrar 1");
  });

  it("el ejecutivo sí se lleva todo", async () => {
    const { enDisco, borrar } = conRol("executive");
    await borrar({ kind: "all" });
    expect([...enDisco.keys()]).toEqual([]);
  });

  it("si no puede borrar nada del lote, falla con el motivo en vez de decir 0", async () => {
    // Un "borré 0 archivos" en verde parece que no había nada que borrar.
    const { borrar } = conRol("executor");
    const result = await borrar({ kind: "all" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("escalate");
  });
});
