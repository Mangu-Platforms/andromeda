/** Errors that the substrate treats as control flow rather than crashes. */

/** Thrown when a workflow deliberately pauses to wait for a human decision. */
export class SuspendSignal extends Error {
  readonly step: string;
  readonly reason: string;
  readonly payload: unknown;

  constructor(step: string, reason: string, payload: unknown) {
    super(`workflow suspended at "${step}": ${reason}`);
    this.name = "SuspendSignal";
    this.step = step;
    this.reason = reason;
    this.payload = payload;
  }
}

/** Thrown when a run would exceed its spend ceiling. Never caught by agent loops. */
export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;

  constructor(spentUsd: number, limitUsd: number) {
    super(
      `budget exceeded: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)} limit`,
    );
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

/**
 * Thrown when starting a run would exceed the ceiling on spend across *all*
 * runs in the configured window — the org-level control, as distinct from
 * `BudgetExceededError`, which is one run hitting its own ceiling.
 */
export class GlobalBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly windowMs: number;

  constructor(spentUsd: number, limitUsd: number, windowMs: number) {
    super(
      `global budget exceeded: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(4)} ` +
        `spent across runs in the last ${(windowMs / 3_600_000).toFixed(0)}h; ` +
        `refusing to start new work`,
    );
    this.name = "GlobalBudgetExceededError";
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
    this.windowMs = windowMs;
  }
}

/** Thrown when model output fails to satisfy a schema after every repair attempt. */
export class SpecValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`spec validation failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "SpecValidationError";
    this.issues = issues;
  }
}

/** Thrown when a human rejects a proposed irreversible action. */
export class RejectedByHumanError extends Error {
  readonly note: string;

  constructor(note: string) {
    super(`action rejected by human reviewer: ${note || "(no note)"}`);
    this.name = "RejectedByHumanError";
    this.note = note;
  }
}
