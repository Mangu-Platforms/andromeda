import type { JsonSchema } from "@andromeda/core";

/**
 * The complete vocabulary of things the agent is allowed to do to a page.
 *
 * It is a closed set on purpose. A planner that emits anything outside it is
 * rejected rather than interpreted, and `classifyAction` independently treats
 * every unknown string as a write — so a new capability cannot arrive by
 * accident and run unattended.
 */
export const ACTION_KINDS = [
  "navigate",
  "read",
  "screenshot",
  "scroll",
  "wait",
  "type",
  "done",
  "click",
  "submit",
  "upload",
  "download",
  "purchase",
  "send",
  "delete",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Kinds that cannot, on their own, change anything outside the browser tab.
 *
 * `type` is here deliberately: filling a field sends nothing. The submit that
 * follows is what is irreversible, and that is a write. The cost of this choice
 * is that a field which auto-submits on input would slip through, which is why
 * `GuardedBrowser` re-checks the landed URL after *every* action.
 */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set([
  "navigate",
  "read",
  "screenshot",
  "scroll",
  "wait",
  "type",
  "done",
]);

export type ActionClass = "read" | "write";

/**
 * A single step proposed by the planner.
 *
 * Every field is required and every unused field is the empty string, because
 * the schema handed to the model is strict and the runtime validator rejects
 * unknown keys. There is deliberately no field for the action's class, its
 * approval, or its risk: those are computed by this package from ground truth,
 * never accepted from a model.
 */
export interface ProposedAction {
  kind: ActionKind;
  /** Handle taken from the observed element index. Never invented. */
  elementId: string;
  /** Absolute URL, for `navigate` only. */
  url: string;
  /** Text to enter, for `type` only. */
  value: string;
  /** The planner's stated reason. Shown to the reviewer; never executed. */
  rationale: string;
}

export const PROPOSED_ACTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "elementId", "url", "value", "rationale"],
  properties: {
    kind: {
      type: "string",
      enum: [...ACTION_KINDS],
      description: "The single next step to take.",
    },
    elementId: {
      type: "string",
      maxLength: 120,
      description:
        'Element handle copied verbatim from the observation. Empty string when the action needs no element.',
    },
    url: {
      type: "string",
      maxLength: 2048,
      description: 'Absolute https URL for "navigate". Empty string otherwise.',
    },
    value: {
      type: "string",
      maxLength: 2000,
      description: 'Text to enter for "type". Empty string otherwise.',
    },
    rationale: {
      type: "string",
      maxLength: 400,
      description: "Why this step advances the operator's task.",
    },
  },
};

/** Kinds that address an element on the current page. */
const ELEMENT_KINDS: ReadonlySet<string> = new Set([
  "click",
  "type",
  "submit",
  "upload",
  "download",
  "purchase",
  "send",
  "delete",
]);

export function needsElement(kind: string): boolean {
  return ELEMENT_KINDS.has(kind);
}

export function isReadOnlyKind(kind: string): boolean {
  return READ_ONLY_KINDS.has(kind);
}
