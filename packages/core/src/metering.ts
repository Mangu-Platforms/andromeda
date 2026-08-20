import { BudgetExceededError } from "./errors.ts";
import type { LLMProvider, LLMRequest, LLMResult } from "./llm/types.ts";

export interface MeterEntry {
  purpose: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MeterSnapshot {
  spentUsd: number;
  limitUsd: number;
  calls: number;
  byModel: Record<string, number>;
  byPurpose: Record<string, number>;
}

/**
 * Per-run spend ceiling.
 *
 * Cost is only knowable after a completion returns, so the ceiling is enforced
 * on the call *following* the one that crossed it: `record` throws once the
 * running total exceeds the limit, which aborts the surrounding agent loop.
 * A single call can therefore overshoot by at most one completion — bound that
 * with `maxTokens`, not with the meter.
 */
export class CostMeter {
  readonly limitUsd: number;
  readonly entries: MeterEntry[] = [];
  #spentUsd = 0;

  constructor(limitUsd: number, initialSpentUsd = 0) {
    if (!(limitUsd > 0)) throw new Error("cost limit must be positive");
    this.limitUsd = limitUsd;
    this.#spentUsd = initialSpentUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.#spentUsd);
  }

  /** Throws `BudgetExceededError` once the accumulated total passes the limit. */
  record(entry: MeterEntry): void {
    this.entries.push(entry);
    this.#spentUsd += entry.costUsd;
    if (this.#spentUsd > this.limitUsd) {
      throw new BudgetExceededError(this.#spentUsd, this.limitUsd);
    }
  }

  /** Refuse to start work that cannot possibly fit in what is left. */
  assertHeadroom(estimatedUsd: number): void {
    if (this.#spentUsd + estimatedUsd > this.limitUsd) {
      throw new BudgetExceededError(this.#spentUsd + estimatedUsd, this.limitUsd);
    }
  }

  snapshot(): MeterSnapshot {
    const byModel: Record<string, number> = {};
    const byPurpose: Record<string, number> = {};
    for (const e of this.entries) {
      byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
      byPurpose[e.purpose] = (byPurpose[e.purpose] ?? 0) + e.costUsd;
    }
    return {
      spentUsd: this.#spentUsd,
      limitUsd: this.limitUsd,
      calls: this.entries.length,
      byModel,
      byPurpose,
    };
  }
}

/**
 * Wraps any provider so that every completion is metered. Products should only
 * ever hold a metered provider — an unwrapped one is an unbounded bill.
 */
export class MeteredProvider implements LLMProvider {
  readonly name: string;
  readonly #inner: LLMProvider;
  readonly #meter: CostMeter;
  readonly #onCall: ((req: LLMRequest, result: LLMResult) => void) | undefined;

  constructor(
    inner: LLMProvider,
    meter: CostMeter,
    onCall?: (req: LLMRequest, result: LLMResult) => void,
  ) {
    this.#inner = inner;
    this.#meter = meter;
    this.#onCall = onCall;
    this.name = `metered(${inner.name})`;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const result = await this.#inner.complete(req);
    this.#onCall?.(req, result);
    this.#meter.record({
      purpose: req.purpose,
      model: result.model,
      costUsd: result.costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
    return result;
  }
}
