import type { Clock, Ids } from "./clock.ts";
import type { Store } from "./store.ts";
import type { AuditLog } from "./audit.ts";

export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Why a proposed action needs a human. `score` is 0-100 and advisory: it orders
 * a reviewer's queue, it never decides anything on its own.
 */
export interface RiskAssessment {
  score: number;
  factors: string[];
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  /** Machine-readable action name, e.g. "autobuilder.merge_pr". */
  action: string;
  summary: string;
  risk: RiskAssessment;
  /** Everything the reviewer needs to decide, rendered by the console. */
  payload: unknown;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string;
}

/**
 * The compensating control the whole blueprint leans on: irreversible actions
 * become proposals, and a named human turns a proposal into an action.
 *
 * The gate deliberately has no auto-approve path and no timeout-approves
 * default. A request that nobody answers stays pending forever, which is the
 * safe resting state.
 */
export class ApprovalGate {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #ids: Ids;

  constructor(store: Store, clock: Clock, ids: Ids) {
    this.#store = store;
    this.#clock = clock;
    this.#ids = ids;
  }

  async request(input: {
    runId: string;
    action: string;
    summary: string;
    risk: RiskAssessment;
    payload: unknown;
    audit?: AuditLog;
  }): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: this.#ids.next("apr"),
      runId: input.runId,
      action: input.action,
      summary: input.summary,
      risk: input.risk,
      payload: input.payload,
      status: "pending",
      requestedAt: this.#clock.now(),
      decidedAt: null,
      decidedBy: null,
      note: "",
    };
    await this.#store.put("approvals", request.id, request);
    await input.audit?.record("gate.requested", input.summary, {
      approvalId: request.id,
      action: input.action,
      risk: input.risk,
    });
    return request;
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return this.#store.get<ApprovalRequest>("approvals", id);
  }

  async decide(
    id: string,
    status: "approved" | "rejected",
    decidedBy: string,
    note = "",
    audit?: AuditLog,
  ): Promise<ApprovalRequest> {
    const request = await this.get(id);
    if (!request) throw new Error(`no approval request ${id}`);
    if (request.status !== "pending") {
      throw new Error(
        `approval ${id} is already ${request.status}; decisions are final`,
      );
    }
    if (!decidedBy.trim()) {
      throw new Error("an approval must be attributable to a named human");
    }
    const decided: ApprovalRequest = {
      ...request,
      status,
      decidedAt: this.#clock.now(),
      decidedBy,
      note,
    };
    await this.#store.put("approvals", id, decided);
    await audit?.record(
      status === "approved" ? "gate.approved" : "gate.rejected",
      `${request.action} ${status} by ${decidedBy}`,
      { approvalId: id, note },
    );
    return decided;
  }

  /** Every request, newest first — the operator's account of what was decided by whom. */
  async list(): Promise<ApprovalRequest[]> {
    const all = await this.#store.list<ApprovalRequest>("approvals");
    return all.map(({ value }) => value).sort((a, b) => b.requestedAt - a.requestedAt);
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const all = await this.#store.list<ApprovalRequest>("approvals");
    return all.map(({ value }) => value).filter((r) => r.status === "pending");
  }

  async listForRun(runId: string): Promise<ApprovalRequest[]> {
    const all = await this.#store.list<ApprovalRequest>("approvals");
    return all.map(({ value }) => value).filter((r) => r.runId === runId);
  }
}
