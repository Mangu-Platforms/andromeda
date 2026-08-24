import type { ScopedContext } from "../repo/scope.ts";
import { scopePaths } from "../repo/scope.ts";
import type { RepoIndex } from "../repo/snapshot.ts";

/** A whole-file replacement. Coarse on purpose: it is trivially reviewable. */
export interface FileEdit {
  path: string;
  contents: string;
}

/**
 * The one logical change a proposal is allowed to carry.
 *
 * Modelled as a union rather than a bag of flags so "exactly one change" is a
 * property of the type, not of a convention. A proposal cannot describe a
 * dependency bump *and* a refactor, because there is nowhere to put the second
 * one.
 */
export type Change =
  | {
      kind: "dependency_bump";
      dependency: string;
      fromVersion: string;
      toVersion: string;
    }
  | {
      kind: "refactor";
      targetPath: string;
      summary: string;
    };

export interface ChangeProposal {
  id: string;
  title: string;
  rationale: string;
  change: Change;
  edits: FileEdit[];
  /** Exactly the files the drafting model was shown. Edits may not leave it. */
  scopePaths: string[];
  baseCommit: string;
}

export class ProposalShapeError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`proposal rejected:\n  - ${reasons.join("\n  - ")}`);
    this.name = "ProposalShapeError";
    this.reasons = reasons;
  }
}

export interface ProposalCheckOptions {
  index: RepoIndex;
  scope: ScopedContext;
  /** Ceiling on files touched by one proposal. Breadth is the review cost. */
  maxEdits?: number;
}

export const DEFAULT_MAX_EDITS = 5;

/**
 * Structural admission checks for a drafted proposal.
 *
 * Three of these are load-bearing:
 *
 * - **No edit outside the loaded context.** The agent was shown a bounded
 *   subgraph; letting it edit a file it never read would put changes into code
 *   nobody — model or reviewer — looked at.
 * - **A dependency bump edits the manifest and nothing else.** A bump that
 *   also rewrites source is two changes wearing one hat, and it would slip
 *   arbitrary code through the patch-bump auto-merge lane.
 * - **A refactor never edits the manifest.** Same reason, other direction.
 */
export function checkProposal(
  proposal: ChangeProposal,
  options: ProposalCheckOptions,
): string[] {
  const reasons: string[] = [];
  const maxEdits = options.maxEdits ?? DEFAULT_MAX_EDITS;
  const manifestPath = options.index.snapshot.manifest.path;
  const allowed = new Set(scopePaths(options.scope));

  if (!proposal.title.trim()) reasons.push("has an empty title");

  if (proposal.edits.length === 0) {
    reasons.push("contains no edits, so there is nothing to review");
  }
  if (proposal.edits.length > maxEdits) {
    reasons.push(
      `touches ${proposal.edits.length} files, over the ${maxEdits}-file limit for one change`,
    );
  }

  const seen = new Set<string>();
  for (const edit of proposal.edits) {
    if (seen.has(edit.path)) {
      reasons.push(`edits "${edit.path}" more than once`);
    }
    seen.add(edit.path);
    if (!allowed.has(edit.path)) {
      reasons.push(
        `edits "${edit.path}", which was not in the retrieved context ` +
          `(scope: ${[...allowed].join(", ")})`,
      );
    }
  }

  const editsManifest = seen.has(manifestPath);
  const sourceEdits = [...seen].filter((p) => p !== manifestPath);

  if (proposal.change.kind === "dependency_bump") {
    const { dependency, fromVersion, toVersion } = proposal.change;
    if (!editsManifest) {
      reasons.push(`is a dependency bump but does not edit ${manifestPath}`);
    }
    if (sourceEdits.length > 0) {
      reasons.push(
        `is a dependency bump that also rewrites source (${sourceEdits.join(", ")}); ` +
          "that is two changes, and only one is allowed per proposal",
      );
    }
    const recorded = options.index.manifestVersion(dependency);
    if (recorded === null) {
      reasons.push(`bumps "${dependency}", which is not a dependency in ${manifestPath}`);
    } else if (recorded !== fromVersion) {
      reasons.push(
        `claims ${dependency} is at ${fromVersion}, but ${manifestPath} records ${recorded}`,
      );
    }
    if (fromVersion === toVersion) {
      reasons.push(`bumps ${dependency} from ${fromVersion} to itself`);
    }
    const manifestEdit = proposal.edits.find((e) => e.path === manifestPath);
    if (manifestEdit && !manifestEdit.contents.includes(toVersion)) {
      reasons.push(
        `the ${manifestPath} edit does not contain the target version ${toVersion}`,
      );
    }
  } else {
    const { targetPath } = proposal.change;
    if (editsManifest) {
      reasons.push(
        `is a refactor that also edits ${manifestPath}; dependency changes belong ` +
          "in their own proposal",
      );
    }
    if (!seen.has(targetPath)) {
      reasons.push(`is a refactor of "${targetPath}" that never edits it`);
    }
    for (const edit of proposal.edits) {
      if (edit.contents.trim() === "") {
        reasons.push(`replaces "${edit.path}" with an empty file`);
      }
    }
  }

  return reasons;
}

export function assertWellFormedProposal(
  proposal: ChangeProposal,
  options: ProposalCheckOptions,
): void {
  const reasons = checkProposal(proposal, options);
  if (reasons.length > 0) throw new ProposalShapeError(reasons);
}

/** One-line description used in branch names, audit lines and gate summaries. */
export function describeChange(change: Change): string {
  return change.kind === "dependency_bump"
    ? `bump ${change.dependency} ${change.fromVersion} -> ${change.toVersion}`
    : `refactor ${change.targetPath}`;
}

/** Deterministic, filesystem-safe branch name for a proposal. */
export function branchNameFor(proposal: ChangeProposal): string {
  const slug = describeChange(proposal.change)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `guardian/${slug}-${proposal.id}`;
}
