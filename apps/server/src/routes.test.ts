import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { construirApp } from "./app.js";
import { MisionScheduler } from "./misiones.js";
import { armarEntorno, type EntornoDePrueba } from "./testing/entorno.js";

/**
 * Las rutas, probadas por HTTP de verdad con `app.inject` — sin socket y sin
 * dependencias nuevas. `routes.ts` tiene 1.150 líneas y cero tests le costaron
 * tres bugs en un solo día; esto no la cubre entera: prioriza la memoria, que
 * es donde una fila mal escrita degrada todas las corridas siguientes.
 */

let entorno: EntornoDePrueba;
let app: FastifyInstance;

beforeEach(async () => {
  entorno = armarEntorno();
  const misiones = new MisionScheduler(
    entorno.store,
    entorno.runtime,
    entorno.runtime.correo,
    "http://localhost:5173",
    60_000,
  );
  app = await construirApp({
    store: entorno.store,
    runtime: entorno.runtime,
    providers: entorno.providers,
    misiones,
  });
});

afterEach(async () => {
  await app.close();
  entorno.cerrar();
});

async function crearEmpresa(): Promise<string> {
  const respuesta = await app.inject({
    method: "POST",
    url: "/api/companies",
    payload: {
      name: "Prueba HTTP",
      mission: "probar rutas",
      budgetUsd: 1,
      defaultModel: { providerId: "openai", tier: "standard" },
    },
  });
  expect(respuesta.statusCode).toBe(201);
  return (respuesta.json() as { id: string }).id;
}

/** El vault de la empresa, para verificar el espejo sin conocer el nombre exacto. */
async function notasDelVault(dir: string): Promise<string[]> {
  const raiz = join(dir, "contexto");
  const notas: string[] = [];
  const recorrer = async (actual: string): Promise<void> => {
    for (const entrada of await readdir(actual, { withFileTypes: true }).catch(() => [])) {
      const ruta = join(actual, entrada.name);
      if (entrada.isDirectory()) await recorrer(ruta);
      else if (entrada.name.endsWith(".md")) notas.push(ruta);
    }
  };
  await recorrer(raiz);
  return notas;
}

describe("memoria por HTTP", () => {
  it("un body inválido contesta 400 con el detalle de Zod, no un 500", async () => {
    const companyId = await crearEmpresa();
    const r = await app.inject({
      method: "POST",
      url: `/api/companies/${companyId}/learnings`,
      payload: { topic: "", lesson: "" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toHaveProperty("issues");
  });

  it("cargar dos veces la misma lección no crea una fila gemela: confirma", async () => {
    // La regla de dedupe es la misma de record_lesson (`normalizarLeccion`):
    // sin esto, lo que la herramienta consideraba repetido esta puerta lo
    // duplicaba, y las dos copias competían por el cupo del prompt.
    const companyId = await crearEmpresa();
    const payload = { topic: "precios", lesson: "La tarifa senior es US$45/hora." };
    await app.inject({ method: "POST", url: `/api/companies/${companyId}/learnings`, payload });
    await app.inject({
      method: "POST",
      url: `/api/companies/${companyId}/learnings`,
      payload: { topic: "Precios", lesson: "la tarifa senior es us$45/hora" },
    });

    const filas = entorno.store.listLearnings(companyId);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.timesConfirmed).toBe(2);
    expect(filas[0]!.confirmaciones).toHaveLength(1);
  });

  it("PATCH refuta con motivo, y la lección queda fuera del prompt sin borrarse", async () => {
    const companyId = await crearEmpresa();
    const alta = await app.inject({
      method: "POST",
      url: `/api/companies/${companyId}/learnings`,
      payload: { topic: "herramientas", lesson: "edit_artifact está rota." },
    });
    const id = (alta.json() as { id: string }).id;

    // Refutar sin motivo se rechaza: el tombstone es el motivo, no el estado.
    const sinMotivo = await app.inject({
      method: "PATCH",
      url: `/api/companies/${companyId}/learnings/${id}`,
      payload: { estado: "refutada" },
    });
    expect(sinMotivo.statusCode).toBe(400);

    const conMotivo = await app.inject({
      method: "PATCH",
      url: `/api/companies/${companyId}/learnings/${id}`,
      payload: { estado: "refutada", motivoDeRefutacion: "era el índice de lectura el que mentía" },
    });
    expect(conMotivo.statusCode).toBe(200);

    const fila = entorno.store.listLearnings(companyId)[0]!;
    expect(fila.estado).toBe("refutada");
    expect(fila.refutacion?.motivo).toContain("índice de lectura");

    // Y la nota del vault cuenta la refutación en vez de desaparecer.
    const notas = await notasDelVault(entorno.dir);
    const contenidos = await Promise.all(notas.map((n) => readFile(n, "utf8")));
    expect(contenidos.some((c) => c.includes("Refutada:"))).toBe(true);
  });

  it("DELETE saca la lección de la base y su nota del vault", async () => {
    const companyId = await crearEmpresa();
    const alta = await app.inject({
      method: "POST",
      url: `/api/companies/${companyId}/learnings`,
      payload: { topic: "temporal", lesson: "Algo que se va a borrar enseguida." },
    });
    const id = (alta.json() as { id: string }).id;
    expect((await notasDelVault(entorno.dir)).length).toBeGreaterThan(0);

    const r = await app.inject({
      method: "DELETE",
      url: `/api/companies/${companyId}/learnings/${id}`,
    });
    expect(r.statusCode).toBe(200);
    expect(entorno.store.listLearnings(companyId)).toHaveLength(0);

    // El espejo también borra: el vault conservando lo borrado fue el bug —
    // mentía por comisión, y nadie sospecha de una nota que está ahí.
    const contenidos = await Promise.all(
      (await notasDelVault(entorno.dir)).map((n) => readFile(n, "utf8")),
    );
    expect(contenidos.some((c) => c.includes("se va a borrar"))).toBe(false);
  });
});

describe("compatibilidad con filas guardadas antes del esquema nuevo", () => {
  it("una fila vieja sale con estado activa y sin evidencia, no rompe", async () => {
    const companyId = await crearEmpresa();
    // El escenario real: el JSON en la base no tiene los campos nuevos, y
    // `Store.many` hace JSON.parse crudo — sin el parse por Zod en
    // `listLearnings`, `estado` llegaba undefined y el filtro del prompt no
    // distinguía nada.
    entorno.store.insertarCrudoParaTests(
      "learnings",
      "lrn_vieja",
      companyId,
      JSON.stringify({
          id: "lrn_vieja",
          companyId,
          topic: "precios",
          lesson: "Fila guardada por el código anterior.",
          authorRoleId: null,
          runId: null,
          timesConfirmed: 3,
          createdAt: 1,
          updatedAt: 1,
        }),
    );

    const filas = entorno.store.listLearnings(companyId);
    expect(filas).toHaveLength(1);
    expect(filas[0]!.estado).toBe("activa");
    expect(filas[0]!.evidencia).toBeNull();
    expect(filas[0]!.confirmaciones).toEqual([]);
    expect(filas[0]!.timesConfirmed).toBe(3);
  });
});
