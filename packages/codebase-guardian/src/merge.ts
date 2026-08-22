import type { ChangeProposal } from "./change/proposal.ts";

export interface BranchRef {
  name: string;
  baseCommit: string;
  /** Where a reviewer looks at it. `(local)` for targets with no web view. */
  url: string;
}

export interface MergeReceipt {
  target: string;
  branch: string;
  commit: string;
  /** Named human, or `null` when the pre-committed auto-merge policy applied. */
  approvedBy: string | null;
  policy: string;
}

export interface MergeRequest {
  branch: BranchRef;
  proposal: ChangeProposal;
  approvedBy: string | null;
  policy: string;
}

/**
 * Where a proposal goes.
 *
 * Split in two on purpose. `openBranch` is reversible — it produces something
 * a human can read, run and throw away — and it happens before CI, so the test
 * gate runs against the change rather than against a description of it.
 * `merge` is the irreversible step, and it is the only one the approval gate
 * stands in front of. `abandon` exists so a red or rejected proposal cleans up
 * after itself instead of leaving branches to accumulate.
 *
 * A GitHub implementation slots in here unchanged: push a branch, open a pull
 * request, merge it.
 */
export interface MergeTarget {
  readonly name: string;
  openBranch(input: { proposal: ChangeProposal; baseCommit: string }): Promise<BranchRef>;
  merge(request: MergeRequest): Promise<MergeReceipt>;
  abandon(input: { branch: BranchRef; reason: string }): Promise<void>;
}

/**
 * In-memory target that records what it was asked to do. Used by the test
 * suite to assert the negative: that `merges` stays empty on every path that
 * did not go through a green CI run and a policy decision.
 */
export class RecordingMergeTarget implements MergeTarget {
  readonly name = "recording";
  readonly branches: BranchRef[] = [];
  readonly merges: MergeRequest[] = [];
  readonly abandoned: Array<{ branch: BranchRef; reason: string }> = [];

  async openBranch(input: {
    proposal: ChangeProposal;
    baseCommit: string;
  }): Promise<BranchRef> {
    const branch: BranchRef = {
      name: `guardian/${input.proposal.id}`,
      baseCommit: input.baseCommit,
      url: `(local)/${input.proposal.id}`,
    };
    this.branches.push(branch);
    return branch;
  }

  async merge(request: MergeRequest): Promise<MergeReceipt> {
    this.merges.push(request);
    return {
      target: this.name,
      branch: request.branch.name,
      commit: `merged-${request.proposal.id}`,
      approvedBy: request.approvedBy,
      policy: request.policy,
    };
  }

  async abandon(input: { branch: BranchRef; reason: string }): Promise<void> {
    this.abandoned.push(input);
  }
}
