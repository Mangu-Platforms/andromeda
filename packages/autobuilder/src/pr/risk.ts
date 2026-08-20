import type { RiskAssessment } from "@andromeda/core";
import type { ProjectSpec } from "../spec/types.ts";
import type { GeneratedFile } from "../templates/types.ts";
import type { FeatureBuild } from "../features/generate.ts";

export interface RiskInput {
  spec: ProjectSpec;
  files: GeneratedFile[];
  featureBuilds: FeatureBuild[];
}

/**
 * Order the reviewer's queue.
 *
 * Deliberately a transparent, hand-tuned sum rather than a model judgement: a
 * reviewer has to be able to read why a build scored what it did, and a score
 * that a model can talk itself into is not a control. Nothing here decides
 * anything — a score of 0 still requires a human approval.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const factors: string[] = [];
  let score = 0;

  const failed = input.featureBuilds.filter((b) => !b.passed);
  if (failed.length > 0) {
    score += 60;
    factors.push(`${failed.length} feature(s) never passed the test-gate: ${failed.map((f) => f.featureId).join(", ")}`);
  }

  const repaired = input.featureBuilds.filter((b) => b.passed && b.attempts.length > 1);
  if (repaired.length > 0) {
    score += 5 * repaired.length;
    factors.push(
      `${repaired.length} feature(s) needed repair attempts: ` +
        repaired.map((b) => `${b.featureId} (${b.attempts.length})`).join(", "),
    );
  }

  const unprotected = input.spec.entities.filter((e) => !e.ownerField);
  if (unprotected.length > 0) {
    score += 10;
    factors.push(
      `${unprotected.length} table(s) have no owner column and are deny-all: ${unprotected.map((e) => e.name).join(", ")}`,
    );
  }

  if (input.spec.auth.enabled) {
    score += 10;
    factors.push("the project handles authentication");
  }

  const secrets = input.spec.env.filter((e) => e.secret);
  if (secrets.length > 0) {
    score += 5 * secrets.length;
    factors.push(`${secrets.length} secret(s) must be provisioned: ${secrets.map((e) => e.name).join(", ")}`);
  }

  if (input.spec.deploy.target !== "none") {
    score += 10;
    factors.push(`deploys to ${input.spec.deploy.target}`);
  }

  const writeRoutes = input.spec.routes.filter((r) => r.method !== "GET");
  if (writeRoutes.length > 0) {
    score += Math.min(15, 3 * writeRoutes.length);
    factors.push(`${writeRoutes.length} route(s) mutate state`);
  }

  if (input.files.length > 40) {
    score += 10;
    factors.push(`${input.files.length} files to review`);
  }

  if (factors.length === 0) factors.push("no elevated-risk signals found");

  return { score: Math.min(100, score), factors };
}
