import type { Clock, Ids } from "./clock.ts";
import type { Store } from "./store.ts";
import { AuditLog } from "./audit.ts";
import { CostMeter } from "./metering.ts";
import { GlobalBudgetExceededError, SuspendSignal } from "./errors.ts";

export type RunStatus = "running" | "suspended" | "completed" | "failed";

export interface RunRecord {
  id: string;
  workflow: string;
  status: RunStatus;
  input: unknown;
  /** Step name -> serialized result. Present steps are never re-executed. */
  checkpoints: Record<string, unknown>;
  suspension: { step: string; reason: string; payload: unknown } | null;
  result: unknown;
  error: { name: string; message: string } | null;
  spentUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface StepContext {
  readonly runId: string;
  readonly audit: AuditLog;
  readonly meter: CostMeter;
  /**
   * Run `fn` once per run and checkpoint its result. On resume, a step that
   * already has a checkpoint returns it without executing, so replay is cheap
   * and side effects happen at most once.
   *
   * The result must be JSON-serializable — it has to survive a process restart.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Whether `name` already has a checkpoint, i.e. it would replay rather than
   * execute. Lets a workflow skip setting up expensive resources that only the
   * un-run steps would need.
   */
  hasCheckpoint(name: string): boolean;
  /**
   * Stop the run and hand control to a human. Resuming with a value makes that
   * value the enclosing step's result.
   */
  suspend(reason: string, payload: unknown): never;
}

export interface WorkflowDefinition<Input, Output> {
  name: string;
  run(ctx: StepContext, input: Input): Promise<Output>;
}

export interface RunnerOptions {
  store: Store;
  clock: Clock;
  ids: Ids;
  /** Per-run spend ceiling in USD. */
  budgetUsd?: number;
  /**
   * Ceiling on spend summed across *all* runs whose window it falls in — the
   * org-level bound the per-run ceiling cannot provide: without it, anyone who
   * can start runs can start an unbounded number of maximally priced ones.
   *
   * Enforced two ways. `start` refuses outright once the windowed total
   * reaches the limit. A run that already exists keeps working — resuming to
   * deliver an approved build spends nothing and must not be blocked by an
   * exhausted budget — but its meter is capped to the global headroom, so any
   * *new* completion fails rather than adding spend. In-flight overshoot is
   * therefore bounded by the per-run ceilings of runs already started.
   */
  globalBudget?: {
    limitUsd: number;
    /** How far back spend counts against the limit. Defaults to 24 hours. */
    windowMs?: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

class Context implements StepContext {
  readonly runId: string;
  readonly audit: AuditLog;
  readonly meter: CostMeter;
  readonly #checkpoints: Record<string, unknown>;
  #currentStep: string | null = null;

  constructor(
    runId: string,
    audit: AuditLog,
    meter: CostMeter,
    checkpoints: Record<string, unknown>,
  ) {
    this.runId = runId;
    this.audit = audit;
    this.meter = meter;
    this.#checkpoints = checkpoints;
  }

  hasCheckpoint(name: string): boolean {
    return Object.hasOwn(this.#checkpoints, name);
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.hasCheckpoint(name)) {
      await this.audit.record("step.replayed", `replayed ${name} from checkpoint`, {
        step: name,
      });
      return this.#checkpoints[name] as T;
    }
    const previous = this.#currentStep;
    this.#currentStep = name;
    await this.audit.record("step.started", `started ${name}`, { step: name });
    try {
      const value = await fn();
      // Round-trip through JSON now rather than at persistence time, so a
      // non-serializable result fails loudly inside the step that produced it.
      this.#checkpoints[name] = JSON.parse(JSON.stringify(value ?? null));
      await this.audit.record("step.completed", `completed ${name}`, { step: name });
      return value;
    } catch (err) {
      if (err instanceof SuspendSignal) throw err;
      await this.audit.record("step.failed", `failed ${name}: ${asError(err).message}`, {
        step: name,
        error: asError(err).message,
      });
      throw err;
    } finally {
      this.#currentStep = previous;
    }
  }

  suspend(reason: string, payload: unknown): never {
    throw new SuspendSignal(this.#currentStep ?? "(top level)", reason, payload);
  }
}

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

/**
 * Durable, checkpointed workflow execution with human-in-the-loop interrupts.
 *
 * The model is LangGraph's, minus the infrastructure: steps are memoized by
 * name, a run that suspends is persisted and can be resumed in a different
 * process, and resuming re-enters the workflow from the top while completed
 * steps return instantly from their checkpoints.
 *
 * The contract that makes replay safe: a step body must be idempotent, and any
 * side effect must live inside a step rather than between steps.
 */
export class WorkflowRunner {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #budgetUsd: number;
  readonly #globalBudget: { limitUsd: number; windowMs: number } | null;

  constructor(options: RunnerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#budgetUsd = options.budgetUsd ?? 5;
    this.#globalBudget = options.globalBudget
      ? {
          limitUsd: options.globalBudget.limitUsd,
          windowMs: options.globalBudget.windowMs ?? DAY_MS,
        }
      : null;
    if (this.#globalBudget && !(this.#globalBudget.limitUsd > 0)) {
      throw new Error("global budget limit must be positive");
    }
  }

  /**
   * Spend across every run created inside the window, derived from the stored
   * records each time rather than kept as a counter — a counter can drift or
   * race; the records are the audit-grade truth this repo already trusts.
   */
  async #globalSpentUsd(windowMs: number, excludeRunId?: string): Promise<number> {
    const cutoff = this.#clock.now() - windowMs;
    const runs = await this.#store.list<RunRecord>("runs");
    let total = 0;
    for (const { value } of runs) {
      if (value.id === excludeRunId) continue;
      if (value.createdAt >= cutoff) total += value.spentUsd;
    }
    return total;
  }

  async start<I, O>(workflow: WorkflowDefinition<I, O>, input: I): Promise<RunRecord> {
    if (this.#globalBudget) {
      const spent = await this.#globalSpentUsd(this.#globalBudget.windowMs);
      if (spent >= this.#globalBudget.limitUsd) {
        throw new GlobalBudgetExceededError(
          spent,
          this.#globalBudget.limitUsd,
          this.#globalBudget.windowMs,
        );
      }
    }
    const now = this.#clock.now();
    const record: RunRecord = {
      id: this.#ids.next("run"),
      workflow: workflow.name,
      status: "running",
      input: input ?? null,
      checkpoints: {},
      suspension: null,
      result: null,
      error: null,
      spentUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.put("runs", record.id, record);
    const audit = new AuditLog(this.#store, this.#clock, record.id);
    await audit.record("run.started", `started ${workflow.name}`, { input });
    return this.#execute(workflow, record, audit);
  }

  /**
   * Resume a suspended run. `resumeValue` becomes the result of the step that
   * suspended, which is how an approval decision flows back into the pipeline.
   */
  async resume<I, O>(
    workflow: WorkflowDefinition<I, O>,
    runId: string,
    resumeValue: unknown,
  ): Promise<RunRecord> {
    const record = await this.#store.get<RunRecord>("runs", runId);
    if (!record) throw new Error(`no run ${runId}`);
    if (record.status !== "suspended") {
      throw new Error(`run ${runId} is ${record.status}, not suspended`);
    }
    const suspension = record.suspension;
    if (!suspension) throw new Error(`run ${runId} is suspended without a suspension record`);

    const audit = await AuditLog.open(this.#store, this.#clock, runId);
    await audit.record("run.resumed", `resumed at ${suspension.step}`, {
      step: suspension.step,
      resumeValue,
    });

    const resumed: RunRecord = {
      ...record,
      status: "running",
      suspension: null,
      checkpoints: {
        ...record.checkpoints,
        [suspension.step]: JSON.parse(JSON.stringify(resumeValue ?? null)),
      },
    };
    return this.#execute(workflow, resumed, audit);
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.#store.get<RunRecord>("runs", runId);
  }

  async list(): Promise<RunRecord[]> {
    const all = await this.#store.list<RunRecord>("runs");
    return all.map(({ value }) => value).sort((a, b) => b.createdAt - a.createdAt);
  }

  async #execute<I, O>(
    workflow: WorkflowDefinition<I, O>,
    record: RunRecord,
    audit: AuditLog,
  ): Promise<RunRecord> {
    // Seeded with prior spend so the ceiling is per run, not per attempt —
    // otherwise every resume would hand the run a fresh budget.
    let limitUsd = this.#budgetUsd;
    if (this.#globalBudget) {
      // Cap to the global headroom, so an existing run keeps replaying and
      // delivering when the window is exhausted but cannot add new spend.
      const elsewhere = await this.#globalSpentUsd(this.#globalBudget.windowMs, record.id);
      const headroom = Math.max(0, this.#globalBudget.limitUsd - elsewhere - record.spentUsd);
      limitUsd = Math.min(limitUsd, record.spentUsd + headroom);
    }
    // CostMeter refuses a non-positive limit; the epsilon covers the one edge
    // where a run that never spent resumes into an exhausted window — it may
    // replay and deliver, and its first new completion throws.
    const meter = new CostMeter(Math.max(limitUsd, 1e-6), record.spentUsd);
    const ctx = new Context(record.id, audit, meter, record.checkpoints);
    let next: RunRecord;

    try {
      const result = await workflow.run(ctx, record.input as I);
      next = {
        ...record,
        status: "completed",
        result: JSON.parse(JSON.stringify(result ?? null)),
      };
      await audit.record("run.completed", `completed ${workflow.name}`, {});
    } catch (err) {
      if (err instanceof SuspendSignal) {
        next = {
          ...record,
          status: "suspended",
          suspension: { step: err.step, reason: err.reason, payload: err.payload },
        };
        await audit.record("run.suspended", err.reason, { step: err.step });
      } else {
        const error = asError(err);
        next = {
          ...record,
          status: "failed",
          error: { name: error.name, message: error.message },
        };
        await audit.record("run.failed", error.message, { name: error.name });
      }
    }

    next.spentUsd = meter.spentUsd;

    next.updatedAt = this.#clock.now();
    await this.#store.put("runs", next.id, next);
    return next;
  }
}
