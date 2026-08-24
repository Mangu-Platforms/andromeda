/** Failures this product treats as control flow. All of them fail closed. */

/**
 * Raised when a sealed mandate no longer matches its digest.
 *
 * The whole anti-anchoring design rests on the reservation value being decided
 * once, before any counterpart text is read. If something mutated it mid
 * negotiation — a model-authored "update", a bad merge, a hand-edited
 * checkpoint — the only safe response is to stop, not to negotiate against an
 * unknown mandate.
 */
export class MandateTamperedError extends Error {
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(expectedDigest: string, actualDigest: string) {
    super(
      `sealed mandate failed integrity check: expected ${expectedDigest.slice(0, 12)}…, ` +
        `recomputed ${actualDigest.slice(0, 12)}…`,
    );
    this.name = "MandateTamperedError";
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

/** Raised when a request falls outside the two allowlisted negotiation lanes. */
export class ScopeRefusedError extends Error {
  readonly reasons: string[];
  readonly referral: string;

  constructor(reasons: string[], referral: string) {
    super(`out of scope: ${reasons.join("; ")}`);
    this.name = "ScopeRefusedError";
    this.reasons = reasons;
    this.referral = referral;
  }
}

/** Raised when an artifact would leave the system without its disclaimer. */
export class DisclaimerMissingError extends Error {
  constructor(where: string) {
    super(`${where} is missing the required non-legal-advice disclaimer`);
    this.name = "DisclaimerMissingError";
  }
}
