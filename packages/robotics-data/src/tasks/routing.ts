import type {
  ContactClass,
  ContactThresholds,
  ContactMode,
  Executor,
  MaterialClass,
  RoutingDecision,
  TaskProperties,
  TaskSpec,
} from "./types.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";

/**
 * The contact-richness gate.
 *
 * Moravec's paradox is the product's dominant blocker: the 20% of manipulation
 * that involves regulating contact force is the part a learned policy cannot
 * do reliably, and it is exactly the part that breaks hardware and injures
 * people when it goes wrong. This module is the containment. It is not a
 * heuristic hint attached to a policy that may override it — it is the only
 * thing in the package that can return `executor: "policy"`, and every
 * autonomous action path calls `assertAutonomyAllowed` first.
 *
 * Three properties are load-bearing:
 *
 *  1. It reads only declared numbers. No model output, no free text, no
 *     policy confidence score is an input to the decision.
 *  2. Every path that is not positively established as low-contact returns a
 *     human. Missing data, contradictory data, NaN, a class the code does not
 *     recognise: all human.
 *  3. There is no override in the permissive direction. `forceHuman` exists;
 *     `forceAutonomous` deliberately does not.
 */

export class ContactGateError extends Error {
  readonly taskId: string;
  readonly contactClass: ContactClass;
  readonly reasons: string[];

  constructor(decision: RoutingDecision) {
    super(
      `task "${decision.taskId}" is routed to ${decision.executor} ` +
        `(contact class: ${decision.contactClass}) and may not run autonomously:\n  - ` +
        decision.reasons.join("\n  - "),
    );
    this.name = "ContactGateError";
    this.taskId = decision.taskId;
    this.contactClass = decision.contactClass;
    this.reasons = decision.reasons;
  }
}

export interface ClassificationResult {
  contactClass: ContactClass;
  reasons: string[];
}

const isDeclaredNumber = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const CONTACT_MODES: ContactMode[] = ["free_space", "transient", "sustained"];
const MATERIALS: MaterialClass[] = ["rigid", "deformable"];

/**
 * Classify a task from its declared properties alone.
 *
 * Returns `unclassified` rather than guessing whenever the record is
 * incomplete, non-finite, negative, or carries a value outside the closed set
 * of modes/materials this version knows about. A future task manifest that
 * introduces a new contact mode therefore degrades to "send a human", not to
 * "treat it as free space".
 */
export function classifyContact(
  declared: TaskProperties,
  thresholds: ContactThresholds = DEFAULT_THRESHOLDS,
): ClassificationResult {
  const missing: string[] = [];
  if (declared.contactMode === null) missing.push("contactMode");
  else if (!CONTACT_MODES.includes(declared.contactMode)) {
    return {
      contactClass: "unclassified",
      reasons: [`unrecognised contactMode "${String(declared.contactMode)}"`],
    };
  }
  if (declared.material === null) missing.push("material");
  else if (!MATERIALS.includes(declared.material)) {
    return {
      contactClass: "unclassified",
      reasons: [`unrecognised material "${String(declared.material)}"`],
    };
  }
  if (!isDeclaredNumber(declared.peakForceN)) missing.push("peakForceN");
  if (!isDeclaredNumber(declared.forceToleranceN)) missing.push("forceToleranceN");
  if (!isDeclaredNumber(declared.positionToleranceMm)) missing.push("positionToleranceMm");

  if (missing.length > 0) {
    return {
      contactClass: "unclassified",
      reasons: [`undeclared or invalid propert${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`],
    };
  }

  // Narrowed by the checks above; re-read as non-null for readability.
  const mode = declared.contactMode as ContactMode;
  const material = declared.material as MaterialClass;
  const peakForceN = declared.peakForceN as number;
  const forceToleranceN = declared.forceToleranceN as number;
  const positionToleranceMm = declared.positionToleranceMm as number;

  const high: string[] = [];
  if (mode === "sustained") {
    high.push("sustained contact: force must be regulated throughout the motion");
  }
  if (material === "deformable") {
    high.push("deformable material: contact dynamics are not modellable open loop");
  }
  if (forceToleranceN <= thresholds.tightForceToleranceN) {
    high.push(
      `force tolerance ${forceToleranceN}N is at or below the ${thresholds.tightForceToleranceN}N open-loop floor`,
    );
  }
  if (positionToleranceMm <= thresholds.tightPositionToleranceMm) {
    high.push(
      `position tolerance ${positionToleranceMm}mm is at or below the ${thresholds.tightPositionToleranceMm}mm open-loop floor`,
    );
  }
  if (mode === "transient" && peakForceN > thresholds.highPeakForceN) {
    high.push(
      `transient contact at ${peakForceN}N exceeds the ${thresholds.highPeakForceN}N impact threshold`,
    );
  }
  if (high.length > 0) return { contactClass: "high", reasons: high };

  // A free-space task that applies real force is a contradictory manifest.
  // Contradictions are never resolved in the permissive direction.
  if (mode === "free_space" && peakForceN > thresholds.highPeakForceN) {
    return {
      contactClass: "borderline",
      reasons: [
        `manifest declares free-space motion but a peak force of ${peakForceN}N; the declaration is inconsistent`,
      ],
    };
  }

  const coarse =
    mode === "free_space" &&
    material === "rigid" &&
    forceToleranceN >= thresholds.looseForceToleranceN &&
    positionToleranceMm >= thresholds.loosePositionToleranceMm;

  if (coarse) {
    return {
      contactClass: "low",
      reasons: [
        `free-space motion on rigid geometry, ±${forceToleranceN}N and ±${positionToleranceMm}mm tolerances`,
      ],
    };
  }

  const why: string[] = [];
  if (mode !== "free_space") why.push(`contact mode is ${mode}, not free_space`);
  if (forceToleranceN < thresholds.looseForceToleranceN) {
    why.push(
      `force tolerance ${forceToleranceN}N is below the ${thresholds.looseForceToleranceN}N coarse band`,
    );
  }
  if (positionToleranceMm < thresholds.loosePositionToleranceMm) {
    why.push(
      `position tolerance ${positionToleranceMm}mm is below the ${thresholds.loosePositionToleranceMm}mm coarse band`,
    );
  }
  return { contactClass: "borderline", reasons: why };
}

export interface RouteOptions {
  thresholds?: ContactThresholds;
  /**
   * Recorded on the decision so a reviewer can see what the policy believed.
   * It is not read by the routing logic. A policy that is certain about a
   * contact-rich task is a policy that is confidently wrong, which is the
   * failure mode this gate exists to stop.
   */
  policyConfidence?: number;
  /**
   * An operator may always pull a task back to teleoperation. There is
   * deliberately no inverse option: nothing in this package can move a task
   * from the human to the policy.
   */
  forceHuman?: boolean;
}

export function routeTask(task: TaskSpec, options: RouteOptions = {}): RoutingDecision {
  const { contactClass, reasons } = classifyContact(task.declared, options.thresholds);

  // The single permissive branch in the package. Everything else is a human.
  let executor: Executor = contactClass === "low" ? "policy" : "human_teleop";
  const allReasons = [...reasons];

  if (options.forceHuman && executor === "policy") {
    executor = "human_teleop";
    allReasons.push("operator override: pulled back to teleoperation");
  }

  return {
    taskId: task.id,
    contactClass,
    executor,
    reasons: allReasons,
    policyConfidence: typeof options.policyConfidence === "number" ? options.policyConfidence : null,
  };
}

export function routeAll(tasks: TaskSpec[], options: RouteOptions = {}): RoutingDecision[] {
  return tasks.map((task) => routeTask(task, options));
}

/**
 * The choke point every autonomous code path must go through.
 *
 * It re-derives the verdict rather than trusting the `executor` field it is
 * handed, so a decision record that was forged, hand-edited, or round-tripped
 * through a store by something that should not have touched it still cannot
 * authorise autonomy.
 */
export function assertAutonomyAllowed(
  decision: RoutingDecision,
  task: TaskSpec,
  thresholds?: ContactThresholds,
): void {
  const recomputed = classifyContact(task.declared, thresholds);
  if (recomputed.contactClass !== "low") {
    throw new ContactGateError({
      ...decision,
      contactClass: recomputed.contactClass,
      executor: "human_teleop",
      reasons: [
        ...recomputed.reasons,
        ...(decision.executor === "policy"
          ? [`decision record claimed executor "policy"; re-derived class is ${recomputed.contactClass}`]
          : []),
      ],
    });
  }
  if (decision.executor !== "policy") {
    throw new ContactGateError(decision);
  }
  if (decision.taskId !== task.id) {
    throw new ContactGateError({
      ...decision,
      executor: "human_teleop",
      reasons: [`decision is for task "${decision.taskId}" but was applied to "${task.id}"`],
    });
  }
}
