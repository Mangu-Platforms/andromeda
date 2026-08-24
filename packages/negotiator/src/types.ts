/**
 * Domain types.
 *
 * One convention holds the arithmetic together: **every issue is oriented so
 * that a higher raw value is better for the user and worse for the
 * counterpart.** A start date is therefore expressed as "days until start"
 * (later = better for a candidate, worse for an employer who wants the seat
 * filled). Without that convention the Pareto and Nash computations below would
 * need a per-issue direction flag that every call site could get wrong.
 */

/** Raw terms, keyed by issue id. Complete packages only — a hole is an error. */
export type Package = Record<string, number>;

export type ConcessionShape = "linear" | "boulware" | "conceder";

export interface IssueSpec {
  id: string;
  label: string;
  unit: string;
  /** The user's walk-away level on this issue. Utility 0. */
  floor: number;
  /** The user's aspiration on this issue. Utility 1. Must exceed `floor`. */
  target: number;
  /** The user's relative importance. Normalized across issues. */
  weight: number;
  /**
   * The user's *estimate* of the counterpart's relative importance, from market
   * research entered up front. It is never revised from what the counterpart
   * says — a counterpart who claims an issue is untouchable is making a claim,
   * not supplying data.
   */
  counterpartWeight: number;
  /** Granularity the parties actually trade in (e.g. whole PTO days). */
  step: number;
}

/** An outside option, priced before the negotiation opens. */
export interface Alternative {
  label: string;
  package: Package;
  /** Probability the user could actually take it, 0-1. */
  probability: number;
}

/** Everything the user supplies. Contains no counterpart-authored text. */
export interface MandateInput {
  domain: string;
  subject: string;
  preparedBy: string;
  /** Issue whose units the headline reservation number is reported in. */
  headlineIssueId: string;
  issues: IssueSpec[];
  alternatives: Alternative[];
  /** Declared absolute floor, in the headline issue's units. */
  walkAwayFloor: number;
  /** 0 = take any improvement over the BATNA; 1 = insist on a real premium. */
  riskTolerance: number;
  /** Rounds the user is willing to run before walking. */
  rounds: number;
  concessionShape: ConcessionShape;
  /** Estimated counterpart reservation utility, 0-1. Research, not dialogue. */
  counterpartReservationEstimate: number;
}

/** The frozen mandate. Every number here is derived from `MandateInput` alone. */
export interface Mandate {
  version: 1;
  domain: string;
  subject: string;
  preparedBy: string;
  headlineIssueId: string;
  issues: IssueSpec[];
  rounds: number;
  concessionShape: ConcessionShape;
  /** Best probability-weighted outside option, in user utility. */
  batnaUtility: number;
  batnaLabel: string;
  /** Non-headline terms of the best outside option; the reference point. */
  batnaPackage: Package;
  /** Premium over the BATNA that makes switching worth it. */
  switchingPremium: number;
  /** The line. Below this, walking away is better than the deal. */
  reservationUtility: number;
  /** The same line in headline units, holding other issues at BATNA levels. */
  reservationHeadline: number;
  /** False when no headline value alone can reach the reservation line. */
  reservationHeadlineAttainable: boolean;
  aspirationUtility: number;
  counterpartReservationEstimate: number;
  disclaimer: string;
}

/** A mandate plus its keyed digest. Serializable; survives a checkpoint. */
export interface SealedMandate {
  mandate: Mandate;
  algorithm: "hmac-sha256";
  digest: string;
  sealedAt: number;
}

/** The only thing the decision function is allowed to know about a message. */
export interface OfferOnTable {
  /** 1-based. Supplied by the pipeline, never read from counterpart text. */
  round: number;
  package: Package;
}

export type DecisionKind = "accept" | "counter" | "walk_away";

export interface Decision {
  kind: DecisionKind;
  round: number;
  offerUtility: number;
  /** What the frozen concession schedule asks for in this round. */
  askUtility: number;
  reservationUtility: number;
  /** Ties the decision to the exact mandate it was computed against. */
  mandateDigest: string;
  rationale: string[];
}
