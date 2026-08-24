import type { RiskAssessment } from "@andromeda/core";

import type { ChangeProposal } from "../change/proposal.ts";
import type { BumpClass } from "../change/semver.ts";
import type { ScopedContext } from "../repo/scope.ts";
import type { RepoIndex } from "../repo/snapshot.ts";

export type Severity = "low" | "moderate" | "high" | "critical";

export interface Advisory {
  id: string;
  dependency: string;
  severity: Severity;
  summary: string;
  /** Versions known to be affected, informational in this v0. */
  affected?: string;
}

export interface AdvisoryFinding {
  id: string;
  dependency: string;
  severity: Severity;
  /** Files in the code map that import the package. Empty means unreachable. */
  importedBy: string[];
  reachable: boolean;
}

export interface GuardianRisk extends RiskAssessment {
  bumpClass: BumpClass | null;
  /** Every advisory considered, with the code-map evidence for each. */
  advisories: AdvisoryFinding[];
  sensitivePaths: string[];
  blastRadius: number;
}

/** Path fragments that make a change worth a closer look. Lowercased match. */
export const DEFAULT_SENSITIVE_PATTERNS = [
  "auth",
  "session",
  "token",
  "secret",
  "credential",
  "password",
  "crypto",
  "permission",
  "middleware",
  "payment",
  "billing",
  "config",
  ".env",
];

const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 3,
  moderate: 8,
  high: 15,
  critical: 25,
};

export interface RiskInput {
  proposal: ChangeProposal;
  scope: ScopedContext;
  index: RepoIndex;
  bumpClass: BumpClass | null;
  advisories?: Advisory[];
  sensitivePatterns?: string[];
}

/**
 * Score a proposal for the reviewer's queue.
 *
 * A transparent hand-tuned sum, matching the auto-builder's stance: a reviewer
 * has to be able to read why a change scored what it did, and a score a model
 * can talk itself into is not a control. The score orders work and feeds one
 * policy threshold; it never turns a "requires human" into an auto-merge.
 *
 * The CVE handling is the interesting part. An advisory against a dependency
 * only raises the score when the code map shows the package is actually
 * imported somewhere. An unreachable advisory is still reported — with the
 * evidence that nothing imports it — but it does not inflate the score, because
 * an inflated score on an unreachable finding is how a queue becomes noise.
 */
export function assessRisk(input: RiskInput): GuardianRisk {
  const factors: string[] = [];
  let score = 0;

  const editedPaths = input.proposal.edits.map((e) => e.path);
  const blastRadius = new Set<string>();
  for (const path of editedPaths) {
    for (const importer of input.index.importersOf(path)) blastRadius.add(importer);
  }

  if (input.proposal.change.kind === "refactor") {
    score += 30;
    factors.push("a refactor changes behaviour-bearing code, not just a version string");
  }

  switch (input.bumpClass) {
    case "patch":
      score += 5;
      factors.push("patch-level dependency bump");
      break;
    case "minor":
      score += 20;
      factors.push("minor dependency bump: new surface, no compatibility guarantee in practice");
      break;
    case "major":
      score += 45;
      factors.push("major dependency bump: breaking changes are expected");
      break;
    case "prerelease":
      score += 45;
      factors.push("prerelease version: no compatibility promise of any kind");
      break;
    case "downgrade":
      score += 40;
      factors.push("version moves backwards");
      break;
    case "unknown":
      score += 45;
      factors.push("version strings could not be parsed as exact semver");
      break;
    default:
      break;
  }

  const patterns = input.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;
  const sensitivePaths = editedPaths.filter((path) => {
    const lower = path.toLowerCase();
    return patterns.some((pattern) => lower.includes(pattern));
  });
  if (sensitivePaths.length > 0) {
    score += 25;
    factors.push(`touches security- or configuration-sensitive files: ${sensitivePaths.join(", ")}`);
  }

  if (blastRadius.size > 10) {
    score += 15;
    factors.push(`${blastRadius.size} file(s) import the edited code`);
  } else if (blastRadius.size > 3) {
    score += 8;
    factors.push(`${blastRadius.size} file(s) import the edited code`);
  }

  if (input.scope.truncated) {
    score += 10;
    factors.push(
      `the change's neighbourhood did not fit the context budget; ` +
        `${input.scope.omitted.length} related file(s) were never read`,
    );
  }

  const advisories: AdvisoryFinding[] = [];
  for (const advisory of input.advisories ?? []) {
    const importedBy = input.index.filesImportingPackage(advisory.dependency);
    const reachable = importedBy.length > 0;
    advisories.push({
      id: advisory.id,
      dependency: advisory.dependency,
      severity: advisory.severity,
      importedBy,
      reachable,
    });
    if (reachable) {
      score += SEVERITY_WEIGHT[advisory.severity];
      factors.push(
        `${advisory.id} (${advisory.severity}) in ${advisory.dependency} is reachable: ` +
          `imported by ${importedBy.slice(0, 5).join(", ")}` +
          (importedBy.length > 5 ? ` and ${importedBy.length - 5} more` : ""),
      );
    } else {
      factors.push(
        `${advisory.id} (${advisory.severity}) in ${advisory.dependency} is not reachable: ` +
          "nothing in the code map imports it",
      );
    }
  }

  if (factors.length === 0) factors.push("no elevated-risk signals found");

  return {
    score: Math.min(100, score),
    factors,
    bumpClass: input.bumpClass,
    advisories,
    sensitivePaths,
    blastRadius: blastRadius.size,
  };
}
