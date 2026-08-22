/** What the run is trying to establish, fixed before any code is written. */
export interface ExperimentPlan {
  id: string;
  objective: string;
  metricName: string;
  /**
   * A seed counts as a success when its metric is >= this value.
   *
   * Pre-committed by the caller, never by the model, so a failing experiment
   * cannot be turned into a passing one by moving the bar.
   */
  threshold: number;
}

export interface SeedRun {
  seed: number;
  /** The trial ran and reported a finite metric. */
  ok: boolean;
  metric: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Exit code, timeout, or parse failure — whatever the reviewer needs. */
  note: string;
}

export interface ExperimentIteration {
  iteration: number;
  /** True when the static guard refused the code, so it never ran. */
  guardRejected: boolean;
  note: string;
  seedRuns: SeedRun[];
  successSeeds: number[];
}

export type ExperimentStop =
  | "reproducible"
  | "iteration_budget"
  | "wall_clock"
  | "no_admissible_code";

export interface ExperimentOutcome {
  experimentId: string;
  objective: string;
  metricName: string;
  threshold: number;
  seeds: number[];
  iterationsUsed: number;
  maxIterations: number;
  /** At least one seed met the threshold on the final iteration. */
  converged: boolean;
  /** Every seed met the threshold. Anything less is not a result. */
  reproducible: boolean;
  stoppedBecause: ExperimentStop;
  metricBySeed: Record<string, number | null>;
  iterations: ExperimentIteration[];
  /** The final admitted trial source, kept so a reviewer can read it. */
  code: string;
}
