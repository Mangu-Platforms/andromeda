import type { ChangeProposal } from "../change/proposal.ts";

export interface CiStepSpec {
  name: string;
  /** Executable, run without a shell. Nothing here is interpolated. */
  command: string;
  args: string[];
}

export interface CiStepResult {
  name: string;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  /** Captured and truncated output, for the reviewer and the audit log. */
  output: string;
  durationMs: number;
}

export interface CiReport {
  runner: string;
  branch: string;
  green: boolean;
  steps: CiStepResult[];
  /** Populated when the run could not be completed at all. */
  error: string | null;
}

export interface CiRunInput {
  branch: string;
  proposal: ChangeProposal;
}

/**
 * The test gate.
 *
 * An interface so the gate can be a scripted fake in tests and a real process
 * runner in production, and so nothing in the pipeline can reach around it: a
 * proposal is only ever put in front of a human after a `CiReport` comes back
 * green. Asking someone to review a change whose tests are red is how approval
 * turns into a rubber stamp.
 */
export interface CiRunner {
  readonly name: string;
  run(input: CiRunInput): Promise<CiReport>;
}

/**
 * Single definition of "green", shared by every runner.
 *
 * A run with no steps is *not* green. An empty pipeline produces no evidence,
 * and no evidence must never read as a pass — that is the failure mode where a
 * misconfigured CI config silently unlocks the auto-merge lane.
 */
export function summarize(
  runner: string,
  branch: string,
  steps: CiStepResult[],
  error: string | null = null,
): CiReport {
  const green = error === null && steps.length > 0 && steps.every((s) => s.passed);
  return { runner, branch, green, steps, error };
}
