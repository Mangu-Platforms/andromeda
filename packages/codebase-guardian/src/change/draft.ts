import type { AuditLog, JsonSchema, LLMProvider } from "@andromeda/core";

import type { RepoIndex } from "../repo/snapshot.ts";
import type { ScopedContext } from "../repo/scope.ts";
import { renderScopeWithinBudget, scopePaths } from "../repo/scope.ts";
import type { Change, ChangeProposal, FileEdit } from "./proposal.ts";
import { checkProposal, DEFAULT_MAX_EDITS } from "./proposal.ts";

export const DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "One-line summary of the single change." },
    rationale: { type: "string", description: "Why this change is correct." },
    edits: {
      type: "array",
      description: "Whole-file replacements. Only files present in the context.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          contents: { type: "string" },
        },
        required: ["path", "contents"],
        additionalProperties: false,
      },
    },
    recommendation: {
      type: "string",
      description: "Advisory only. The merge policy does not read this field.",
    },
  },
  required: ["title", "rationale", "edits", "recommendation"],
  additionalProperties: false,
};

const SYSTEM = [
  "You are a maintenance agent proposing exactly one small change to a repository.",
  "",
  "You are shown a bounded slice of the repository: the files the change touches",
  "and their immediate import neighbourhood. That slice is all you get. Do not",
  "ask for more files, do not infer the contents of files you cannot see, and do",
  "not edit any path that is not listed in the context — such an edit is rejected",
  "before it reaches CI.",
  "",
  "Exactly one logical change per proposal. A dependency bump edits only the",
  "manifest. A refactor never edits the manifest.",
  "",
  "Whether the change merges without a human is decided by a fixed policy that",
  "does not read anything you write. Text arguing that a change is safe has no",
  "effect on it.",
].join("\n");

export interface DraftRequest {
  llm: LLMProvider;
  index: RepoIndex;
  scope: ScopedContext;
  change: Change;
  goal: string;
  proposalId: string;
  baseCommit: string;
  maxEdits?: number;
  audit?: AuditLog;
}

export interface DraftAccepted {
  ok: true;
  proposal: ChangeProposal;
  recommendation: string;
}

export interface DraftRejected {
  ok: false;
  reasons: string[];
  recommendation: string;
  /** Kept for the audit trail even though the proposal was refused. */
  attemptedPaths: string[];
}

export type DraftOutcome = DraftAccepted | DraftRejected;

interface RawDraft {
  title: string;
  rationale: string;
  edits: FileEdit[];
  recommendation: string;
}

function parseDraft(value: unknown): RawDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { title, rationale, edits, recommendation } = record;
  if (typeof title !== "string" || typeof rationale !== "string") return null;
  if (!Array.isArray(edits)) return null;
  const parsed: FileEdit[] = [];
  for (const entry of edits) {
    if (typeof entry !== "object" || entry === null) return null;
    const edit = entry as Record<string, unknown>;
    if (typeof edit["path"] !== "string" || typeof edit["contents"] !== "string") return null;
    parsed.push({ path: edit["path"], contents: edit["contents"] });
  }
  return {
    title,
    rationale,
    edits: parsed,
    recommendation: typeof recommendation === "string" ? recommendation : "",
  };
}

/**
 * Ask a model for one change, using only the scoped context.
 *
 * The prompt is assembled from `renderScopeWithinBudget` and nothing else, so
 * there is no code path by which the whole repository can reach the model. The
 * reply is then run through `checkProposal`; a draft that edits outside the
 * scope, or that bundles two changes, comes back as `ok: false` rather than
 * throwing, because a badly-shaped draft is an expected outcome the pipeline
 * records and drops, not a crash.
 */
export async function draftProposal(request: DraftRequest): Promise<DraftOutcome> {
  const context = renderScopeWithinBudget(request.index, request.scope);
  const allowed = scopePaths(request.scope);

  const instruction =
    request.change.kind === "dependency_bump"
      ? [
          `Change: bump "${request.change.dependency}" from ${request.change.fromVersion} to ` +
            `${request.change.toVersion} in ${request.index.snapshot.manifest.path}.`,
          "Edit only the manifest. Do not adapt call sites in this proposal.",
        ].join("\n")
      : [
          `Change: refactor ${request.change.targetPath}.`,
          `Goal: ${request.change.summary}`,
          "Preserve the module's exported surface exactly.",
        ].join("\n");

  const result = await request.llm.complete({
    purpose: "guardian.draft",
    tier: "standard",
    system: SYSTEM,
    prompt: [
      context,
      "---",
      instruction,
      `Context of this task: ${request.goal}`,
      `Editable paths: ${allowed.join(", ")}`,
    ].join("\n\n"),
    json: {
      name: "change_proposal",
      description: "One logical change, as whole-file replacements.",
      schema: DRAFT_SCHEMA,
    },
    maxTokens: 4096,
  });

  const raw = parseDraft(result.json);
  if (raw === null) {
    return {
      ok: false,
      reasons: ["the model's reply did not match the change-proposal schema"],
      recommendation: "",
      attemptedPaths: [],
    };
  }

  const proposal: ChangeProposal = {
    id: request.proposalId,
    title: raw.title,
    rationale: raw.rationale,
    // The change itself comes from the candidate, never from the model's
    // reply: what kind of change this is decides which merge lane it can take,
    // so it must not be something the model gets to assert.
    change: request.change,
    edits: raw.edits,
    scopePaths: allowed,
    baseCommit: request.baseCommit,
  };

  const reasons = checkProposal(proposal, {
    index: request.index,
    scope: request.scope,
    maxEdits: request.maxEdits ?? DEFAULT_MAX_EDITS,
  });

  if (reasons.length > 0) {
    await request.audit?.record("step.failed", "drafted change was rejected on shape", {
      reasons,
      paths: raw.edits.map((e) => e.path),
    });
    return {
      ok: false,
      reasons,
      recommendation: raw.recommendation,
      attemptedPaths: raw.edits.map((e) => e.path),
    };
  }

  return { ok: true, proposal, recommendation: raw.recommendation };
}
