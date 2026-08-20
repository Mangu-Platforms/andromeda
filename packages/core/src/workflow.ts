import type { Clock, Ids } from "./clock.ts";
import type { Store } from "./store.ts";
import { AuditLog } from "./audit.ts";
import { CostMeter } from "./metering.ts";
import { SuspendSignal } from "./errors.ts";

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
}

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

  constructor(options: RunnerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#budgetUsd = options.budgetUsd ?? 5;
  }

  async start<I, O>(workflow: WorkflowDefinition<I, O>, input: I): Promise<RunRecord> {
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
    const meter = new CostMeter(this.#budgetUsd, record.spentUsd);
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
