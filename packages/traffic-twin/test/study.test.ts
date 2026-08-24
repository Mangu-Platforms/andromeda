import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ApprovalGate,
  FixedClock,
  MemoryStore,
  SeededIds,
  WorkflowRunner,
  type RunRecord,
} from "@andromeda/core";

import { DEFAULT_SAFETY_POLICY } from "../src/safety/policy.ts";
import { validatePlan } from "../src/safety/validate.ts";
import { deriveConflictMatrix, conflicts, destinationLeg } from "../src/safety/conflicts.ts";
import { simulate } from "../src/sim/mesoscopic.ts";
import { evaluate } from "../src/evaluate.ts";
import {
  assertExportable,
  createTrafficStudy,
  ADVISORY_NOTICE,
  type SignalTimingRecommendation,
  type StudyResult,
} from "../src/pipeline.ts";
import type { SignalPlan } from "../src/network/types.ts";
import { sampleIntersection, baselinePlan, sampleDemand, clone } from "./fixtures.ts";

const intersection = sampleIntersection();
const demand = sampleDemand();
const policy = DEFAULT_SAFETY_POLICY;

/**
 * A shorter cycle that keeps every movement under capacity.
 *
 * The north-south throughs run at v/c well under 0.5 on this demand, so the
 * slack in their phase is pure delay for everyone else. Trimming it shortens
 * the cycle from 83s to 75s without pushing anything toward saturation — which
 * is the ordinary retiming win an agency is actually buying.
 */
function improvedPlan(): SignalPlan {
  const plan = baselinePlan();
  plan.label = "shorter cycle AM";
  (plan.phases[1] as SignalPlan["phases"][number]).greenS = 22;
  plan.cycleLengthS =
    plan.phases.reduce((s, p) => s + p.greenS + p.yellowS + p.allRedS, 0);
  return plan;
}

/** Safe, but a longer cycle than the baseline: more delay, no benefit. */
function worsePlan(): SignalPlan {
  const plan = baselinePlan();
  plan.label = "longer cycle, no benefit";
  (plan.phases[1] as SignalPlan["phases"][number]).greenS = 40;
  (plan.phases[2] as SignalPlan["phases"][number]).greenS = 33;
  plan.cycleLengthS =
    plan.phases.reduce((s, p) => s + p.greenS + p.yellowS + p.allRedS, 0);
  return plan;
}

// ---- the advisory-only boundary ----

test("no code path exists from a study to an actuation command", () => {
  // The structural claim, checked structurally: if a controller client is ever
  // added, this test is what fails.
  const sources = [
    "src/pipeline.ts",
    "src/evaluate.ts",
    "src/sim/mesoscopic.ts",
    "src/network/types.ts",
    "src/index.ts",
  ].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

  const forbidden = [
    /\bfetch\s*\(/,
    /node:net\b/,
    /node:http\b/,
    /node:dgram\b/,
    /\bntcip\b/i,
    /\bactuate\b/i,
    /\bsendToController\b/i,
    /\bwriteTiming\b/i,
  ];
  for (const source of sources) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `found ${pattern} on the advisory path`);
    }
  }
});

test("an unapproved recommendation cannot be exported", () => {
  const draft = {
    advisory: true as const,
    approvedBy: null,
    safety: { ok: true },
  } as unknown as SignalTimingRecommendation;
  assert.throws(() => assertExportable(draft), /not approved by a named traffic engineer/);

  const unsafe = {
    advisory: true as const,
    approvedBy: "engineer@city.gov",
    safety: { ok: false },
  } as unknown as SignalTimingRecommendation;
  assert.throws(() => assertExportable(unsafe), /failed its own safety validation/);

  const notAdvisory = {
    advisory: false,
    approvedBy: "engineer@city.gov",
    safety: { ok: true },
  } as unknown as SignalTimingRecommendation;
  assert.throws(() => assertExportable(notAdvisory), /must be marked advisory/);
});

// ---- safety envelope ----

test("the baseline plan satisfies the default envelope", () => {
  const report = validatePlan({ intersection, plan: baselinePlan(), policy });
  assert.equal(report.ok, true, report.violations.map((v) => v.message).join("; "));
});

test("each safety violation class is rejected, not warned about", () => {
  const cases: Array<[string, (p: SignalPlan) => void]> = [
    ["short green", (p) => { (p.phases[0] as SignalPlan["phases"][number]).greenS = 2; }],
    ["short yellow", (p) => { (p.phases[1] as SignalPlan["phases"][number]).yellowS = 0.5; }],
    ["no all-red", (p) => { for (const ph of p.phases) ph.allRedS = 0; }],
    [
      "over-long cycle",
      (p) => {
        for (const ph of p.phases) ph.greenS = 200;
        p.cycleLengthS = p.phases.reduce((s, ph) => s + ph.greenS + ph.yellowS + ph.allRedS, 0);
      },
    ],
    [
      "conflicting movements green together",
      (p) => {
        // North through and east through cross; they may never share a phase.
        (p.phases[1] as SignalPlan["phases"][number]).movementIds = [
          "n_through",
          "e_through",
        ];
      },
    ],
  ];

  for (const [label, mutate] of cases) {
    const plan = clone(baselinePlan());
    mutate(plan);
    const report = validatePlan({ intersection, plan, policy });
    assert.equal(report.ok, false, `${label} should have been rejected`);
    assert.ok(report.violations.length > 0);
  }
});

test("a plan that assumes fast pedestrians is capped, not believed", () => {
  // A 14m crossing at a sprinting 3.5 m/s plus 7s WALK would "justify" an 11s
  // interval. Clearance is computed at the policy cap of 1.2 m/s instead, which
  // needs 18.67s — so the time the fast assumption tried to buy is refused.
  const site = clone(intersection);
  for (const movement of site.movements) {
    if (movement.kind === "ped") movement.assumedWalkSpeedMps = 3.5;
  }
  const plan = clone(baselinePlan());
  (plan.phases[1] as SignalPlan["phases"][number]).greenS = 11;
  (plan.phases[2] as SignalPlan["phases"][number]).greenS = 11;
  plan.cycleLengthS = plan.phases.reduce((s, p) => s + p.greenS + p.yellowS + p.allRedS, 0);

  const report = validatePlan({ intersection: site, plan, policy });
  assert.equal(report.ok, false);
  const pedViolations = report.violations.filter((v) =>
    v.movementIds.some((id) => id.startsWith("ped_")),
  );
  assert.ok(pedViolations.length > 0, "expected a pedestrian clearance violation");
  assert.match(pedViolations[0]?.message ?? "", /no more than 1\.2m\/s/);
});

test("the conflict matrix is derived from geometry", () => {
  assert.equal(destinationLeg("N", "through"), "S");
  assert.equal(destinationLeg("N", "left"), "E");
  assert.equal(destinationLeg("N", "right"), "W");

  const matrix = deriveConflictMatrix(intersection);
  // Opposing throughs do not cross; crossing throughs do.
  assert.equal(conflicts(matrix, "n_through", "s_through"), false);
  assert.equal(conflicts(matrix, "n_through", "e_through"), true);
  // A pedestrian crossing conflicts with traffic on its own leg.
  assert.equal(conflicts(matrix, "ped_n", "n_through"), true);
});

// ---- simulation ----

test("the simulation is deterministic for a given seed", () => {
  const a = simulate({ intersection, plan: baselinePlan(), demand, seed: 7 });
  const b = simulate({ intersection, plan: baselinePlan(), demand, seed: 7 });
  assert.deepEqual(a, b);

  const c = simulate({ intersection, plan: baselinePlan(), demand, seed: 8 });
  assert.notEqual(a.meanDelayS, c.meanDelayS);
});

test("more green for a movement lowers its delay", () => {
  const base = simulate({ intersection, plan: baselinePlan(), demand, seed: 3 });
  const better = simulate({ intersection, plan: improvedPlan(), demand, seed: 3 });

  const delayOf = (r: typeof base, id: string): number =>
    r.movements.find((m) => m.movementId === id)?.meanDelayS ?? 0;

  assert.ok(
    delayOf(better, "e_through") < delayOf(base, "e_through"),
    "east-west through delay should fall when its green rises",
  );
});

test("demand above capacity is reported as oversaturated", () => {
  const flood = clone(demand);
  for (const key of Object.keys(flood.vph)) flood.vph[key] = 3_000;
  const result = simulate({ intersection, plan: baselinePlan(), demand: flood, seed: 1 });
  assert.equal(result.oversaturated, true);
  assert.ok(result.movements.some((m) => m.volumeToCapacity > 1));
});

// ---- honest evaluation ----

test("an improvement must hold across every seed", () => {
  const result = evaluate({
    intersection,
    baseline: baselinePlan(),
    proposed: improvedPlan(),
    demand,
    seeds: [1, 2, 3, 4, 5],
  });
  assert.equal(result.metrics[0]?.consistent, true);
  assert.equal(result.verdict, "improvement");
  assert.match(result.notes.join(" "), /consistently across all 5 seeds/);
});

test("a plan identical to the baseline is inconclusive, not an improvement", () => {
  const identical = baselinePlan();
  identical.label = "same timings, new name";
  const result = evaluate({
    intersection,
    baseline: baselinePlan(),
    proposed: identical,
    demand,
    seeds: [1, 2, 3],
  });
  assert.notEqual(result.verdict, "improvement");
});

test("every evaluation carries its own limitations", () => {
  const result = evaluate({
    intersection,
    baseline: baselinePlan(),
    proposed: improvedPlan(),
    demand,
    seeds: [1, 2],
  });
  assert.match(result.notes.join(" "), /queue model of a single intersection/);
  assert.match(result.notes.join(" "), /screening estimate/);
});

// ---- pipeline ----

function harness() {
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const gate = new ApprovalGate(store, clock, ids);
  return {
    gate,
    runner: new WorkflowRunner({ store, clock, ids, budgetUsd: 5 }),
    workflow: createTrafficStudy({ gate }),
  };
}

const resultOf = (r: RunRecord): StudyResult => r.result as StudyResult;

const study = (candidates: SignalPlan[]) => ({
  intersection,
  baseline: baselinePlan(),
  candidates,
  demand,
  policy,
  requestedBy: "planner@city.gov",
  seeds: [1, 2, 3],
});

test("a study stops for a traffic engineer before it is exportable", async () => {
  const { runner, workflow, gate } = harness();

  const suspended = await runner.start(workflow, study([improvedPlan()]));
  assert.equal(suspended.status, "suspended");

  const [pending] = await gate.listPending();
  assert.equal(pending?.action, "traffictwin.export_recommendation");

  await gate.decide(pending!.id, "approved", "engineer@city.gov", "reviewed");
  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "engineer@city.gov",
  });

  const result = resultOf(done);
  assert.equal(result.outcome, "recommended");
  assert.equal(result.recommendation?.advisory, true);
  assert.equal(result.recommendation?.approvedBy, "engineer@city.gov");
  assert.match(result.recommendation?.notice ?? "", /ADVISORY ONLY/);
  assert.equal(result.recommendation?.notice, ADVISORY_NOTICE);
});

test("an unsafe candidate is discarded before it is ever evaluated", async () => {
  const { runner, workflow } = harness();
  const unsafe = improvedPlan();
  unsafe.label = "unsafe: no clearance";
  for (const phase of unsafe.phases) phase.allRedS = 0;

  const suspended = await runner.start(workflow, study([unsafe, improvedPlan()]));

  // The run suspended on the safe candidate; the unsafe one never got a number.
  assert.equal(suspended.status, "suspended");
  const rejected = (suspended.checkpoints["screen-candidates"] as {
    rejected: Array<{ planLabel: string }>;
  }).rejected;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.planLabel, "unsafe: no clearance");
  // A suspended run has no result yet: nothing was recommended or exported.
  assert.equal(suspended.result, null);
});

test("a study with no safe candidate recommends nothing", async () => {
  const { runner, workflow, gate } = harness();
  const unsafe = improvedPlan();
  for (const phase of unsafe.phases) phase.greenS = 1;

  const record = await runner.start(workflow, study([unsafe]));
  assert.equal(record.status, "completed");
  assert.equal(resultOf(record).outcome, "no_safe_candidate");
  assert.equal(resultOf(record).recommendation, null);
  assert.deepEqual(await gate.listPending(), []);
});

test("a candidate that is safe but no better is not recommended", async () => {
  const { runner, workflow, gate } = harness();
  const record = await runner.start(workflow, study([worsePlan()]));
  assert.equal(resultOf(record).outcome, "no_improvement");
  assert.deepEqual(await gate.listPending(), []);
});

test("a rejected study exports nothing", async () => {
  const { runner, workflow, gate } = harness();
  const suspended = await runner.start(workflow, study([improvedPlan()]));
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "engineer@city.gov", "want more seeds");

  const done = await runner.resume(workflow, suspended.id, {
    status: "rejected",
    decidedBy: "engineer@city.gov",
  });
  assert.equal(resultOf(done).outcome, "rejected");
  assert.equal(resultOf(done).recommendation, null);
});

test("a forged approval cannot make a study exportable", async () => {
  const { runner, workflow, gate } = harness();
  const suspended = await runner.start(workflow, study([improvedPlan()]));
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "engineer@city.gov", "no");

  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "attacker",
  });
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /is rejected, not approved/);
});
