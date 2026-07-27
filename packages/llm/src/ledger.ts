import type { ModelInfo, ProviderId } from "@orq/shared";
import type { TokenUsage } from "./types.js";

/**
 * Contabilidad de gasto.
 *
 * Es la última red de contención de la corrida: cada llamada al modelo se
 * valoriza con el precio real del catálogo y, al superar el presupuesto, el
 * motor corta. Configurá además un límite en el dashboard de tu proveedor —
 * esto protege contra un bucle del agente, no contra una key filtrada.
 */

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** `false` cuando el catálogo no publica precio: el costo se cuenta como 0. */
  priced: boolean;
}

export function computeCost(model: ModelInfo | undefined, usage: TokenUsage): CostBreakdown {
  const inputPrice = model?.inputPricePerMTok ?? null;
  const outputPrice = model?.outputPricePerMTok ?? null;

  if (inputPrice == null || outputPrice == null) {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0, priced: false };
  }

  const inputUsd = (usage.inputTokens / 1_000_000) * inputPrice;
  const outputUsd = (usage.outputTokens / 1_000_000) * outputPrice;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd, priced: true };
}

export interface LedgerRecord {
  roleId: string | null;
  providerId: ProviderId;
  modelSlug: string;
  tick: number;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  at: number;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Presupuesto agotado: se gastaron US$${spentUsd.toFixed(4)} de US$${budgetUsd.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Acumulador de gasto de una corrida. Vive en memoria mientras corre y se
 * persiste entrada por entrada; `spentUsd` es lo que muestra el dashboard.
 */
export class RunLedger {
  private entries: LedgerRecord[] = [];
  private spent = 0;

  constructor(
    readonly budgetUsd: number,
    private readonly onRecord?: (record: LedgerRecord) => void,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.spent);
  }

  /** `true` cuando ya no queda margen para otra llamada. */
  get exhausted(): boolean {
    return this.spent >= this.budgetUsd;
  }

  record(record: Omit<LedgerRecord, "at"> & { at?: number }): LedgerRecord {
    const entry: LedgerRecord = { ...record, at: record.at ?? Date.now() };
    this.entries.push(entry);
    this.spent += entry.costUsd;
    this.onRecord?.(entry);
    return entry;
  }

  /**
   * Se llama antes de cada turno. Lanza si el presupuesto ya se agotó, para
   * que el motor pare con un motivo claro en vez de seguir gastando.
   */
  assertWithinBudget(): void {
    if (this.exhausted) throw new BudgetExceededError(this.spent, this.budgetUsd);
  }

  /** Gasto agrupado por rol, para el Cost Dashboard. */
  byRole(): Map<string, { costUsd: number; calls: number }> {
    const totals = new Map<string, { costUsd: number; calls: number }>();
    for (const entry of this.entries) {
      const key = entry.roleId ?? "sistema";
      const current = totals.get(key) ?? { costUsd: 0, calls: 0 };
      current.costUsd += entry.costUsd;
      current.calls += 1;
      totals.set(key, current);
    }
    return totals;
  }

  /** Gasto agrupado por modelo, para ver qué tier se está comiendo el presupuesto. */
  byModel(): Map<string, { costUsd: number; calls: number }> {
    const totals = new Map<string, { costUsd: number; calls: number }>();
    for (const entry of this.entries) {
      const key = `${entry.providerId}/${entry.modelSlug}`;
      const current = totals.get(key) ?? { costUsd: 0, calls: 0 };
      current.costUsd += entry.costUsd;
      current.calls += 1;
      totals.set(key, current);
    }
    return totals;
  }

  all(): readonly LedgerRecord[] {
    return this.entries;
  }
}
