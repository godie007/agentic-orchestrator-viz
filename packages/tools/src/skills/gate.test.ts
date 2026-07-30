import { describe, expect, it } from "vitest";
import { createSkillTools } from "./index.js";
import { verificarCifras } from "../calculo.js";
import type { AgentWorkspace, ToolContext, VerificacionCifras } from "../types.js";

/**
 * Le pedimos exhaustividad al auditor de cinco maneras —la herramienta, el
 * prompt, la versión en lote, abaratar la lectura, más iteraciones— y verificó
 * una cifra de seis y se dio por satisfecho. Acá deja de ser algo que debería
 * hacer: un documento con plata no sale sin que alguien haya hecho las cuentas.
 */

const PROPUESTA = "# Propuesta\n\nPrecio al cliente: $ 9.660.000 con margen del 35%.\n";

function escenario(contenido = PROPUESTA, version = 1) {
  const verificaciones = new Map<string, VerificacionCifras>();
  const workspace = {
    company: { id: "cmp_1", name: "Codytion" },
    readArtifact: async () => ({ key: "propuesta", title: "Propuesta", content: contenido, version }),
    listArtifacts: async () => [{ key: "propuesta", title: "Propuesta", version }],
    registrarVerificacion: (clave: string, r: VerificacionCifras) => verificaciones.set(clave, r),
    verificacionDe: (clave: string) => verificaciones.get(clave),
  } as unknown as AgentWorkspace;
  const ctx = { workspace, actor: { id: "rol_1", name: "Mateo" } } as unknown as ToolContext;
  const almacenamiento = {
    save: async () => ({ url: "/x.pdf", path: "x.pdf", sizeBytes: 10 }),
    list: async () => [],
    remove: async () => {},
  };
  const tools = createSkillTools(almacenamiento as never);
  return { ctx, exportar: tools.find((t) => t.name === "export_pdf")!, verificaciones };
}

describe("nada con plata sale sin verificar", () => {
  it("bloquea la exportación cuando nadie hizo las cuentas", async () => {
    const { ctx, exportar } = escenario();
    const r = await exportar.execute({ artifact_key: "propuesta" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("verificar_cifras");
  });

  it("bloquea si la verificación encontró cifras mal", async () => {
    const { ctx, exportar } = escenario();
    await verificarCifras.execute(
      {
        entregable: "propuesta",
        cifras: [{ concepto: "margen", expresion: "0,35", esperado: "0,50" }],
      },
      ctx,
    );
    const r = await exportar.execute({ artifact_key: "propuesta" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("no coinciden");
  });

  it("deja exportar cuando las cuentas cierran", async () => {
    const { ctx, exportar } = escenario();
    await verificarCifras.execute(
      {
        entregable: "propuesta",
        cifras: [{ concepto: "precio", expresion: "6.279.000 / 0,65", esperado: "9.660.000" }],
      },
      ctx,
    );
    const r = await exportar.execute({ artifact_key: "propuesta" }, ctx);
    expect(r.ok).toBe(true);
  });

  it("un documento sin cifras no necesita verificación", async () => {
    const { ctx, exportar } = escenario("# Guía de proceso\n\nPrimero se releva, después se diseña.\n");
    const r = await exportar.execute({ artifact_key: "propuesta" }, ctx);
    expect(r.ok).toBe(true);
  });
});
