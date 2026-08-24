import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChunkingInfeasibleError,
  assertChunkingFeasible,
  planActionChunking,
  runChunked,
  type Action,
  type PolicyRunner,
} from "../src/control/chunking.ts";

/** Emits `emit` actions per inference regardless of what the plan asked for. */
const policy = (emit: number, dof = 6): PolicyRunner => ({
  name: "stub-vla",
  infer: (observation, chunkLength) => {
    const count = Math.min(emit, chunkLength);
    const actions: Action[] = [];
    for (let i = 0; i < count; i++) {
      actions.push({
        jointPositions: Array.from({ length: dof }, () => observation.tick + i),
        gripper: 0,
      });
    }
    return actions;
  },
  confidence: () => 0.99,
});

test("a 2 Hz policy driving a 50 Hz loop with a chunk of 5 is refused", () => {
  const plan = planActionChunking({ policyHz: 2, controlHz: 50, chunkLength: 5 });

  assert.equal(plan.feasible, false);
  // 0.5s of inference latency is 25 control ticks; +2 reserve = 27 actions
  // needed, but a 0.5s open-loop horizon at 50Hz allows at most 25.
  assert.equal(plan.latencyTicks, 25);
  assert.equal(plan.requiredChunkLength, 27);
  assert.equal(plan.maxChunkLength, 25);
  assert.match(plan.reasons.join(" "), /no chunk length works/);
  assert.throws(() => assertChunkingFeasible(plan), ChunkingInfeasibleError);
  assert.throws(
    () =>
      runChunked({
        plan,
        policy: policy(5),
        initialJointPositions: [0, 0, 0, 0, 0, 0],
        ticks: 10,
      }),
    ChunkingInfeasibleError,
  );
});

test("the feasible band is bounded at both ends", () => {
  // 10Hz inference, 50Hz control: 5 latency ticks + 2 reserve = 7 minimum.
  const tooShort = planActionChunking({ policyHz: 10, controlHz: 50, chunkLength: 6 });
  assert.equal(tooShort.feasible, false);
  assert.match(tooShort.reasons.join(" "), /underruns/);

  const ok = planActionChunking({ policyHz: 10, controlHz: 50, chunkLength: 8 });
  assert.equal(ok.feasible, true);
  assert.equal(ok.requiredChunkLength, 7);
  assert.equal(ok.maxChunkLength, 25);

  // Long enough to never underrun, but 0.6s of blind motion.
  const tooBlind = planActionChunking({ policyHz: 10, controlHz: 50, chunkLength: 30 });
  assert.equal(tooBlind.feasible, false);
  assert.match(tooBlind.reasons.join(" "), /beyond the 0.5s safety horizon/);
});

test("jitter is charged against the chunk, not absorbed silently", () => {
  const nominal = planActionChunking({ policyHz: 10, controlHz: 50, chunkLength: 8 });
  assert.equal(nominal.feasible, true);

  // 100ms of worst-case jitter doubles the window the chunk must cover.
  const jittery = planActionChunking({
    policyHz: 10,
    controlHz: 50,
    chunkLength: 8,
    inferenceJitterMs: 100,
  });
  assert.equal(jittery.latencyTicks, 10);
  assert.equal(jittery.requiredChunkLength, 12);
  assert.equal(jittery.feasible, false);
});

test("invalid rates are refused rather than coerced to a default", () => {
  for (const config of [
    { policyHz: 0, controlHz: 50, chunkLength: 8 },
    { policyHz: 10, controlHz: Number.NaN, chunkLength: 8 },
    { policyHz: 10, controlHz: 50, chunkLength: 7.5 },
    { policyHz: 10, controlHz: 50, chunkLength: 0 },
    { policyHz: 10, controlHz: 50, chunkLength: 8, maxOpenLoopHorizonSec: 0 },
  ]) {
    const plan = planActionChunking(config);
    assert.equal(plan.feasible, false, JSON.stringify(config));
    assert.ok(plan.reasons.length > 0, JSON.stringify(config));
  }
});

test("a feasible plan replays without underrunning; a short chunk aborts into a hold", () => {
  const plan = planActionChunking({ policyHz: 10, controlHz: 50, chunkLength: 8 });
  const good = runChunked({
    plan,
    policy: policy(8),
    initialJointPositions: [0, 0, 0, 0, 0, 0],
    ticks: 200,
  });
  assert.equal(good.underruns, 0);
  assert.equal(good.aborted, false);
  assert.equal(good.commanded.length, 200);

  // A policy that returns fewer actions than the plan assumed must not lead to
  // extrapolation past the end of the chunk.
  const starved = runChunked({
    plan,
    policy: policy(3),
    initialJointPositions: [1, 1, 1, 1, 1, 1],
    ticks: 200,
  });
  assert.equal(starved.aborted, true);
  assert.ok(starved.underruns > 0);
  assert.match(starved.abortReason ?? "", /underran/);
  const held = starved.commanded.at(-1);
  assert.deepEqual(held?.jointPositions, starved.commanded.at(-2)?.jointPositions);
});
