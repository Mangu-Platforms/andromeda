import type {
  DemandProfile,
  Intersection,
  SignalPlan,
  VehicleMovement,
} from "../network/types.ts";
import { greenPerCycle, phaseSum, vehicleMovements } from "../network/types.ts";

/**
 * A deterministic queue-based (mesoscopic) simulation of one intersection.
 *
 * Vehicles arrive by a seeded Poisson-ish process per movement and discharge at
 * saturation flow while their movement holds green. That is enough to compare
 * two signal plans on the same demand, and it is honest about what it is: a
 * queue model, not a microsimulation. It has no car-following, no lane changing,
 * no turning-conflict gap acceptance, and no network — so it can tell a city
 * that plan B clears the queue faster than plan A, and it cannot tell them what
 * happens at the next junction downstream.
 *
 * Determinism is a requirement rather than a convenience: an advisory tool
 * whose numbers move between runs cannot be reviewed.
 */

/** Small deterministic PRNG (mulberry32). Same seed, same run, always. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimOptions {
  intersection: Intersection;
  plan: SignalPlan;
  demand: DemandProfile;
  seed: number;
  /** Simulated period. One hour by default, matching demand's units. */
  durationS?: number;
  /** Integration step. One second is plenty for a queue model. */
  stepS?: number;
}

export interface MovementResult {
  movementId: string;
  arrivals: number;
  departures: number;
  /** Vehicles still queued when the period ended. */
  endQueue: number;
  /** Mean seconds of control delay per arriving vehicle. */
  meanDelayS: number;
  maxQueue: number;
  /** Fraction of arrivals that had to stop. */
  stopRate: number;
  /** Demand as a fraction of capacity. Above 1 the queue never clears. */
  volumeToCapacity: number;
}

export interface SimResult {
  seed: number;
  planLabel: string;
  durationS: number;
  totalArrivals: number;
  totalDepartures: number;
  /** Arrival-weighted mean control delay, the headline number. */
  meanDelayS: number;
  totalStops: number;
  maxQueue: number;
  /** True when any movement ended oversaturated; comparisons get shakier. */
  oversaturated: boolean;
  movements: MovementResult[];
}

/** Green seconds available to a movement per cycle, as a rate. */
function capacityVph(movement: VehicleMovement, plan: SignalPlan): number {
  const cycle = plan.cycleLengthS > 0 ? plan.cycleLengthS : phaseSum(plan);
  if (cycle <= 0) return 0;
  const green = greenPerCycle(plan, movement.id);
  return movement.saturationFlowVphpl * movement.lanes * (green / cycle);
}

/** Whether `movementId` is green at `t` seconds into the cycle. */
function greenAt(plan: SignalPlan, movementId: string, tInCycle: number): boolean {
  let cursor = 0;
  for (const phase of plan.phases) {
    const start = cursor;
    const greenEnd = start + phase.greenS;
    cursor = greenEnd + phase.yellowS + phase.allRedS;
    if (tInCycle >= start && tInCycle < greenEnd) {
      return phase.movementIds.includes(movementId);
    }
  }
  return false;
}

export function simulate(options: SimOptions): SimResult {
  const { intersection, plan, demand } = options;
  const durationS = options.durationS ?? 3600;
  const stepS = options.stepS ?? 1;
  const cycle = plan.cycleLengthS > 0 ? plan.cycleLengthS : phaseSum(plan);
  const movements = vehicleMovements(intersection);
  const random = rng(options.seed);

  interface State {
    movement: VehicleMovement;
    queue: number;
    arrivals: number;
    departures: number;
    /** Vehicle-seconds of delay, accumulated over the queue each step. */
    delayVehS: number;
    stops: number;
    maxQueue: number;
    /** Carried fractional discharge, so saturation flow is not rounded away. */
    dischargeCredit: number;
  }

  const states: State[] = movements.map((movement) => ({
    movement,
    queue: 0,
    arrivals: 0,
    departures: 0,
    delayVehS: 0,
    stops: 0,
    maxQueue: 0,
    dischargeCredit: 0,
  }));

  for (let t = 0; t < durationS; t += stepS) {
    const tInCycle = cycle > 0 ? t % cycle : 0;

    for (const state of states) {
      const vph = Math.max(0, demand.vph[state.movement.id] ?? 0);
      const expected = (vph / 3600) * stepS;

      // Poisson arrivals by inversion. At these rates the loop runs once or
      // twice, and it keeps the process genuinely stochastic rather than
      // spreading a fractional vehicle evenly across every step.
      let arrivals = 0;
      let product = Math.exp(-expected);
      let cumulative = product;
      const roll = random();
      while (roll > cumulative && arrivals < 20) {
        arrivals++;
        product *= expected / arrivals;
        cumulative += product;
      }

      state.arrivals += arrivals;
      const isGreen = greenAt(plan, state.movement.id, tInCycle);

      // A vehicle arriving on green into an empty queue passes without
      // stopping; anything else joins the queue.
      if (isGreen && state.queue === 0) {
        const saturationPerStep =
          (state.movement.saturationFlowVphpl * state.movement.lanes * stepS) / 3600;
        const passes = Math.min(arrivals, Math.floor(saturationPerStep + state.dischargeCredit));
        state.departures += passes;
        state.queue += arrivals - passes;
        state.stops += arrivals - passes;
      } else {
        state.queue += arrivals;
        state.stops += arrivals;
      }

      if (isGreen && state.queue > 0) {
        const saturationPerStep =
          (state.movement.saturationFlowVphpl * state.movement.lanes * stepS) / 3600;
        state.dischargeCredit += saturationPerStep;
        const discharged = Math.min(state.queue, Math.floor(state.dischargeCredit));
        state.dischargeCredit -= discharged;
        state.queue -= discharged;
        state.departures += discharged;
      }

      // Everyone still queued waited this whole step.
      state.delayVehS += state.queue * stepS;
      if (state.queue > state.maxQueue) state.maxQueue = state.queue;
    }
  }

  const results: MovementResult[] = states.map((state) => {
    const capacity = capacityVph(state.movement, plan);
    const vph = Math.max(0, demand.vph[state.movement.id] ?? 0);
    return {
      movementId: state.movement.id,
      arrivals: state.arrivals,
      departures: state.departures,
      endQueue: state.queue,
      meanDelayS: state.arrivals > 0 ? round3(state.delayVehS / state.arrivals) : 0,
      maxQueue: state.maxQueue,
      stopRate: state.arrivals > 0 ? round3(state.stops / state.arrivals) : 0,
      volumeToCapacity: capacity > 0 ? round3(vph / capacity) : Number.POSITIVE_INFINITY,
    };
  });

  const totalArrivals = results.reduce((sum, r) => sum + r.arrivals, 0);
  const totalDelay = states.reduce((sum, s) => sum + s.delayVehS, 0);

  return {
    seed: options.seed,
    planLabel: plan.label,
    durationS,
    totalArrivals,
    totalDepartures: results.reduce((sum, r) => sum + r.departures, 0),
    meanDelayS: totalArrivals > 0 ? round3(totalDelay / totalArrivals) : 0,
    totalStops: states.reduce((sum, s) => sum + s.stops, 0),
    maxQueue: results.reduce((max, r) => Math.max(max, r.maxQueue), 0),
    oversaturated: results.some((r) => r.volumeToCapacity > 1),
    movements: results,
  };
}

const round3 = (value: number): number => Number(value.toFixed(3));
