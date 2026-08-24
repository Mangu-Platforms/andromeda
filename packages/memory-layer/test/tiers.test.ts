import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CloudBoundaryError,
  DEFAULT_STAGES,
  DEFAULT_TIERS,
  TierBudgetError,
  assertCloudPayload,
  cloudPayloadIssues,
  planTiers,
  tierOf,
  type ProcessingStage,
} from "../src/tiers.ts";

const stage = (over: Partial<ProcessingStage> & { id: string }): ProcessingStage => ({
  computeUnits: 1,
  powerMw: 1,
  consumes: "raw_audio",
  emits: "raw_audio",
  ...over,
});

test("the default pipeline offloads transcription off the device and stays inside every budget", () => {
  const plan = planTiers();

  assert.equal(tierOf(plan, "capture"), "device");
  assert.equal(tierOf(plan, "voice-activity"), "device");
  // The blocker in one assertion: transcription does not fit a badge, so the
  // planner moves it rather than letting it run degraded on the wearable.
  assert.equal(tierOf(plan, "transcribe"), "edge");
  assert.equal(tierOf(plan, "embed"), "edge");
  assert.equal(tierOf(plan, "index-cloud"), "cloud");

  const transcribe = plan.placements.find((p) => p.stageId === "transcribe");
  assert.match(transcribe?.reason ?? "", /offloaded to edge/);

  for (const capacity of DEFAULT_TIERS) {
    const load = plan.load[capacity.tier];
    assert.ok(
      load.computeUnits <= capacity.computeUnits,
      `${capacity.tier} compute ${load.computeUnits} over ${capacity.computeUnits}`,
    );
    assert.ok(
      load.powerMw <= capacity.powerMw,
      `${capacity.tier} power ${load.powerMw} over ${capacity.powerMw}`,
    );
  }

  // Nothing touching raw audio or verbatim transcript may be scheduled in the cloud.
  const byId = new Map(DEFAULT_STAGES.map((s) => [s.id, s]));
  for (const placement of plan.placements) {
    if (placement.tier !== "cloud") continue;
    const s = byId.get(placement.stageId);
    assert.ok(s);
    assert.ok(s.consumes !== "raw_audio" && s.emits !== "raw_audio");
    assert.ok(s.consumes !== "transcript" && s.emits !== "transcript");
  }
});

test("a stage that fits no tier fails the plan closed rather than degrading", () => {
  // Pinning transcription to the wearable is the mistake this product exists to
  // stop being made; it has to be an error, not a warning.
  assert.throws(
    () => planTiers([stage({ id: "transcribe", computeUnits: 120, powerMw: 900, emits: "transcript", pin: "device" })]),
    (err: unknown) => {
      assert.ok(err instanceof TierBudgetError);
      assert.equal(err.stageId, "transcribe");
      assert.ok(err.reasons.some((r) => /compute budget exceeded/.test(r)));
      assert.ok(err.reasons.some((r) => /may not hold transcript/.test(r)));
      return true;
    },
  );

  // Too heavy for the phone, and the cloud is not allowed to hold raw audio, so
  // there is nowhere left to put it.
  assert.throws(
    () =>
      planTiers([
        stage({ id: "capture", computeUnits: 0.35, powerMw: 18, pin: "device" }),
        stage({ id: "denoise", computeUnits: 900, powerMw: 100 }),
      ]),
    (err: unknown) => {
      assert.ok(err instanceof TierBudgetError);
      assert.equal(err.stageId, "denoise");
      assert.ok(err.reasons.some((r) => /cloud may not hold raw_audio/.test(r)));
      return true;
    },
  );

  // Data flows outward only: once work is on the phone, a later stage cannot be
  // pinned back onto the device.
  assert.throws(
    () =>
      planTiers([
        stage({ id: "transcribe", computeUnits: 120, powerMw: 900, emits: "transcript" }),
        stage({ id: "late-capture", consumes: "raw_audio", emits: "raw_audio", pin: "device" }),
      ]),
    (err: unknown) =>
      err instanceof TierBudgetError && err.reasons.some((r) => /does not flow back inward/.test(r)),
  );
});

test("the cloud boundary refuses anything that is not derived metadata", () => {
  const clean = [
    {
      entryId: "mem_1",
      sessionId: "s1",
      speakerRef: "spk_9f2c",
      at: 1_700_000_000_000,
      retentionUntil: 1_701_000_000_000,
      topics: ["invoice", "deadline"],
      vector: [0.1, 0.9],
    },
  ];
  assert.doesNotThrow(() => assertCloudPayload(clean));

  // Raw media, by key name.
  assert.throws(
    () => assertCloudPayload([{ ...clean[0], audioBase64: "UklGRi..." }]),
    (err: unknown) =>
      err instanceof CloudBoundaryError &&
      err.issues.some((i) => /audioBase64 is raw or identifying content/.test(i)),
  );

  // Verbatim speech smuggled inside an otherwise-plausible metadata field.
  const smuggled = [
    { ...clean[0], topics: ["invoice", { dataClass: "transcript", value: "he said he was leaving" }] },
  ];
  const issues = cloudPayloadIssues(smuggled);
  assert.ok(issues.some((i) => /dataClass "transcript"/.test(i)));
  assert.throws(() => assertCloudPayload(smuggled), CloudBoundaryError);

  // Unknown fields are refused rather than silently dropped, and a record that
  // is missing a required field is refused too.
  assert.throws(
    () => assertCloudPayload([{ ...clean[0], speakerId: "alex" }]),
    (err: unknown) =>
      err instanceof CloudBoundaryError && err.issues.some((i) => /speakerId/.test(i)),
  );
  assert.throws(() => assertCloudPayload([{ entryId: "mem_1" }]), CloudBoundaryError);
  assert.throws(() => assertCloudPayload("not-an-array"), CloudBoundaryError);
});
