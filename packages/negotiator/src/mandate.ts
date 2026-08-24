import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { MandateTamperedError } from "./errors.ts";
import type { IssueSpec, Mandate, MandateInput, Package, SealedMandate } from "./types.ts";
import { issueUtility, packageUtility, quantize } from "./utility.ts";

/**
 * Build and seal the mandate.
 *
 * This is the anti-anchoring control, and its whole force comes from *when* it
 * runs: before a single word from the counterpart has been read. Every number
 * in a `Mandate` is derived from the user's own inputs and their own market
 * research. Nothing downstream can raise or lower the reservation utility,
 * because nothing downstream is allowed to build a mandate — the decision
 * function takes a sealed one and verifies it.
 *
 * A counterpart can therefore anchor, flatter, threaten, invent deadlines, or
 * address the model directly, and the line does not move. The most an injection
 * achieves is a tampered mandate, which fails the integrity check and stops
 * the run.
 */

export const DISCLAIMER =
  "Prepared by an automated negotiation assistant. This is not legal advice, " +
  "and this assistant is not a lawyer. Nothing here is sent or agreed on your " +
  "behalf: you review, you send, you sign.";

export interface SealOptions {
  /** Operator-held key. Not derived from anything the counterpart can see. */
  key: string;
  now: number;
}

/** Probability-weighted value of the best outside option, in user utility. */
function batnaOf(input: MandateInput): { utility: number; label: string; pkg: Package } {
  let best = { utility: 0, label: "no outside option", pkg: {} as Package };
  for (const alternative of input.alternatives) {
    const probability = Math.min(1, Math.max(0, alternative.probability));
    // An option you probably cannot take is not worth its face value.
    const utility = packageUtility(input.issues, alternative.package, "user") * probability;
    if (utility > best.utility) {
      best = { utility, label: alternative.label, pkg: alternative.package };
    }
  }
  return best;
}

export function buildMandate(input: MandateInput, now: number): Mandate {
  if (input.issues.length === 0) throw new Error("a mandate needs at least one issue");
  const headline = input.issues.find((issue) => issue.id === input.headlineIssueId);
  if (!headline) {
    throw new Error(`headlineIssueId "${input.headlineIssueId}" is not one of the issues`);
  }
  for (const issue of input.issues) {
    if (issue.target <= issue.floor) {
      throw new Error(`issue "${issue.id}": target must exceed floor`);
    }
  }

  const batna = batnaOf(input);

  // Risk tolerance buys a premium over simply matching the BATNA. At 0 the user
  // takes any improvement; at 1 they insist on a meaningful one.
  const risk = Math.min(1, Math.max(0, input.riskTolerance));
  const switchingPremium = risk * 0.15;

  // The declared floor is a hard limit, not an input to an average: whichever
  // of the two lines is higher wins.
  const declaredFloorUtility = issueUtility(headline, input.walkAwayFloor);
  const reservationUtility = Math.min(
    0.95,
    Math.max(batna.utility + switchingPremium, declaredFloorUtility),
  );

  // Express the same line in headline units, holding every other issue at the
  // level the BATNA offers. This is the number a person can actually hold in
  // their head during a call.
  const reference: Package = {};
  for (const issue of input.issues) {
    reference[issue.id] = batna.pkg[issue.id] ?? issue.floor;
  }
  const solved = solveHeadline(input.issues, headline, reference, reservationUtility);

  return {
    version: 1,
    domain: input.domain,
    subject: input.subject,
    preparedBy: input.preparedBy,
    headlineIssueId: input.headlineIssueId,
    issues: input.issues,
    rounds: Math.max(1, Math.floor(input.rounds)),
    concessionShape: input.concessionShape,
    batnaUtility: round6(batna.utility),
    batnaLabel: batna.label,
    batnaPackage: reference,
    switchingPremium: round6(switchingPremium),
    reservationUtility: round6(reservationUtility),
    reservationHeadline: solved.value,
    reservationHeadlineAttainable: solved.attainable,
    aspirationUtility: 1,
    counterpartReservationEstimate: Math.min(
      1,
      Math.max(0, input.counterpartReservationEstimate),
    ),
    disclaimer: DISCLAIMER,
  };
}

/**
 * Smallest headline value that reaches `targetUtility` with everything else
 * held at the reference package. Reports when no value can — a mandate whose
 * headline number is unreachable must say so rather than quietly clamping to
 * the target and looking satisfiable.
 */
function solveHeadline(
  issues: readonly IssueSpec[],
  headline: IssueSpec,
  reference: Package,
  targetUtility: number,
): { value: number; attainable: boolean } {
  const test = (value: number): number =>
    packageUtility(issues, { ...reference, [headline.id]: value }, "user");

  if (test(headline.target) < targetUtility) {
    return { value: headline.target, attainable: false };
  }

  let lo = headline.floor;
  let hi = headline.target;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (test(mid) >= targetUtility) hi = mid;
    else lo = mid;
  }
  // Round up to the tradeable step so the number quoted is one that can be
  // asked for, and re-check that rounding did not drop below the line.
  const step = headline.step > 0 ? headline.step : 1;
  let value = Math.ceil(hi / step) * step;
  value = Number(Math.min(headline.target, value).toFixed(6));
  if (test(value) < targetUtility) value = quantize(headline, headline.target);
  return { value, attainable: true };
}

const round6 = (value: number): number => Number(value.toFixed(6));

function digest(mandate: Mandate, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(mandate), "utf8").digest("hex");
}

export function sealMandate(mandate: Mandate, options: SealOptions): SealedMandate {
  return {
    mandate,
    algorithm: "hmac-sha256",
    digest: digest(mandate, options.key),
    sealedAt: options.now,
  };
}

/**
 * Re-derive the digest and refuse to proceed if it moved.
 *
 * Called before *every* decision, not once at the start, so a mandate mutated
 * between rounds — by a model-authored "update", a bad merge, an edited
 * checkpoint — is caught at the next decision rather than silently negotiated
 * against.
 */
export function verifyMandate(sealed: SealedMandate, key: string): Mandate {
  if (sealed.algorithm !== "hmac-sha256") {
    throw new MandateTamperedError(sealed.digest, `unsupported:${sealed.algorithm}`);
  }
  const actual = digest(sealed.mandate, key);
  const expected = Buffer.from(sealed.digest, "hex");
  const recomputed = Buffer.from(actual, "hex");
  if (
    expected.length !== recomputed.length ||
    !timingSafeEqual(expected, recomputed)
  ) {
    throw new MandateTamperedError(sealed.digest, actual);
  }
  return sealed.mandate;
}
