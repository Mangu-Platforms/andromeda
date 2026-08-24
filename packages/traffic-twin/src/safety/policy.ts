/**
 * The pre-committed safety envelope.
 *
 * Every number here is a bound the optimiser is not allowed to trade away. The
 * policy is a plain record so it can be checked into a repository, reviewed by
 * an agency, and diffed — a safety limit that lives only inside a search
 * heuristic is not a limit.
 */

import type { Intersection, PedCrossing, VehicleMovement } from "../network/types.ts";

export interface SafetyPolicy {
  id: string;
  /** Absolute floor on any phase's green, regardless of demand. */
  minGreenS: number;
  /** WALK indication length before the flashing-don't-walk clearance starts. */
  minPedWalkS: number;
  /**
   * Ceiling on the walking speed a plan is allowed to *assume*. A plan that
   * buys green time by assuming athletic pedestrians is the failure mode this
   * bounds, so clearance is always computed at the slower of assumed and cap.
   */
  maxAssumedWalkSpeedMps: number;
  minYellowS: number;
  maxYellowS: number;
  /** Perception-reaction time used in the yellow-change formula. */
  driverReactionS: number;
  /** Comfortable deceleration used in the yellow-change formula. */
  decelerationMps2: number;
  minCycleLengthS: number;
  maxCycleLengthS: number;
  /** Longest continuous red any movement may be held. Bounds starvation. */
  maxRedS: number;
  /** Slack for floating-point comparison only — never a safety allowance. */
  timingToleranceS: number;
}

/**
 * Defaults are conservative readings of the usual North American practice
 * (ITE change-interval formula, MUTCD pedestrian intervals). They are starting
 * points for an agency to override, not a standard this package certifies to.
 */
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  id: "default-conservative-v1",
  minGreenS: 7,
  minPedWalkS: 7,
  maxAssumedWalkSpeedMps: 1.2,
  minYellowS: 3,
  maxYellowS: 6,
  driverReactionS: 1,
  decelerationMps2: 3,
  minCycleLengthS: 40,
  maxCycleLengthS: 150,
  maxRedS: 120,
  timingToleranceS: 1e-6,
};

const GRAVITY = 9.81;
const kphToMps = (kph: number): number => (kph * 1000) / 3600;

/**
 * ITE change-interval: reaction time plus the distance to stop from approach
 * speed, with grade working against the driver on a downhill.
 */
export function requiredYellowS(
  movement: VehicleMovement,
  intersection: Intersection,
  policy: SafetyPolicy,
): number {
  const v = kphToMps(movement.approachSpeedKph);
  const effectiveDecel = policy.decelerationMps2 + GRAVITY * (intersection.gradePercent / 100);
  if (effectiveDecel <= 0) return policy.maxYellowS;
  const raw = policy.driverReactionS + v / (2 * effectiveDecel);
  return Math.min(policy.maxYellowS, Math.max(policy.minYellowS, round2(raw)));
}

/** Time for the last vehicle entering on yellow to clear the conflict area. */
export function requiredAllRedS(
  movement: VehicleMovement,
  intersection: Intersection,
): number {
  const v = kphToMps(movement.approachSpeedKph);
  if (v <= 0) return 0;
  return round2((intersection.clearanceWidthM + intersection.designVehicleLengthM) / v);
}

/**
 * WALK plus the time to cross at the *capped* assumed speed. Computing at the
 * cap rather than the plan's own assumption is what makes an optimistic plan
 * fail validation instead of quietly shortening the crossing.
 */
export function requiredPedServiceS(crossing: PedCrossing, policy: SafetyPolicy): number {
  const speed = Math.min(crossing.assumedWalkSpeedMps, policy.maxAssumedWalkSpeedMps);
  if (speed <= 0) return Number.POSITIVE_INFINITY;
  return round2(policy.minPedWalkS + crossing.crossingDistanceM / speed);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
