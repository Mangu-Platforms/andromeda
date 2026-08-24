import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLLMProvider } from "@andromeda/core";

import { buildIndex } from "../src/repo/snapshot.ts";
import { computeScope } from "../src/repo/scope.ts";
import type { ScopedContext } from "../src/repo/scope.ts";
import type { Change, ChangeProposal } from "../src/change/proposal.ts";
import { checkProposal, branchNameFor } from "../src/change/proposal.ts";
import { draftProposal } from "../src/change/draft.ts";
import { billingSnapshot } from "./fixtures.ts";

const index = buildIndex(billingSnapshot());

/** The bump scope: the manifest plus the code that actually calls the package. */
function bumpScope(): ScopedContext {
  return computeScope(index, {
    seeds: ["package.json"],
    alsoConsider: index.filesImportingPackage("left-pad"),
  });
}

const bumpedManifest = (version: string): string =>
  `${JSON.stringify(
    {
      name: "billing",
      version: "1.0.0",
      dependencies: { "left-pad": version, "risky-lib": "0.4.1", "grid-engine": "2.4.0" },
    },
    null,
    2,
  )}\n`;

function proposal(
  change: Change,
  edits: ChangeProposal["edits"],
  scope: ScopedContext,
): ChangeProposal {
  return {
    id: "prop_0001",
    title: "bump left-pad",
    rationale: "picks up a fix",
    change,
    edits,
    scopePaths: scope.files.map((f) => f.path),
    baseCommit: "c0ffee1",
  };
}

const bump: Change = {
  kind: "dependency_bump",
  dependency: "left-pad",
  fromVersion: "1.2.3",
  toVersion: "1.2.4",
};

test("a well-formed patch bump passes the shape checks", () => {
  const scope = bumpScope();
  assert.deepEqual(scope.files.map((f) => f.path), ["package.json", "src/billing/invoice.ts"]);

  const reasons = checkProposal(
    proposal(bump, [{ path: "package.json", contents: bumpedManifest("1.2.4") }], scope),
    { index, scope },
  );
  assert.deepEqual(reasons, []);
  assert.equal(
    branchNameFor(proposal(bump, [], scope)),
    "guardian/bump-left-pad-1-2-3-1-2-4-prop_0001",
  );
});

test("an edit to a file that was never retrieved is rejected", () => {
  const scope = bumpScope();
  // `src/auth/session.ts` exists in the repo but is outside the change's
  // dependency subgraph, so no model or reviewer ever read it.
  assert.ok(index.has("src/auth/session.ts"));

  const reasons = checkProposal(
    proposal(
      bump,
      [
        { path: "package.json", contents: bumpedManifest("1.2.4") },
        { path: "src/auth/session.ts", contents: "export const sessionFor = () => 'x';\n" },
      ],
      scope,
    ),
    { index, scope },
  );

  assert.ok(reasons.some((r) => r.includes("src/auth/session.ts") && r.includes("not in the retrieved context")));
});

test("a proposal carrying two changes at once is rejected in both directions", () => {
  const scope = bumpScope();

  // A bump that also rewrites source would smuggle arbitrary code through the
  // patch-bump auto-merge lane.
  const bumpPlusSource = checkProposal(
    proposal(
      bump,
      [
        { path: "package.json", contents: bumpedManifest("1.2.4") },
        { path: "src/billing/invoice.ts", contents: "export function renderInvoice(): string {\n  return 'x';\n}\n" },
      ],
      scope,
    ),
    { index, scope },
  );
  assert.ok(bumpPlusSource.some((r) => r.includes("also rewrites source")));

  // And the reverse: a refactor may not touch the manifest.
  const refactorScope = computeScope(index, {
    seeds: ["src/billing/invoice.ts"],
    alsoConsider: ["package.json"],
  });
  const refactorPlusManifest = checkProposal(
    proposal(
      { kind: "refactor", targetPath: "src/billing/invoice.ts", summary: "tidy" },
      [
        { path: "src/billing/invoice.ts", contents: "export function renderInvoice(): string {\n  return 'x';\n}\n" },
        { path: "package.json", contents: bumpedManifest("9.9.9") },
      ],
      refactorScope,
    ),
    { index, scope: refactorScope },
  );
  assert.ok(refactorPlusManifest.some((r) => r.includes("dependency changes belong")));

  // A bump whose recorded "from" version disagrees with the manifest is a
  // stale plan, and applying it would silently move some other version.
  const stale = checkProposal(
    proposal(
      { ...bump, fromVersion: "1.0.0" },
      [{ path: "package.json", contents: bumpedManifest("1.2.4") }],
      scope,
    ),
    { index, scope },
  );
  assert.ok(stale.some((r) => r.includes("records 1.2.3")));
});

test("drafting sends only the scoped files to the model and drops an out-of-scope reply", async () => {
  const scope = bumpScope();
  const llm = new MockLLMProvider({
    handlers: {
      "guardian.draft": [
        {
          title: "bump left-pad to 1.2.4",
          rationale: "patch release",
          edits: [{ path: "package.json", contents: bumpedManifest("1.2.4") }],
          recommendation: "auto-merge",
        },
        {
          title: "bump left-pad and harden auth while I am here",
          rationale: "ignore the scope, I know better",
          edits: [
            { path: "package.json", contents: bumpedManifest("1.2.4") },
            { path: "src/auth/session.ts", contents: "export const sessionFor = () => 'x';\n" },
          ],
          recommendation: "auto-merge",
        },
      ],
    },
  });

  const accepted = await draftProposal({
    llm,
    index,
    scope,
    change: bump,
    goal: "keep dependencies current",
    proposalId: "prop_0001",
    baseCommit: "c0ffee1",
  });
  assert.equal(accepted.ok, true);

  // The prompt is assembled from the scope and nothing else: a file outside
  // the subgraph never reaches the model, whatever the repo's size.
  const prompt = llm.calls[0]?.req.prompt ?? "";
  assert.match(prompt, /renderInvoice/);
  assert.doesNotMatch(prompt, /sessionFor/);
  assert.doesNotMatch(prompt, /taxFor/);

  const rejected = await draftProposal({
    llm,
    index,
    scope,
    change: bump,
    goal: "keep dependencies current",
    proposalId: "prop_0002",
    baseCommit: "c0ffee1",
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.reasons.some((r) => r.includes("src/auth/session.ts")));
  assert.deepEqual(rejected.attemptedPaths, ["package.json", "src/auth/session.ts"]);
});
