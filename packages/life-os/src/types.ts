/** Core vocabulary shared by the domain agents, the coordinator and the brief. */

export type DomainId = "calendar" | "finance" | "health" | "mail";

export const DOMAIN_IDS: readonly DomainId[] = ["calendar", "finance", "health", "mail"];

export const isDomainId = (value: string): value is DomainId =>
  (DOMAIN_IDS as readonly string[]).includes(value);

/**
 * Typed consequences of a proposal.
 *
 * Conflict detection runs over these and nothing else. That is deliberate: the
 * coordinator must be able to compare a health proposal against a calendar
 * commitment without either domain seeing the other's connector data, so the
 * only thing that crosses a domain boundary is a small, structured effect.
 */
export interface TimeEffect {
  kind: "time";
  startMs: number;
  endMs: number;
  label: string;
}

export interface SpendEffect {
  kind: "spend";
  /** Always positive. Money leaving an account. */
  amountCents: number;
  account: string;
  label: string;
}

/** A recommendation for or against something, so two domains can be caught disagreeing. */
export interface StanceEffect {
  kind: "stance";
  topic: string;
  stance: "do" | "avoid";
  label: string;
}

/**
 * A spending ceiling published by the finance domain. Only ever valid on a
 * commitment — a domain that could attach one to a proposal could raise its own
 * cap, so `validateProposal` rejects it there.
 */
export interface BudgetEffect {
  kind: "budget";
  account: string;
  capCents: number;
  committedCents: number;
  label: string;
}

export type Effect = TimeEffect | SpendEffect | StanceEffect | BudgetEffect;

export type Urgency = 0 | 1 | 2 | 3;

/**
 * One ranked suggestion from one domain.
 *
 * `claimedReversibility` and `confidence` are what the domain says about
 * itself. Neither is trusted: reversibility comes from the action catalog and
 * conflicts are never settled by comparing confidences.
 */
export interface Proposal {
  id: string;
  domain: DomainId;
  actionKind: string;
  title: string;
  detail: string;
  urgency: Urgency;
  confidence: number;
  claimedReversibility?: "reversible" | "irreversible";
  effects: Effect[];
  /** Connector item ids this came from, for the audit trail. */
  sources: string[];
}

/**
 * A fact a domain publishes purely so cross-domain conflicts can be detected —
 * a busy interval, a budget ceiling. Carries no connector content.
 */
export interface Commitment {
  domain: DomainId;
  id: string;
  effect: Effect;
}

/** A message or invite whose text tried to steer the agent. Reported, never acted on. */
export interface QuarantineNote {
  domain: DomainId;
  connectorId: string;
  itemId: string;
  patterns: string[];
}

export interface DomainReport {
  domain: DomainId;
  proposals: Proposal[];
  commitments: Commitment[];
  quarantined: QuarantineNote[];
  /** Human-readable note when a domain deliberately proposed nothing. */
  note: string;
}

export type ConflictKind = "time_overlap" | "budget_exceeded" | "contradiction";

/**
 * Two things the user cannot have at once.
 *
 * There is no `resolution` field and no `winner` field, on purpose. The product
 * refuses to optimise across domains; it presents the trade-off and the options
 * and stops.
 */
export interface Conflict {
  id: string;
  kind: ConflictKind;
  summary: string;
  proposalIds: string[];
  domains: DomainId[];
  /** Choices offered to the human. The system never picks one. */
  options: string[];
}

export type Disposition = "auto" | "needs_approval" | "blocked_by_conflict";

export interface RankedProposal {
  proposal: Proposal;
  rank: number;
  disposition: Disposition;
  reason: string;
  /** Catalog classification. Authoritative; overrides anything the domain claimed. */
  reversibility: "reversible" | "irreversible";
  stakes: "low" | "high";
}

export interface RejectedProposal {
  proposalId: string;
  domain: DomainId;
  actionKind: string;
  reason: string;
}
