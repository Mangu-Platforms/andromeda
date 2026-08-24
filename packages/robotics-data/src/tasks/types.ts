/**
 * Declared physical properties of a manipulation task, and the routing verdict
 * derived from them.
 *
 * Everything here is *declared* by whoever specified the task — a robot
 * integrator filling in a task manifest — not measured and not inferred by a
 * model. That matters: the routing gate is only as trustworthy as its inputs,
 * so the inputs are a small, closed, human-authored record rather than free
 * text a model summarises.
 */

/** How much of the task is spent touching something. */
export type ContactMode = "free_space" | "transient" | "sustained";

/** Whether the manipulated object's contact dynamics are modellable. */
export type MaterialClass = "rigid" | "deformable";

/**
 * `null` means "not declared". It is never treated as a benign default — an
 * undeclared property makes the whole task unclassified, which routes to a
 * human. This is the fail-closed direction.
 */
export interface TaskProperties {
  contactMode: ContactMode | null;
  material: MaterialClass | null;
  /** Peak normal force the task is expected to apply, newtons. */
  peakForceN: number | null;
  /** Half-width of the acceptable force band, newtons. Smaller = harder. */
  forceToleranceN: number | null;
  /** Positional tolerance at the end effector, millimetres. */
  positionToleranceMm: number | null;
}

export interface TaskSpec {
  id: string;
  /**
   * Free text for humans. Attacker-influenced in the general case (it can come
   * from a customer ticket), so nothing in the routing gate reads it.
   */
  summary: string;
  declared: TaskProperties;
}

/**
 * `borderline` and `unclassified` are distinct on purpose: the first means the
 * declared numbers sit between the coarse and the fine band, the second means
 * we do not have the numbers. Both route to a human; the reviewer needs to know
 * which one happened.
 */
export type ContactClass = "low" | "borderline" | "high" | "unclassified";

export type Executor = "policy" | "human_teleop";

export interface RoutingDecision {
  taskId: string;
  contactClass: ContactClass;
  executor: Executor;
  /** Human-readable justification. Every non-`low` reason is listed. */
  reasons: string[];
  /**
   * The policy's self-reported confidence, recorded for the audit trail only.
   * `classifyContact` and `routeTask` never read it — see routing.ts.
   */
  policyConfidence: number | null;
}

/**
 * Where the coarse/fine boundaries sit. Exported so the README, the tests and
 * the reviewer UI all quote the same numbers instead of three copies drifting.
 *
 * These are deliberately conservative. An OpenVLA-class policy executing an
 * open-loop action chunk has no force feedback inside the chunk at all, so any
 * task whose success depends on regulating force is out of scope by
 * construction, not by benchmark result.
 */
export interface ContactThresholds {
  /** At or below this force tolerance, no open-loop chunk can hold the band. */
  tightForceToleranceN: number;
  /** At or above this, the task is coarse enough to be attempted. */
  looseForceToleranceN: number;
  /** Above this peak force, even transient contact counts as contact-rich. */
  highPeakForceN: number;
  tightPositionToleranceMm: number;
  loosePositionToleranceMm: number;
}

export const DEFAULT_THRESHOLDS: ContactThresholds = {
  tightForceToleranceN: 2,
  looseForceToleranceN: 8,
  highPeakForceN: 5,
  tightPositionToleranceMm: 2,
  loosePositionToleranceMm: 10,
};
