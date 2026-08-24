/**
 * Hard validation of a signal plan against the safety envelope.
 *
 * Everything in here is a rejection, never a warning. There is deliberately no
 * severity axis and no "advisory violation" — a plan either satisfies the whole
 * envelope or it is not a plan this package will carry any further. The
 * optimiser calls this on every candidate it generates and discards, rather
 * than repairs, anything that fails; there is no code path that scores an
 * invalid plan.
 */

import type { Intersection, SignalPlan } from "../network/types.ts";
import {
  greenPerCycle,
  isPed,
  isVehicle,
  movementById,
  phaseSum,
} from "../network/types.ts";
import type { ConflictMatrix } from "./conflicts.ts";
import { conflictingPairsIn, deriveConflictMatrix } from "./conflicts.ts";
import type { SafetyPolicy } from "./policy.ts";
import {
  DEFAULT_SAFETY_POLICY,
  requiredAllRedS,
  requiredPedServiceS,
  requiredYellowS,
} from "./policy.ts";

export type ViolationCode =
  | "plan_structure"
  | "min_green"
  | "ped_clearance"
  | "change_interval"
  | "max_cycle_length"
  | "phase_conflict"
  | "red_starvation";

export interface SafetyViolation {
  code: ViolationCode;
  message: string;
  /** Phase the violation was found in, when it is phase-scoped. */
  phaseId: string | null;
  movementIds: string[];
  requiredS: number | null;
  actualS: number | null;
}

export interface SafetyReport {
  intersectionId: string;
  planLabel: string;
  policyId: string;
  ok: boolean;
  violations: SafetyViolation[];
  /** Codes present, deduplicated — the summary a reviewer reads first. */
  codes: ViolationCode[];
}

export class SafetyViolationError extends Error {
  readonly violations: SafetyViolation[];
  readonly report: SafetyReport;

  constructor(report: SafetyReport) {
    super(
      `signal plan "${report.planLabel}" violates the safety envelope:\n  - ` +
        report.violations.map((v) => `[${v.code}] ${v.message}`).join("\n  - "),
    );
    this.name = "SafetyViolationError";
    this.violations = report.violations;
    this.report = report;
  }
}

export interface ValidateArgs {
  intersection: Intersection;
  plan: SignalPlan;
  policy?: SafetyPolicy;
  /** Pass a precomputed matrix to keep a search loop cheap; derived if absent. */
  matrix?: ConflictMatrix;
}

export function validatePlan(args: ValidateArgs): SafetyReport {
  const { intersection, plan } = args;
  const policy = args.policy ?? DEFAULT_SAFETY_POLICY;
  const matrix = args.matrix ?? deriveConflictMatrix(intersection);
  const tol = policy.timingToleranceS;
  const violations: SafetyViolation[] = [];

  const add = (
    code: ViolationCode,
    message: string,
    extra: Partial<Omit<SafetyViolation, "code" | "message">> = {},
  ): void => {
    violations.push({
      code,
      message,
      phaseId: extra.phaseId ?? null,
      movementIds: extra.movementIds ?? [],
      requiredS: extra.requiredS ?? null,
      actualS: extra.actualS ?? null,
    });
  };

  // ---- structure -------------------------------------------------------
  if (plan.intersectionId !== intersection.id) {
    add("plan_structure", `plan targets ${plan.intersectionId}, not ${intersection.id}`);
  }
  if (plan.phases.length === 0) {
    add("plan_structure", "a plan with no phases can never serve any movement");
  }
  for (const phase of plan.phases) {
    if (phase.movementIds.length === 0) {
      add("plan_structure", `phase ${phase.id} serves no movements`, { phaseId: phase.id });
    }
    for (const id of phase.movementIds) {
      if (!movementById(intersection, id)) {
        add("plan_structure", `phase ${phase.id} references unknown movement ${id}`, {
          phaseId: phase.id,
          movementIds: [id],
        });
      }
    }
    if (phase.greenS < 0 || phase.yellowS < 0 || phase.allRedS < 0) {
      add("plan_structure", `phase ${phase.id} has a negative interval`, { phaseId: phase.id });
    }
  }
  const sum = phaseSum(plan);
  if (Math.abs(sum - plan.cycleLengthS) > 0.5) {
    add(
      "plan_structure",
      `phase intervals sum to ${sum}s but the cycle is declared as ${plan.cycleLengthS}s`,
      { requiredS: plan.cycleLengthS, actualS: sum },
    );
  }

  // ---- cycle length ----------------------------------------------------
  if (plan.cycleLengthS > policy.maxCycleLengthS + tol) {
    add(
      "max_cycle_length",
      `cycle of ${plan.cycleLengthS}s exceeds the ${policy.maxCycleLengthS}s ceiling`,
      { requiredS: policy.maxCycleLengthS, actualS: plan.cycleLengthS },
    );
  }
  if (plan.cycleLengthS < policy.minCycleLengthS - tol) {
    add(
      "max_cycle_length",
      `cycle of ${plan.cycleLengthS}s is below the ${policy.minCycleLengthS}s floor`,
      { requiredS: policy.minCycleLengthS, actualS: plan.cycleLengthS },
    );
  }

  // ---- per-phase checks ------------------------------------------------
  for (const phase of plan.phases) {
    if (phase.greenS < policy.minGreenS - tol) {
      add(
        "min_green",
        `phase ${phase.id} holds ${phase.greenS}s of green, below the ${policy.minGreenS}s minimum`,
        { phaseId: phase.id, requiredS: policy.minGreenS, actualS: phase.greenS },
      );
    }

    const conflictPairs = conflictingPairsIn(matrix, phase.movementIds);
    for (const [a, b] of conflictPairs) {
      add("phase_conflict", `phase ${phase.id} holds conflicting movements ${a} and ${b} green together`, {
        phaseId: phase.id,
        movementIds: [a, b],
      });
    }

    const served = phase.movementIds
      .map((id) => movementById(intersection, id))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);

    // Change interval: sized for the fastest movement leaving this phase.
    const vehicles = served.filter(isVehicle);
    for (const m of vehicles) {
      const yellow = requiredYellowS(m, intersection, policy);
      if (phase.yellowS < yellow - tol) {
        add("change_interval", `phase ${phase.id} yellow of ${phase.yellowS}s is short of the ${yellow}s needed by ${m.id}`, {
          phaseId: phase.id,
          movementIds: [m.id],
          requiredS: yellow,
          actualS: phase.yellowS,
        });
      }
      const allRed = requiredAllRedS(m, intersection);
      if (phase.allRedS < allRed - tol) {
        add("change_interval", `phase ${phase.id} all-red of ${phase.allRedS}s is short of the ${allRed}s needed by ${m.id}`, {
          phaseId: phase.id,
          movementIds: [m.id],
          requiredS: allRed,
          actualS: phase.allRedS,
        });
      }
    }

    // Pedestrian clearance may run into the vehicle change intervals, which is
    // the only reason yellow and all-red count towards the available time.
    const available = phase.greenS + phase.yellowS + phase.allRedS;
    for (const p of served.filter(isPed)) {
      const need = requiredPedServiceS(p, policy);
      if (available < need - tol) {
        add(
          "ped_clearance",
          `phase ${phase.id} gives ${available}s to crossing ${p.id}, which needs ${need}s ` +
            `(${p.crossingDistanceM}m at no more than ${policy.maxAssumedWalkSpeedMps}m/s plus ${policy.minPedWalkS}s WALK)`,
          { phaseId: phase.id, movementIds: [p.id], requiredS: need, actualS: available },
        );
      }
    }
  }

  // ---- starvation ------------------------------------------------------
  for (const m of intersection.movements) {
    const green = greenPerCycle(plan, m.id);
    if (green <= 0) {
      add("red_starvation", `movement ${m.id} is never served: it is held red every cycle`, {
        movementIds: [m.id],
        requiredS: policy.maxRedS,
        actualS: null,
      });
      continue;
    }
    // Worst case for a movement served once per cycle: everything that is not
    // its own green is red for it.
    const red = plan.cycleLengthS - green;
    if (red > policy.maxRedS + tol) {
      add("red_starvation", `movement ${m.id} waits ${red}s of red, past the ${policy.maxRedS}s ceiling`, {
        movementIds: [m.id],
        requiredS: policy.maxRedS,
        actualS: red,
      });
    }
  }

  return {
    intersectionId: intersection.id,
    planLabel: plan.label,
    policyId: policy.id,
    ok: violations.length === 0,
    violations,
    codes: [...new Set(violations.map((v) => v.code))].sort(),
  };
}

/** Same check, as a guard. Used anywhere a plan is about to be handed onward. */
export function assertSafe(args: ValidateArgs): SafetyReport {
  const report = validatePlan(args);
  if (!report.ok) throw new SafetyViolationError(report);
  return report;
}
