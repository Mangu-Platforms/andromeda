import { ScopeRefusedError } from "./errors.ts";

/**
 * The unauthorized-practice-of-law boundary.
 *
 * The FTC's 2025 order against DoNotPay — $193,000 in monetary relief, plus a
 * prohibition on advertising that the service performs like a lawyer without
 * evidence — is what makes this concrete rather than cautious. UPL is
 * prohibited in all fifty states, and ABA Formal Opinion 512 is explicit that
 * AI cannot replace an attorney's professional judgment.
 *
 * So the product starts in the lane where no bar licence is implicated: salary
 * and vendor terms. This module is the gate, and it fails closed — an
 * unrecognised domain is refused, not attempted.
 */

export const ALLOWED_DOMAINS = ["salary", "vendor_contract"] as const;
export type AllowedDomain = (typeof ALLOWED_DOMAINS)[number];

const REFERRAL =
  "This assistant only helps with salary and vendor-contract terms. What you " +
  "have described needs a licensed attorney in your jurisdiction; a state or " +
  "local bar referral service can name one.";

/**
 * Subject matter that pulls a negotiation into legal representation.
 *
 * Word-boundary matched rather than substring matched, so "sue" does not fire
 * on "issue" and "will" does not fire on "goodwill". Over-refusing is the
 * intended bias, but only on real signals — refusing at random would just train
 * users to phrase around the filter.
 */
const OUT_OF_SCOPE: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(lawsuit|litigation|sue|suing|plaintiff|defendant|subpoena)\b/i, reason: "litigation" },
  { pattern: /\b(court|judge|magistrate|hearing|trial|deposition)\b/i, reason: "court proceedings" },
  { pattern: /\b(visa|green ?card|asylum|deportation|immigration|uscis)\b/i, reason: "immigration" },
  { pattern: /\b(custody|divorce|alimony|prenup(?:tial)?)\b/i, reason: "family law" },
  { pattern: /\b(will|estate|probate|inheritance)\b/i, reason: "estates" },
  { pattern: /\b(patent|trademark|copyright infringement)\b/i, reason: "intellectual property disputes" },
  { pattern: /\b(criminal|felony|misdemeanou?r|plea|indictment)\b/i, reason: "criminal matters" },
  { pattern: /\b(discriminat\w*|harassment|retaliation|wrongful termination)\b/i, reason: "employment claims" },
  { pattern: /\b(sec|hipaa|gdpr|regulatory) (?:filing|complaint|investigation)\b/i, reason: "regulatory proceedings" },
  { pattern: /\b(legal advice|represent me|act as my (?:lawyer|attorney)|is this legal)\b/i, reason: "a request for legal advice" },
];

export interface ScopeCheck {
  ok: boolean;
  reasons: string[];
  referral: string;
}

export function checkScope(domain: string, subject: string): ScopeCheck {
  const reasons: string[] = [];

  if (!(ALLOWED_DOMAINS as readonly string[]).includes(domain)) {
    reasons.push(
      `"${domain}" is not one of the supported lanes (${ALLOWED_DOMAINS.join(", ")})`,
    );
  }

  for (const { pattern, reason } of OUT_OF_SCOPE) {
    if (pattern.test(subject)) reasons.push(`the request involves ${reason}`);
  }

  return { ok: reasons.length === 0, reasons, referral: REFERRAL };
}

export function assertInScope(domain: string, subject: string): AllowedDomain {
  const check = checkScope(domain, subject);
  if (!check.ok) throw new ScopeRefusedError(check.reasons, check.referral);
  return domain as AllowedDomain;
}
