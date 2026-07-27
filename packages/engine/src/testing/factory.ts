import { ids } from "@orq/shared";
import type { Company, Department, ModelSelection, Role, Run } from "@orq/shared";

/**
 * Constructores mínimos para armar empresas en los tests sin repetir veinte
 * campos por objeto.
 */

const model: ModelSelection = {
  providerId: "openai",
  modelSlug: "fake-model",
  tier: "cheap",
  temperature: null,
  maxOutputTokens: 1024,
};

export function makeCompany(overrides: Partial<Company> = {}): Company {
  const now = Date.now();
  return {
    id: ids.company(),
    name: "Empresa de prueba",
    mission: "Probar el motor",
    context: "",
    currency: "USD",
    budgetUsd: 10,
    defaultModel: model,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeDepartment(companyId: string, name: string): Department {
  return {
    id: ids.department(),
    companyId,
    name,
    purpose: "",
    parentId: null,
    position: { x: 0, y: 0 },
  };
}

export function makeRole(
  companyId: string,
  departmentId: string,
  name: string,
  overrides: Partial<Role> = {},
): Role {
  return {
    id: ids.role(),
    companyId,
    departmentId,
    name,
    title: name,
    systemPrompt: "",
    model,
    toolIds: [],
    authority: "executor",
    reportsTo: null,
    maxTurns: 4,
    spendApprovalThresholdUsd: null,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

export function makeRun(companyId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: ids.run(),
    companyId,
    objective: "Objetivo de prueba",
    status: "idle",
    mode: "manual",
    tick: 0,
    maxTicks: 10,
    budgetUsd: 10,
    spentUsd: 0,
    cronIntervalMs: 60_000,
    stopReason: null,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  };
}
