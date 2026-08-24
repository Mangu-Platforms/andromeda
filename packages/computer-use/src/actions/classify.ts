import { hasControlChars } from "../text.ts";
import {
  ACTION_KINDS,
  isReadOnlyKind,
  needsElement,
  type ActionClass,
  type ProposedAction,
} from "./types.ts";

/**
 * Read or write, decided from the kind alone and defaulting to write.
 *
 * The default is the whole point. `READ_ONLY_KINDS` is an explicit membership
 * test, so a kind nobody has classified — a typo, a newly added capability, a
 * string a model invented — is a write, and a write cannot run without a human.
 * A classifier that defaulted the other way would silently grant autonomy to
 * every future mistake.
 */
export function classifyAction(kind: string): ActionClass {
  return isReadOnlyKind(kind) ? "read" : "write";
}

export type ActionParse =
  | { ok: true; action: ProposedAction }
  | { ok: false; issues: string[] };

export interface ParseActionOptions {
  /**
   * Handles present in the observation the planner was shown. An element the
   * planner did not see is an element it invented, and clicking an invented
   * handle is how an agent ends up somewhere nobody predicted.
   */
  knownElementIds: readonly string[];
}

const LIMITS = {
  elementId: 120,
  url: 2048,
  value: 2000,
  rationale: 400,
} as const;


const FIELDS = ["kind", "elementId", "url", "value", "rationale"] as const;

/**
 * Turn whatever the planner returned into a `ProposedAction`, or refuse.
 *
 * This runs on model output that has already been constrained by a strict JSON
 * schema, and it re-checks everything anyway. The schema is enforced by the
 * provider; this function is enforced by us, and only one of those two is in
 * this repository.
 */
export function parseProposedAction(raw: unknown, options: ParseActionOptions): ActionParse {
  const issues: string[] = [];
  const add = (message: string): void => void issues.push(message);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["action: expected an object"] };
  }
  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      // An extra key is either a model hallucinating a richer protocol or an
      // injection trying to smuggle one. Neither is executed.
      add(`action.${key}: unknown field`);
    }
  }

  const text = (name: (typeof FIELDS)[number], max: number): string | null => {
    const value = record[name];
    if (typeof value !== "string") {
      add(`action.${name}: expected a string`);
      return null;
    }
    if (value.length > max) {
      add(`action.${name}: is ${value.length} characters, limit is ${max}`);
      return null;
    }
    if (hasControlChars(value)) {
      add(`action.${name}: contains control characters`);
      return null;
    }
    return value;
  };

  const kind = text("kind", 32);
  const elementId = text("elementId", LIMITS.elementId);
  const url = text("url", LIMITS.url);
  const value = text("value", LIMITS.value);
  const rationale = text("rationale", LIMITS.rationale);

  if (kind !== null && !(ACTION_KINDS as readonly string[]).includes(kind)) {
    add(`action.kind: "${kind}" is not one of ${ACTION_KINDS.join(", ")}`);
  }

  if (kind !== null && elementId !== null) {
    if (needsElement(kind)) {
      if (elementId === "") {
        add(`action.elementId: "${kind}" needs an element handle`);
      } else if (!options.knownElementIds.includes(elementId)) {
        add(`action.elementId: "${elementId}" was not in the observation`);
      }
    } else if (elementId !== "") {
      add(`action.elementId: "${kind}" takes no element, got "${elementId}"`);
    }
  }

  if (kind !== null && url !== null) {
    if (kind === "navigate") {
      if (url === "") add("action.url: navigate needs a url");
    } else if (url !== "") {
      add(`action.url: "${kind}" takes no url`);
    }
  }

  if (kind !== null && value !== null && kind !== "type" && value !== "") {
    add(`action.value: "${kind}" takes no value`);
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    action: {
      kind: kind as ProposedAction["kind"],
      elementId: elementId as string,
      url: url as string,
      value: value as string,
      rationale: rationale as string,
    },
  };
}

export { LIMITS as ACTION_LIMITS };
