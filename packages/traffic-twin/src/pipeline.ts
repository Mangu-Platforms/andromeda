import type {
  ApprovalGate,
  StepContext,
  WorkflowDefinition,
} from "@andromeda/core";
import { RejectedByHumanError } from "@andromeda/core";

import type { DemandProfile, Intersection, SignalPlan } from "./network/types.ts";
import type { SafetyPolicy } from "./safety/policy.ts";
import { validatePlan, type SafetyReport } from "./safety/validate.ts";
import { evaluate, type Evaluation } from "./evaluate.ts";

/**
 * The digital-twin study.
 *
 * The blocker for this product is that nobody can offer a formal zero-failure
 * guarantee for live signal control, and a vendor who implies otherwise is
 * selling liability they cannot carry. The containment is to never leave
 * simulation: this package produces a *recommendation document*, and there is
 * no code path from a simulation result to a field device — no driver, no
 * controller client, no actuation type anywhere in the package.
 *
 * Two things are enforced rather than promised:
 *
 *   safety first    a plan that violates the pre-committed envelope is
 *                   discarded before it is ever evaluated, so the optimiser
 *                   cannot trade a clearance interval for delay
 *   approval        the study is only exportable after a named traffic
 *                   engineer approves it, and the export says so
 */

export interface StudyInput {
  intersection: Intersection;
  baseline: SignalPlan;
  candidates: SignalPlan[];
  demand: DemandProfile;
  policy: SafetyPolicy;
  requestedBy: string;
  seeds?: number[];
}

export interface RejectedCandidate {
  planLabel: string;
  violations: SafetyReport["violations"];
}

/**
 * The deliverable. Deliberately inert: timings, numbers and caveats.
 * Nothing here can be handed to a controller.
 */
export interface SignalTimingRecommendation {
  intersectionId: string;
  intersectionName: string;
  policyId: string;
  recommendedPlan: SignalPlan;
  evaluation: Evaluation;
  safety: SafetyReport;
  /** Candidates discarded for violating the envelope, and why. */
  rejected: RejectedCandidate[];
  advisory: true;
  /** Set only once a named engineer has approved. Absent means not exportable. */
  approvedBy: string | null;
  approvedAt: number | null;
  notice: string;
}

export type StudyOutcome = "recommended" | "rejected" | "no_safe_candidate" | "no_improvement";

export interface StudyResult {
  outcome: StudyOutcome;
  recommendation: SignalTimingRecommendation | null;
  rejected: RejectedCandidate[];
  approvalId: string | null;
}

export const ADVISORY_NOTICE =
  "ADVISORY ONLY. These timings are a simulation-based recommendation, not a " +
  "control instruction. They must be reviewed by a licensed traffic engineer " +
  "and deployed through the agency's own controller processes. This study " +
  "carries no warranty of field performance.";

/**
 * Guard on the export boundary.
 *
 * Exported as its own function so the rule is testable in isolation and so
 * there is exactly one place where a study becomes releasable.
 */
export function assertExportable(
  recommendation: SignalTimingRecommendation,
): SignalTimingRecommendation {
  if (recommendation.advisory !== true) {
    throw new Error("a recommendation must be marked advisory");
  }
  if (!recommendation.approvedBy) {
    throw new Error("recommendation is not approved by a named traffic engineer");
  }
  if (!recommendation.safety.ok) {
    throw new Error("recommendation failed its own safety validation");
  }
  return recommendation;
}

export interface TrafficTwinDeps {
  gate: ApprovalGate;
}

export function createTrafficStudy(
  deps: TrafficTwinDeps,
): WorkflowDefinition<StudyInput, StudyResult> {
  return {
    name: "traffictwin.study",

    async run(ctx: StepContext, input: StudyInput): Promise<StudyResult> {
      // Safety is applied before evaluation, not after. A candidate that
      // violates the envelope never gets a delay figure, so it can never be
      // argued for on the strength of one.
      const screened = await ctx.step("screen-candidates", async () => {
        const safe: Array<{ plan: SignalPlan; report: SafetyReport }> = [];
        const rejected: RejectedCandidate[] = [];

        for (const plan of input.candidates) {
          const report = validatePlan({
            intersection: input.intersection,
            plan,
            policy: input.policy,
          });
          if (report.ok) safe.push({ plan, report });
          else rejected.push({ planLabel: plan.label, violations: report.violations });
        }
        return { safe, rejected };
      });

      for (const candidate of screened.rejected) {
        await ctx.audit.record("step.failed", `discarded ${candidate.planLabel}: unsafe`, {
          violations: candidate.violations.map((v) => v.code),
        });
      }

      if (screened.safe.length === 0) {
        await ctx.audit.record("run.completed", "no candidate satisfied the safety envelope", {});
        return {
          outcome: "no_safe_candidate",
          recommendation: null,
          rejected: screened.rejected,
          approvalId: null,
        };
      }

      const best = await ctx.step("evaluate", async () => {
        const scored = screened.safe.map((candidate) => ({
          plan: candidate.plan,
          report: candidate.report,
          evaluation: evaluate({
            intersection: input.intersection,
            baseline: input.baseline,
            proposed: candidate.plan,
            demand: input.demand,
            ...(input.seeds ? { seeds: input.seeds } : {}),
          }),
        }));

        // Only consistent improvements are eligible. An inconclusive result is
        // not a smaller improvement; it is not a result.
        const improvements = scored.filter((s) => s.evaluation.verdict === "improvement");
        improvements.sort(
          (a, b) =>
            (a.evaluation.metrics[0]?.deltaMean ?? 0) - (b.evaluation.metrics[0]?.deltaMean ?? 0),
        );
        return { chosen: improvements[0] ?? null, all: scored.map((s) => s.evaluation.verdict) };
      });

      if (!best.chosen) {
        await ctx.audit.record(
          "run.completed",
          "no candidate showed a consistent improvement over the baseline",
          { verdicts: best.all },
        );
        return {
          outcome: "no_improvement",
          recommendation: null,
          rejected: screened.rejected,
          approvalId: null,
        };
      }

      const draft: SignalTimingRecommendation = {
        intersectionId: input.intersection.id,
        intersectionName: input.intersection.name,
        policyId: input.policy.id,
        recommendedPlan: best.chosen.plan,
        evaluation: best.chosen.evaluation,
        safety: best.chosen.report,
        rejected: screened.rejected,
        advisory: true,
        approvedBy: null,
        approvedAt: null,
        notice: ADVISORY_NOTICE,
      };

      const approvalId = await ctx.step("request-approval", async () => {
        const request = await deps.gate.request({
          runId: ctx.runId,
          action: "traffictwin.export_recommendation",
          summary: `${draft.recommendedPlan.label} at ${draft.intersectionName}`,
          risk: {
            score: 55,
            factors: [
              `${draft.evaluation.metrics[0]?.deltaPercent ?? 0}% change in mean control delay`,
              `${screened.rejected.length} candidate(s) discarded as unsafe`,
              "advisory only: deployment remains an agency decision",
            ],
          },
          payload: { recommendation: draft, requestedBy: input.requestedBy },
          audit: ctx.audit,
        });
        return request.id;
      });

      const decision = await ctx.step<{ status: string; decidedBy: string }>(
        "await-engineer",
        async () =>
          ctx.suspend("waiting for a traffic engineer to review the study", {
            approvalId,
            plan: draft.recommendedPlan.label,
          }),
      );

      if (decision.status !== "approved") {
        await ctx.audit.record("run.completed", `study rejected by ${decision.decidedBy}`, {});
        return {
          outcome: "rejected",
          recommendation: null,
          rejected: screened.rejected,
          approvalId,
        };
      }

      const stored = await deps.gate.get(approvalId);
      if (stored?.status !== "approved") {
        throw new RejectedByHumanError(
          `approval ${approvalId} is ${stored?.status ?? "missing"}, not approved`,
        );
      }

      const approved: SignalTimingRecommendation = {
        ...draft,
        approvedBy: stored.decidedBy,
        approvedAt: stored.decidedAt,
      };
      assertExportable(approved);

      await ctx.audit.record("run.completed", `study approved by ${stored.decidedBy}`, {
        plan: approved.recommendedPlan.label,
      });

      return {
        outcome: "recommended",
        recommendation: approved,
        rejected: screened.rejected,
        approvalId,
      };
    },
  };
}
