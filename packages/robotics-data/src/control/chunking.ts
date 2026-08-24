/**
 * Action chunking: surviving the inference-rate gap.
 *
 * A VLA policy of the OpenVLA class produces roughly 2-5 predictions per
 * second. A manipulator's control loop wants 30-100 Hz. There is no way to
 * close that gap by making inference faster, so the policy emits a *chunk* of
 * actions per inference and the controller plays it back open loop while the
 * next inference runs.
 *
 * That trade has a hard limit which is easy to forget: everything inside a
 * chunk is executed blind. Making the chunk longer always fixes an underrun
 * and always makes the blind window longer. So feasibility here is a band, not
 * a floor — a chunk must be long enough to cover worst-case inference latency
 * *and* short enough to stay inside the open-loop safety horizon. When no
 * length satisfies both, the configuration is refused rather than attempted.
 */

export interface ChunkingConfig {
  /** Policy inference rate, Hz. */
  policyHz: number;
  /** Rate the controller consumes actions at, Hz. */
  controlHz: number;
  /** Actions returned per inference. */
  chunkLength: number;
  /** Worst-case latency beyond the nominal inference period, ms. */
  inferenceJitterMs?: number;
  /** Actions held in reserve so the buffer is refilled before it empties. */
  safetyMarginActions?: number;
  /** Longest stretch the arm may execute without a fresh observation, seconds. */
  maxOpenLoopHorizonSec?: number;
}

export interface ChunkPlan {
  feasible: boolean;
  policyHz: number;
  controlHz: number;
  chunkLength: number;
  /** Actions consumed during one nominal inference period. */
  actionsPerInference: number;
  /** Control ticks a single inference must be covered for, worst case. */
  latencyTicks: number;
  /** Shortest chunk that never underruns. */
  requiredChunkLength: number;
  /** Longest chunk still inside the open-loop safety horizon. */
  maxChunkLength: number;
  /** How long the configured chunk runs blind, seconds. */
  chunkHorizonSec: number;
  safetyMarginActions: number;
  maxOpenLoopHorizonSec: number;
  reasons: string[];
}

export class ChunkingInfeasibleError extends Error {
  readonly plan: ChunkPlan;

  constructor(plan: ChunkPlan) {
    super(
      `action chunking is infeasible for ${plan.policyHz}Hz inference driving a ` +
        `${plan.controlHz}Hz loop with a chunk of ${plan.chunkLength}:\n  - ` +
        plan.reasons.join("\n  - "),
    );
    this.name = "ChunkingInfeasibleError";
    this.plan = plan;
  }
}

const DEFAULTS = {
  inferenceJitterMs: 0,
  safetyMarginActions: 2,
  maxOpenLoopHorizonSec: 0.5,
};

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * Compute the chunk-length band and decide whether the configuration holds.
 *
 * Invalid input (zero, negative, NaN, a fractional chunk length) is refused
 * rather than coerced — the arithmetic here decides whether a robot moves
 * blind, and a silently-defaulted rate is how that goes wrong.
 */
export function planActionChunking(config: ChunkingConfig): ChunkPlan {
  const jitterMs = config.inferenceJitterMs ?? DEFAULTS.inferenceJitterMs;
  const safetyMarginActions = config.safetyMarginActions ?? DEFAULTS.safetyMarginActions;
  const maxOpenLoopHorizonSec = config.maxOpenLoopHorizonSec ?? DEFAULTS.maxOpenLoopHorizonSec;

  const invalid: string[] = [];
  if (!positive(config.policyHz)) invalid.push(`policyHz must be positive, got ${config.policyHz}`);
  if (!positive(config.controlHz)) invalid.push(`controlHz must be positive, got ${config.controlHz}`);
  if (!Number.isInteger(config.chunkLength) || config.chunkLength < 1) {
    invalid.push(`chunkLength must be a positive integer, got ${config.chunkLength}`);
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) invalid.push(`inferenceJitterMs must be >= 0`);
  if (!Number.isInteger(safetyMarginActions) || safetyMarginActions < 0) {
    invalid.push(`safetyMarginActions must be a non-negative integer`);
  }
  if (!positive(maxOpenLoopHorizonSec)) invalid.push(`maxOpenLoopHorizonSec must be positive`);

  if (invalid.length > 0) {
    return {
      feasible: false,
      policyHz: config.policyHz,
      controlHz: config.controlHz,
      chunkLength: config.chunkLength,
      actionsPerInference: Number.NaN,
      latencyTicks: Number.NaN,
      requiredChunkLength: Number.NaN,
      maxChunkLength: Number.NaN,
      chunkHorizonSec: Number.NaN,
      safetyMarginActions,
      maxOpenLoopHorizonSec,
      reasons: invalid,
    };
  }

  const actionsPerInference = config.controlHz / config.policyHz;
  // Worst case an inference takes its nominal period plus the jitter budget.
  const latencyTicks = Math.ceil(config.controlHz * (1 / config.policyHz + jitterMs / 1000));
  const requiredChunkLength = latencyTicks + safetyMarginActions;
  const maxChunkLength = Math.floor(config.controlHz * maxOpenLoopHorizonSec);
  const chunkHorizonSec = config.chunkLength / config.controlHz;

  const reasons: string[] = [];
  if (requiredChunkLength > maxChunkLength) {
    reasons.push(
      `no chunk length works: covering ${latencyTicks} tick(s) of inference latency needs ` +
        `${requiredChunkLength} actions, but the ${maxOpenLoopHorizonSec}s open-loop horizon ` +
        `allows at most ${maxChunkLength} at ${config.controlHz}Hz`,
    );
  }
  if (config.chunkLength < requiredChunkLength) {
    reasons.push(
      `chunk of ${config.chunkLength} underruns: ${config.controlHz}Hz control consumes ` +
        `${actionsPerInference} action(s) per ${config.policyHz}Hz inference, so at least ` +
        `${requiredChunkLength} are needed`,
    );
  }
  if (config.chunkLength > maxChunkLength) {
    reasons.push(
      `chunk of ${config.chunkLength} runs open loop for ${chunkHorizonSec.toFixed(3)}s, ` +
        `beyond the ${maxOpenLoopHorizonSec}s safety horizon`,
    );
  }

  const feasible = reasons.length === 0;
  if (feasible) {
    reasons.push(
      `chunk of ${config.chunkLength} covers ${latencyTicks} latency tick(s) with ` +
        `${config.chunkLength - latencyTicks} in reserve, blind for ${chunkHorizonSec.toFixed(3)}s`,
    );
  }

  return {
    feasible,
    policyHz: config.policyHz,
    controlHz: config.controlHz,
    chunkLength: config.chunkLength,
    actionsPerInference,
    latencyTicks,
    requiredChunkLength,
    maxChunkLength,
    chunkHorizonSec,
    safetyMarginActions,
    maxOpenLoopHorizonSec,
    reasons,
  };
}

export function assertChunkingFeasible(plan: ChunkPlan): void {
  if (!plan.feasible) throw new ChunkingInfeasibleError(plan);
}

/** One commanded joint-space setpoint. */
export interface Action {
  jointPositions: number[];
  gripper: number;
}

export interface PolicyRunner {
  readonly name: string;
  /** Returns up to `chunkLength` actions for the given observation. */
  infer(observation: Observation, chunkLength: number): Action[];
  /** Self-reported confidence, recorded but never trusted by the gate. */
  confidence(): number;
}

export interface Observation {
  tick: number;
  jointPositions: number[];
}

export interface ChunkedRunResult {
  ticks: number;
  inferences: number;
  /** Ticks where the buffer was empty and a hold was commanded instead. */
  underruns: number;
  aborted: boolean;
  abortReason: string | null;
  commanded: Action[];
}

export interface ChunkedRunOptions {
  plan: ChunkPlan;
  policy: PolicyRunner;
  initialJointPositions: number[];
  ticks: number;
  /** Consecutive-underrun budget before the run is aborted and held. */
  maxUnderruns?: number;
}

/**
 * Deterministic discrete-time replay of a chunked run.
 *
 * Refuses to start on an infeasible plan, and holds position rather than
 * extrapolating when the buffer empties anyway (a short chunk from the policy,
 * for instance). Extrapolating past the end of a chunk is how an arm keeps
 * moving after the thing steering it has stopped talking.
 */
export function runChunked(options: ChunkedRunOptions): ChunkedRunResult {
  assertChunkingFeasible(options.plan);
  const { plan, policy } = options;
  const maxUnderruns = options.maxUnderruns ?? 0;

  const buffer: Action[] = [];
  const commanded: Action[] = [];
  let pending: { readyAtTick: number } | null = null;
  let underruns = 0;
  let joints = [...options.initialJointPositions];
  let hold: Action = { jointPositions: [...joints], gripper: 0 };

  // The arm does not move until the first chunk has arrived. Priming here is
  // what makes tick 0 a commanded action rather than an underrun.
  buffer.push(...policy.infer({ tick: 0, jointPositions: joints }, plan.chunkLength));
  let inferences = 1;

  for (let tick = 0; tick < options.ticks; tick++) {
    if (pending && tick >= pending.readyAtTick) {
      buffer.push(...policy.infer({ tick, jointPositions: joints }, plan.chunkLength));
      pending = null;
    }
    // Refill while there is still a full latency window plus the reserve left
    // to run on — that threshold is exactly `requiredChunkLength`, which is
    // why a plan at the minimum feasible chunk length still never underruns.
    if (!pending && buffer.length <= plan.requiredChunkLength) {
      pending = { readyAtTick: tick + plan.latencyTicks };
      inferences += 1;
    }

    const next = buffer.shift();
    if (next === undefined) {
      underruns += 1;
      commanded.push({ jointPositions: [...hold.jointPositions], gripper: hold.gripper });
      if (underruns > maxUnderruns) {
        return {
          ticks: tick + 1,
          inferences,
          underruns,
          aborted: true,
          abortReason: `action buffer underran ${underruns} time(s), over the budget of ${maxUnderruns}`,
          commanded,
        };
      }
      continue;
    }
    joints = [...next.jointPositions];
    hold = { jointPositions: [...joints], gripper: next.gripper };
    commanded.push(next);
  }

  return {
    ticks: options.ticks,
    inferences,
    underruns,
    aborted: false,
    abortReason: null,
    commanded,
  };
}
