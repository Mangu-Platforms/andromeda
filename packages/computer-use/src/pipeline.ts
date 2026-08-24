import type {
  ApprovalGate,
  LLMProvider,
  StepContext,
  WorkflowDefinition,
} from "@andromeda/core";
import { MeteredProvider, RejectedByHumanError } from "@andromeda/core";

import { classifyAction } from "./actions/classify.ts";
import type { ActionClass, ProposedAction } from "./actions/types.ts";
import type { BrowserDriver } from "./browser/types.ts";
import { GuardedBrowser } from "./browser/guarded.ts";
import type { DomainAllowlist } from "./policy/allowlist.ts";
import { readPage, type PageFacts } from "./reader.ts";
import { planStep } from "./planner.ts";

export interface TaskInput {
  goal: string;
  startUrl: string;
  requestedBy: string;
}

export interface StepRecord {
  index: number;
  url: string;
  action: ProposedAction;
  actionClass: ActionClass;
  /** Set for write actions: the approval that authorised this step. */
  approvalId: string | null;
  facts: PageFacts;
}

export type TaskOutcome = "completed" | "rejected" | "step_limit";

export interface TaskResult {
  outcome: TaskOutcome;
  steps: StepRecord[];
  finalUrl: string;
  spentUsd: number;
}

export interface AgentDeps {
  llm: LLMProvider;
  browser: BrowserDriver;
  allowlist: DomainAllowlist;
  gate: ApprovalGate;
  /** Hard ceiling on steps, so a loop ends rather than running until the budget does. */
  maxSteps?: number;
}

/**
 * The computer-use agent.
 *
 * Three controls stack here, and they are deliberately independent — each is
 * sufficient against a different failure, and none relies on the model
 * behaving:
 *
 *   allowlist   the landed URL is checked after every operation, so the agent
 *               cannot read a page the operator did not sanction
 *   dual-LLM    the reader sees untrusted text and cannot emit actions; the
 *               planner emits actions and never sees untrusted text
 *   approval    every write suspends for a named human, and an unrecognised
 *               action kind is classified as a write
 *
 * Read-only work therefore runs unattended, and nothing irreversible happens
 * without a person. That is the whole product: injection is not prevented, it
 * is made unable to reach anything that matters.
 */
export function createComputerUseAgent(
  deps: AgentDeps,
): WorkflowDefinition<TaskInput, TaskResult> {
  const maxSteps = deps.maxSteps ?? 12;

  return {
    name: "computeruse.task",

    async run(ctx: StepContext, input: TaskInput): Promise<TaskResult> {
      const llm = new MeteredProvider(deps.llm, ctx.meter, (req, result) => {
        void ctx.audit.record("llm.call", `${req.purpose} on ${result.model}`, {
          purpose: req.purpose,
          model: result.model,
          costUsd: result.costUsd,
        });
      });

      const browser = new GuardedBrowser(deps.browser, deps.allowlist, (url, reason) => {
        void ctx.audit.record("step.failed", `navigation blocked: ${reason}`, { url, reason });
      });

      const steps: StepRecord[] = [];

      // The opening navigation is itself allowlist-checked, so a task can not
      // be aimed off-policy by its own start URL.
      await ctx.step("open", async () => {
        const snapshot = await browser.navigate(input.startUrl);
        return { url: snapshot.url };
      });

      for (let index = 0; index < maxSteps; index++) {
        const snapshot = await browser.observe();

        // Read and plan are separate checkpoints so a resumed run never
        // re-reads a page, and so the audit log shows the facts the planner
        // actually saw rather than a reconstruction.
        const facts = await ctx.step(`read:${index}`, async () =>
          readPage({ llm, snapshot, goal: input.goal }),
        );

        const action = await ctx.step(`plan:${index}`, async () =>
          planStep({
            llm,
            goal: input.goal,
            facts,
            knownElementIds: snapshot.elements.map((e) => e.id),
            history: steps.map((s) => `${s.action.kind} ${s.action.elementId || s.action.url}`),
          }),
        );

        if (action.kind === "done") {
          await ctx.audit.record("run.completed", `agent reported done: ${action.rationale}`, {});
          return {
            outcome: "completed",
            steps,
            finalUrl: browser.currentUrl(),
            spentUsd: ctx.meter.spentUsd,
          };
        }

        // Ground truth, computed here from the kind — never taken from the model.
        const actionClass = classifyAction(action.kind);
        let approvalId: string | null = null;

        if (actionClass === "write") {
          approvalId = await ctx.step(`approval-request:${index}`, async () => {
            const request = await deps.gate.request({
              runId: ctx.runId,
              action: `computeruse.${action.kind}`,
              summary: `${action.kind} on ${snapshot.url}: ${action.rationale}`,
              risk: {
                score: 70,
                factors: [
                  `"${action.kind}" changes state outside the browser`,
                  `page: ${facts.title}`,
                  `element: ${action.elementId || "(none)"}`,
                ],
              },
              payload: {
                goal: input.goal,
                url: snapshot.url,
                action,
                pageSummary: facts.summary,
                requestedBy: input.requestedBy,
              },
              audit: ctx.audit,
            });
            return request.id;
          });

          const decision = await ctx.step<{ status: string; decidedBy: string }>(
            `approval:${index}`,
            async () =>
              ctx.suspend(`waiting for approval of ${action.kind}`, {
                approvalId,
                action,
                url: snapshot.url,
              }),
          );

          if (decision.status !== "approved") {
            await ctx.audit.record("run.completed", `rejected by ${decision.decidedBy}`, {});
            return {
              outcome: "rejected",
              steps,
              finalUrl: browser.currentUrl(),
              spentUsd: ctx.meter.spentUsd,
            };
          }

          // The stored record is the authority, not the value we resumed with.
          const stored = await deps.gate.get(approvalId as string);
          if (stored?.status !== "approved") {
            throw new RejectedByHumanError(
              `approval ${approvalId} is ${stored?.status ?? "missing"}, not approved`,
            );
          }
        }

        await ctx.step(`act:${index}`, async () => {
          if (action.kind === "navigate") {
            await browser.navigate(action.url);
          } else {
            await browser.interact(action.kind, action.elementId, action.value);
          }
          return { url: browser.currentUrl() };
        });

        steps.push({ index, url: snapshot.url, action, actionClass, approvalId, facts });
      }

      await ctx.audit.record("run.completed", `stopped at the ${maxSteps}-step limit`, {});
      return {
        outcome: "step_limit",
        steps,
        finalUrl: browser.currentUrl(),
        spentUsd: ctx.meter.spentUsd,
      };
    },
  };
}
