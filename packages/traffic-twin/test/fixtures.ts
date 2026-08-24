/**
 * One ordinary four-leg signalised intersection, used by every test.
 *
 * Six vehicle movements (protected lefts on the N-S axis, throughs on both
 * axes) and four pedestrian crossings, served by a conventional three-phase
 * plan. The numbers are plausible but invented — this is a fixture, not a
 * calibrated site.
 */

import type { DemandProfile } from "../src/sim/mesoscopic.ts";
import type { Intersection, SignalPlan } from "../src/network/types.ts";

export function sampleIntersection(): Intersection {
  const veh = (
    id: string,
    from: "N" | "E" | "S" | "W",
    turn: "left" | "through" | "right",
    lanes: number,
  ) =>
    ({
      kind: "vehicle" as const,
      id,
      from,
      turn,
      lanes,
      saturationFlowVphpl: 1800,
      approachSpeedKph: 50,
      approachLengthM: 200,
    });

  const ped = (id: string, across: "N" | "E" | "S" | "W") =>
    ({
      kind: "ped" as const,
      id,
      across,
      crossingDistanceM: 14,
      assumedWalkSpeedMps: 1.2,
    });

  return {
    id: "int-12th-and-market",
    name: "12th & Market",
    clearanceWidthM: 18,
    designVehicleLengthM: 5,
    gradePercent: 0,
    movements: [
      veh("n_left", "N", "left", 1),
      veh("n_through", "N", "through", 2),
      veh("s_left", "S", "left", 1),
      veh("s_through", "S", "through", 2),
      veh("e_through", "E", "through", 2),
      veh("w_through", "W", "through", 2),
      ped("ped_n", "N"),
      ped("ped_e", "E"),
      ped("ped_s", "S"),
      ped("ped_w", "W"),
    ],
  };
}

/** The plan the agency runs today: the honest comparator for anything proposed. */
export function baselinePlan(): SignalPlan {
  return {
    intersectionId: "int-12th-and-market",
    label: "existing fixed-time AM",
    cycleLengthS: 83,
    phases: [
      { id: "A", movementIds: ["n_left", "s_left"], greenS: 10, yellowS: 4, allRedS: 2 },
      {
        id: "B",
        movementIds: ["n_through", "s_through", "ped_e", "ped_w"],
        greenS: 30,
        yellowS: 4,
        allRedS: 2,
      },
      {
        id: "C",
        movementIds: ["e_through", "w_through", "ped_n", "ped_s"],
        greenS: 25,
        yellowS: 4,
        allRedS: 2,
      },
    ],
  };
}

export function sampleDemand(): DemandProfile {
  return {
    intersectionId: "int-12th-and-market",
    label: "weekday AM peak (synthetic)",
    vph: {
      n_left: 150,
      n_through: 600,
      s_left: 120,
      s_through: 500,
      e_through: 700,
      w_through: 650,
    },
  };
}

/** Deep copy so a test that mutates a plan cannot leak into the next test. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
