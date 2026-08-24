import { test } from "node:test";
import assert from "node:assert/strict";
import type { Clock } from "@andromeda/core";
import { MockLLMProvider } from "@andromeda/core";

import { UnsafeExperimentError, assertSafeExperimentSource, checkExperimentSource } from "../src/experiment/guard.ts";
import { runBoundedExperiment, parseMetric } from "../src/experiment/runner.ts";
import { LocalSandbox } from "../src/sandbox/local.ts";
import type { ExecOptions, ExecResult, Sandbox, SandboxFile } from "../src/sandbox/types.ts";
import type { ExperimentPlan } from "../src/experiment/types.ts";

/** A pure seeded trial: the only shape the guard admits. */
const PURE_TRIAL = `export function runTrial(seed: number): number {
  let state = (seed * 2654435761) >>> 0;
  let total = 0;
  for (let i = 0; i < 128; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    total += state / 4294967296;
  }
  return 0.90 + (total / 128) * 0.05;
}
`;

/** Same shape, but never clears the threshold. Used to prove termination. */
const HOPELESS_TRIAL = `export function runTrial(seed: number): number {
  let state = (seed * 40503) >>> 0;
  state = (state * 1664525 + 1013904223) >>> 0;
  return 0.10 + (state / 4294967296) * 0.05;
}
`;

/** Clears the bar on one seed only — a lucky draw, not a finding. */
const LUCKY_SEED_TRIAL = `export function runTrial(seed: number): number {
  return seed === 11 ? 0.97 : 0.11;
}
`;

const plan = (overrides: Partial<ExperimentPlan> = {}): ExperimentPlan => ({
  id: "exp-consolidation",
  objective: "Estimate the recovery rate of a simulated consolidation model.",
  metricName: "recovery",
  threshold: 0.5,
  ...overrides,
});

/** Records what the runner asked of the sandbox without executing anything. */
class StubSandbox implements Sandbox {
  readonly root = "/stub";
  writes = 0;
  execs = 0;

  async writeFiles(_files: SandboxFile[]): Promise<void> {
    this.writes++;
  }
  async readFile(_path: string): Promise<string> {
    return "";
  }
  async exists(_path: string): Promise<boolean> {
    return false;
  }
  async exec(_command: string, _args: string[], _options?: ExecOptions): Promise<ExecResult> {
    this.execs++;
    return { code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 };
  }
  async dispose(): Promise<void> {}
}

/** Advances a fixed amount per reading, so a deadline can be crossed on demand. */
class SteppingClock implements Clock {
  #t: number;
  readonly #step: number;
  constructor(startMs: number, stepMs: number) {
    this.#t = startMs;
    this.#step = stepMs;
  }
  now(): number {
    const value = this.#t;
    this.#t += this.#step;
    return value;
  }
}

test("the guard admits a pure seeded trial and refuses everything else", () => {
  assert.deepEqual(checkExperimentSource(PURE_TRIAL), []);
  assert.doesNotThrow(() => assertSafeExperimentSource("exp", PURE_TRIAL));

  const hostile: Array<[string, RegExp]> = [
    [`import { readFileSync } from "node:fs";\n${PURE_TRIAL}`, /may not import anything/],
    [`const { spawn } = await import("node:child_process");\n${PURE_TRIAL}`, /may not import anything/],
    [PURE_TRIAL.replace("let state", "let state = 0;\n  if (typeof globalThis === 'object') state"), /global access is not allowed/],
    [`export function runTrial(seed: number): number { return Math.random() + seed; }`, /must be seeded/],
    [`export function runTrial(seed: number): number { return Date.now() % seed; }`, /may not read the clock/],
    [`export function runTrial(seed: number): number { return eval("1") + seed; }`, /eval\(\) is not allowed/],
    [`export function runTrial(seed: number): number { return new Function("return 1")() + seed; }`, /Function constructor/],
    [`export function runTrial(seed: number): number { await fetch("http://x"); return seed; }`, /may not use the network/],
    [`export function score(seed: number): number { return seed; }`, /must export a function named "runTrial"/],
  ];

  for (const [source, expected] of hostile) {
    const reasons = checkExperimentSource(source);
    assert.ok(reasons.length > 0, `expected a rejection for:\n${source}`);
    assert.match(reasons.join("\n"), expected);
  }

  assert.throws(
    () => assertSafeExperimentSource("exp-1", `import x from "node:os";\n${PURE_TRIAL}`),
    (err: unknown) =>
      err instanceof UnsafeExperimentError &&
      err.reasons.length > 0 &&
      err.message.includes('experiment code for "exp-1" was rejected'),
  );
});

test("an experiment that never converges terminates at its iteration budget", async () => {
  const sandbox = await LocalSandbox.create();
  try {
    const llm = new MockLLMProvider({
      handlers: { "experiment.write": [HOPELESS_TRIAL], "experiment.revise": [HOPELESS_TRIAL] },
    });
    const outcome = await runBoundedExperiment({
      llm,
      plan: plan(),
      sandbox,
      maxIterations: 3,
      seeds: [11, 23],
      trialTimeoutMs: 20_000,
    });

    // The loop is a counter, not a "keep going until it works" agent loop.
    assert.equal(outcome.iterationsUsed, 3);
    assert.equal(outcome.maxIterations, 3);
    assert.equal(outcome.stoppedBecause, "iteration_budget");
    assert.equal(outcome.converged, false);
    assert.equal(outcome.reproducible, false);
    assert.equal(llm.callCount("experiment.write") + llm.callCount("experiment.revise"), 3);
    // It really ran: every seed reported a finite metric, all below the bar.
    for (const seed of outcome.seeds) {
      const metric = outcome.metricBySeed[String(seed)];
      assert.ok(typeof metric === "number" && metric < 0.5, `seed ${seed} -> ${String(metric)}`);
    }
  } finally {
    await sandbox.dispose();
  }
});

test("a result that holds on one seed only is reported as not reproducible", async () => {
  const sandbox = await LocalSandbox.create();
  try {
    const llm = new MockLLMProvider({
      handlers: { "experiment.write": [LUCKY_SEED_TRIAL], "experiment.revise": [LUCKY_SEED_TRIAL] },
    });
    const outcome = await runBoundedExperiment({
      llm,
      plan: plan(),
      sandbox,
      maxIterations: 2,
      seeds: [11, 23, 47],
      trialTimeoutMs: 20_000,
    });

    assert.equal(outcome.converged, true);
    assert.equal(outcome.reproducible, false, "one seed out of three is not a result");
    assert.equal(outcome.stoppedBecause, "iteration_budget");
    assert.deepEqual(outcome.iterations.at(-1)?.successSeeds, [11]);
    assert.equal(outcome.metricBySeed["11"], 0.97);
    assert.equal(outcome.metricBySeed["23"], 0.11);

    // The runner refuses to be configured into a single-seed experiment at all.
    await assert.rejects(
      runBoundedExperiment({ llm, plan: plan(), sandbox, seeds: [11] }),
      /at least two distinct integer seeds/,
    );
  } finally {
    await sandbox.dispose();
  }
});

test("the wall-clock deadline stops a run well inside its iteration budget", async () => {
  const sandbox = new StubSandbox();
  const llm = new MockLLMProvider({
    handlers: { "experiment.write": [PURE_TRIAL], "experiment.revise": [PURE_TRIAL] },
  });

  const outcome = await runBoundedExperiment({
    llm,
    plan: plan(),
    sandbox,
    maxIterations: 20,
    seeds: [11, 23, 47],
    wallClockMs: 60_000,
    clock: new SteppingClock(1_000_000, 50_000),
  });

  assert.equal(outcome.stoppedBecause, "wall_clock");
  assert.equal(outcome.iterationsUsed, 1);
  assert.equal(outcome.maxIterations, 20);
  assert.equal(outcome.reproducible, false);
  // The deadline is checked before each seed too, so nothing was executed.
  assert.equal(sandbox.execs, 0);
  assert.equal(llm.callCount("experiment.write"), 1);
});

test("code that never passes the guard is never written to the sandbox", async () => {
  const sandbox = new StubSandbox();
  const llm = new MockLLMProvider({
    handlers: {
      "experiment.write": [`import fs from "node:fs";\n${PURE_TRIAL}`],
      "experiment.revise": [`export function runTrial(seed: number): number { return Math.random(); }`],
    },
  });

  const outcome = await runBoundedExperiment({
    llm,
    plan: plan(),
    sandbox,
    maxIterations: 3,
    seeds: [11, 23],
  });

  assert.equal(outcome.stoppedBecause, "no_admissible_code");
  assert.equal(outcome.iterationsUsed, 3, "a rejected proposal still spends an iteration");
  assert.ok(outcome.iterations.every((i) => i.guardRejected));
  assert.equal(outcome.code, "");
  assert.equal(sandbox.writes, 0);
  assert.equal(sandbox.execs, 0);
  assert.equal(outcome.reproducible, false);

  // A trial cannot report its own result: only the harness's marker line counts.
  assert.equal(parseMetric("recovery = 0.99\nfinal score: 0.99"), null);
  assert.equal(parseMetric('ANDROMEDA_TRIAL_RESULT {"seed":11,"metric":0.42}'), 0.42);
});
