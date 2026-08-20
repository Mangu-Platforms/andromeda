import type { Clock } from "./clock.ts";
import type { Store } from "./store.ts";

export type AuditKind =
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.suspended"
  | "run.resumed"
  | "step.started"
  | "step.completed"
  | "step.replayed"
  | "step.failed"
  | "llm.call"
  | "sandbox.exec"
  | "gate.requested"
  | "gate.approved"
  | "gate.rejected";

export interface AuditEvent {
  seq: number;
  runId: string;
  at: number;
  kind: AuditKind;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Append-only, per-run event log.
 *
 * Every agent action a human might later have to answer for lands here. It is
 * the record a reviewer reads before approving, and the trail an operator reads
 * after something goes wrong; nothing in the substrate ever mutates or deletes
 * an entry. Ids are `<runId>.<zero-padded seq>` so a plain lexical listing
 * comes back in causal order.
 */
export class AuditLog {
  readonly runId: string;
  readonly #store: Store;
  readonly #clock: Clock;
  #seq = 0;

  constructor(store: Store, clock: Clock, runId: string) {
    this.#store = store;
    this.#clock = clock;
    this.runId = runId;
  }

  /** Continue numbering an existing run (used when a suspended run resumes). */
  static async open(store: Store, clock: Clock, runId: string): Promise<AuditLog> {
    const log = new AuditLog(store, clock, runId);
    const existing = await log.events();
    log.#seq = existing.length === 0 ? 0 : (existing.at(-1)?.seq ?? 0) + 1;
    return log;
  }

  async record(
    kind: AuditKind,
    summary: string,
    data: Record<string, unknown> = {},
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      seq: this.#seq++,
      runId: this.runId,
      at: this.#clock.now(),
      kind,
      summary,
      data,
    };
    await this.#store.put("audit", `${this.runId}.${String(event.seq).padStart(6, "0")}`, event);
    return event;
  }

  async events(): Promise<AuditEvent[]> {
    const all = await this.#store.list<AuditEvent>("audit");
    return all
      .filter(({ id }) => id.startsWith(`${this.runId}.`))
      .map(({ value }) => value);
  }
}
