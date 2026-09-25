import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@orq/shared";
import { auditarCorrida } from "./auditoria.js";

let seq = 0;

/**
 * Arma un TraceEvent mínimo válido para un tipo dado, con los campos base
 * (`id`, `runId`, `at`) resueltos solos. Cada test sólo completa lo que le
 * importa a la regla que está probando — el resto queda con un valor neutro.
 */
function evento<T extends TraceEvent["type"]>(
  type: T,
  parcial: Omit<Extract<TraceEvent, { type: T }>, "type" | "id" | "at">,
): TraceEvent {
  seq += 1;
  return { type, id: `ev-${seq}`, at: seq, ...parcial } as unknown as TraceEvent;
}

describe("auditarCorrida — turno-sin-modelo", () => {
  it("un turno que cierra sin model.selected previo del mismo rol y tick queda señalado", () => {
    const eventos: TraceEvent[] = [
      evento("agent.turn_end", {
        runId: "r1",
        tick: 1,
        roleId: "guionista",
        iterations: 2,
        costUsd: 0,
        summary: "listo, avanzo con el resto",
      }),
    ];
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "turno-sin-modelo")).toBe(true);
  });

  it("con su model.selected en el mismo tick, el turno no queda señalado", () => {
    const eventos: TraceEvent[] = [
      evento("model.selected", {
        runId: "r1",
        tick: 1,
        roleId: "guionista",
        providerId: "anthropic",
        modelSlug: "claude-sonnet-5",
        tier: "standard",
        escalado: false,
        motivo: "tier fijo del rol",
      }),
      evento("agent.turn_end", {
        runId: "r1",
        tick: 1,
        roleId: "guionista",
        iterations: 2,
        costUsd: 0.01,
        summary: "avanzo con el resto",
      }),
    ];
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "turno-sin-modelo")).toBe(false);
  });
});

describe("auditarCorrida — exito-sin-respaldo (el corazón del harness)", () => {
  it("un rol que informa 'entregado' sin haber ejecutado nada queda señalado", () => {
    // El caso real que motivó este harness: el rol dijo "ya exporté el PDF" y
    // lo único que había producido era un .txt con instrucciones para imprimir
    // a mano. Ninguna herramienta corrió, así que el resumen queda sin respaldo.
    const eventos: TraceEvent[] = [
      evento("agent.turn_end", {
        runId: "r1",
        tick: 3,
        roleId: "publicador",
        iterations: 1,
        costUsd: 0.002,
        summary: "Ya exporté el informe en PDF, quedó listo para enviar.",
      }),
    ];
    const informe = auditarCorrida(eventos);
    const hallazgo = informe.hallazgos.find((h) => h.regla === "exito-sin-respaldo");
    expect(hallazgo).toBeDefined();
    expect(hallazgo?.severidad).toBe("alta");
    expect(hallazgo?.roleId).toBe("publicador");
  });

  it("nueve fallos declarados de edit_artifact no son éxito corrupto: son fallos a la vista", () => {
    // Nueve tool.end con ok=false no cuentan como respaldo — si contaran, la
    // regla no distinguiría entre "ejecuté y funcionó" y "lo intenté nueve
    // veces y nunca funcionó", que es justo la mentira que hay que atrapar.
    const eventos: TraceEvent[] = Array.from({ length: 9 }, () =>
      evento("tool.end", {
        runId: "r1",
        tick: 3,
        roleId: "publicador",
        callId: `call-${seq}`,
        toolName: "edit_artifact",
        origin: "capability",
        mcpServerId: null,
        durationMs: 50,
        ok: false,
        preview: "no se pudo escribir",
        error: "ruta inválida",
      }),
    );
    eventos.push(
      evento("agent.turn_end", {
        runId: "r1",
        tick: 3,
        roleId: "publicador",
        iterations: 9,
        costUsd: 0.01,
        summary: "Completé la edición del informe.",
      }),
    );
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "exito-sin-respaldo")).toBe(true);
  });

  it("con un tool.end exitoso del mismo rol y tick, la entrega declarada queda respaldada", () => {
    const eventos: TraceEvent[] = [
      evento("tool.end", {
        runId: "r1",
        tick: 3,
        roleId: "publicador",
        callId: "call-1",
        toolName: "export_pdf",
        origin: "skill",
        mcpServerId: null,
        durationMs: 400,
        ok: true,
        preview: "informe.pdf",
        error: null,
      }),
      evento("agent.turn_end", {
        runId: "r1",
        tick: 3,
        roleId: "publicador",
        iterations: 2,
        costUsd: 0.01,
        summary: "Exporté el informe en PDF.",
      }),
    ];
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "exito-sin-respaldo")).toBe(false);
  });
});

describe("auditarCorrida — export-sin-verificacion", () => {
  it("un export de PDF sin verificar_cifras previo queda señalado", () => {
    const eventos: TraceEvent[] = [
      evento("tool.end", {
        runId: "r1",
        tick: 2,
        roleId: "publicador",
        callId: "call-1",
        toolName: "export_pdf",
        origin: "skill",
        mcpServerId: null,
        durationMs: 300,
        ok: true,
        preview: "informe.pdf",
        error: null,
      }),
    ];
    const informe = auditarCorrida(eventos);
    const hallazgo = informe.hallazgos.find((h) => h.regla === "export-sin-verificacion");
    expect(hallazgo).toBeDefined();
    expect(hallazgo?.severidad).toBe("alta");
  });

  it("el export con la verificación hecha pasa limpio", () => {
    const eventos: TraceEvent[] = [
      evento("tool.end", {
        runId: "r1",
        tick: 1,
        roleId: "auditor",
        callId: "call-1",
        toolName: "verificar_cifras",
        origin: "capability",
        mcpServerId: null,
        durationMs: 200,
        ok: true,
        preview: "cifras ok",
        error: null,
      }),
      evento("tool.end", {
        runId: "r1",
        tick: 2,
        roleId: "publicador",
        callId: "call-2",
        toolName: "export_pdf",
        origin: "skill",
        mcpServerId: null,
        durationMs: 300,
        ok: true,
        preview: "informe.pdf",
        error: null,
      }),
    ];
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "export-sin-verificacion")).toBe(false);
  });
});

describe("auditarCorrida — tasa-de-fallos", () => {
  it("un rol con más del 30% de sus llamadas fallidas (y al menos 5) queda señalado", () => {
    const eventos: TraceEvent[] = Array.from({ length: 10 }, (_, i) =>
      evento("tool.end", {
        runId: "r1",
        tick: 1,
        roleId: "explorador",
        callId: `call-${i}`,
        toolName: "fetch_url",
        origin: "capability",
        mcpServerId: null,
        durationMs: 100,
        ok: i < 6, // 4 de 10 fallan: 40%
        preview: "ok",
        error: i < 6 ? null : "timeout",
      }),
    );
    const informe = auditarCorrida(eventos);
    const hallazgo = informe.hallazgos.find((h) => h.regla === "tasa-de-fallos");
    expect(hallazgo).toBeDefined();
    expect(hallazgo?.severidad).toBe("info");
  });

  it("con menos de 5 llamadas no se señala, aunque todas fallen", () => {
    const eventos: TraceEvent[] = Array.from({ length: 3 }, (_, i) =>
      evento("tool.end", {
        runId: "r1",
        tick: 1,
        roleId: "explorador",
        callId: `call-${i}`,
        toolName: "fetch_url",
        origin: "capability",
        mcpServerId: null,
        durationMs: 100,
        ok: false,
        preview: "",
        error: "timeout",
      }),
    );
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "tasa-de-fallos")).toBe(false);
  });
});

describe("auditarCorrida — relectura-repetida", () => {
  it("más de 6 lecturas del mismo rol, tool y tick quedan señaladas", () => {
    const eventos: TraceEvent[] = Array.from({ length: 7 }, (_, i) =>
      evento("tool.end", {
        runId: "r1",
        tick: 4,
        roleId: "verificador",
        callId: `call-${i}`,
        toolName: "read_artifact",
        origin: "coordination",
        mcpServerId: null,
        durationMs: 40,
        ok: true,
        preview: "…",
        error: null,
      }),
    );
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "relectura-repetida")).toBe(true);
  });

  it("6 lecturas o menos no alcanzan para señalar", () => {
    const eventos: TraceEvent[] = Array.from({ length: 6 }, (_, i) =>
      evento("tool.end", {
        runId: "r1",
        tick: 4,
        roleId: "verificador",
        callId: `call-${i}`,
        toolName: "read_artifact",
        origin: "coordination",
        mcpServerId: null,
        durationMs: 40,
        ok: true,
        preview: "…",
        error: null,
      }),
    );
    const informe = auditarCorrida(eventos);
    expect(informe.hallazgos.some((h) => h.regla === "relectura-repetida")).toBe(false);
  });
});

describe("auditarCorrida — métricas", () => {
  it("cuenta llamadas y fallidas totales y por rol", () => {
    const eventos: TraceEvent[] = [
      evento("tool.end", {
        runId: "r1",
        tick: 1,
        roleId: "a",
        callId: "1",
        toolName: "x",
        origin: "capability",
        mcpServerId: null,
        durationMs: 10,
        ok: true,
        preview: "",
        error: null,
      }),
      evento("tool.end", {
        runId: "r1",
        tick: 1,
        roleId: "b",
        callId: "2",
        toolName: "x",
        origin: "capability",
        mcpServerId: null,
        durationMs: 10,
        ok: false,
        preview: "",
        error: "falló",
      }),
    ];
    const informe = auditarCorrida(eventos);
    expect(informe.metricas.llamadas).toBe(2);
    expect(informe.metricas.fallidas).toBe(1);
    expect(informe.metricas.porRol.a).toEqual({ llamadas: 1, fallidas: 0 });
    expect(informe.metricas.porRol.b).toEqual({ llamadas: 1, fallidas: 1 });
  });
});
