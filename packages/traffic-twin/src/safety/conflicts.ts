/**
 * The conflict matrix: which movements may never be green at the same time.
 *
 * This is derived from geometry rather than hand-listed, because a hand-listed
 * matrix is exactly the artefact that silently rots when someone edits a plan.
 *
 * The model: an intersection is a ring of eight points, two per leg — the
 * inbound stop line and the outbound receiving lanes. Driving on the right, the
 * inbound side of a leg comes first when travelling clockwise around the ring,
 * so the clockwise order is N-in, N-out, E-in, E-out, S-in, S-out, W-in, W-out.
 *
 * Every vehicle movement is then a chord across that ring, and two vehicle
 * paths cross — i.e. conflict — exactly when their chord endpoints interleave.
 * Movements that share an endpoint (same stop line, or merging into the same
 * receiving lanes) do not cross.
 *
 * Pedestrians are handled separately: a crossing over leg L conflicts with
 * every vehicle movement that enters from L or discharges into L.
 */

import type { Intersection, LegId, Movement, Turn, VehicleMovement } from "../network/types.ts";
import { isPed, isVehicle } from "../network/types.ts";

/** Clockwise leg order. Index arithmetic below depends on it. */
const LEGS: readonly LegId[] = ["N", "E", "S", "W"];

const legIndex = (leg: LegId): number => LEGS.indexOf(leg);

/** Where a movement from `leg` making `turn` leaves the intersection. */
export function destinationLeg(from: LegId, turn: Turn): LegId {
  const i = legIndex(from);
  const offset = turn === "through" ? 2 : turn === "left" ? 1 : 3;
  const leg = LEGS[(i + offset) % 4];
  // LEGS has exactly four entries and the modulus keeps us inside it.
  return leg as LegId;
}

const inPoint = (leg: LegId): number => legIndex(leg) * 2;
const outPoint = (leg: LegId): number => legIndex(leg) * 2 + 1;

/** Whether `x` lies strictly between `a` and `b` travelling clockwise from `a`. */
function strictlyBetween(x: number, a: number, b: number): boolean {
  const span = (b - a + 8) % 8;
  const offset = (x - a + 8) % 8;
  return offset > 0 && offset < span;
}

/** Two chords of the ring cross iff exactly one endpoint of B is inside A. */
function chordsCross(a1: number, a2: number, b1: number, b2: number): boolean {
  if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) return false;
  const inside = (strictlyBetween(b1, a1, a2) ? 1 : 0) + (strictlyBetween(b2, a1, a2) ? 1 : 0);
  return inside === 1;
}

const vehicleChord = (m: VehicleMovement): [number, number] => [
  inPoint(m.from),
  outPoint(destinationLeg(m.from, m.turn)),
];

/** True when the two movements may never hold green simultaneously. */
export function movementsConflict(a: Movement, b: Movement): boolean {
  if (a.id === b.id) return false;
  if (isPed(a) && isPed(b)) return false;
  if (isPed(a) || isPed(b)) {
    const ped = isPed(a) ? a : (b as Extract<Movement, { kind: "ped" }>);
    const veh = isPed(a) ? (b as VehicleMovement) : (a as VehicleMovement);
    return veh.from === ped.across || destinationLeg(veh.from, veh.turn) === ped.across;
  }
  const [a1, a2] = vehicleChord(a as VehicleMovement);
  const [b1, b2] = vehicleChord(b as VehicleMovement);
  return chordsCross(a1, a2, b1, b2);
}

/**
 * Frozen pair list for one intersection. Stored as sorted `"a|b"` keys so a
 * matrix survives JSON round-tripping through a workflow checkpoint.
 */
export interface ConflictMatrix {
  intersectionId: string;
  pairs: string[];
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function deriveConflictMatrix(intersection: Intersection): ConflictMatrix {
  const pairs = new Set<string>();
  const ms = intersection.movements;
  for (let i = 0; i < ms.length; i++) {
    for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i];
      const b = ms[j];
      if (!a || !b) continue;
      if (movementsConflict(a, b)) pairs.add(pairKey(a.id, b.id));
    }
  }
  return { intersectionId: intersection.id, pairs: [...pairs].sort() };
}

export function conflicts(matrix: ConflictMatrix, a: string, b: string): boolean {
  return a !== b && matrix.pairs.includes(pairKey(a, b));
}

/** Every conflicting pair inside a single set of concurrently green movements. */
export function conflictingPairsIn(
  matrix: ConflictMatrix,
  movementIds: readonly string[],
): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (let i = 0; i < movementIds.length; i++) {
    for (let j = i + 1; j < movementIds.length; j++) {
      const a = movementIds[i];
      const b = movementIds[j];
      if (a === undefined || b === undefined) continue;
      if (conflicts(matrix, a, b)) found.push(a < b ? [a, b] : [b, a]);
    }
  }
  return found;
}

/** Sanity check used by tests and by the pipeline's envelope step. */
export const vehicleMovementIds = (intersection: Intersection): string[] =>
  intersection.movements.filter(isVehicle).map((m) => m.id);
