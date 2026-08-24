import type { DomainId } from "./types.ts";
import { isDomainId } from "./types.ts";

export type Reversibility = "reversible" | "irreversible";
export type Stakes = "low" | "high";

/**
 * One row of the reversibility table.
 *
 * `undo` is required for anything claiming to be reversible and must be a
 * concrete instruction. If nobody can write down how to take the action back,
 * it is not reversible, and `validateActionSpec` refuses to register it.
 */
export interface ActionSpec {
  kind: string;
  domain: DomainId | "unknown";
  reversibility: Reversibility;
  stakes: Stakes;
  description: string;
  undo: string;
}

/**
 * The reversibility gate, as data.
 *
 * Anything that leaves the user's own account — a sent mail, a moved dollar, a
 * shared health report, a decline that another person sees — is irreversible
 * and goes to a human. Anything that only writes to the user's own tentative
 * layer is reversible.
 *
 * `stakes: "high"` on a reversible action is not a contradiction: a tentative
 * hold that invites other people can be deleted, but the invitations were still
 * sent, so it is gated anyway.
 */
export const ACTION_CATALOG: readonly ActionSpec[] = [
  {
    kind: "calendar.create_reminder",
    domain: "calendar",
    reversibility: "reversible",
    stakes: "low",
    description: "Add a private reminder to the user's own calendar.",
    undo: "Delete the reminder.",
  },
  {
    kind: "calendar.hold_tentative",
    domain: "calendar",
    reversibility: "reversible",
    stakes: "low",
    description: "Place a tentative, invitee-free hold on the user's calendar.",
    undo: "Delete the hold.",
  },
  {
    kind: "calendar.hold_with_guests",
    domain: "calendar",
    reversibility: "reversible",
    stakes: "high",
    description: "Place a hold that sends invitations to other people.",
    undo: "Delete the hold, which sends a cancellation to every guest.",
  },
  {
    kind: "calendar.decline_invite",
    domain: "calendar",
    reversibility: "irreversible",
    stakes: "high",
    description: "Decline an invitation. The organiser is notified.",
    undo: "",
  },
  {
    kind: "calendar.cancel_event",
    domain: "calendar",
    reversibility: "irreversible",
    stakes: "high",
    description: "Cancel an event. Every attendee is notified.",
    undo: "",
  },

  {
    kind: "finance.flag_transaction",
    domain: "finance",
    reversibility: "reversible",
    stakes: "low",
    description: "Flag a transaction for the user's own review.",
    undo: "Remove the flag.",
  },
  {
    kind: "finance.draft_budget_note",
    domain: "finance",
    reversibility: "reversible",
    stakes: "low",
    description: "Write a private note about a budget line.",
    undo: "Delete the note.",
  },
  {
    kind: "finance.schedule_transfer",
    domain: "finance",
    reversibility: "irreversible",
    stakes: "high",
    description: "Schedule money to move between accounts or to a third party.",
    undo: "",
  },
  {
    kind: "finance.pay_bill",
    domain: "finance",
    reversibility: "irreversible",
    stakes: "high",
    description: "Pay a bill.",
    undo: "",
  },

  {
    kind: "health.log_note",
    domain: "health",
    reversibility: "reversible",
    stakes: "low",
    description: "Write a private note in the health log.",
    undo: "Delete the note.",
  },
  {
    kind: "health.schedule_workout",
    domain: "health",
    reversibility: "reversible",
    stakes: "low",
    description: "Put a private, tentative workout block on the calendar.",
    undo: "Delete the block.",
  },
  {
    kind: "health.share_report",
    domain: "health",
    reversibility: "irreversible",
    stakes: "high",
    description: "Share a health report with a clinician or third party.",
    undo: "",
  },

  {
    kind: "mail.draft_reply",
    domain: "mail",
    reversibility: "reversible",
    stakes: "low",
    description: "Save a reply as a draft. Nothing is sent.",
    undo: "Delete the draft.",
  },
  {
    kind: "mail.flag_suspicious",
    domain: "mail",
    reversibility: "reversible",
    stakes: "low",
    description: "Flag a message as suspicious in the user's own mailbox.",
    undo: "Remove the flag.",
  },
  {
    kind: "mail.archive_thread",
    domain: "mail",
    reversibility: "reversible",
    stakes: "low",
    description: "Move a thread out of the inbox.",
    undo: "Move the thread back to the inbox.",
  },
  {
    kind: "mail.send_reply",
    domain: "mail",
    reversibility: "irreversible",
    stakes: "high",
    description: "Send a reply.",
    undo: "",
  },
  {
    kind: "mail.forward_thread",
    domain: "mail",
    reversibility: "irreversible",
    stakes: "high",
    description: "Forward a thread to someone else.",
    undo: "",
  },
];

/** Structural rules an action row must satisfy before it can be registered. */
export function validateActionSpec(spec: ActionSpec): string[] {
  const issues: string[] = [];
  if (!/^[a-z]+\.[a-z][a-z0-9_]*$/.test(spec.kind)) {
    issues.push(`kind "${spec.kind}" must look like "<domain>.<verb>"`);
  }
  const prefix = spec.kind.split(".")[0] ?? "";
  if (!isDomainId(prefix)) {
    issues.push(`kind "${spec.kind}" is not prefixed with a known domain`);
  } else if (spec.domain !== prefix) {
    // A row whose declared domain differs from its prefix would let one domain
    // smuggle another domain's capability past the isolation check.
    issues.push(`kind "${spec.kind}" is declared for domain "${spec.domain}"`);
  }
  if (spec.reversibility === "reversible" && spec.undo.trim().length === 0) {
    issues.push(`"${spec.kind}" claims to be reversible but says nothing about how to undo it`);
  }
  if (spec.reversibility === "irreversible" && spec.undo.trim().length > 0) {
    issues.push(`"${spec.kind}" is irreversible; it must not carry an undo instruction`);
  }
  if (spec.description.trim().length === 0) {
    issues.push(`"${spec.kind}" needs a description a reviewer can read`);
  }
  return issues;
}

/** Spec used for any action kind nobody has classified. */
export function unknownActionSpec(kind: string): ActionSpec {
  return {
    kind,
    domain: "unknown",
    reversibility: "irreversible",
    stakes: "high",
    description: `Unclassified action "${kind}".`,
    undo: "",
  };
}

/**
 * Classify an action kind. The table is the only authority: whatever a domain
 * agent claims about its own proposal is ignored.
 *
 * Fails closed — an action nobody has written a row for is irreversible and
 * high-stakes, so a novel or misspelled kind is gated rather than executed.
 */
export function classifyAction(kind: string, extra: readonly ActionSpec[] = []): ActionSpec {
  for (const spec of extra) {
    if (spec.kind === kind && validateActionSpec(spec).length === 0) return spec;
  }
  for (const spec of ACTION_CATALOG) {
    if (spec.kind === kind) return spec;
  }
  return unknownActionSpec(kind);
}

/** True only for actions that may run without a human looking at them first. */
export function isAutonomous(spec: ActionSpec): boolean {
  return spec.reversibility === "reversible" && spec.stakes === "low";
}

/** Every catalogued kind belonging to a domain. */
export function kindsForDomain(
  domain: DomainId,
  extra: readonly ActionSpec[] = [],
): string[] {
  return [...ACTION_CATALOG, ...extra]
    .filter((s) => s.domain === domain)
    .map((s) => s.kind)
    .sort();
}
