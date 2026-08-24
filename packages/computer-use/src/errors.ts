/**
 * Failures this package treats as "stop the run", not "try something else".
 *
 * Every one of them is raised by a control on the untrusted path. An agent that
 * recovers from these by improvising is an agent whose controls do nothing, so
 * none of them is caught inside the pipeline loop: they propagate, the run is
 * recorded as failed, and a human reads the audit log.
 */

/** A URL outside the operator's allowlist was requested, or was landed on. */
export class NavigationBlockedError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`navigation blocked: ${url || "(empty)"} — ${reason}`);
    this.name = "NavigationBlockedError";
    this.url = url;
    this.reason = reason;
  }
}

/** The planner proposed something the action validator refused to execute. */
export class UnsafeActionError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`proposed action rejected:\n  - ${issues.join("\n  - ")}`);
    this.name = "UnsafeActionError";
    this.issues = issues;
  }
}

/**
 * The quarantined reader returned something that was not a `PageFacts` record.
 *
 * This is the interesting failure: it is what a successful injection of the
 * reader looks like from the outside, because the only thing an attacker can
 * make the reader emit is a malformed or over-long summary. It can never be an
 * action, so the correct response is to abandon the run rather than repair it.
 */
export class QuarantineViolationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`quarantined reader output rejected:\n  - ${issues.join("\n  - ")}`);
    this.name = "QuarantineViolationError";
    this.issues = issues;
  }
}
