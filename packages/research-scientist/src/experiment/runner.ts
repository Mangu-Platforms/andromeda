import type { AuditLog, Clock, LLMProvider } from "@andromeda/core";
import { systemClock } from "@andromeda/core";
import type { Sandbox } from "../sandbox/types.ts";
import { assertSafeExperimentSource, UnsafeExperimentError } from "./guard.ts";
import type {
  ExperimentIteration,
  ExperimentOutcome,
  ExperimentPlan,
  ExperimentStop,
  SeedRun,
} from "./types.ts";

export const DEFAULT_SEEDS = [11, 23, 47];
export const DEFAULT_MAX_ITERATIONS = 4;
export const DEFAULT_WALL_CLOCK_MS = 120_000;
export const DEFAULT_TRIAL_TIMEOUT_MS = 10_000;

const RESULT_PREFIX = "ANDROMEDA_TRIAL_RESULT ";

/**
 * The harness. Hand-written, written fresh every iteration, never generated.
 *
 * The model only ever supplies `runTrial`; argv parsing, the finite-number
 * check, the result marker and the exit codes live here, because a trial that
 * could write its own reporting could report anything.
 */
const HARNESS = `import { runTrial } from "./trial.ts";

const seed = Number(process.argv[2]);
if (!Number.isInteger(seed)) {
  console.error("harness: expected an integer seed argument");
  process.exit(2);
}
const metric = runTrial(seed);
if (typeof metric !== "number" || !Number.isFinite(metric)) {
  console.error("harness: runTrial must return a finite number, got " + String(metric));
  process.exit(3);
}
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ seed, metric }));
`;

export interface RunExperimentOptions {
  llm: LLMProvider;
  plan: ExperimentPlan;
  sandbox: Sandbox;
  /** Context handed to the model: the question and the verified claims so far. */
  background?: string;
  audit?: AuditLog;
  /** Hard ceiling on propose-run-revise cycles. Enforced by a counter. */
  maxIterations?: number;
  /** Seeds every iteration is evaluated on. More than one, always. */
  seeds?: number[];
  /** Ceiling on total wall time across all iterations and all seeds. */
  wallClockMs?: number;
  /** Ceiling on a single trial process. */
  trialTimeoutMs?: number;
  /** Injected so tests can drive the deadline deterministically. */
  clock?: Clock;
}

const SYSTEM = `You write one self-contained numerical experiment as a TypeScript module.

Output requirements:
- Emit a single TypeScript file and nothing else. No prose, no markdown fences.
- Export exactly one function: export function runTrial(seed: number): number
- Import nothing. No node builtins, no packages.
- Do not use Math.random(), Date, process, fetch, eval, or the Function constructor.
  Derive all randomness from the seed with an explicit generator you write out.
- Return the metric as a plain number. Higher is better.

The same code is run once per seed and only counts as a result if every seed clears
the threshold. Do not special-case a seed.`;

/**
 * Run one experiment inside three hard bounds: an iteration counter, a
 * wall-clock deadline, and a multi-seed reproducibility rule.
 *
 * The bounds are the containment, and they are unconditional. The loop is a
 * plain `for` over a counter rather than a "keep going until it works" agent
 * loop, so a non-converging experiment terminates by construction instead of
 * spinning; the deadline is checked before every model call and before every
 * trial, so a slow experiment stops even inside its iteration budget; and a
 * result is only a result when every seed clears the pre-committed threshold,
 * so an experiment that happens to work on one seed is reported as not
 * reproducible rather than as a finding.
 *
 * Nothing here throws on failure. A failed experiment is evidence a reviewer
 * needs to see, not an exception that loses it.
 */
export async function runBoundedExperiment(
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const { llm, plan, sandbox, audit } = options;
  const clock = options.clock ?? systemClock;
  const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const seeds = normalizeSeeds(options.seeds ?? DEFAULT_SEEDS);
  const trialTimeoutMs = options.trialTimeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS;
  const deadline = clock.now() + (options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);

  const iterations: ExperimentIteration[] = [];
  let stoppedBecause: ExperimentStop = "iteration_budget";
  let feedback = "";
  let code = "";
  let admitted = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (clock.now() >= deadline) {
      stoppedBecause = "wall_clock";
      break;
    }

    const reply = await llm.complete({
      purpose: iteration === 1 ? "experiment.write" : "experiment.revise",
      tier: "frontier",
      effort: "high",
      system: SYSTEM,
      cacheSystem: true,
      prompt: trialPrompt(plan, seeds, options.background ?? "", feedback),
    });
    const candidate = normalizeSource(extractCode(reply.text));

    try {
      assertSafeExperimentSource(plan.id, candidate);
    } catch (err) {
      if (!(err instanceof UnsafeExperimentError)) throw err;
      // Rejected code is a spent iteration, not a crash: the budget still
      // shrinks, so a model that keeps producing inadmissible code stops.
      feedback = err.message;
      iterations.push({
        iteration,
        guardRejected: true,
        note: err.message,
        seedRuns: [],
        successSeeds: [],
      });
      await audit?.record("step.failed", `guard rejected experiment ${plan.id} iteration ${iteration}`, {
        experiment: plan.id,
        iteration,
        reasons: err.reasons,
      });
      continue;
    }

    code = candidate;
    admitted = true;
    await sandbox.writeFiles([
      { path: "trial.ts", contents: code },
      // Rewritten every iteration so an earlier run cannot have left a
      // weakened harness behind.
      { path: "harness.ts", contents: HARNESS },
    ]);

    const seedRuns: SeedRun[] = [];
    let ranOutOfTime = false;
    for (const seed of seeds) {
      if (clock.now() >= deadline) {
        ranOutOfTime = true;
        break;
      }
      seedRuns.push(await runSeed(sandbox, seed, trialTimeoutMs));
    }

    const successSeeds = seedRuns
      .filter((r) => r.ok && r.metric !== null && r.metric >= plan.threshold)
      .map((r) => r.seed);

    iterations.push({
      iteration,
      guardRejected: false,
      note: summarize(plan, seedRuns, successSeeds, seeds.length),
      seedRuns,
      successSeeds,
    });
    await audit?.record("sandbox.exec", `experiment ${plan.id} iteration ${iteration}`, {
      experiment: plan.id,
      iteration,
      successSeeds,
      seeds,
    });

    if (ranOutOfTime) {
      stoppedBecause = "wall_clock";
      break;
    }
    if (successSeeds.length === seeds.length && seeds.length > 0) {
      stoppedBecause = "reproducible";
      break;
    }
    feedback = iterations[iterations.length - 1]?.note ?? "";
  }

  if (!admitted && iterations.every((i) => i.guardRejected)) {
    stoppedBecause = "no_admissible_code";
  }

  const last = [...iterations].reverse().find((i) => !i.guardRejected);
  const metricBySeed: Record<string, number | null> = {};
  for (const seed of seeds) {
    metricBySeed[String(seed)] = last?.seedRuns.find((r) => r.seed === seed)?.metric ?? null;
  }

  const successCount = last?.successSeeds.length ?? 0;
  return {
    experimentId: plan.id,
    objective: plan.objective,
    metricName: plan.metricName,
    threshold: plan.threshold,
    seeds,
    iterationsUsed: iterations.length,
    maxIterations,
    converged: successCount > 0,
    // The whole point of the multi-seed rule: partial success is not success.
    reproducible: seeds.length > 0 && successCount === seeds.length,
    stoppedBecause,
    metricBySeed,
    iterations,
    code,
  };
}

async function runSeed(sandbox: Sandbox, seed: number, timeoutMs: number): Promise<SeedRun> {
  const run = await sandbox.exec("node", ["harness.ts", String(seed)], { timeoutMs });
  if (run.timedOut) {
    return {
      seed,
      ok: false,
      metric: null,
      timedOut: true,
      durationMs: run.durationMs,
      note: `killed after ${run.durationMs}ms; the trial exceeded its ${timeoutMs}ms limit`,
    };
  }
  if (run.code !== 0) {
    return {
      seed,
      ok: false,
      metric: null,
      timedOut: false,
      durationMs: run.durationMs,
      note: `exited ${run.code}: ${firstLine(run.stderr) || firstLine(run.stdout) || "(no output)"}`,
    };
  }
  const metric = parseMetric(run.stdout);
  if (metric === null) {
    return {
      seed,
      ok: false,
      metric: null,
      timedOut: false,
      durationMs: run.durationMs,
      note: "the trial exited 0 but printed no parseable result line",
    };
  }
  return { seed, ok: true, metric, timedOut: false, durationMs: run.durationMs, note: "ok" };
}

/**
 * Read the metric off the harness's marker line only.
 *
 * Scanning the whole of stdout for a number would let a trial's own logging
 * decide the result. The last marker line wins, so a trial that prints several
 * cannot pick which one is read by ordering them cleverly.
 */
export function parseMetric(stdout: string): number | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(RESULT_PREFIX));
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(last.slice(RESULT_PREFIX.length)) as { metric?: unknown };
    return typeof parsed.metric === "number" && Number.isFinite(parsed.metric)
      ? parsed.metric
      : null;
  } catch {
    return null;
  }
}

const normalizeSeeds = (seeds: number[]): number[] => {
  const unique = [...new Set(seeds.filter((s) => Number.isInteger(s)))].sort((a, b) => a - b);
  if (unique.length < 2) {
    // A single-seed experiment cannot distinguish a result from a lucky draw,
    // so the runner refuses to be configured into one.
    throw new Error("an experiment needs at least two distinct integer seeds");
  }
  return unique;
};

function summarize(
  plan: ExperimentPlan,
  seedRuns: SeedRun[],
  successSeeds: number[],
  seedCount: number,
): string {
  const detail = seedRuns
    .map((r) => `seed ${r.seed}: ${r.ok ? `${plan.metricName}=${r.metric}` : r.note}`)
    .join("; ");
  return `${successSeeds.length}/${seedCount} seeds reached ${plan.metricName} >= ${plan.threshold}. ${detail}`;
}

function trialPrompt(
  plan: ExperimentPlan,
  seeds: number[],
  background: string,
  feedback: string,
): string {
  const base = `Experiment id: ${plan.id}
Objective: ${plan.objective}
Metric: ${plan.metricName} (higher is better)
Success threshold: ${plan.metricName} >= ${plan.threshold}, on every one of the seeds ${seeds.join(", ")}.
${background ? `\nBackground from the verified literature review:\n${background}\n` : ""}
Write trial.ts.`;

  if (!feedback) return base;
  return `${base}

Your previous attempt did not succeed:
\`\`\`
${feedback.slice(0, 4_000)}
\`\`\`

Revise it.`;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

const normalizeSource = (source: string): string =>
  source.endsWith("\n") ? source : `${source}\n`;

/** Models wrap code in fences even when told not to; take the largest block. */
export function extractCode(text: string): string {
  const fenced = [...text.matchAll(/```(?:[\w-]*)\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  if (fenced.length === 0) return text.trim();
  return (fenced.sort((a, b) => b.length - a.length)[0] ?? "").trim();
}
