import type {
  ApprovalGate,
  LLMProvider,
  RiskAssessment,
  RunRecord,
  StepContext,
  WorkflowDefinition,
} from "@andromeda/core";
import { MeteredProvider, RejectedByHumanError } from "@andromeda/core";

import type { ProjectSpec } from "./spec/types.ts";
import { compileSpec } from "./spec/compiler.ts";
import { TemplateRegistry } from "./templates/registry.ts";
import type { GeneratedFile } from "./templates/types.ts";
import type { Sandbox } from "./sandbox/types.ts";
import { generateFeature, type FeatureBuild } from "./features/generate.ts";
import { assessRisk } from "./pr/risk.ts";
import type { DeliveryReceipt, DeliveryTarget } from "./pr/delivery.ts";

export interface BuildInput {
  /** Natural-language description of the project to build. */
  intent: string;
  requestedBy: string;
}

export type BuildOutcome = "delivered" | "rejected" | "blocked_by_test_gate";

export interface BuildProposal {
  projectName: string;
  spec: ProjectSpec;
  templateId: string;
  templateVersion: string;
  /** Scaffold plus generated feature modules: the whole reviewable repository. */
  files: GeneratedFile[];
  featureBuilds: FeatureBuild[];
  testsGreen: boolean;
  risk: RiskAssessment;
  specAttempts: number;
}

export interface BuildResult {
  outcome: BuildOutcome;
  proposal: BuildProposal;
  approvalId: string | null;
  receipt: DeliveryReceipt | null;
  spentUsd: number;
}

/** Decision handed back when a suspended run resumes. */
export interface ApprovalDecision {
  status: "approved" | "rejected";
  decidedBy: string;
  note: string;
}

/**
 * Step whose checkpoint holds the reviewable proposal.
 *
 * A build spends most of its life suspended, waiting for a human, and a
 * suspended run has no `result` yet — so the reviewer's view has to come from
 * the checkpoint rather than the return value. Named here so the console and
 * the pipeline cannot drift apart.
 */
export const PROPOSAL_STEP = "assess-risk";

/** The proposal for a run, whether it is still awaiting review or finished. */
export function proposalFromRun(record: RunRecord): BuildProposal | null {
  const result = record.result as BuildResult | null;
  if (result?.proposal) return result.proposal;
  return (record.checkpoints[PROPOSAL_STEP] as BuildProposal | undefined) ?? null;
}

export interface AutoBuilderDeps {
  llm: LLMProvider;
  registry: TemplateRegistry;
  gate: ApprovalGate;
  delivery: DeliveryTarget;
  /** Fresh execution environment per run; disposed as soon as features are built. */
  createSandbox: () => Promise<Sandbox>;
  maxSpecAttempts?: number;
  maxFeatureAttempts?: number;
}

/**
 * The auto-builder pipeline.
 *
 * The shape of it is the product's answer to non-deterministic multi-step code
 * generation: split the work into a deterministic half and a gated
 * non-deterministic half, and never let the second half reach a customer
 * unattended.
 *
 *   intent -> spec (validated, repaired)      model proposes, validator decides
 *          -> scaffold (rendered)             pure function of the spec
 *          -> features (test-gated)           frozen tests must pass
 *          -> risk assessment                 transparent, hand-tuned
 *          -> human approval                  suspends here, indefinitely
 *          -> delivery                        the only irreversible step
 *
 * Two rules hold the whole thing up. A build whose tests are red is never put
 * in front of a reviewer — asking someone to approve known-broken code is how
 * approval becomes a rubber stamp. And delivery happens only after a named
 * human approves, so the pipeline's autonomy stops at the last reversible step.
 */
export function createAutoBuilder(
  deps: AutoBuilderDeps,
): WorkflowDefinition<BuildInput, BuildResult> {
  return {
    name: "autobuilder.build",

    async run(ctx: StepContext, input: BuildInput): Promise<BuildResult> {
      const llm = new MeteredProvider(deps.llm, ctx.meter, (req, result) => {
        void ctx.audit.record("llm.call", `${req.purpose} on ${result.model}`, {
          purpose: req.purpose,
          model: result.model,
          costUsd: result.costUsd,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      });

      const compiled = await ctx.step("compile-spec", async () =>
        compileSpec({
          llm,
          intent: input.intent,
          knownTemplates: deps.registry.ids(),
          maxAttempts: deps.maxSpecAttempts ?? 3,
          audit: ctx.audit,
        }),
      );
      const spec = compiled.spec;

      const scaffold = await ctx.step("render-scaffold", async () => deps.registry.render(spec));

      const featureBuilds = await buildFeatures(ctx, deps, llm, spec, scaffold.files);

      const files = [...scaffold.files, ...featureBuilds.flatMap((b) => b.files)].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      const testsGreen = featureBuilds.every((b) => b.passed);

      const proposal: BuildProposal = await ctx.step(PROPOSAL_STEP, async () => ({
        projectName: spec.name,
        spec,
        templateId: scaffold.templateId,
        templateVersion: scaffold.templateVersion,
        files,
        featureBuilds,
        testsGreen,
        risk: assessRisk({ spec, files, featureBuilds }),
        specAttempts: compiled.attempts,
      }));

      if (!testsGreen) {
        // Stop here on purpose. The reviewer gets the evidence through the run
        // record; they do not get an approve button for a red build.
        await ctx.audit.record(
          "run.completed",
          "blocked: one or more features never passed their tests",
          { failed: featureBuilds.filter((b) => !b.passed).map((b) => b.featureId) },
        );
        return {
          outcome: "blocked_by_test_gate",
          proposal,
          approvalId: null,
          receipt: null,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      const approvalId = await ctx.step("request-approval", async () => {
        const request = await deps.gate.request({
          runId: ctx.runId,
          action: "autobuilder.deliver",
          summary: `Deliver ${spec.name}: ${files.length} files, ${featureBuilds.length} test-gated feature(s)`,
          risk: proposal.risk,
          payload: {
            projectName: spec.name,
            fileCount: files.length,
            requestedBy: input.requestedBy,
          },
          audit: ctx.audit,
        });
        return request.id;
      });

      const decision = await ctx.step<ApprovalDecision>("await-approval", async () =>
        ctx.suspend(`waiting for a human to review ${spec.name}`, {
          approvalId,
          projectName: spec.name,
          risk: proposal.risk,
        }),
      );

      if (decision.status !== "approved") {
        await ctx.audit.record("run.completed", `rejected by ${decision.decidedBy}`, {
          note: decision.note,
        });
        return {
          outcome: "rejected",
          proposal,
          approvalId,
          receipt: null,
          spentUsd: ctx.meter.spentUsd,
        };
      }

      const receipt = await ctx.step("deliver", async () => {
        // Re-read the recorded decision rather than trusting the resume value:
        // delivery must be traceable to a stored, immutable approval.
        const stored = await deps.gate.get(approvalId);
        if (stored?.status !== "approved") {
          throw new RejectedByHumanError(
            `approval ${approvalId} is ${stored?.status ?? "missing"}, not approved`,
          );
        }
        return deps.delivery.deliver({
          projectName: spec.name,
          files,
          approvedBy: stored.decidedBy ?? decision.decidedBy,
        });
      });

      return {
        outcome: "delivered",
        proposal,
        approvalId,
        receipt,
        spentUsd: ctx.meter.spentUsd,
      };
    },

  };
}

/**
 * One checkpointed step per feature, so a resume never regenerates a feature
 * that already passed — and never needs a sandbox when they all did.
 */
async function buildFeatures(
  ctx: StepContext,
  deps: AutoBuilderDeps,
  llm: LLMProvider,
  spec: ProjectSpec,
  scaffoldFiles: GeneratedFile[],
): Promise<FeatureBuild[]> {
  if (spec.features.length === 0) return [];
  const pending = spec.features.filter((f) => !ctx.hasCheckpoint(`feature:${f.id}`));

  let sandbox: Sandbox | null = null;
  try {
    if (pending.length > 0) {
      sandbox = await deps.createSandbox();
      await sandbox.writeFiles(scaffoldFiles);
    }

    const builds: FeatureBuild[] = [];
    for (const feature of spec.features) {
      builds.push(
        await ctx.step(`feature:${feature.id}`, async () =>
          generateFeature({
            llm,
            spec,
            feature,
            // Only reached for features without a checkpoint, which is exactly
            // when the sandbox was created above.
            sandbox: sandbox as Sandbox,
            audit: ctx.audit,
            maxAttempts: deps.maxFeatureAttempts ?? 3,
          }),
        ),
      );
    }
    return builds;
  } finally {
    await sandbox?.dispose();
  }
}
