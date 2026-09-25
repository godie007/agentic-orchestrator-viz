import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ids } from "@orq/shared";
import { FakeProvider } from "@orq/engine";
import type { ChatRequest } from "@orq/llm";
import { armarEntorno, type EntornoDePrueba } from "./testing/entorno.js";

/** El prompt de sistema del turno: viaja como mensaje `role: "system"`. */
function systemDe(req: ChatRequest): string {
  return req.messages.find((message) => message.role === "system")?.content ?? "";
}

/**
 * Ciclo de vida completo de la memoria de una empresa: una lección guardada
 * por una corrida anterior tiene que llegar al prompt de la siguiente, y una
 * refutación tiene que sacarla del prompt sin borrarla de la base ni del
 * vault — es lo que dice `buildMemorySection` (packages/engine/src/prompt.ts)
 * y `notaDeAprendizajes` (apps/server/src/contexto.ts), acá verificado de
 * punta a punta con un Store SQLite real y un vault real en disco.
 */

let entorno: EntornoDePrueba;
let provider: FakeProvider;

beforeEach(() => {
  // El proveedor guionado responde siempre lo mismo: no hace falta que actúe
  // con herramientas para que el turno cierre, sólo que hable y termine.
  provider = new FakeProvider(() => ({ text: "Listo." }), "openai");
  // Pasarlo como extraProvider hace que `armarEntorno` lo registre encima del
  // proveedor falso por defecto (mismo id "openai"): `ProviderRegistry.register`
  // usa un `Map` por id, así que la segunda escritura pisa la primera en vez
  // de convivir con ella.
  entorno = armarEntorno([provider]);
});

afterEach(() => {
  entorno.cerrar();
});

/** Recorre el vault buscando notas .md, sin asumir la ruta exacta. */
function notasDelVault(dir: string): string[] {
  const notas: string[] = [];
  const recorrer = (actual: string) => {
    for (const entrada of readdirSync(actual)) {
      const ruta = join(actual, entrada);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (entrada.endsWith(".md")) notas.push(ruta);
    }
  };
  recorrer(dir);
  return notas;
}

async function empresaConEquipo(): Promise<{ companyId: string; company: { id: string; name: string } }> {
  const now = Date.now();
  const companyId = ids.company();
  entorno.store.saveCompany({
    id: companyId,
    name: "De prueba",
    mission: "",
    voz: { unaSolaVoz: false, pronunciacion: {} },
    marca: { acento: "#40a0f8", panel: "#232f4d", rotulos: false },
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: {
      providerId: "openai",
      modelSlug: null,
      tier: "standard",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    },
    createdAt: now,
    updatedAt: now,
  });
  await entorno.runtime.generarEquipo(companyId, "consultora");
  const company = entorno.store.getCompany(companyId)!;
  return { companyId, company };
}

describe("memoria persistida entre corridas", () => {
  it("la memoria persiste, llega al prompt, y la refutación la saca sin borrarla", async () => {
    const { companyId, company } = await empresaConEquipo();

    // 1) Una corrida anterior dejó una lección: se guarda vía API (como hace
    // el POST de una persona) y se espeja al vault, tal como hace el runtime
    // cuando la lección llega por `record_lesson`.
    const now = Date.now();
    entorno.store.saveLearning({
      id: ids.learning(),
      companyId,
      topic: "precios",
      lesson: "La tarifa senior es US$45/hora.",
      authorRoleId: null,
      runId: null,
      timesConfirmed: 1,
      evidencia: null,
      estado: "activa",
      refutacion: null,
      confirmaciones: [],
      createdAt: now,
      updatedAt: now,
    });
    await entorno.runtime.espejarAprendizajes(company, "precios");

    // 2) Primera corrida: la lección tiene que llegar al prompt de sistema.
    const run1 = await entorno.runtime.startRun({
      companyId,
      objective: "Cotizar un proyecto para un cliente nuevo.",
      mode: "manual",
    });
    await entorno.runtime.tick(run1.id);

    expect(provider.calls.length).toBeGreaterThan(0);
    const conMemoria = provider.calls.filter((call) => systemDe(call).includes("US$45/hora"));
    expect(conMemoria.length).toBeGreaterThan(0);
    expect(systemDe(conMemoria[0]!)).toContain("## Lo que esta empresa ya aprendió");

    const llamadasAntesDeRefutar = provider.calls.length;

    // 3) Se refuta: una persona determina que la tarifa cambió.
    const [aprendida] = entorno.store.listLearnings(companyId);
    expect(aprendida).toBeDefined();
    entorno.store.saveLearning({
      ...aprendida!,
      estado: "refutada",
      refutacion: { motivo: "la tarifa cambió", at: Date.now() },
      updatedAt: Date.now(),
    });
    await entorno.runtime.espejarAprendizajes(company, "precios");

    // 4) Segunda corrida: la lección refutada no puede volver a aparecer en
    // ningún prompt de sistema nuevo.
    const run2 = await entorno.runtime.startRun({
      companyId,
      objective: "Cotizar otro proyecto para otro cliente.",
      mode: "manual",
    });
    await entorno.runtime.tick(run2.id);

    const llamadasNuevas = provider.calls.slice(llamadasAntesDeRefutar);
    expect(llamadasNuevas.length).toBeGreaterThan(0);
    for (const call of llamadasNuevas) {
      expect(systemDe(call)).not.toContain("US$45/hora");
    }

    // 5) La lección sigue viva en la base: refutar no borra.
    const learningsFinal = entorno.store.listLearnings(companyId);
    expect(learningsFinal).toHaveLength(1);
    expect(learningsFinal[0]!.estado).toBe("refutada");

    // 6) El vault conserva el tombstone: la nota de "precios" pasa a listar la
    // lección bajo "Refutadas" con su motivo, en vez de desaparecer.
    const notas = notasDelVault(join(entorno.dir, "contexto"));
    const notaDePrecios = notas.find((ruta) => readFileSync(ruta, "utf8").includes("Refutada:"));
    expect(notaDePrecios).toBeDefined();
    const contenido = readFileSync(notaDePrecios!, "utf8");
    expect(contenido).toContain("Refutada:");
    expect(contenido).toContain("la tarifa cambió");
  });
});
