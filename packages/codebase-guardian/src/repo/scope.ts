import type { RepoIndex } from "./snapshot.ts";

/**
 * Diff-scoped retrieval.
 *
 * The blocker this product runs into is attention degradation: a coding agent
 * that is handed a whole repository gets steadily worse as the repository gets
 * bigger, and the failure is silent. The containment is to make the context a
 * function of the *change* rather than of the repository — the files a change
 * touches, plus their immediate dependency neighbourhood, bounded by depth,
 * file count and bytes.
 *
 * The property worth defending is that scoping a one-file change in a
 * 500-file repository produces exactly the same context as scoping it in a
 * 50-file repository. `test/scope.test.ts` asserts that byte-for-byte.
 */

export interface ContextBudget {
  /** Maximum files admitted into the prompt, seeds included. */
  maxFiles: number;
  /** Maximum rendered prompt size. Per-file framing is charged against it. */
  maxBytes: number;
  /** How many import/importer hops out from the seeds to walk. */
  maxDepth: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxFiles: 24,
  maxBytes: 96_000,
  maxDepth: 1,
};

/** Framing bytes charged per file, so the render check is a backstop, not a trap. */
const PER_FILE_OVERHEAD_BYTES = 160;

export type BudgetStage = "seeds" | "render";

/**
 * Thrown when the mandatory part of a context does not fit.
 *
 * This fails closed on purpose. A change whose own edited files overflow the
 * budget is a change no reviewer can hold in their head either; the guardian
 * refuses it rather than quietly loading a truncated version of the code it is
 * about to rewrite.
 */
export class ContextBudgetExceededError extends Error {
  readonly stage: BudgetStage;
  readonly budget: ContextBudget;
  readonly attemptedFiles: number;
  readonly attemptedBytes: number;

  constructor(
    stage: BudgetStage,
    budget: ContextBudget,
    attemptedFiles: number,
    attemptedBytes: number,
  ) {
    super(
      `context budget exceeded at ${stage}: ${attemptedFiles} file(s)/${attemptedBytes} byte(s) ` +
        `against a limit of ${budget.maxFiles} file(s)/${budget.maxBytes} byte(s)`,
    );
    this.name = "ContextBudgetExceededError";
    this.stage = stage;
    this.budget = budget;
    this.attemptedFiles = attemptedFiles;
    this.attemptedBytes = attemptedBytes;
  }
}

export class UnknownPathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`"${path}" is not in the code map; it cannot be scoped or edited`);
    this.name = "UnknownPathError";
    this.path = path;
  }
}

export type ScopeReason = "seed" | "imports" | "imported-by" | "related";

export interface ScopedFile {
  path: string;
  depth: number;
  reason: ScopeReason;
  bytes: number;
}

export interface ScopedContext {
  seeds: string[];
  files: ScopedFile[];
  /** Rendered size the scope was charged for, framing included. */
  chargedBytes: number;
  depthReached: number;
  /** True when the neighbourhood was larger than the budget allowed. */
  truncated: boolean;
  /** Neighbours the budget pushed out, so the reviewer sees what was dropped. */
  omitted: string[];
  budget: ContextBudget;
}

export interface ScopeRequest {
  /** Files the change will edit. Mandatory: they fit, or the scope fails. */
  seeds: string[];
  /**
   * Extra roots to admit alongside the depth-1 neighbours — used for a
   * dependency bump, where the code that actually calls the package is the
   * relevant context but the only edited file is the manifest.
   */
  alsoConsider?: string[];
  budget?: Partial<ContextBudget>;
}

export function resolveBudget(partial: Partial<ContextBudget> | undefined): ContextBudget {
  return { ...DEFAULT_CONTEXT_BUDGET, ...(partial ?? {}) };
}

const charge = (bytes: number): number => bytes + PER_FILE_OVERHEAD_BYTES;

/**
 * Walk the dependency subgraph of `seeds` outwards, admitting whole files
 * until the budget is spent.
 *
 * Seeds are non-negotiable; everything past depth 0 is best-effort and is
 * recorded in `omitted` when it does not fit. That split is what lets a change
 * to a heavily-imported file still be proposed — with an explicit
 * `truncated` flag that risk scoring reads — while a change that is itself too
 * broad is rejected outright.
 */
export function computeScope(index: RepoIndex, request: ScopeRequest): ScopedContext {
  const budget = resolveBudget(request.budget);
  const seeds: string[] = [];
  for (const raw of request.seeds) {
    const file = index.file(raw);
    if (file === null) throw new UnknownPathError(raw);
    if (!seeds.includes(file.path)) seeds.push(file.path);
  }
  if (seeds.length === 0) throw new Error("a scope needs at least one seed file");

  const files: ScopedFile[] = [];
  let chargedBytes = 0;

  for (const path of seeds) {
    const file = index.file(path);
    if (file === null) throw new UnknownPathError(path);
    files.push({ path, depth: 0, reason: "seed", bytes: file.bytes });
    chargedBytes += charge(file.bytes);
  }
  if (files.length > budget.maxFiles || chargedBytes > budget.maxBytes) {
    throw new ContextBudgetExceededError("seeds", budget, files.length, chargedBytes);
  }

  const admitted = new Set(seeds);
  const omitted: string[] = [];
  let truncated = false;
  let depthReached = 0;
  let frontier = seeds;

  for (let depth = 1; depth <= budget.maxDepth; depth += 1) {
    const candidates: Array<{ path: string; reason: ScopeReason }> = [];
    const push = (path: string, reason: ScopeReason): void => {
      if (admitted.has(path)) return;
      if (candidates.some((c) => c.path === path)) return;
      candidates.push({ path, reason });
    };

    for (const path of frontier) {
      for (const target of index.importsOf(path)) push(target, "imports");
      for (const importer of index.importersOf(path)) push(importer, "imported-by");
    }
    if (depth === 1) {
      for (const extra of request.alsoConsider ?? []) {
        const file = index.file(extra);
        if (file === null) throw new UnknownPathError(extra);
        push(file.path, "related");
      }
    }
    if (candidates.length === 0) break;

    // Deterministic order: the same change must produce the same prompt on a
    // replay, or checkpoints and audit trails stop meaning anything.
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const nextFrontier: string[] = [];
    for (const candidate of candidates) {
      const file = index.file(candidate.path);
      if (file === null) continue;
      const cost = charge(file.bytes);
      if (files.length + 1 > budget.maxFiles || chargedBytes + cost > budget.maxBytes) {
        truncated = true;
        omitted.push(candidate.path);
        continue;
      }
      files.push({
        path: candidate.path,
        depth,
        reason: candidate.reason,
        bytes: file.bytes,
      });
      chargedBytes += cost;
      admitted.add(candidate.path);
      nextFrontier.push(candidate.path);
      depthReached = depth;
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  return { seeds, files, chargedBytes, depthReached, truncated, omitted, budget };
}

/** Paths the agent is allowed to see, and therefore allowed to edit. */
export function scopePaths(scope: ScopedContext): string[] {
  return scope.files.map((f) => f.path);
}

/**
 * Render the scope into prompt text.
 *
 * Nothing outside `scope.files` may appear here — this function is the single
 * place the repository turns into tokens, which is what makes the bound
 * enforceable instead of merely intended.
 */
export function renderScope(index: RepoIndex, scope: ScopedContext): string {
  const lines: string[] = [];
  lines.push(`# Scoped repository context (${scope.files.length} file(s))`);
  lines.push(
    `Seeds: ${scope.seeds.join(", ")}. Depth walked: ${scope.depthReached} of ` +
      `${scope.budget.maxDepth}.`,
  );
  if (scope.truncated) {
    lines.push(
      `NOTE: ${scope.omitted.length} neighbouring file(s) did not fit the context budget ` +
        `and are not shown.`,
    );
  }
  lines.push("");

  for (const scoped of scope.files) {
    const file = index.file(scoped.path);
    if (file === null) continue;
    lines.push(`## ${file.path}  (${scoped.reason}, depth ${scoped.depth})`);
    lines.push(`exports: ${file.exports.length > 0 ? file.exports.join(", ") : "(none)"}`);
    lines.push(`imports: ${file.imports.length > 0 ? file.imports.join(", ") : "(none)"}`);
    lines.push(
      `imported by: ${index.importersOf(file.path).join(", ") || "(nothing in this scope)"}`,
    );
    if (file.source !== null) {
      lines.push("```");
      lines.push(file.source);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Render and re-check. A scope that somehow overflows never reaches a model. */
export function renderScopeWithinBudget(index: RepoIndex, scope: ScopedContext): string {
  const text = renderScope(index, scope);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > scope.budget.maxBytes) {
    throw new ContextBudgetExceededError("render", scope.budget, scope.files.length, bytes);
  }
  return text;
}
