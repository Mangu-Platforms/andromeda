import type { LedgerEntry, SearchRecord } from "../literature/ledger.ts";
import type { ExperimentOutcome } from "../experiment/types.ts";

/**
 * A citation as the model writes it.
 *
 * `key` is the only field the verifier needs; `doi`, `title` and `year` are
 * optional identity assertions, and every one supplied is checked against the
 * ledger. Volunteering a DOI is therefore a liability for a model that is
 * guessing, which is the point — the usual failure is a real-looking DOI on an
 * otherwise plausible sentence.
 */
export interface DraftCitation {
  key: string;
  /** Verbatim span of the cited paper's abstract that supports the statement. */
  quote: string;
  doi?: string;
  title?: string;
  year?: number;
}

export interface DraftClaim {
  id: string;
  statement: string;
  citations: DraftCitation[];
}

/** What the drafting model is asked for. It never writes a bibliography. */
export interface DraftReview {
  question: string;
  summary: string;
  claims: DraftClaim[];
  limitations: string[];
}

/** One row of the evidence table: a claim and the ledger entries behind it. */
export interface EvidenceRow {
  claimId: string;
  statement: string;
  support: Array<{
    key: string;
    quote: string;
    paper: LedgerEntry["paper"];
    sourceId: string;
    /** Which searches in this run returned the paper. */
    seenIn: string[];
  }>;
}

export interface VerifiedReview {
  question: string;
  summary: string;
  evidence: EvidenceRow[];
  /** Derived from the cited keys, never authored by a model. */
  bibliography: LedgerEntry[];
  limitations: string[];
}

export interface VerificationResult {
  ok: boolean;
  /** Human-readable, one per problem, fed back to the model on a repair pass. */
  issues: string[];
  review: VerifiedReview | null;
}

/** The reviewable document. Nothing here is publishable until it is signed. */
export interface ReviewBody {
  question: string;
  hypothesis: string;
  summary: string;
  searches: SearchRecord[];
  evidence: EvidenceRow[];
  bibliography: LedgerEntry[];
  experiments: ExperimentOutcome[];
  limitations: string[];
}

export interface SignOff {
  reviewer: string;
  note: string;
  at: number;
  approvalId: string;
  /** HMAC over the canonical body; ties the reviewer's name to this exact text. */
  signature: string;
}

export interface ReviewArtifact {
  runId: string;
  body: ReviewBody;
  publishable: boolean;
  signOff: SignOff | null;
}
