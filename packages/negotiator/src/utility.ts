import type { IssueSpec, Package } from "./types.ts";

/**
 * Multi-issue utility.
 *
 * Every issue is oriented so a higher raw value is better for the user, which
 * is what lets one formula serve both sides: the user's utility on an issue is
 * its normalised position between floor and target, and the counterpart's is
 * the complement. Log-rolling falls out of this — when the two sides weight
 * issues differently, there are packages that are better for both than a
 * straight split, and `improve` finds them.
 */

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function normalizedWeights(
  issues: readonly IssueSpec[],
  side: "user" | "counterpart",
): Map<string, number> {
  const pick = (issue: IssueSpec): number =>
    side === "user" ? issue.weight : issue.counterpartWeight;
  const total = issues.reduce((sum, issue) => sum + Math.max(0, pick(issue)), 0);
  const out = new Map<string, number>();
  for (const issue of issues) {
    // A degenerate weight vector becomes uniform rather than dividing by zero.
    out.set(issue.id, total > 0 ? Math.max(0, pick(issue)) / total : 1 / issues.length);
  }
  return out;
}

/** Position of `value` between the user's floor and target, clamped to 0..1. */
export function issueUtility(issue: IssueSpec, value: number): number {
  const span = issue.target - issue.floor;
  if (span <= 0) throw new Error(`issue "${issue.id}": target must exceed floor`);
  return clamp01((value - issue.floor) / span);
}

export function packageUtility(
  issues: readonly IssueSpec[],
  pkg: Package,
  side: "user" | "counterpart" = "user",
): number {
  const weights = normalizedWeights(issues, side);
  let total = 0;
  for (const issue of issues) {
    const raw = pkg[issue.id];
    if (raw === undefined) {
      // A partial package would silently score as though the missing issue sat
      // at the floor, which reads as a worse offer than was actually made.
      throw new Error(`package is missing issue "${issue.id}"`);
    }
    const user = issueUtility(issue, raw);
    total += (weights.get(issue.id) ?? 0) * (side === "user" ? user : 1 - user);
  }
  return clamp01(total);
}

/** True when `a` is at least as good as `b` for both sides, and better for one. */
export function paretoDominates(
  issues: readonly IssueSpec[],
  a: Package,
  b: Package,
): boolean {
  const au = packageUtility(issues, a, "user");
  const bu = packageUtility(issues, b, "user");
  const ac = packageUtility(issues, a, "counterpart");
  const bc = packageUtility(issues, b, "counterpart");
  const epsilon = 1e-9;
  const noWorse = au >= bu - epsilon && ac >= bc - epsilon;
  const strictlyBetter = au > bu + epsilon || ac > bc + epsilon;
  return noWorse && strictlyBetter;
}

/**
 * Nash bargaining product, measured from both sides' reservation utilities.
 * Zero when either side is at or below its own walk-away point, which is the
 * arithmetic saying what it should: that is not a deal, it is a surrender.
 */
export function nashProduct(
  issues: readonly IssueSpec[],
  pkg: Package,
  userReservation: number,
  counterpartReservation: number,
): number {
  const user = packageUtility(issues, pkg, "user") - userReservation;
  const counterpart = packageUtility(issues, pkg, "counterpart") - counterpartReservation;
  return user <= 0 || counterpart <= 0 ? 0 : user * counterpart;
}

/** Snap to the granularity the parties actually trade in, and clamp to range. */
export function quantize(issue: IssueSpec, value: number): number {
  const step = issue.step > 0 ? issue.step : 1;
  const lo = Math.min(issue.floor, issue.target);
  const hi = Math.max(issue.floor, issue.target);
  const snapped = Math.round(value / step) * step;
  const bounded = Math.min(hi, Math.max(lo, snapped));
  // Re-round to kill binary float dust like 0.30000000000000004.
  return Number(bounded.toFixed(6));
}

/**
 * Build a package worth about `targetUtility` to the user, conceding first
 * where it costs the user least per unit of counterpart gain.
 *
 * This is the log-rolling engine. Sorting by the user-cost to counterpart-gain
 * ratio means the concessions handed over are the ones the counterpart values
 * most and the user values least, so the resulting package tends to be
 * Pareto-efficient rather than merely cheaper.
 */
export function packageForUtility(
  issues: readonly IssueSpec[],
  targetUtility: number,
): Package {
  const userWeights = normalizedWeights(issues, "user");
  const counterpartWeights = normalizedWeights(issues, "counterpart");

  // Start from the user's aspiration, then concede down to the target.
  const pkg: Package = {};
  for (const issue of issues) pkg[issue.id] = issue.target;

  const order = [...issues].sort((a, b) => {
    const ratio = (issue: IssueSpec): number => {
      const cost = userWeights.get(issue.id) ?? 0;
      const gain = counterpartWeights.get(issue.id) ?? 0;
      // Cheap for the user and valuable to them: concede this first.
      return gain <= 0 ? Number.POSITIVE_INFINITY : cost / gain;
    };
    return ratio(a) - ratio(b);
  });

  for (const issue of order) {
    if (packageUtility(issues, pkg, "user") <= targetUtility) break;
    const weight = userWeights.get(issue.id) ?? 0;
    if (weight <= 0) {
      pkg[issue.id] = issue.floor;
      continue;
    }
    const current = packageUtility(issues, pkg, "user");
    const surplus = current - targetUtility;
    // How far down this issue can go before it overshoots the target utility.
    const dropInIssueUtility = Math.min(1, surplus / weight);
    const span = issue.target - issue.floor;
    const next = issue.target - dropInIssueUtility * span;
    pkg[issue.id] = quantize(issue, next);
  }

  for (const issue of issues) pkg[issue.id] = quantize(issue, pkg[issue.id] as number);
  return pkg;
}

/**
 * Find a package that is better for both sides than `pkg`, if one exists.
 * Returns null when `pkg` is already on the frontier for the issue grid.
 */
export function improve(issues: readonly IssueSpec[], pkg: Package): Package | null {
  let best: Package | null = null;

  // Pairwise trades only: give up a step on one issue, take a step on another.
  // Enough to detect the failure that matters — a package left on the table
  // because nobody tried swapping two differently-weighted issues.
  for (const give of issues) {
    for (const take of issues) {
      if (give.id === take.id) continue;
      const candidate: Package = { ...pkg };
      const giveValue = (pkg[give.id] as number) - give.step;
      const takeValue = (pkg[take.id] as number) + take.step;
      candidate[give.id] = quantize(give, giveValue);
      candidate[take.id] = quantize(take, takeValue);
      if (candidate[give.id] === pkg[give.id] && candidate[take.id] === pkg[take.id]) continue;
      if (paretoDominates(issues, candidate, pkg)) {
        if (!best || paretoDominates(issues, candidate, best)) best = candidate;
      }
    }
  }
  return best;
}
