import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ids } from "@orq/shared";
import type { AgentRequest, Company, Role } from "@orq/shared";
import { Store } from "./db.js";

/**
 * Una solicitud es un pedido de un agente a la persona. Si el agente se borra,
 * nadie puede responderla, y aprobarla haría cosas absurdas —darle acceso a
 * herramientas a un rol que ya no existe—. Se van con él.
 */

let dir: string;
let store: Store;
const companyId = ids.company();
const otraEmpresa = ids.company();

const rol = (name: string, company = companyId): Role => ({
  id: ids.role(),
  companyId: company,
  departmentId: ids.department(),
  name,
  title: name,
  systemPrompt: "",
  model: {
    providerId: "openrouter",
    modelSlug: null,
    tier: "cheap",
    escalado: null,
    temperature: null,
    maxOutputTokens: 1024,
  },
  toolIds: [],
  authority: "executor",
  reportsTo: null,
  maxTurns: 4,
  spendApprovalThresholdUsd: null,
  position: { x: 0, y: 0 },
});

const solicitud = (roleId: string | null, company = companyId): AgentRequest => ({
  id: ids.request(),
  companyId: company,
  runId: null,
  requestedByRoleId: roleId,
  type: "context",
  reason: "Falta un dato del negocio",
  roleProposal: null,
  question: "¿Cuánto se factura por tenant?",
  toolNames: [],
  mcpProposal: [],
  status: "pending",
  resolution: null,
  createdAt: Date.now(),
  resolvedAt: null,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orq-db-"));
  store = new Store(join(dir, "test.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("borrar un rol", () => {
  it("borra sus solicitudes y deja las de los demás", () => {
    const andres = rol("Andrés");
    const diego = rol("Diego");
    store.saveRole(andres);
    store.saveRole(diego);
    store.saveRequest(solicitud(andres.id));
    store.saveRequest(solicitud(andres.id));
    store.saveRequest(solicitud(diego.id));

    const borradas = store.deleteRole(andres.id);

    expect(borradas).toBe(2);
    const quedan = store.listRequests(companyId);
    expect(quedan).toHaveLength(1);
    expect(quedan[0]?.requestedByRoleId).toBe(diego.id);
    expect(store.listRoles(companyId).map((r) => r.id)).toEqual([diego.id]);
  });

  it("no toca solicitudes de otra empresa aunque se repita el nombre", () => {
    const propio = rol("Andrés");
    const ajeno = rol("Andrés", otraEmpresa);
    store.saveRole(propio);
    store.saveRole(ajeno);
    store.saveRequest(solicitud(propio.id));
    store.saveRequest(solicitud(ajeno.id, otraEmpresa));

    store.deleteRole(propio.id);

    expect(store.listRequests(companyId)).toHaveLength(0);
    expect(store.listRequests(otraEmpresa)).toHaveLength(1);
  });

  it("deja intactas las solicitudes sin autor", () => {
    // `requestedByRoleId` es nullable; un NULL no puede parecerse a ningún id.
    const andres = rol("Andrés");
    store.saveRole(andres);
    store.saveRequest(solicitud(null));

    expect(store.deleteRole(andres.id)).toBe(0);
    expect(store.listRequests(companyId)).toHaveLength(1);
  });

  it("también se lleva las ya resueltas, que apuntarían a un rol inexistente", () => {
    const andres = rol("Andrés");
    store.saveRole(andres);
    store.saveRequest({ ...solicitud(andres.id), status: "approved", resolvedAt: Date.now() });

    expect(store.deleteRole(andres.id)).toBe(1);
    expect(store.listRequests(companyId)).toHaveLength(0);
  });
});

describe("borrar una corrida", () => {
  const run = (id: string) => ({
    id,
    companyId,
    objective: "x",
    status: "completed" as const,
    mode: "manual" as const,
    tick: 1,
    maxTicks: 10,
    budgetUsd: 1,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
  });

  const artefacto = (id: string, runId: string) => ({
    id,
    runId,
    key: "informe",
    title: "Informe",
    contentType: "markdown" as const,
    content: "contenido",
    version: 1,
    authorRoleId: "rol_1",
    tick: 1,
    createdAt: Date.now(),
  });

  it("conserva los entregables: son de la empresa, no de la corrida", () => {
    store.saveRun(run("run_1"));
    store.saveArtifact(artefacto("art_1", "run_1"), companyId);

    store.deleteRun("run_1");

    expect(store.listRuns(companyId)).toHaveLength(0);
    // Lo que la empresa produjo sobrevive a que se limpie la lista de corridas.
    expect(store.listArtifactsByCompany(companyId).map((a) => a.id)).toEqual(["art_1"]);
  });

  it("se lleva el rastro de cómo se llegó", () => {
    store.saveRun(run("run_2"));
    store.saveMessage({
      id: "msg_1",
      runId: "run_2",
      fromRoleId: null,
      toRoleId: "rol_1",
      toDepartmentId: null,
      type: "human",
      subject: "s",
      body: "b",
      threadId: "thr_1",
      inReplyTo: null,
      status: "pending",
      tick: 0,
      createdAt: Date.now(),
    });

    store.deleteRun("run_2");
    expect(store.listMessages("run_2")).toHaveLength(0);
  });

  it("no toca las otras corridas", () => {
    store.saveRun(run("run_3"));
    store.saveRun(run("run_4"));

    store.deleteRun("run_3");
    expect(store.listRuns(companyId).map((r) => r.id)).toEqual(["run_4"]);
  });
});

/**
 * Los residuos son filas que quedaron apuntando a algo que ya no existe. Hoy los
 * borrados en cascada no dejan ninguna, pero antes sí: se midieron 10
 * entregables y 21 corridas apuntando a empresas inexistentes. Una base que
 * viene de esa época sigue arrastrando esa basura, y no se puede ver desde la
 * UI porque justamente lo que le falta es el padre por el que se navega.
 */
describe("residuos", () => {
  const empresa = (id: string): Company => ({
    id,
    name: `Empresa ${id}`,
    mission: "",
    voz: { unaSolaVoz: false, pronunciacion: {} },
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: {
      providerId: "openrouter",
      modelSlug: null,
      tier: "cheap",
      escalado: null,
      temperature: null,
      maxOutputTokens: 1024,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const corrida = (id: string, company: string) => ({
    id,
    companyId: company,
    objective: "x",
    status: "completed" as const,
    mode: "manual" as const,
    tick: 1,
    maxTicks: 10,
    budgetUsd: 1,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
  });

  const entregable = (id: string, runId: string) => ({
    id,
    runId,
    key: `k_${id}`,
    title: "Informe",
    contentType: "markdown" as const,
    content: "contenido",
    version: 1,
    authorRoleId: "rol_1",
    tick: 1,
    createdAt: Date.now(),
  });

  it("una base sana no tiene ninguno", () => {
    store.saveCompany(empresa(companyId));
    store.saveRun(corrida("run_ok", companyId));
    store.saveArtifact(entregable("art_ok", "run_ok"), companyId);
    store.saveRole(rol("Andrés"));

    expect(store.residuos().filas).toBe(0);
  });

  it("cuenta por tabla lo que quedó sin dueño", () => {
    // Sin `saveCompany`: es exactamente el estado que dejaba el borrado viejo.
    store.saveRun(corrida("run_suelta", "cmp_fantasma"));
    store.saveArtifact(entregable("art_suelto", "run_suelta"), "cmp_fantasma");
    store.saveRole(rol("Huérfano", "cmp_fantasma"));

    const residuos = store.residuos();
    expect(residuos.porEmpresa["artifacts"]).toBe(1);
    expect(residuos.porEmpresa["roles"]).toBe(1);
    expect(residuos.filas).toBeGreaterThanOrEqual(2);
  });

  it("anuncia exactamente las filas que va a borrar", () => {
    // Un botón destructivo que subdeclara lo que se lleva no se vuelve a creer.
    // Acá son tres: la corrida, su mensaje y su entregable.
    store.saveRun(corrida("run_suelta", "cmp_fantasma"));
    store.saveArtifact(entregable("art_suelto", "run_suelta"), "cmp_fantasma");
    store.saveMessage({
      id: "msg_suelto",
      runId: "run_suelta",
      fromRoleId: null,
      toRoleId: "rol_1",
      toDepartmentId: null,
      type: "human",
      subject: "s",
      body: "b",
      threadId: "thr_1",
      inReplyTo: null,
      status: "pending",
      tick: 0,
      createdAt: Date.now(),
    });

    const anunciado = store.residuos();
    expect(anunciado.porEmpresa["runs"]).toBe(1);
    // El mensaje cuelga de una corrida que todavía existe, pero que se va a
    // borrar: contra `runs` a secas quedaba fuera de la cuenta.
    expect(anunciado.porCorrida["messages"]).toBe(1);
    expect(anunciado.filas).toBe(3);

    expect(store.purgarResiduos().filas).toBe(3);
    expect(store.residuos().filas).toBe(0);
  });

  it("purga las corridas sin empresa y, con ellas, su rastro", () => {
    store.saveRun(corrida("run_suelta", "cmp_fantasma"));
    store.saveMessage({
      id: "msg_suelto",
      runId: "run_suelta",
      fromRoleId: null,
      toRoleId: "rol_1",
      toDepartmentId: null,
      type: "human",
      subject: "s",
      body: "b",
      threadId: "thr_1",
      inReplyTo: null,
      status: "pending",
      tick: 0,
      createdAt: Date.now(),
    });

    store.purgarResiduos();

    // En una sola pasada: la corrida se va primero y por eso el barrido por
    // corrida ya encuentra huérfano su mensaje. Al revés harían falta dos.
    expect(store.residuos().filas).toBe(0);
    expect(store.listMessages("run_suelta")).toHaveLength(0);
  });

  it("no toca lo que sí tiene dueño", () => {
    store.saveCompany(empresa(companyId));
    store.saveRun(corrida("run_ok", companyId));
    store.saveArtifact(entregable("art_ok", "run_ok"), companyId);
    store.saveRun(corrida("run_suelta", "cmp_fantasma"));

    store.purgarResiduos();

    expect(store.listRuns(companyId).map((r) => r.id)).toEqual(["run_ok"]);
    expect(store.listArtifactsByCompany(companyId)).toHaveLength(1);
  });

  it("borrar una empresa no deja residuos", () => {
    store.saveCompany(empresa(companyId));
    store.saveRun(corrida("run_1", companyId));
    store.saveArtifact(entregable("art_1", "run_1"), companyId);
    store.saveRole(rol("Andrés"));
    store.saveRequest(solicitud(null));

    store.deleteCompany(companyId);

    // Es la garantía que `TABLAS_POR_EMPRESA` compartido tiene que sostener: si
    // aparece una tabla nueva y se agrega en un solo lado, esto falla.
    expect(store.residuos().filas).toBe(0);
  });

  it("compactar no rompe la base", () => {
    store.saveCompany(empresa(companyId));
    store.saveRun(corrida("run_1", companyId));
    store.deleteRun("run_1");

    // `VACUUM` no puede correr dentro de una transacción: si alguien lo mete en
    // una, esto tira "cannot VACUUM from within a transaction".
    expect(() => store.vacuum()).not.toThrow();
    expect(store.pesoEnDisco()).toBeGreaterThan(0);
    expect(store.listCompanies()).toHaveLength(1);
  });
});

/**
 * El resumen alimenta la pantalla de Proyectos, que existe para poder decidir
 * cuál abrir —o cuál borrar— sin entrar a cada uno.
 */
describe("resumen de proyectos", () => {
  const empresa = (id: string, name: string): Company => ({
    id,
    name,
    mission: "m",
    voz: { unaSolaVoz: false, pronunciacion: {} },
    context: "",
    currency: "USD",
    budgetUsd: 1,
    defaultModel: {
      providerId: "openrouter",
      modelSlug: null,
      tier: "standard",
      escalado: null,
      temperature: null,
      maxOutputTokens: 4096,
    },
    createdAt: 1,
    updatedAt: 1,
  });

  const corrida = (id: string, company: string, startedAt: number) => ({
    id,
    companyId: company,
    objective: "x",
    status: "completed" as const,
    mode: "manual" as const,
    tick: 1,
    maxTicks: 10,
    budgetUsd: 1,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt,
    endedAt: startedAt + 1,
  });

  it("cuenta lo de cada uno sin mezclar", () => {
    store.saveCompany(empresa(companyId, "Uno"));
    store.saveCompany(empresa(otraEmpresa, "Dos"));
    store.saveRole(rol("Andrés"));
    store.saveRole(rol("Bruno"));
    store.saveRole(rol("Ajeno", otraEmpresa));
    store.saveRun(corrida("run_1", companyId, 10));

    const resumen = store.resumenEmpresas();
    const uno = resumen.find((entrada) => entrada.id === companyId);
    const dos = resumen.find((entrada) => entrada.id === otraEmpresa);

    expect(uno?.roles).toBe(2);
    expect(uno?.corridas).toBe(1);
    expect(dos?.roles).toBe(1);
    expect(dos?.corridas).toBe(0);
  });

  it("un proyecto vacío aparece en cero, no ausente", () => {
    // Con un `GROUP BY` a secas, el que no tiene ninguna fila en ninguna tabla
    // no aparece en ningún resultado y se caía de la lista: sería un proyecto
    // recién creado, que es justo el que hay que poder abrir.
    store.saveCompany(empresa(companyId, "Recién creado"));

    const resumen = store.resumenEmpresas();
    expect(resumen).toHaveLength(1);
    expect(resumen[0]?.roles).toBe(0);
    expect(resumen[0]?.entregables).toBe(0);
    expect(resumen[0]?.ultimaCorridaAt).toBeNull();
  });

  it("la última corrida es la más reciente", () => {
    store.saveCompany(empresa(companyId, "Uno"));
    store.saveRun(corrida("run_viejo", companyId, 100));
    store.saveRun(corrida("run_nuevo", companyId, 900));

    expect(store.resumenEmpresas()[0]?.ultimaCorridaAt).toBe(900);
  });
});

/**
 * Borrar un servidor MCP tiene que llevarse sus herramientas y podar los
 * `toolIds` muertos de los roles. `deleteToolsByMcpServer` existía sin ningún
 * llamador: las filas quedaban huérfanas en la base y los roles apuntando a
 * ids inexistentes — silencioso en el motor, ruido permanente en la UI.
 */
describe("cascada al borrar un servidor MCP", () => {
  const tool = (name: string, mcpServerId: string | null, origin: "mcp" | "skill" = "mcp") => ({
    id: ids.tool(),
    name,
    description: "",
    origin,
    inputSchema: {},
    readOnly: false,
    requiresApproval: false,
    mcpServerId,
    composicion: null,
  });

  it("borra las tools del servidor y poda los toolIds de los roles", () => {
    const serverId = ids.mcpServer();
    const delServidor = tool("mcp__uno__leer", serverId);
    const deOtro = tool("mcp__otro__leer", ids.mcpServer());
    const habilidad = tool("export_pdf", null, "skill");
    store.saveTool(companyId, delServidor);
    store.saveTool(companyId, deOtro);
    store.saveTool(companyId, habilidad);

    const agente = { ...rol("Diego"), toolIds: [delServidor.id, deOtro.id, habilidad.id] };
    store.saveRole(agente);

    store.deleteToolsByMcpServer(companyId, serverId);
    const podados = store.podarToolIdsHuerfanos(companyId);

    const restantes = store.listTools(companyId).map((t) => t.name);
    expect(restantes).toContain("mcp__otro__leer");
    expect(restantes).toContain("export_pdf");
    expect(restantes).not.toContain("mcp__uno__leer");

    expect(podados).toBe(1);
    const actualizado = store.listRoles(companyId).find((r) => r.id === agente.id);
    expect(actualizado?.toolIds).toEqual([deOtro.id, habilidad.id]);
  });

  it("la poda no toca roles sanos ni cuenta de más", () => {
    const habilidad = tool("export_docx", null, "skill");
    store.saveTool(companyId, habilidad);
    const sano = { ...rol("Ana"), toolIds: [habilidad.id] };
    store.saveRole(sano);

    expect(store.podarToolIdsHuerfanos(companyId)).toBe(0);
    expect(store.listRoles(companyId).find((r) => r.id === sano.id)?.toolIds).toEqual([
      habilidad.id,
    ]);
  });
});

/**
 * Continuidad entre corridas. Los entregables ya sobrevivían a su corrida; el
 * trabajo abierto no, así que retomar un encargo largo empezaba con el tablero
 * vacío. Y una caída dura dejaba corridas marcadas como vivas para siempre,
 * que además bloquean las misiones de esa empresa.
 */
describe("trabajo abierto de la empresa", () => {
  const ahora = Date.now();

  const corrida = (id: string, company = companyId, status = "completed") => ({
    id,
    companyId: company,
    objective: "Un encargo largo",
    status,
    mode: "manual" as const,
    tick: 3,
    maxTicks: 10,
    budgetUsd: 5,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: ahora,
    endedAt: null,
  });

  const tarea = (runId: string, title: string, status: string) => ({
    id: ids.task(),
    runId,
    title,
    detail: "",
    assigneeRoleId: ids.role(),
    createdByRoleId: null,
    status,
    priority: "normal" as const,
    dueTick: null,
    result: null,
    heredadaDeRunId: null,
    createdAt: ahora,
    updatedAt: ahora,
  });

  it("devuelve lo pendiente de cualquier corrida y deja afuera lo terminado", () => {
    const vieja = corrida(ids.run());
    const otra = corrida(ids.run(), otraEmpresa);
    store.saveRun(vieja as never);
    store.saveRun(otra as never);
    store.saveTask(tarea(vieja.id, "Grabar la escena 3", "in_progress") as never);
    store.saveTask(tarea(vieja.id, "Escribir el guion", "done") as never);
    store.saveTask(tarea(vieja.id, "Revisar el corte", "blocked") as never);
    store.saveTask(tarea(vieja.id, "Idea descartada", "cancelled") as never);
    store.saveTask(tarea(otra.id, "De otra empresa", "pending") as never);

    const abiertas = store.listTasksAbiertasByCompany(companyId).map((t) => t.title);
    expect(abiertas.sort()).toEqual(["Grabar la escena 3", "Revisar el corte"]);
  });

  it("una empresa sin trabajo previo devuelve la lista vacía", () => {
    expect(store.listTasksAbiertasByCompany(companyId)).toEqual([]);
  });
});

describe("saneo de corridas huérfanas", () => {
  const ahora = Date.now();
  const corrida = (status: string) => ({
    id: ids.run(),
    companyId,
    objective: "x",
    status,
    mode: "continuous" as const,
    tick: 1,
    maxTicks: 10,
    budgetUsd: 1,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: ahora,
    endedAt: null,
  });

  it("cierra las que quedaron vivas y explica por qué, sin tocar las terminadas", () => {
    const corriendo = corrida("running");
    const esperando = corrida("awaiting_approval");
    const pausada = corrida("paused");
    const terminada = corrida("completed");
    for (const run of [corriendo, esperando, pausada, terminada]) store.saveRun(run as never);

    expect(store.sanearCorridasHuerfanas()).toBe(3);

    for (const id of [corriendo.id, esperando.id, pausada.id]) {
      const run = store.getRun(id)!;
      expect(run.status).toBe("stopped");
      expect(run.stopReason).toContain("reinició");
      expect(run.endedAt).not.toBeNull();
    }
    expect(store.getRun(terminada.id)?.status).toBe("completed");
  });

  it("es idempotente: correrlo de nuevo no encuentra nada", () => {
    store.saveRun(corrida("running") as never);
    expect(store.sanearCorridasHuerfanas()).toBe(1);
    expect(store.sanearCorridasHuerfanas()).toBe(0);
  });
});
