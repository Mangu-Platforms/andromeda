import type { CitationLedger } from "../literature/ledger.ts";
import type {
  DraftCitation,
  DraftReview,
  EvidenceRow,
  VerificationResult,
} from "./types.ts";

/**
 * A quote shorter than this is not evidence.
 *
 * Substring matching against an abstract is trivially satisfiable by a short
 * fragment — "we found" appears in half the corpus — so a floor on quote
 * length is what stops the grounding check from being decorative.
 */
export const MIN_QUOTE_CHARS = 40;

/** Bounds on a draft, so a runaway generation cannot make verification expensive. */
export const MAX_CLAIMS = 40;
export const MAX_CITATIONS_PER_CLAIM = 8;

export class CitationVerificationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`citation verification failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "CitationVerificationError";
    this.issues = issues;
  }
}

/**
 * Decide whether a draft is allowed to become a review.
 *
 * The rule is provenance, not plausibility: a citation is valid only if a
 * literature search *in this run* returned that exact paper, and only if the
 * quoted span really occurs in the abstract the search returned. The verifier
 * has no opinion about whether a paper exists in the world — it only knows
 * what this run retrieved, which is why a perfectly real paper that nobody
 * searched for is rejected exactly like a fabricated one.
 *
 * Everything here fails closed. Any issue at all means `ok: false` and no
 * review object; there is no "mostly verified" outcome and no way to downgrade
 * a failure to a warning.
 */
export function verifyDraft(draft: DraftReview, ledger: CitationLedger): VerificationResult {
  const issues: string[] = [];

  // Nothing can be cited in a run that never searched. Checked first because
  // every other check would otherwise report a confusing cascade.
  if (ledger.searchCount === 0) {
    return {
      ok: false,
      review: null,
      issues: [
        "no literature search completed in this run, so no claim can be cited; " +
          "a review may not be drafted from the model's own recollection",
      ],
    };
  }

  if (!draft.question?.trim()) issues.push("the review has no research question");
  if (!draft.summary?.trim()) issues.push("the review has no summary");

  const claims = Array.isArray(draft.claims) ? draft.claims : [];
  if (claims.length === 0) issues.push("the review contains no claims");
  if (claims.length > MAX_CLAIMS) {
    issues.push(`the review contains ${claims.length} claims, above the limit of ${MAX_CLAIMS}`);
  }

  const limitations = (Array.isArray(draft.limitations) ? draft.limitations : []).filter((l) =>
    l?.trim(),
  );
  if (limitations.length === 0) {
    // A systematic review with no stated limitations is not a shorter review,
    // it is a less honest one.
    issues.push("the review states no limitations");
  }

  const evidence: EvidenceRow[] = [];
  const citedKeys = new Set<string>();
  const seenClaimIds = new Set<string>();

  for (const [index, claim] of claims.slice(0, MAX_CLAIMS).entries()) {
    const label = claim?.id?.trim() || `claim#${index + 1}`;
    if (!claim?.statement?.trim()) {
      issues.push(`${label} has no statement`);
      continue;
    }
    if (seenClaimIds.has(label)) {
      issues.push(`${label} is used as the id of more than one claim`);
      continue;
    }
    seenClaimIds.add(label);

    const citations = Array.isArray(claim.citations) ? claim.citations : [];
    if (citations.length === 0) {
      issues.push(`${label} cites nothing; every claim must be attributed to a retrieved paper`);
      continue;
    }
    if (citations.length > MAX_CITATIONS_PER_CLAIM) {
      issues.push(
        `${label} has ${citations.length} citations, above the limit of ${MAX_CITATIONS_PER_CLAIM}`,
      );
      continue;
    }

    const support: EvidenceRow["support"] = [];
    for (const citation of citations) {
      const problems = checkCitation(label, citation, ledger);
      if (problems.length > 0) {
        issues.push(...problems);
        continue;
      }
      const entry = ledger.resolve(citation.key.trim());
      if (!entry) continue; // unreachable: checkCitation already resolved it
      citedKeys.add(entry.key);
      support.push({
        key: entry.key,
        quote: citation.quote.trim(),
        paper: entry.paper,
        sourceId: entry.sourceId,
        seenIn: entry.seenIn,
      });
    }

    if (support.length > 0) {
      evidence.push({ claimId: label, statement: claim.statement.trim(), support });
    }
  }

  if (issues.length > 0) return { ok: false, issues, review: null };

  // The bibliography is derived, not transcribed: it is exactly the ledger
  // entries the verified claims cite, so it cannot contain a paper nobody
  // retrieved and cannot pad itself with impressive-looking references.
  const bibliography = [...citedKeys]
    .sort()
    .flatMap((key) => {
      const entry = ledger.resolve(key);
      return entry ? [entry] : [];
    });

  return {
    ok: true,
    issues: [],
    review: {
      question: draft.question.trim(),
      summary: draft.summary.trim(),
      evidence,
      bibliography,
      limitations: limitations.map((l) => l.trim()),
    },
  };
}

export function assertVerified(draft: DraftReview, ledger: CitationLedger) {
  const result = verifyDraft(draft, ledger);
  if (!result.ok || !result.review) throw new CitationVerificationError(result.issues);
  return result.review;
}

function checkCitation(
  label: string,
  citation: DraftCitation,
  ledger: CitationLedger,
): string[] {
  const key = citation?.key?.trim() ?? "";
  if (!key) return [`${label} has a citation with no key`];

  const entry = ledger.resolve(key);
  if (!entry) {
    return [
      `${label} cites [${key}], which no literature search in this run returned. ` +
        `Known keys: ${ledger.keys().join(", ") || "(none)"}`,
    ];
  }

  const problems: string[] = [];

  // Identity assertions. A model that guesses metadata to look authoritative
  // is caught here even when the key itself happens to be real.
  if (citation.doi !== undefined && citation.doi !== "") {
    if (normalizeDoi(citation.doi) !== normalizeDoi(entry.paper.doi)) {
      problems.push(
        `${label} cites [${key}] with doi "${citation.doi}", but the retrieved record ` +
          `has doi "${entry.paper.doi || "(none)"}"`,
      );
    }
  }
  if (citation.title !== undefined && citation.title !== "") {
    if (normalizeText(citation.title) !== normalizeText(entry.paper.title)) {
      problems.push(
        `${label} cites [${key}] as "${citation.title}", but the retrieved record is titled ` +
          `"${entry.paper.title}"`,
      );
    }
  }
  if (citation.year !== undefined && citation.year !== 0) {
    if (Number(citation.year) !== entry.paper.year) {
      problems.push(
        `${label} cites [${key}] as ${citation.year}, but the retrieved record is ${entry.paper.year}`,
      );
    }
  }

  // Grounding. The citation must point at text that actually says something,
  // which is what catches a real paper attached to a claim it does not support.
  const quote = citation?.quote?.trim() ?? "";
  const normalizedQuote = normalizeText(quote);
  if (normalizedQuote.length < MIN_QUOTE_CHARS) {
    problems.push(
      `${label} supports [${key}] with a ${normalizedQuote.length}-character quote; ` +
        `at least ${MIN_QUOTE_CHARS} characters of the abstract are required`,
    );
  } else if (!normalizeText(entry.paper.abstract).includes(normalizedQuote)) {
    problems.push(
      `${label} quotes "${truncate(quote)}" from [${key}], but that text does not appear ` +
        "in the abstract that search returned",
    );
  }

  return problems;
}

/**
 * Fold away the differences a copy-paste introduces — smart quotes, en dashes,
 * line wrapping, case — without folding away words. Anything more aggressive
 * would start matching text the paper does not contain.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export const normalizeDoi = (doi: string): string =>
  doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:/, "");

const truncate = (text: string): string =>
  text.length <= 80 ? text : `${text.slice(0, 80)}...`;
