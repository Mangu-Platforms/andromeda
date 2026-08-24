import { test } from "node:test";
import assert from "node:assert/strict";

import { DemonstrationDataset } from "../src/data/dataset.ts";
import { validateEpisode } from "../src/data/validate.ts";
import type {
  Calibration,
  DemoFrame,
  RawEpisode,
  RobotProfile,
} from "../src/data/types.ts";
import { routeTask } from "../src/tasks/routing.ts";
import type { TaskSpec } from "../src/tasks/types.ts";

const ROBOT: RobotProfile = {
  robotId: "arm-01",
  dof: 3,
  jointLimitsRad: [
    { min: -3, max: 3 },
    { min: -3, max: 3 },
    { min: -3, max: 3 },
  ],
  maxJointVelocityRadPerSec: 2,
  gripperRange: { min: 0, max: 1 },
};

const NOW_MS = 1_700_000_000_000;

const CALIBRATION: Calibration = {
  calibrationId: "cal-7",
  robotId: "arm-01",
  recordedAtMs: NOW_MS - 3_600_000,
  validForMs: 7 * 24 * 3_600_000,
};

const TASK: TaskSpec = {
  id: "t-wipe",
  summary: "Wipe the counter.",
  declared: {
    contactMode: "sustained",
    material: "deformable",
    peakForceN: 6,
    forceToleranceN: 1,
    positionToleranceMm: 3,
  },
};

const DECISION = routeTask(TASK);

/** 50 frames at 20Hz: 0..2450ms. */
function frames(count = 50, mutate: (frame: DemoFrame, i: number) => void = () => {}): DemoFrame[] {
  const out: DemoFrame[] = [];
  for (let i = 0; i < count; i++) {
    const frame: DemoFrame = {
      tMs: i * 50,
      jointPositions: [0.1 * i * 0.01, 0.2, 0.3],
      jointVelocities: [0.1, 0.1, 0.1],
      gripper: 0.5,
      wrench: [0, 0, i < 25 ? 0 : 3, 0, 0, 0],
    };
    mutate(frame, i);
    out.push(frame);
  }
  return out;
}

function episode(overrides: Partial<RawEpisode> = {}): RawEpisode {
  return {
    episodeId: "ep-001",
    taskId: "t-wipe",
    robotId: "arm-01",
    operator: "op-jules",
    calibrationId: "cal-7",
    controlHz: 20,
    declaredDurationMs: 2450,
    outcome: "success",
    frames: frames(),
    ...overrides,
  };
}

const validationOptions = (over: Partial<Parameters<typeof validateEpisode>[1]> = {}) => ({
  robot: ROBOT,
  calibration: CALIBRATION,
  nowMs: NOW_MS,
  knownTaskIds: ["t-wipe"],
  ...over,
});

test("a clean episode is validated, labelled with its routing verdict, and stored", () => {
  const dataset = new DemonstrationDataset();
  const result = dataset.ingest({
    episode: episode(),
    decision: DECISION,
    validation: validationOptions(),
  });

  assert.equal(result.admitted, true);
  assert.deepEqual(result.issues, []);
  const entry = result.entry;
  assert.ok(entry);
  assert.equal(entry.label.contactClass, "high");
  assert.equal(entry.label.clearedExecutor, "human_teleop");
  assert.equal(entry.label.frameCount, 50);
  assert.equal(entry.label.durationMs, 2450);
  assert.equal(entry.label.contactFraction, 0.5);
  assert.equal(entry.label.operator, "op-jules");
  assert.match(entry.digest, /^[0-9a-f]{64}$/);
  assert.equal(dataset.has("ep-001"), true);
  assert.equal(dataset.stats().episodes, 1);
});

test("validation rejects each defect it exists to catch", () => {
  const cases: Array<[string, RawEpisode, string]> = [
    [
      "dropped frames",
      episode({ frames: frames().filter((_f, i) => i !== 20) }),
      "dropped_frames",
    ],
    [
      "non-monotonic timestamps",
      episode({ frames: frames(50, (f, i) => { if (i === 30) f.tMs = 100; }) }),
      "non_monotonic_timestamps",
    ],
    [
      "joint out of range",
      episode({ frames: frames(50, (f, i) => { if (i === 10) f.jointPositions = [9, 0.2, 0.3]; }) }),
      "joint_out_of_range",
    ],
    [
      "velocity out of range",
      episode({ frames: frames(50, (f, i) => { if (i === 10) f.jointVelocities = [50, 0, 0]; }) }),
      "velocity_out_of_range",
    ],
    [
      "gripper out of range",
      episode({ frames: frames(50, (f, i) => { if (i === 3) f.gripper = 4; }) }),
      "gripper_out_of_range",
    ],
    ["truncated episode", episode({ frames: frames(20) }), "truncated_episode"],
    ["empty episode", episode({ frames: [] }), "empty_episode"],
    [
      "non-finite value",
      episode({ frames: frames(50, (f, i) => { if (i === 5) f.jointPositions = [Number.NaN, 0, 0]; }) }),
      "non_finite_value",
    ],
    [
      "wrong DoF",
      episode({ frames: frames(50, (f) => { f.jointPositions = [0, 0]; f.jointVelocities = [0, 0]; }) }),
      "dof_mismatch",
    ],
    ["aborted outcome", episode({ outcome: "aborted" }), "aborted_outcome"],
    ["invalid control rate", episode({ controlHz: 0 }), "invalid_control_rate"],
    ["unknown robot", episode({ robotId: "arm-99" }), "unknown_robot"],
    ["unknown task", episode({ taskId: "t-nope" }), "unknown_task"],
  ];

  const dataset = new DemonstrationDataset();
  for (const [label, ep, expected] of cases) {
    const result = dataset.ingest({
      episode: { ...ep, episodeId: `ep-${label.replace(/\s+/g, "-")}` },
      decision: DECISION,
      validation: validationOptions(),
    });
    assert.equal(result.admitted, false, label);
    assert.ok(
      result.issues.some((issue) => issue.code === expected),
      `${label}: expected ${expected}, got ${result.issues.map((i) => i.code).join(",") || "none"}`,
    );
  }

  // Nothing rejected reached the dataset, and every rejection is on the record.
  assert.equal(dataset.entries().length, 0);
  assert.equal(dataset.stats().episodes, 0);
  assert.equal(dataset.stats().rejected, cases.length);
  assert.equal(dataset.stats().admissionRate, 0);
});

test("missing, mismatched or expired calibration keeps an episode out of the dataset", () => {
  const dataset = new DemonstrationDataset();

  const missing = dataset.ingest({
    episode: episode({ episodeId: "ep-a" }),
    decision: DECISION,
    validation: validationOptions({ calibration: null }),
  });
  assert.equal(missing.admitted, false);
  assert.equal(missing.issues[0]?.code, "missing_calibration");

  const stale = dataset.ingest({
    episode: episode({ episodeId: "ep-b" }),
    decision: DECISION,
    validation: validationOptions({
      calibration: { ...CALIBRATION, recordedAtMs: NOW_MS - 30 * 24 * 3_600_000 },
    }),
  });
  assert.equal(stale.admitted, false);
  assert.ok(stale.issues.some((i) => i.code === "stale_calibration"));

  const wrongRobot = dataset.ingest({
    episode: episode({ episodeId: "ep-c" }),
    decision: DECISION,
    validation: validationOptions({ calibration: { ...CALIBRATION, robotId: "arm-42" } }),
  });
  assert.equal(wrongRobot.admitted, false);
  assert.ok(wrongRobot.issues.some((i) => i.code === "calibration_robot_mismatch"));

  assert.equal(dataset.entries().length, 0);
});

test("an episode cannot be labelled without a routing decision, or with another task's", () => {
  const dataset = new DemonstrationDataset();

  const orphan = dataset.ingest({
    episode: episode({ episodeId: "ep-orphan" }),
    decision: null,
    validation: validationOptions(),
  });
  assert.equal(orphan.admitted, false);
  assert.equal(orphan.issues[0]?.code, "unknown_task");

  assert.throws(
    () =>
      dataset.ingest({
        episode: episode({ episodeId: "ep-crossed" }),
        decision: { ...DECISION, taskId: "t-somewhere-else" },
        validation: validationOptions(),
      }),
    /but episode ep-crossed is for/,
  );
  assert.equal(dataset.entries().length, 0);
});

test("duplicate episodes are refused by id and by content", () => {
  const dataset = new DemonstrationDataset();
  assert.equal(dataset.ingest({ episode: episode(), decision: DECISION, validation: validationOptions() }).admitted, true);

  const sameId = dataset.ingest({ episode: episode(), decision: DECISION, validation: validationOptions() });
  assert.equal(sameId.admitted, false);
  assert.equal(sameId.issues[0]?.code, "duplicate_episode");

  // Same recording, fresh id: content-addressed, so it is still one episode.
  const reupload = dataset.ingest({
    episode: episode({ episodeId: "ep-002" }),
    decision: DECISION,
    validation: validationOptions(),
  });
  assert.equal(reupload.admitted, false);
  assert.equal(reupload.issues[0]?.code, "duplicate_episode");
  assert.equal(dataset.stats().episodes, 1);
  assert.equal(dataset.stats().rejected, 2);
  assert.equal(dataset.stats().admissionRate, 1 / 3);
});
