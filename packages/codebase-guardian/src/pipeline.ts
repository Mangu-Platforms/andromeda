import type {
  ApprovalGate,
  LLMProvider,
  RunRecord,
  StepContext,
  WorkflowDefinition,
} from "@andromeda/core";
import { MeteredProvider, RejectedByHumanError } from "@andromeda/core";

import type { RepoIndex } from "./repo/snapshot.ts";
import type { ContextBudget, ScopedContext } from "./repo/scope.ts";
import { computeScope } from "./repo/scope.ts";
import type { Change, ChangeProposal } from "./change/proposal.ts";
import { branchNameFor, describeChange } from "./change/proposal.ts";
import { classifyBump } from "./change/semver.ts";
import { draftProposal } from "./change/draft.ts";
import type { CiReport, CiRunner } from "./ci/types.ts";
import type { Advisory, GuardianRisk } from "./policy/risk.ts";
import { assessRisk } from "./policy/risk.ts";
import type { AutoMergePolicy, MergeDecision } from "./policy/automerge.ts";
import { decideAutoMerge } from "./policy/automerge.ts";
import type { BranchRef, MergeReceipt, MergeTarget } from "./merge.ts";

export interface GuardianInput {
  /** The single change to attempt. Chosen upstream, not by the model. */
  change: Change;
  /** Why this maintenance run exists; shown to the model and the reviewer. */
  goal: string;
  requestedBy: string;
}

export type GuardianOutcome =
  | "auto_merged"
  | "merged"
  | "rejected"
  | "blocked_by_test_gate"
  | "dropped_bad_draft";

/** Everything a reviewer needs, and everything the audit trail keeps. */
export interface ReviewPacket {
  proposal: ChangeProposal;
  branch: BranchRef;
  ci: CiReport;
  risk: GuardianRisk;
  decision: MergeDecision;
  /** Proof of what the model was shown: file count, bytes, what was omitted. */
  context: {
    seeds: string[];
    files: string[];
    chargedBytes: number;
    truncated: boolean;
    omitted: string[];
    repoFileCount: number;
  };
}

export interface GuardianResult {
  outcome: GuardianOutcome;
  review: ReviewPacket | null;
  /** Why a draft was dropped before it ever became a branch. */
  draftRejections: string[];
  approvalId: string | null;
  receipt: MergeReceipt | null;
  spentUsd: number;
}

export interface ApprovalDecision {
  status: "approved" | "rejected";
  decidedBy: string;
  note: string;
}

/**
 * Step whose checkpoint holds the review packet.
 *
 * A run awaiting a human is suspended and has no `result` yet, so the console
 * reads the packet from this checkpoint. Named once here so the two cannot
 * drift apart.
 */
export const REVIEW_STEP = "review";

export function reviewFromRun(record: RunRecord): ReviewPacket | null {
  const result = record.result as GuardianResult | null;
  if (result?.review) return result.review;
  return (record.checkpoints[REVIEW_STEP] as ReviewPacket | undefined) ?? null;
}

export interface GuardianDeps {
  llm: LLMProvider;
  /** The code map. Retrieval never goes outside it. */
  index: RepoIndex;
  ci: CiRunner;
  target: MergeTarget;
  gate: ApprovalGate;
  advisories?: Advisory[];
  budget?: Partial<ContextBudget>;
  policy?: Partial<AutoMergePolicy>;
  maxEdits?: number;
}

/**
 * Seeds and neighbourhood roots for a change.
 *
 * A dependency bump only edits the manifest, but the code that calls the
 * package is what makes the bump reviewable — so it is admitted as an extra
 * root rather than being reached by graph walking, which would never find it
 * (nothing imports `package.json`).
 */
function scopeRequestFor(
  index: RepoIndex,
  change: Change,
): { seeds: string[]; alsoConsider: string[] } {
  if (change.kind === "dependency_bump") {
    return {
      seeds: [index.snapshot.manifest.path],
      alsoConsider: index.filesImportingPackage(change.dependency),
    };
  }
  return { seeds: [change.targetPath], alsoConsider: [] };
}

/**
 * The codebase-guardian pipeline.
 *
 *   change -> scope        bounded dependency subgraph, or the run fails
 *          -> draft        model sees only that slice; shape-checked
 *          -> branch       reversible, so CI has something real to run
 *          -> CI           the test gate; red never reaches a human
 *          -> risk         transparent, hand-tuned
 *          -> policy       patch bumps only, deny-first
 *          -> approval     suspends here, indefinitely
 *          -> merge        the one irreversible step
 *
 * Three rules hold it up, in the order they bite. Context is a function of the
 * change and never of the repository's size. A red CI run drops the proposal
 * instead of putting it in front of a reviewer, because asking a human to
 * approve known-broken code is how approval becomes a rubber stamp. And the
 * only change that merges unattended is a green, low-risk, patch-level bump —
 * everything else, including anything the policy cannot classify, waits for a
 * named human.
 */
export function createCodebaseGuardian(
  deps: GuardianDeps,
): WorkflowDefinition<GuardianInput, GuardianResult> {
  return {
    name: "guardian.maintain",

    async run(ctx: StepContext, input: GuardianInput): Promise<GuardianResult> {
      const llm = new MeteredProvider(deps.llm, ctx.meter, (req, result) => {
        void ctx.audit.record("llm.call", `${req.purpose} on ${result.model}`, {
          purpose: req.purpose,
          model: result.model,
          costUsd: result.costUsd,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      });

      const index = deps.index;
      const baseCommit = index.snapshot.commit;

      // Retrieval first, and it throws rather than truncating: a change whose
      // own files do not fit the budget is not a change anyone can review.
      const scope: ScopedContext = await ctx.step("scope", async () => {
        const request = scopeRequestFor(index, input.change);
        return computeScope(index, { ...request, budget: deps.budget });
      });

      const drafted = await ctx.step("draft", async () =>
        draftProposal({
          llm,
          index,
          scope,
          change: input.change,
          goal: input.goal,
          proposalId: `${ctx.runId}-1`,
          baseCommit,
          maxEdits: deps.maxEdits,
          audit: ctx.audit,
        }),
      );

      if (!drafted.ok) {
        // No branch was ever opened, so there is nothing to clean up: a draft
        // that edits outside its context dies before it touches the repo.
        await ctx.audit.record("run.completed", "dropped: the draft failed its shape checks", {
          reasons: drafted.reasons,
        });
        return {
          outcome: "dropped_bad_draft",
          review: null,
          draftRejections: drafted.reasons,
          approvalId: null,
          receipt: null,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      const proposal = drafted.proposal;

      const branch = await ctx.step("open-branch", async () =>
        deps.target.openBranch({
          proposal,
          name: branchNameFor(proposal),
          baseCommit,
        }),
      );

      const ci = await ctx.step("run-ci", async () => deps.ci.run({ branch, proposal }));

      const review: ReviewPacket = await ctx.step(REVIEW_STEP, async () => {
        const bumpClass =
          input.change.kind === "dependency_bump"
            ? classifyBump(input.change.fromVersion, input.change.toVersion)
            : null;
        const risk = assessRisk({
          proposal,
          scope,
          index,
          bumpClass,
          ...(deps.advisories ? { advisories: deps.advisories } : {}),
        });
        return {
          proposal,
          branch,
          ci,
          risk,
          decision: decideAutoMerge({
            proposal,
            ci,
            risk,
            modelRecommendation: drafted.recommendation,
            ...(deps.policy ? { policy: deps.policy } : {}),
          }),
          context: {
            seeds: scope.seeds,
            files: scope.files.map((f) => f.path),
            chargedBytes: scope.chargedBytes,
            truncated: scope.truncated,
            omitted: scope.omitted,
            repoFileCount: index.fileCount,
          },
        };
      });

      if (!ci.green) {
        await ctx.step("abandon-red", async () => {
          await deps.target.abandon({
            branch,
            reason: `CI was not green: ${failedStepNames(ci).join(", ") || ci.error || "unknown"}`,
          });
          return { abandoned: branch.name };
        });
        await ctx.audit.record("run.completed", "blocked: CI was not green", {
          failed: failedStepNames(ci),
        });
        return {
          outcome: "blocked_by_test_gate",
          review,
          draftRejections: [],
          approvalId: null,
          receipt: null,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      if (review.decision.autoMerge) {
        const receipt = await ctx.step("auto-merge", async () =>
          deps.target.merge({
            branch,
            proposal,
            // No human decided this one; the pre-committed policy did, and the
            // receipt says so rather than naming someone who never looked.
            approvedBy: null,
            policy: review.decision.policy,
          }),
        );
        await ctx.audit.record("run.completed", "auto-merged under the patch-bump policy", {
          branch: branch.name,
          reasons: review.decision.reasons,
        });
        return {
          outcome: "auto_merged",
          review,
          draftRejections: [],
          approvalId: null,
          receipt,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      const approvalId = await ctx.step("request-approval", async () => {
        const request = await deps.gate.request({
          runId: ctx.runId,
          action: "guardian.merge",
          summary: `${describeChange(proposal.change)} (${proposal.edits.length} file(s), CI green)`,
          risk: review.risk,
          payload: {
            proposalId: proposal.id,
            branch: branch.name,
            url: branch.url,
            requestedBy: input.requestedBy,
            blockers: review.decision.blockers,
            context: review.context,
          },
          audit: ctx.audit,
        });
        return request.id;
      });

      const decision = await ctx.step<ApprovalDecision>("await-approval", async () =>
        ctx.suspend(`waiting for a human to review ${describeChange(proposal.change)}`, {
          approvalId,
          branch: branch.name,
          blockers: review.decision.blockers,
          risk: review.risk,
        }),
      );

      if (decision.status !== "approved") {
        await ctx.step("abandon-rejected", async () => {
          await deps.target.abandon({
            branch,
            reason: `rejected by ${decision.decidedBy}: ${decision.note || "(no note)"}`,
          });
          return { abandoned: branch.name };
        });
        await ctx.audit.record("run.completed", `rejected by ${decision.decidedBy}`, {
          note: decision.note,
        });
        return {
          outcome: "rejected",
          review,
          draftRejections: [],
          approvalId,
          receipt: null,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      const receipt = await ctx.step("merge", async () => {
        // Trust the stored approval rather than the resume value: the merge
        // has to be traceable to an immutable record a human actually made.
        const stored = await deps.gate.get(approvalId);
        if (stored?.status !== "approved") {
          throw new RejectedByHumanError(
            `approval ${approvalId} is ${stored?.status ?? "missing"}, not approved`,
          );
        }
        return deps.target.merge({
          branch,
          proposal,
          approvedBy: stored.decidedBy ?? decision.decidedBy,
          policy: "human-approved",
        });
      });

      return {
        outcome: "merged",
        review,
        draftRejections: [],
        approvalId,
        receipt,
        spentUsd: ctx.meter.spentUsd,
      };
    },
  };
}

const failedStepNames = (ci: CiReport): string[] =>
  ci.steps.filter((s) => !s.passed).map((s) => s.name);
