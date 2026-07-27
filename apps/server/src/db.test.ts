import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ids } from "@orq/shared";
import type { AgentRequest, Role } from "@orq/shared";
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
