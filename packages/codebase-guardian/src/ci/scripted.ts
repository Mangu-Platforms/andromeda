import type { CiReport, CiRunInput, CiRunner, CiStepResult } from "./types.ts";
import { summarize } from "./types.ts";

const step = (name: string, passed: boolean, output = ""): CiStepResult => ({
  name,
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  output,
  durationMs: 1,
});

export const DEFAULT_STEP_NAMES = ["lint", "typecheck", "test"];

/** A report where every configured step passed. */
export function greenSteps(names: string[] = DEFAULT_STEP_NAMES): CiStepResult[] {
  return names.map((name) => step(name, true, `${name}: ok`));
}

/** A report that fails at `failing`, with earlier steps green. */
export function redSteps(
  failing: string,
  output = "1 test failed",
  names: string[] = DEFAULT_STEP_NAMES,
): CiStepResult[] {
  const results: CiStepResult[] = [];
  for (const name of names) {
    if (name === failing) {
      results.push(step(name, false, output));
      break;
    }
    results.push(step(name, true, `${name}: ok`));
  }
  return results;
}

/**
 * Scripted fake CI. Replays a queue of outcomes, holding the last one once the
 * queue is drained, and records every input for assertions.
 */
export class ScriptedCiRunner implements CiRunner {
  readonly name = "scripted";
  readonly inputs: CiRunInput[] = [];
  readonly #script: CiStepResult[][];
  #calls = 0;

  constructor(script: CiStepResult[][] = [greenSteps()]) {
    if (script.length === 0) throw new Error("a scripted CI runner needs at least one entry");
    this.#script = script;
  }

  async run(input: CiRunInput): Promise<CiReport> {
    this.inputs.push(input);
    const index = Math.min(this.#calls, this.#script.length - 1);
    this.#calls += 1;
    return summarize(this.name, input.branch, this.#script[index] ?? []);
  }
}
