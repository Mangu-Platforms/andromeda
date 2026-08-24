/**
 * Geometry and signal-plan data for a single signalised intersection.
 *
 * Everything here is plain JSON data. Nothing in this package holds a handle to
 * a field device, and no type in this file can be turned into one — a plan is a
 * description of timings, not an instruction to anything.
 */

/** Approach legs, named by compass point, in clockwise order. */
export type LegId = "N" | "E" | "S" | "W";

export type Turn = "left" | "through" | "right";

/**
 * One vehicular movement: everything entering from `from` and making `turn`.
 *
 * Right turns are folded into the through group unless a separate movement is
 * declared, which is the usual lane-group abstraction for a queue model.
 */
export interface VehicleMovement {
  kind: "vehicle";
  id: string;
  from: LegId;
  turn: Turn;
  lanes: number;
  /** Saturation flow per lane, vehicles per hour of green. */
  saturationFlowVphpl: number;
  /** 85th-percentile approach speed, used to derive yellow and all-red. */
  approachSpeedKph: number;
  /** Length of approach modelled, for the free-flow part of travel time. */
  approachLengthM: number;
}

/**
 * A marked crossing over one leg's carriageway.
 *
 * `assumedWalkSpeedMps` is a property of the *plan's assumption*, not of any
 * real pedestrian, which is why the safety policy caps it: a plan that buys
 * green time by assuming fast walkers is the failure mode this bounds.
 */
export interface PedCrossing {
  kind: "ped";
  id: string;
  across: LegId;
  crossingDistanceM: number;
  assumedWalkSpeedMps: number;
}

export type Movement = VehicleMovement | PedCrossing;

export interface Intersection {
  id: string;
  name: string;
  movements: Movement[];
  /** Distance a clearing vehicle must travel to leave the conflict area. */
  clearanceWidthM: number;
  designVehicleLengthM: number;
  /** Approach grade in percent; positive is uphill. Affects yellow. */
  gradePercent: number;
}

/** One interval of the cycle: a set of movements held green together. */
export interface PhaseTiming {
  id: string;
  movementIds: string[];
  greenS: number;
  yellowS: number;
  allRedS: number;
}

export interface SignalPlan {
  intersectionId: string;
  label: string;
  cycleLengthS: number;
  phases: PhaseTiming[];
}

export const isVehicle = (m: Movement): m is VehicleMovement => m.kind === "vehicle";
export const isPed = (m: Movement): m is PedCrossing => m.kind === "ped";

export function movementById(intersection: Intersection, id: string): Movement | undefined {
  return intersection.movements.find((m) => m.id === id);
}

export const vehicleMovements = (intersection: Intersection): VehicleMovement[] =>
  intersection.movements.filter(isVehicle);

export const pedCrossings = (intersection: Intersection): PedCrossing[] =>
  intersection.movements.filter(isPed);

/** Total green seconds a movement receives per cycle. */
export function greenPerCycle(plan: SignalPlan, movementId: string): number {
  return plan.phases
    .filter((p) => p.movementIds.includes(movementId))
    .reduce((sum, p) => sum + p.greenS, 0);
}

/** Sum of green + yellow + all-red across every phase. */
export function phaseSum(plan: SignalPlan): number {
  return plan.phases.reduce((sum, p) => sum + p.greenS + p.yellowS + p.allRedS, 0);
}

/**
 * Vehicle demand at one intersection, in vehicles per hour per movement.
 *
 * Lives with the network rather than with a simulator: demand is an observed
 * property of the site, and any evaluator — the queue model here, or a real
 * microsimulation later — consumes the same profile.
 */
export interface DemandProfile {
  intersectionId: string;
  /** Human-readable period, e.g. "weekday AM peak". */
  label: string;
  /** Movement id -> vehicles per hour. */
  vph: Record<string, number>;
}
