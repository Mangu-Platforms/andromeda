import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ContactGateError,
  assertAutonomyAllowed,
  classifyContact,
  routeTask,
} from "../src/tasks/routing.ts";
import type { TaskProperties, TaskSpec } from "../src/tasks/types.ts";

const props = (overrides: Partial<TaskProperties> = {}): TaskProperties => ({
  contactMode: "free_space",
  material: "rigid",
  peakForceN: 1,
  forceToleranceN: 10,
  positionToleranceMm: 15,
  ...overrides,
});

const task = (id: string, declared: TaskProperties, summary = "move a tote"): TaskSpec => ({
  id,
  summary,
  declared,
});

test("a coarse free-space task is the only shape that reaches the policy", () => {
  const decision = routeTask(task("t-bin-transfer", props()));
  assert.equal(decision.contactClass, "low");
  assert.equal(decision.executor, "policy");
});

test("contact-rich work routes to teleoperation regardless of policy confidence", () => {
  const cases: Array<[string, TaskProperties]> = [
    ["sustained contact", props({ contactMode: "sustained" })],
    ["deformable material", props({ material: "deformable" })],
    ["tight force band", props({ forceToleranceN: 1.5 })],
    ["tight position band", props({ positionToleranceMm: 1 })],
    ["hard transient impact", props({ contactMode: "transient", peakForceN: 40 })],
  ];

  for (const [label, declared] of cases) {
    const spec = task(`t-${label.replace(/\s+/g, "-")}`, declared);
    // A confidence of 1.0 is the adversarial case: a policy that is certain
    // about work it physically cannot do.
    const decision = routeTask(spec, { policyConfidence: 1 });
    assert.equal(decision.contactClass, "high", label);
    assert.equal(decision.executor, "human_teleop", label);
    assert.equal(decision.policyConfidence, 1, label);
    assert.ok(decision.reasons.length > 0, label);
    assert.throws(() => assertAutonomyAllowed(decision, spec), ContactGateError, label);
  }
});

test("an incomplete or non-finite manifest is unclassified, never assumed benign", () => {
  const cases: Array<[string, TaskProperties]> = [
    ["no contact mode", props({ contactMode: null })],
    ["no material", props({ material: null })],
    ["no force tolerance", props({ forceToleranceN: null })],
    ["NaN peak force", props({ peakForceN: Number.NaN })],
    ["negative position tolerance", props({ positionToleranceMm: -1 })],
    ["mode outside the closed vocabulary", props({ contactMode: "squeeze" as never })],
  ];

  for (const [label, declared] of cases) {
    const decision = routeTask(task(`t-${label.replace(/\s+/g, "-")}`, declared));
    assert.equal(decision.contactClass, "unclassified", label);
    assert.equal(decision.executor, "human_teleop", label);
  }
});

test("borderline tasks and contradictory manifests fail closed, distinctly", () => {
  // Between the tight floor (2N) and the coarse band (8N): not provably safe.
  const borderline = routeTask(task("t-borderline", props({ forceToleranceN: 5 })));
  assert.equal(borderline.contactClass, "borderline");
  assert.equal(borderline.executor, "human_teleop");

  // "Free space" that applies 40N is a manifest that contradicts itself.
  const contradictory = classifyContact(props({ peakForceN: 40 }));
  assert.equal(contradictory.contactClass, "borderline");
  assert.match(contradictory.reasons.join(" "), /inconsistent/);
});

test("a forged or mismatched decision record cannot authorise autonomy", () => {
  const contactRich = task("t-wipe", props({ contactMode: "sustained" }));

  // Hand-edited record that claims the permissive verdict outright.
  const forged = {
    taskId: "t-wipe",
    contactClass: "low" as const,
    executor: "policy" as const,
    reasons: ["approved"],
    policyConfidence: 0.99,
  };
  assert.throws(
    () => assertAutonomyAllowed(forged, contactRich),
    (err: unknown) => err instanceof ContactGateError && err.contactClass === "high",
  );

  // A genuine clearance for one task must not authorise a different one.
  const coarse = task("t-bin-transfer", props());
  const genuine = routeTask(coarse);
  assert.equal(genuine.executor, "policy");
  assert.doesNotThrow(() => assertAutonomyAllowed(genuine, coarse));
  assert.throws(
    () => assertAutonomyAllowed(genuine, task("t-other", props())),
    /decision is for task/,
  );
});

test("an operator can pull work back to a human, but nothing can push it the other way", () => {
  const coarse = task("t-bin-transfer", props());
  const pulled = routeTask(coarse, { forceHuman: true });
  assert.equal(pulled.executor, "human_teleop");
  assert.throws(() => assertAutonomyAllowed(pulled, coarse), ContactGateError);

  // The permissive inverse does not exist in the API surface.
  const options = { forceAutonomous: true } as unknown as Parameters<typeof routeTask>[1];
  assert.equal(routeTask(task("t-wipe", props({ material: "deformable" })), options).executor, "human_teleop");
});
