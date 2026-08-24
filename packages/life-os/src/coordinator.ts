import type { ActionSpec } from "./catalog.ts";
import { classifyAction, isAutonomous } from "./catalog.ts";
import { money } from "./domains/types.ts";
import type {
  BudgetEffect,
  Commitment,
  Conflict,
  DomainId,
  DomainReport,
  Proposal,
  QuarantineNote,
  RankedProposal,
  RejectedProposal,
  SpendEffect,
  StanceEffect,
  TimeEffect,
} from "./types.ts";
import { flattenText } from "./untrusted.ts";

/**
 * Each domain agent gets a small, fixed number of slots. The cap is a control,
 * not ergonomics: an agent that can emit fifty proposals can bury a conflicting
 * one in noise, and a reviewer reading a daily brief will not find it.
 */
export const MAX_PROPOSALS_PER_DOMAIN = 3;

export interface CoordinatorOptions {
  /** Extra catalog rows, e.g. a deployment's own action types. Still validated. */
  extraActions?: readonly ActionSpec[];
  maxProposalsPerDomain?: number;
}

export interface Coordination {
  ranked: RankedProposal[];
  conflicts: Conflict[];
  rejected: RejectedProposal[];
  quarantined: QuarantineNote[];
  commitments: Commitment[];
}

/**
 * Structural rules a proposal must satisfy to be considered at all.
 *
 * Returns a reason to reject, or `null`. Everything here is about a domain
 * staying inside its own lane — the coordinator is the only component that sees
 * every domain at once, so it is the only place these can be checked.
 */
export function validateProposal(
  proposal: Proposal,
  reportDomain: DomainId,
  extraActions: readonly ActionSpec[] = [],
): string | null {
  if (proposal.domain !== reportDomain) {
    return `proposal claims domain "${proposal.domain}" inside the "${reportDomain}" report`;
  }
  const prefix = proposal.actionKind.split(".")[0] ?? "";
  if (prefix !== proposal.domain) {
    // The load-bearing isolation rule: a mailbox full of hostile text cannot
    // mint a finance action, because the mail domain can only ever emit
    // "mail.*" kinds and the finance catalog rows are not addressable from it.
    return `action kind "${proposal.actionKind}" does not belong to domain "${proposal.domain}"`;
  }
  const spec = classifyAction(proposal.actionKind, extraActions);
  if (spec.domain !== "unknown" && spec.domain !== proposal.domain) {
    return `action "${proposal.actionKind}" is catalogued for domain "${spec.domain}"`;
  }
  for (const effect of proposal.effects) {
    if (effect.kind === "budget") {
      // A domain that could attach a ceiling to its own proposal could raise
      // the ceiling it is about to breach.
      return "a proposal may not publish a budget ceiling";
    }
    if (effect.kind === "time" && !(effect.endMs > effect.startMs)) {
      return "time effect ends at or before it starts";
    }
    if (
      effect.kind === "spend" &&
      !(Number.isFinite(effect.amountCents) && effect.amountCents > 0)
    ) {
      // A zero or negative "spend" would slip under every budget check.
      return "spend effect must be a positive amount of money leaving an account";
    }
  }
  return null;
}

const reject = (
  proposal: Proposal,
  reason: string,
): RejectedProposal => ({
  proposalId: proposal.id,
  domain: proposal.domain,
  actionKind: proposal.actionKind,
  reason,
});

/** Accepted proposals plus the audit trail of everything thrown out. */
export function validateReports(
  reports: readonly DomainReport[],
  options: CoordinatorOptions = {},
): { accepted: Proposal[]; rejected: RejectedProposal[] } {
  const extraActions = options.extraActions ?? [];
  const limit = options.maxProposalsPerDomain ?? MAX_PROPOSALS_PER_DOMAIN;
  const accepted: Proposal[] = [];
  const rejected: RejectedProposal[] = [];
  const seen = new Set<string>();

  for (const report of reports) {
    let kept = 0;
    for (const proposal of report.proposals) {
      const reason = validateProposal(proposal, report.domain, extraActions);
      if (reason) {
        rejected.push(reject(proposal, reason));
        continue;
      }
      if (seen.has(proposal.id)) {
        // Two proposals sharing an id would let one shadow the other in every
        // downstream map, including the conflict set.
        rejected.push(reject(proposal, `duplicate proposal id "${proposal.id}"`));
        continue;
      }
      if (kept >= limit) {
        rejected.push(reject(proposal, `over the ${limit}-proposal limit for one domain`));
        continue;
      }
      seen.add(proposal.id);
      kept += 1;
      accepted.push(proposal);
    }
  }
  return { accepted, rejected };
}

/** Commitments a domain published about itself. Anything else is dropped. */
export function collectCommitments(reports: readonly DomainReport[]): {
  commitments: Commitment[];
  rejected: RejectedProposal[];
} {
  const commitments: Commitment[] = [];
  const rejected: RejectedProposal[] = [];
  for (const report of reports) {
    for (const commitment of report.commitments) {
      if (commitment.domain !== report.domain) {
        rejected.push({
          proposalId: commitment.id,
          domain: report.domain,
          actionKind: "(commitment)",
          reason: `commitment claims domain "${commitment.domain}" inside the "${report.domain}" report`,
        });
        continue;
      }
      commitments.push(commitment);
    }
  }
  return { commitments, rejected };
}

const overlaps = (a: TimeEffect, b: TimeEffect): boolean =>
  a.startMs < b.endMs && b.startMs < a.endMs;

const timeEffects = (p: Proposal): TimeEffect[] =>
  p.effects.filter((e): e is TimeEffect => e.kind === "time");

const spendEffects = (p: Proposal): SpendEffect[] =>
  p.effects.filter((e): e is SpendEffect => e.kind === "spend");

const stanceEffects = (p: Proposal): StanceEffect[] =>
  p.effects.filter((e): e is StanceEffect => e.kind === "stance");

const window = (e: TimeEffect): string => {
  const at = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
  return `${at(e.startMs)}–${at(e.endMs)}`;
};

/** Titles are third-party text in disguise; never let one break a brief line. */
const label = (text: string): string => flattenText(text, 60);

/**
 * Find everything the user cannot have at once.
 *
 * Two scoping rules, both deliberate:
 *
 *   Time overlaps and contradictions are only raised *between* domains. A
 *   domain is expected to deconflict its own silo — the calendar already
 *   proposes declining its own double bookings — and re-raising that here would
 *   drown the real cross-domain trade-offs.
 *
 *   Budget ceilings are checked against every spend regardless of domain, and
 *   the *strictest* published cap for an account wins. A cap is a statement
 *   about an account, not about a silo, so a second domain publishing a
 *   generous ceiling cannot suppress a conflict against a tighter one.
 *
 * Nothing here resolves anything. There is no winner field to populate.
 */
export function detectConflicts(
  proposals: readonly Proposal[],
  commitments: readonly Commitment[],
): Conflict[] {
  const conflicts: Conflict[] = [];

  for (let i = 0; i < proposals.length; i += 1) {
    const a = proposals[i];
    if (!a) continue;

    for (let j = i + 1; j < proposals.length; j += 1) {
      const b = proposals[j];
      if (!b || b.domain === a.domain) continue;

      for (const ta of timeEffects(a)) {
        for (const tb of timeEffects(b)) {
          if (!overlaps(ta, tb)) continue;
          conflicts.push({
            id: `time:${a.id}|${b.id}`,
            kind: "time_overlap",
            summary:
              `"${label(a.title)}" (${window(ta)}) and "${label(b.title)}" (${window(tb)}) ` +
              "want the same time.",
            proposalIds: [a.id, b.id],
            domains: [a.domain, b.domain],
            options: [
              `Do "${label(a.title)}" and drop "${label(b.title)}"`,
              `Do "${label(b.title)}" and drop "${label(a.title)}"`,
              "Do neither today",
            ],
          });
        }
      }

      for (const sa of stanceEffects(a)) {
        for (const sb of stanceEffects(b)) {
          if (sa.topic !== sb.topic || sa.stance === sb.stance) continue;
          conflicts.push({
            id: `stance:${sa.topic}:${a.id}|${b.id}`,
            kind: "contradiction",
            summary:
              `${a.domain} says ${sa.stance} "${sa.topic}", ${b.domain} says ${sb.stance}: ` +
              `${label(sa.label)} vs ${label(sb.label)}.`,
            proposalIds: [a.id, b.id],
            domains: [a.domain, b.domain],
            options: [
              `Side with ${a.domain}: ${label(a.title)}`,
              `Side with ${b.domain}: ${label(b.title)}`,
              "Neither — this needs a decision only you can make",
            ],
          });
        }
      }
    }

    for (const commitment of commitments) {
      if (commitment.domain === a.domain || commitment.effect.kind !== "time") continue;
      const tc = commitment.effect;
      for (const ta of timeEffects(a)) {
        if (!overlaps(ta, tc)) continue;
        conflicts.push({
          id: `time:${a.id}|${commitment.domain}:${commitment.id}`,
          kind: "time_overlap",
          summary:
            `"${label(a.title)}" (${window(ta)}) lands on "${label(tc.label)}" ` +
            `(${window(tc)}), already committed in ${commitment.domain}.`,
          proposalIds: [a.id],
          domains: [a.domain, commitment.domain],
          options: [
            `Skip "${label(a.title)}"`,
            `Move "${label(a.title)}" to a free slot`,
            `Move or drop "${label(tc.label)}"`,
          ],
        });
      }
    }
  }

  conflicts.push(...budgetConflicts(proposals, commitments));
  return conflicts.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function budgetConflicts(
  proposals: readonly Proposal[],
  commitments: readonly Commitment[],
): Conflict[] {
  const caps = new Map<string, { effect: BudgetEffect; domain: DomainId }>();
  for (const commitment of commitments) {
    if (commitment.effect.kind !== "budget") continue;
    const effect = commitment.effect;
    const existing = caps.get(effect.account);
    const headroom = effect.capCents - effect.committedCents;
    // Strictest cap wins, so a generous second opinion cannot unblock a spend.
    if (
      !existing ||
      headroom < existing.effect.capCents - existing.effect.committedCents
    ) {
      caps.set(effect.account, { effect, domain: commitment.domain });
    }
  }

  const byAccount = new Map<string, { total: number; ids: string[]; domains: DomainId[] }>();
  for (const proposal of proposals) {
    for (const spend of spendEffects(proposal)) {
      const bucket = byAccount.get(spend.account) ?? { total: 0, ids: [], domains: [] };
      bucket.total += spend.amountCents;
      if (!bucket.ids.includes(proposal.id)) bucket.ids.push(proposal.id);
      if (!bucket.domains.includes(proposal.domain)) bucket.domains.push(proposal.domain);
      byAccount.set(spend.account, bucket);
    }
  }

  const conflicts: Conflict[] = [];
  for (const [account, bucket] of byAccount) {
    const cap = caps.get(account);
    if (!cap) continue;
    const over = cap.effect.committedCents + bucket.total - cap.effect.capCents;
    if (over <= 0) continue;
    const domains = [...bucket.domains];
    if (!domains.includes(cap.domain)) domains.push(cap.domain);
    conflicts.push({
      id: `budget:${account}`,
      kind: "budget_exceeded",
      summary:
        `Proposed spending of ${money(bucket.total)} on "${account}" exceeds the ` +
        `${money(cap.effect.capCents)} cap by ${money(over)} ` +
        `(${money(cap.effect.committedCents)} already committed).`,
      proposalIds: bucket.ids,
      domains,
      options: [
        `Accept going ${money(over)} over on "${account}"`,
        "Drop the proposed spending",
        `Raise the "${account}" cap yourself — this system will not`,
      ],
    });
  }
  return conflicts;
}

/**
 * Order the proposals and decide, for each, whether it may run.
 *
 * `confidence` is never read here. A domain cannot talk its way past a conflict
 * or past the reversibility gate by being sure of itself, which is the whole
 * point: the system has no way to trade one life domain off against another, so
 * it declines to try.
 */
export function rankProposals(
  proposals: readonly Proposal[],
  conflicts: readonly Conflict[],
  extraActions: readonly ActionSpec[] = [],
): RankedProposal[] {
  const blocked = new Map<string, string>();
  for (const conflict of conflicts) {
    for (const id of conflict.proposalIds) {
      if (!blocked.has(id)) blocked.set(id, conflict.id);
    }
  }

  const ordered = [...proposals].sort((a, b) => {
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return ordered.map((proposal, index) => {
    const spec = classifyAction(proposal.actionKind, extraActions);
    const conflictId = blocked.get(proposal.id);
    const autonomous = isAutonomous(spec);
    return {
      proposal,
      rank: index + 1,
      disposition: conflictId ? "blocked_by_conflict" : autonomous ? "auto" : "needs_approval",
      reason: conflictId
        ? `held for conflict ${conflictId}`
        : autonomous
          ? `reversible and low stakes (undo: ${spec.undo})`
          : spec.domain === "unknown"
            ? `unclassified action kind, treated as irreversible`
            : `${spec.reversibility}, ${spec.stakes} stakes`,
      reversibility: spec.reversibility,
      stakes: spec.stakes,
    };
  });
}

/** Validate, cross-check and rank every domain's report in one pass. */
export function coordinate(
  reports: readonly DomainReport[],
  options: CoordinatorOptions = {},
): Coordination {
  const { accepted, rejected } = validateReports(reports, options);
  const { commitments, rejected: badCommitments } = collectCommitments(reports);
  const conflicts = detectConflicts(accepted, commitments);
  return {
    ranked: rankProposals(accepted, conflicts, options.extraActions ?? []),
    conflicts,
    rejected: [...rejected, ...badCommitments],
    quarantined: reports.flatMap((r) => r.quarantined),
    commitments,
  };
}

export const byDisposition = (
  coordination: Coordination,
  disposition: RankedProposal["disposition"],
): RankedProposal[] => coordination.ranked.filter((r) => r.disposition === disposition);
