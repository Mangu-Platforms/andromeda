import type {
  Calibration,
  DemoFrame,
  EpisodeLabel,
  IssueCode,
  RawEpisode,
  RobotProfile,
  ValidationIssue,
} from "./types.ts";
import type { RoutingDecision } from "../tasks/types.ts";

/**
 * The demonstration quality gate.
 *
 * What the product actually sells is provenance: an episode whose joint angles
 * mean what they claim, recorded at a known rate against a known calibration.
 * A dropped frame or a stale calibration does not announce itself downstream —
 * it silently teaches a policy the wrong dynamics — so every episode is checked
 * before it is labelled, and an episode that fails any check never becomes a
 * dataset entry.
 *
 * The checks are deliberately mechanical: comparisons against a declared robot
 * profile and a declared control rate. No model looks at a demonstration and
 * decides whether it is good.
 */

export interface EpisodeValidationOptions {
  robot: RobotProfile;
  /** The calibration record the episode claims. `null` is itself a failure. */
  calibration: Calibration | null;
  /** Ingest-time wall clock, ms. Only used to age the calibration. */
  nowMs: number;
  /** Allowed inter-frame gap as a multiple of the nominal frame period. */
  frameJitterTolerance?: number;
  /** Episode must cover at least this fraction of its declared duration. */
  minDurationFraction?: number;
  /** Task ids this batch knows about; an episode for anything else is refused. */
  knownTaskIds?: string[];
}

export interface EpisodeValidation {
  ok: boolean;
  issues: ValidationIssue[];
  /** Frames actually present. Reported so a reviewer sees the shortfall. */
  frameCount: number;
  durationMs: number;
}

const DEFAULT_JITTER_TOLERANCE = 0.5;
const DEFAULT_MIN_DURATION_FRACTION = 0.95;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const allFinite = (values: number[]): boolean => values.every((v) => finite(v));

/**
 * Collector that keeps one issue per code.
 *
 * A recording with a broken encoder produces the same fault on every frame; the
 * reviewer needs to know *which* fault and where it started, not five thousand
 * copies of it.
 */
class Issues {
  readonly #seen = new Set<IssueCode>();
  readonly list: ValidationIssue[] = [];

  add(code: IssueCode, detail: string): void {
    if (this.#seen.has(code)) return;
    this.#seen.add(code);
    this.list.push({ code, detail });
  }

  has(code: IssueCode): boolean {
    return this.#seen.has(code);
  }
}

function checkCalibration(episode: RawEpisode, options: EpisodeValidationOptions, issues: Issues): void {
  const calibration = options.calibration;
  if (!calibration) {
    issues.add("missing_calibration", `no calibration record for "${episode.calibrationId}"`);
    return;
  }
  if (calibration.calibrationId !== episode.calibrationId) {
    issues.add(
      "missing_calibration",
      `calibration "${calibration.calibrationId}" does not match the episode's declared "${episode.calibrationId}"`,
    );
  }
  if (calibration.robotId !== episode.robotId) {
    issues.add(
      "calibration_robot_mismatch",
      `calibration was recorded on ${calibration.robotId}, episode on ${episode.robotId}`,
    );
  }
  const expiresAtMs = calibration.recordedAtMs + calibration.validForMs;
  if (!(calibration.validForMs > 0) || options.nowMs > expiresAtMs) {
    issues.add(
      "stale_calibration",
      `calibration expired at ${expiresAtMs}, ingest is at ${options.nowMs}`,
    );
  }
}

function checkFrame(
  frame: DemoFrame,
  index: number,
  previous: DemoFrame | undefined,
  episode: RawEpisode,
  options: EpisodeValidationOptions,
  issues: Issues,
): void {
  const robot = options.robot;

  if (
    !finite(frame.tMs) ||
    !finite(frame.gripper) ||
    !Array.isArray(frame.jointPositions) ||
    !Array.isArray(frame.jointVelocities) ||
    !Array.isArray(frame.wrench) ||
    !allFinite(frame.jointPositions) ||
    !allFinite(frame.jointVelocities) ||
    !allFinite(frame.wrench)
  ) {
    issues.add("non_finite_value", `frame ${index} contains a non-finite or malformed value`);
    return;
  }

  if (frame.jointPositions.length !== robot.dof || frame.jointVelocities.length !== robot.dof) {
    issues.add(
      "dof_mismatch",
      `frame ${index} has ${frame.jointPositions.length} joint position(s) and ` +
        `${frame.jointVelocities.length} velocity value(s); robot ${robot.robotId} has ${robot.dof} DoF`,
    );
    return;
  }
  if (frame.wrench.length !== 6) {
    issues.add("dof_mismatch", `frame ${index} has a ${frame.wrench.length}-component wrench, expected 6`);
  }

  if (previous !== undefined && finite(previous.tMs)) {
    if (frame.tMs <= previous.tMs) {
      issues.add(
        "non_monotonic_timestamps",
        `frame ${index} is stamped ${frame.tMs}ms, not after frame ${index - 1} at ${previous.tMs}ms`,
      );
    } else if (episode.controlHz > 0) {
      const periodMs = 1000 / episode.controlHz;
      const tolerance = options.frameJitterTolerance ?? DEFAULT_JITTER_TOLERANCE;
      const gapMs = frame.tMs - previous.tMs;
      if (gapMs > periodMs * (1 + tolerance)) {
        const missed = Math.round(gapMs / periodMs) - 1;
        issues.add(
          "dropped_frames",
          `${gapMs}ms gap before frame ${index} at ${episode.controlHz}Hz: ~${missed} frame(s) missing`,
        );
      }
    }
  }

  for (let j = 0; j < frame.jointPositions.length; j++) {
    const value = frame.jointPositions[j];
    const limit = robot.jointLimitsRad[j];
    if (value === undefined || limit === undefined) continue;
    if (value < limit.min || value > limit.max) {
      issues.add(
        "joint_out_of_range",
        `frame ${index} joint ${j} at ${value}rad is outside [${limit.min}, ${limit.max}]`,
      );
    }
  }

  for (let j = 0; j < frame.jointVelocities.length; j++) {
    const value = frame.jointVelocities[j];
    if (value === undefined) continue;
    if (Math.abs(value) > robot.maxJointVelocityRadPerSec) {
      issues.add(
        "velocity_out_of_range",
        `frame ${index} joint ${j} at ${value}rad/s exceeds ${robot.maxJointVelocityRadPerSec}rad/s`,
      );
    }
  }

  if (frame.gripper < robot.gripperRange.min || frame.gripper > robot.gripperRange.max) {
    issues.add(
      "gripper_out_of_range",
      `frame ${index} gripper at ${frame.gripper} is outside [${robot.gripperRange.min}, ${robot.gripperRange.max}]`,
    );
  }
}

/** Every check that stands between a recording and the dataset. */
export function validateEpisode(
  episode: RawEpisode,
  options: EpisodeValidationOptions,
): EpisodeValidation {
  const issues = new Issues();

  if (options.knownTaskIds && !options.knownTaskIds.includes(episode.taskId)) {
    issues.add("unknown_task", `task "${episode.taskId}" is not part of this batch`);
  }
  if (episode.robotId !== options.robot.robotId) {
    issues.add(
      "unknown_robot",
      `episode declares robot "${episode.robotId}", profile is for "${options.robot.robotId}"`,
    );
  }
  if (!finite(episode.controlHz) || episode.controlHz <= 0) {
    issues.add("invalid_control_rate", `controlHz must be positive, got ${episode.controlHz}`);
  }
  if (episode.outcome === "aborted") {
    // An aborted episode is a record of an operator giving up partway. It is
    // real data, but it is not a demonstration of the task.
    issues.add("aborted_outcome", "episode was aborted by the operator");
  }

  checkCalibration(episode, options, issues);

  const frames = Array.isArray(episode.frames) ? episode.frames : [];
  if (frames.length === 0) {
    issues.add("empty_episode", "episode contains no frames");
    return { ok: false, issues: issues.list, frameCount: 0, durationMs: 0 };
  }

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame === undefined) continue;
    checkFrame(frame, i, frames[i - 1], episode, options, issues);
  }

  const first = frames[0];
  const last = frames[frames.length - 1];
  const durationMs =
    first && last && finite(first.tMs) && finite(last.tMs) ? last.tMs - first.tMs : 0;

  const minFraction = options.minDurationFraction ?? DEFAULT_MIN_DURATION_FRACTION;
  if (
    finite(episode.declaredDurationMs) &&
    episode.declaredDurationMs > 0 &&
    durationMs < episode.declaredDurationMs * minFraction
  ) {
    // The operator's station said how long the episode ran. A recording that
    // stops early is a truncated upload, not a shorter demonstration.
    issues.add(
      "truncated_episode",
      `recording covers ${durationMs}ms of a declared ${episode.declaredDurationMs}ms`,
    );
  }

  return { ok: issues.list.length === 0, issues: issues.list, frameCount: frames.length, durationMs };
}

export interface LabelOptions {
  /** Wrench magnitude, per component, treated as sensor noise rather than contact. */
  wrenchNoiseFloorN?: number;
}

/**
 * Attach the provenance a buyer pays for.
 *
 * The label carries the routing verdict for the task, so a downstream consumer
 * can tell contact-rich teleoperation data from the coarse subset a policy is
 * allowed to attempt. Labelling refuses a decision from a different task: a
 * demonstration must never inherit another task's clearance.
 */
export function labelEpisode(
  episode: RawEpisode,
  decision: RoutingDecision,
  validation: EpisodeValidation,
  options: LabelOptions = {},
): EpisodeLabel {
  if (decision.taskId !== episode.taskId) {
    throw new Error(
      `routing decision is for task "${decision.taskId}" but episode ${episode.episodeId} is for "${episode.taskId}"`,
    );
  }
  const floor = options.wrenchNoiseFloorN ?? 0;
  const contactFrames = episode.frames.filter(
    (frame) => Array.isArray(frame.wrench) && frame.wrench.some((c) => finite(c) && Math.abs(c) > floor),
  ).length;

  return {
    taskId: episode.taskId,
    contactClass: decision.contactClass,
    clearedExecutor: decision.executor,
    outcome: episode.outcome,
    operator: episode.operator,
    robotId: episode.robotId,
    controlHz: episode.controlHz,
    frameCount: validation.frameCount,
    durationMs: validation.durationMs,
    contactFraction: episode.frames.length === 0 ? 0 : contactFrames / episode.frames.length,
  };
}
