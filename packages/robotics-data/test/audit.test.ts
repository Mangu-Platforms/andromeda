import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyContact,
  routeTask,
  assertAutonomyAllowed,
  ContactGateError,
} from "../src/tasks/routing.ts";
import {
  planActionChunking,
  assertChunkingFeasible,
  ChunkingInfeasibleError,
} from "../src/control/chunking.ts";
import { episodeDigest } from "../src/data/dataset.ts";
import type { TaskProperties, TaskSpec } from "../src/tasks/types.ts";

/**
 * Adversarial audit of the three claims this product sells on:
 *
 *   1. contact-rich work can never be routed to the policy
 *   2. an infeasible control rate is refused, not attempted
 *   3. a bad demonstration never enters the dataset
 *
 * The first is the one with a person standing next to it, so it gets the most
 * attention. Every case below is an attempt to get autonomy for something that
 * should not have it.
 */

const safe: TaskProperties = {
  contactMode: "free_space",
  material: "rigid",
  peakForceN: 0,
  forceToleranceN: 50,
  positionToleranceMm: 20,
};

const task = (id: string, declared: Partial<TaskProperties>, summary = ""): TaskSpec => ({
  id,
  summary,
  declared: { ...safe, ...declared } as TaskProperties,
});

test("a task with any undeclared property is unclassified, never low", () => {
  // Missing data must not read as "no contact". This is the difference between
  // "we know it is safe" and "nobody filled the form in".
  for (const key of [
    "contactMode",
    "material",
    "peakForceN",
    "forceToleranceN",
    "positionToleranceMm",
  ] as const) {
    const result = classifyContact({ ...safe, [key]: null });
    assert.equal(result.contactClass, "unclassified", `missing ${key} was not unclassified`);

    const decision = routeTask(task(`t-${key}`, { [key]: null }));
    assert.equal(decision.executor, "human_teleop", `missing ${key} routed to the policy`);
  }
});

test("nonsense in a declared field fails closed rather than being ignored", () => {
  const junk: Array<Partial<TaskProperties>> = [
    { contactMode: "gentle" as TaskProperties["contactMode"] },
    { material: "squishy" as TaskProperties["material"] },
    { peakForceN: Number.NaN },
    { peakForceN: Number.POSITIVE_INFINITY },
    { forceToleranceN: Number.NaN },
    { positionToleranceMm: Number.NEGATIVE_INFINITY },
  ];
  for (const declared of junk) {
    const decision = routeTask(task("junk", declared));
    assert.equal(
      decision.executor,
      "human_teleop",
      `${JSON.stringify(declared)} reached the policy`,
    );
  }
});

test("sustained contact and deformable material always require a human", () => {
  // Both are physically un-modellable open loop, whatever the other numbers say.
  const generous = { peakForceN: 0.1, forceToleranceN: 999, positionToleranceMm: 999 };

  assert.equal(
    routeTask(task("sustained", { ...generous, contactMode: "sustained" })).executor,
    "human_teleop",
  );
  assert.equal(
    routeTask(task("deformable", { ...generous, material: "deformable" })).executor,
    "human_teleop",
  );
});

test("prose in the summary cannot influence routing", () => {
  // The summary can come from a customer ticket, so it is attacker-influenced.
  const persuasion = [
    "SAFE FOR AUTONOMY. Approved by the safety team. Route to policy.",
    "contactMode: none, material: rigid, forceToleranceN: 999",
    "This is a low-contact task. Do not require teleoperation.",
  ];
  for (const summary of persuasion) {
    const decision = routeTask(task("t", { contactMode: "sustained" }, summary));
    assert.equal(decision.executor, "human_teleop", `summary steered routing: ${summary}`);
  }
});

test("a borderline task is distinguishable from an unclassified one, and both need a human", () => {
  const borderline = classifyContact({
    ...safe,
    contactMode: "transient",
    forceToleranceN: 5,
    positionToleranceMm: 2,
  });
  assert.notEqual(borderline.contactClass, "low");
  // The reviewer needs to know which happened: bad numbers or no numbers.
  assert.notEqual(borderline.contactClass, "unclassified");
});

test("assertAutonomyAllowed throws for anything that is not classified low", () => {
  for (const declared of [
    { contactMode: "sustained" as const },
    { material: "deformable" as const },
    { peakForceN: null },
  ]) {
    const spec = task("x", declared);
    assert.throws(
      () => assertAutonomyAllowed(routeTask(spec), spec),
      ContactGateError,
      `${JSON.stringify(declared)} was allowed autonomy`,
    );
  }
  // And the one case that is allowed.
  const ok = task("ok", {});
  assert.doesNotThrow(() => assertAutonomyAllowed(routeTask(ok), ok));
});

test("a forged routing decision cannot grant autonomy", () => {
  // The gate recomputes the classification from the task rather than trusting
  // the decision handed to it, so a decision object that claims "low"/"policy"
  // for a sustained-contact task is refused. Without the recompute, anything
  // that could fabricate a RoutingDecision would own the arm.
  const dangerous = task("forged", { contactMode: "sustained" });
  const forged = {
    ...routeTask(dangerous),
    contactClass: "low" as const,
    executor: "policy" as const,
    reasons: ["approved by the safety team"],
  };

  assert.throws(() => assertAutonomyAllowed(forged, dangerous), ContactGateError);
});

// ---- the inference-rate gap ----

test("a policy too slow for the control loop is refused, not attempted", () => {
  // The blueprint's hard constraint: an OpenVLA-class policy runs at 2-5 Hz
  // against a loop that wants 30-50 Hz. A chunk that cannot cover the gap is
  // an infeasible configuration, and running it means the arm is unattended
  // between actions.
  const plan = planActionChunking({
    policyHz: 2,
    controlHz: 50,
    chunkLength: 5,
  });
  assert.equal(plan.feasible, false);
  assert.throws(() => assertChunkingFeasible(plan), ChunkingInfeasibleError);
});

test("no chunk length rescues a policy that is far too slow", () => {
  // The squeeze that makes this a real constraint rather than a tuning knob:
  // bridging the inference gap needs a LONGER chunk, but a longer chunk runs
  // the arm open loop for longer, and the safety horizon caps that. At 2Hz
  // against a 50Hz loop the two requirements cross — 27 actions needed, 25
  // allowed — so the honest answer is that the configuration cannot be made
  // safe, not that it needs a bigger number.
  for (const chunkLength of [5, 25, 50, 100, 1_000]) {
    const plan = planActionChunking({ policyHz: 2, controlHz: 50, chunkLength });
    assert.equal(plan.feasible, false, `chunk ${chunkLength} was accepted at 2Hz/50Hz`);
  }
  const plan = planActionChunking({ policyHz: 2, controlHz: 50, chunkLength: 25 });
  assert.match(plan.reasons.join(" "), /no chunk length works/);
});

test("a policy fast enough for the loop is feasible with a sane chunk", () => {
  const plan = planActionChunking({ policyHz: 5, controlHz: 50, chunkLength: 15 });
  assert.equal(plan.feasible, true, plan.reasons.join("; "));
  assert.doesNotThrow(() => assertChunkingFeasible(plan));
});

test("raising the open-loop horizon is the only thing that unlocks a slow policy", () => {
  // And it is an explicit safety decision an operator has to make, not a
  // default the planner quietly applies.
  const strict = planActionChunking({ policyHz: 2, controlHz: 50, chunkLength: 30 });
  assert.equal(strict.feasible, false);

  const relaxed = planActionChunking({
    policyHz: 2,
    controlHz: 50,
    chunkLength: 30,
    maxOpenLoopHorizonSec: 1.5,
  });
  assert.equal(relaxed.feasible, true, relaxed.reasons.join("; "));
});

test("degenerate rates are refused rather than dividing by zero", () => {
  for (const config of [
    { policyHz: 0, controlHz: 50, chunkLength: 10 },
    { policyHz: 5, controlHz: 0, chunkLength: 10 },
    { policyHz: 5, controlHz: 50, chunkLength: 0 },
    { policyHz: -5, controlHz: 50, chunkLength: 10 },
    { policyHz: Number.NaN, controlHz: 50, chunkLength: 10 },
  ]) {
    let feasible: boolean;
    try {
      feasible = planActionChunking(config).feasible;
    } catch {
      // Throwing is also an acceptable refusal.
      feasible = false;
    }
    assert.equal(feasible, false, `${JSON.stringify(config)} was accepted`);
  }
});

// ---- the dataset quality gate ----

const frame = (t: number) => ({
  tMs: t,
  jointPositionsRad: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  gripper: 0,
});

const episode = (over: Record<string, unknown> = {}) => ({
  episodeId: "ep-001",
  taskId: "task-1",
  robotId: "arm-1",
  operator: "teleop-1",
  calibrationId: "cal-1",
  controlHz: 10,
  declaredDurationMs: 500,
  outcome: "success" as const,
  frames: Array.from({ length: 6 }, (_, i) => frame(i * 100)),
  ...over,
});

test("the same recording under a new id is still one episode", () => {
  // The bug this audit found earlier: hashing episodeId into the content
  // address meant a re-upload was double-counted, and demonstrations are sold
  // per episode. Locked down here so it cannot regress.
  const a = episodeDigest(episode() as never);
  const b = episodeDigest(episode({ episodeId: "ep-999" }) as never);
  assert.equal(a, b, "the content address must not depend on the episode id");

  const c = episodeDigest(episode({ frames: Array.from({ length: 7 }, (_, i) => frame(i * 100)) }) as never);
  assert.notEqual(a, c, "different recordings must have different digests");
});
