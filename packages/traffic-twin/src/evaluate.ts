import type { DemandProfile, Intersection, SignalPlan } from "./network/types.ts";
import { simulate, type SimResult } from "./sim/mesoscopic.ts";

/**
 * Compare two plans honestly.
 *
 * The failure this module exists to prevent is the one that sells adaptive
 * signals badly: run each plan once, report the difference, and call a result
 * that was inside the noise a 20% improvement. So every comparison runs across
 * multiple seeds, reports spread as well as mean, and refuses to call a result
 * an improvement unless it holds on *every* seed.
 */

export interface EvaluateOptions {
  intersection: Intersection;
  baseline: SignalPlan;
  proposed: SignalPlan;
  demand: DemandProfile;
  /** One run per seed. Fewer than three cannot show consistency. */
  seeds?: number[];
  durationS?: number;
}

export interface MetricComparison {
  metric: string;
  unit: string;
  baselineMean: number;
  proposedMean: number;
  /** Negative means the proposed plan reduced it. */
  deltaMean: number;
  deltaPercent: number;
  /** Best and worst per-seed delta, so spread is visible. */
  deltaMin: number;
  deltaMax: number;
  /** True when every seed moved the same way. */
  consistent: boolean;
}

export type Verdict = "improvement" | "regression" | "inconclusive";

export interface Evaluation {
  intersectionId: string;
  baselineLabel: string;
  proposedLabel: string;
  demandLabel: string;
  seeds: number[];
  metrics: MetricComparison[];
  verdict: Verdict;
  /** Plain-language reasons, safe to put in front of a city engineer. */
  notes: string[];
  baselineRuns: SimResult[];
  proposedRuns: SimResult[];
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const round3 = (value: number): number => Number(value.toFixed(3));

export function evaluate(options: EvaluateOptions): Evaluation {
  const seeds = options.seeds ?? [1, 2, 3, 4, 5];
  const run = (plan: SignalPlan, seed: number): SimResult =>
    simulate({
      intersection: options.intersection,
      plan,
      demand: options.demand,
      seed,
      ...(options.durationS === undefined ? {} : { durationS: options.durationS }),
    });

  const baselineRuns = seeds.map((seed) => run(options.baseline, seed));
  const proposedRuns = seeds.map((seed) => run(options.proposed, seed));

  // Every metric is oriented so that lower is better, which keeps the
  // "consistent" test a single sign check rather than a per-metric special case.
  const extractors: Array<{ metric: string; unit: string; of: (r: SimResult) => number }> = [
    { metric: "mean control delay", unit: "s/veh", of: (r) => r.meanDelayS },
    { metric: "stops", unit: "vehicles", of: (r) => r.totalStops },
    { metric: "maximum queue", unit: "vehicles", of: (r) => r.maxQueue },
    {
      metric: "unserved demand",
      unit: "vehicles",
      of: (r) => r.totalArrivals - r.totalDepartures,
    },
  ];

  const metrics: MetricComparison[] = extractors.map(({ metric, unit, of }) => {
    const base = baselineRuns.map(of);
    const prop = proposedRuns.map(of);
    const deltas = seeds.map((_, i) => (prop[i] as number) - (base[i] as number));
    const baselineMean = mean(base);
    const proposedMean = mean(prop);
    const deltaMean = proposedMean - baselineMean;

    return {
      metric,
      unit,
      baselineMean: round3(baselineMean),
      proposedMean: round3(proposedMean),
      deltaMean: round3(deltaMean),
      deltaPercent: baselineMean === 0 ? 0 : round3((deltaMean / baselineMean) * 100),
      deltaMin: round3(Math.min(...deltas)),
      deltaMax: round3(Math.max(...deltas)),
      // Consistent means every seed agreed on the direction. A metric that
      // improved on average but got worse on one seed is not a finding.
      consistent: deltas.every((d) => d <= 0) || deltas.every((d) => d >= 0),
    };
  });

  const notes: string[] = [];
  const headline = metrics[0] as MetricComparison;

  let verdict: Verdict;
  if (!headline.consistent) {
    verdict = "inconclusive";
    notes.push(
      `Mean control delay moved in both directions across seeds (${headline.deltaMin} to ${headline.deltaMax} s/veh). ` +
        "That is noise, not a finding: run more seeds or a longer period before drawing a conclusion.",
    );
  } else if (headline.deltaMean < 0) {
    verdict = "improvement";
    notes.push(
      `Mean control delay fell by ${Math.abs(headline.deltaMean)} s/veh ` +
        `(${Math.abs(headline.deltaPercent)}%), consistently across all ${seeds.length} seeds.`,
    );
  } else if (headline.deltaMean > 0) {
    verdict = "regression";
    notes.push(
      `Mean control delay rose by ${headline.deltaMean} s/veh across all ${seeds.length} seeds.`,
    );
  } else {
    verdict = "inconclusive";
    notes.push("Mean control delay was unchanged.");
  }

  for (const metric of metrics.slice(1)) {
    if (!metric.consistent) {
      notes.push(`${metric.metric} was not consistent across seeds; treat it as unmeasured.`);
    }
  }

  if (proposedRuns.some((r) => r.oversaturated)) {
    notes.push(
      "At least one movement is oversaturated under the proposed plan. A queue model " +
        "understates delay once demand exceeds capacity, so the real figure is worse than shown.",
    );
  }

  notes.push(
    "Figures come from a queue model of a single intersection: no car-following, no " +
      "downstream network effects, no pedestrian delay. Treat them as a screening estimate.",
  );

  return {
    intersectionId: options.intersection.id,
    baselineLabel: options.baseline.label,
    proposedLabel: options.proposed.label,
    demandLabel: options.demand.label,
    seeds,
    metrics,
    verdict,
    notes,
    baselineRuns,
    proposedRuns,
  };
}
