import type { ContactClass, Executor } from "../tasks/types.ts";

/** One control-rate sample of a teleoperated demonstration. */
export interface DemoFrame {
  /** Milliseconds since episode start. Must strictly increase. */
  tMs: number;
  jointPositions: number[];
  jointVelocities: number[];
  /** Normalised gripper aperture. */
  gripper: number;
  /** End-effector wrench: fx, fy, fz, tx, ty, tz. */
  wrench: number[];
}

export type EpisodeOutcome = "success" | "failure" | "aborted";

export interface RawEpisode {
  episodeId: string;
  taskId: string;
  robotId: string;
  /** Teleoperator identity; part of the provenance record buyers pay for. */
  operator: string;
  calibrationId: string;
  controlHz: number;
  /** What the operator's station said the episode should have lasted. */
  declaredDurationMs: number;
  outcome: EpisodeOutcome;
  frames: DemoFrame[];
}

export interface JointLimit {
  min: number;
  max: number;
}

export interface RobotProfile {
  robotId: string;
  dof: number;
  jointLimitsRad: JointLimit[];
  maxJointVelocityRadPerSec: number;
  gripperRange: JointLimit;
}

/**
 * A recorded kinematic/force-sensor calibration. Demonstrations recorded
 * against a stale or missing calibration are worthless as training data — the
 * joint angles do not mean what they claim — so they never enter the dataset.
 */
export interface Calibration {
  calibrationId: string;
  robotId: string;
  recordedAtMs: number;
  validForMs: number;
}

export type IssueCode =
  | "unknown_robot"
  | "missing_calibration"
  | "calibration_robot_mismatch"
  | "stale_calibration"
  | "empty_episode"
  | "dof_mismatch"
  | "non_finite_value"
  | "non_monotonic_timestamps"
  | "dropped_frames"
  | "joint_out_of_range"
  | "velocity_out_of_range"
  | "gripper_out_of_range"
  | "truncated_episode"
  | "aborted_outcome"
  | "invalid_control_rate"
  | "unknown_task"
  | "duplicate_episode";

export interface ValidationIssue {
  code: IssueCode;
  detail: string;
}

export interface EpisodeLabel {
  taskId: string;
  contactClass: ContactClass;
  /** Who is cleared to perform this task in deployment, per the routing gate. */
  clearedExecutor: Executor;
  outcome: EpisodeOutcome;
  operator: string;
  robotId: string;
  controlHz: number;
  frameCount: number;
  durationMs: number;
  /** Fraction of frames with any non-zero wrench reading. */
  contactFraction: number;
}

export interface DatasetEntry {
  episode: RawEpisode;
  label: EpisodeLabel;
  /** SHA-256 of the canonical episode encoding. */
  digest: string;
}

export interface RejectedEpisode {
  episodeId: string;
  taskId: string;
  issues: ValidationIssue[];
}

export interface DatasetStats {
  episodes: number;
  frames: number;
  durationMs: number;
  successes: number;
  byTask: Record<string, number>;
  byContactClass: Record<string, number>;
  byExecutor: Record<string, number>;
  byOutcome: Record<string, number>;
  byOperator: Record<string, number>;
  rejected: number;
  rejectionsByCode: Record<string, number>;
  /** Admitted / (admitted + rejected), 0 when nothing was submitted. */
  admissionRate: number;
}
