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
