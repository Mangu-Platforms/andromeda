import type { CiReport } from "../ci/types.ts";
import type { ChangeProposal } from "../change/proposal.ts";
import { classifyBump, isPreRelease1 } from "../change/semver.ts";
import type { BumpClass } from "../change/semver.ts";
import type { GuardianRisk } from "./risk.ts";

export interface AutoMergePolicy {
  /** Kill switch for the whole unattended lane. */
  allowAutoMerge: boolean;
  /** Risk ceiling for an unattended merge. Above it, a human decides. */
  maxAutoMergeRisk: number;
}

export const DEFAULT_AUTO_MERGE_POLICY: AutoMergePolicy = {
  allowAutoMerge: true,
  maxAutoMergeRisk: 15,
};

export interface MergeDecision {
  autoMerge: boolean;
  requiresHuman: boolean;
  bumpClass: BumpClass | null;
  /** Every rule that refused. Empty on the auto-merge path. */
  blockers: string[];
  /** Rules that were satisfied, so an approved merge is explainable too. */
  reasons: string[];
  policy: string;
}

export interface MergeDecisionInput {
  proposal: ChangeProposal;
  ci: CiReport;
  risk: GuardianRisk;
  /**
   * What the drafting model said should happen. Recorded, never read by a
   * rule. It exists in the signature so the test suite can prove that varying
   * it changes nothing.
   */
  modelRecommendation?: string | null;
  policy?: Partial<AutoMergePolicy>;
}

export const POLICY_ID = "guardian.automerge.v1:patch-bumps-only";

/**
 * The auto-merge policy engine.
 *
 * One rule, stated once: **only a green, low-risk, patch-level bump of a 1.0+
 * dependency merges without a human.** Minor bumps, major bumps and every
 * refactor always wait for a named reviewer, and anything the engine cannot
 * classify — an unparseable version, a range instead of a version — falls into
 * "requires human" rather than out of the check.
 *
 * It is written deny-first and evaluates every rule before deciding, so the
 * decision carries the full list of blockers rather than the first one hit.
 * The model's own recommendation is deliberately not an input to any rule: the
 * thing being contained here is a model that argues its change is safe.
 */
export function decideAutoMerge(input: MergeDecisionInput): MergeDecision {
  const policy = { ...DEFAULT_AUTO_MERGE_POLICY, ...(input.policy ?? {}) };
  const blockers: string[] = [];
  const reasons: string[] = [];
  const change = input.proposal.change;

  const bumpClass: BumpClass | null =
    change.kind === "dependency_bump"
      ? classifyBump(change.fromVersion, change.toVersion)
      : null;

  if (!policy.allowAutoMerge) {
    blockers.push("unattended merging is disabled for this repository");
  }

  if (!input.ci.green) {
    blockers.push("CI is not green");
  } else {
    reasons.push(`CI green across ${input.ci.steps.length} step(s)`);
  }

  if (change.kind !== "dependency_bump") {
    blockers.push("a refactor always requires a human reviewer");
  } else if (bumpClass !== "patch") {
    blockers.push(
      `${change.dependency} ${change.fromVersion} -> ${change.toVersion} classifies as ` +
        `"${bumpClass}"; only patch-level bumps may merge unattended`,
    );
  } else if (isPreRelease1(change.fromVersion) || isPreRelease1(change.toVersion)) {
    // Pre-1.0 packages routinely break on a patch bump; semver makes no
    // promise below 1.0, so neither does this policy.
    blockers.push(
      `${change.dependency} is pre-1.0 (${change.fromVersion}), where a patch bump ` +
        "carries no compatibility guarantee",
    );
  } else {
    reasons.push(`patch-level bump of ${change.dependency} at 1.0 or above`);
  }

  if (input.risk.score > policy.maxAutoMergeRisk) {
    blockers.push(
      `risk score ${input.risk.score} is over the ${policy.maxAutoMergeRisk} auto-merge ceiling`,
    );
  } else {
    reasons.push(`risk score ${input.risk.score} within the auto-merge ceiling`);
  }

  if (input.risk.sensitivePaths.length > 0) {
    blockers.push(
      `touches sensitive paths: ${input.risk.sensitivePaths.join(", ")}`,
    );
  }

  if (input.modelRecommendation) {
    reasons.push(
      `model recommended "${input.modelRecommendation}"; policy does not read it`,
    );
  }

  const autoMerge = blockers.length === 0;
  return {
    autoMerge,
    requiresHuman: !autoMerge,
    bumpClass,
    blockers,
    reasons,
    policy: POLICY_ID,
  };
}
