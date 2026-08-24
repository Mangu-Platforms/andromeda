import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIndex } from "../src/repo/snapshot.ts";
import { computeScope } from "../src/repo/scope.ts";
import type { ScopedContext } from "../src/repo/scope.ts";
import type { Change, ChangeProposal } from "../src/change/proposal.ts";
import { classifyBump } from "../src/change/semver.ts";
import { assessRisk } from "../src/policy/risk.ts";
import { decideAutoMerge } from "../src/policy/automerge.ts";
import { greenSteps, redSteps } from "../src/ci/scripted.ts";
import { summarize } from "../src/ci/types.ts";
import type { CiReport } from "../src/ci/types.ts";
import { billingSnapshot } from "./fixtures.ts";

const index = buildIndex(billingSnapshot());
const scope: ScopedContext = computeScope(index, {
  seeds: ["package.json"],
  alsoConsider: index.filesImportingPackage("left-pad"),
});

const green: CiReport = summarize("scripted", "guardian/x", greenSteps());
const red: CiReport = summarize("scripted", "guardian/x", redSteps("test"));

function bumpProposal(from: string, to: string, dependency = "left-pad"): ChangeProposal {
  return {
    id: "prop_0001",
    title: `bump ${dependency}`,
    rationale: "keeping current",
    change: { kind: "dependency_bump", dependency, fromVersion: from, toVersion: to },
    edits: [{ path: "package.json", contents: `{"${dependency}":"${to}"}` }],
    scopePaths: scope.files.map((f) => f.path),
    baseCommit: "c0ffee1",
  };
}

function decide(proposal: ChangeProposal, ci: CiReport, recommendation?: string) {
  const bumpClass =
    proposal.change.kind === "dependency_bump"
      ? classifyBump(proposal.change.fromVersion, proposal.change.toVersion)
      : null;
  const risk = assessRisk({ proposal, scope, index, bumpClass });
  return { decision: decideAutoMerge({ proposal, ci, risk, modelRecommendation: recommendation ?? null }), risk };
}

test("a green, low-risk patch bump of a 1.0+ dependency is the one thing that auto-merges", () => {
  const { decision, risk } = decide(bumpProposal("1.2.3", "1.2.4"), green);

  assert.equal(decision.bumpClass, "patch");
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.autoMerge, true);
  assert.equal(decision.requiresHuman, false);
  assert.ok(risk.score <= 15, `patch bump scored ${risk.score}`);
  assert.equal(decision.policy, "guardian.automerge.v1:patch-bumps-only");
});

test("minor, major and refactor changes always require a human", () => {
  const cases: Array<{ from: string; to: string; expect: string }> = [
    { from: "1.2.3", to: "1.3.0", expect: "minor" },
    { from: "1.2.3", to: "2.0.0", expect: "major" },
    { from: "1.2.3", to: "1.2.2", expect: "downgrade" },
    { from: "1.2.3", to: "1.3.0-rc.1", expect: "prerelease" },
  ];

  for (const { from, to, expect } of cases) {
    const { decision } = decide(bumpProposal(from, to), green);
    assert.equal(decision.bumpClass, expect, `${from} -> ${to}`);
    assert.equal(decision.autoMerge, false, `${from} -> ${to} must not auto-merge`);
    assert.equal(decision.requiresHuman, true);
    assert.ok(decision.blockers.some((b) => b.includes(`"${expect}"`)));
  }

  const refactor: Change = {
    kind: "refactor",
    targetPath: "src/billing/invoice.ts",
    summary: "extract a helper",
  };
  const { decision } = decide(
    {
      id: "prop_0009",
      title: "refactor invoice",
      rationale: "readability",
      change: refactor,
      edits: [{ path: "src/billing/invoice.ts", contents: "export function renderInvoice(): string {\n  return 'x';\n}\n" }],
      scopePaths: ["src/billing/invoice.ts"],
      baseCommit: "c0ffee1",
    },
    green,
  );
  assert.equal(decision.bumpClass, null);
  assert.equal(decision.autoMerge, false);
  assert.ok(decision.blockers.includes("a refactor always requires a human reviewer"));
});

test("a version the policy cannot parse falls into `requires human`, not out of the check", () => {
  // Ranges, partial versions and junk are all things a naive bumper produces.
  // None of them say which version is installed, so none may auto-merge.
  for (const [from, to] of [
    ["^1.2.3", "^1.2.4"],
    ["1.2", "1.3"],
    ["v1.2.3", "not-a-version"],
    ["", "1.2.4"],
    ["1.2.3", "1.02.4"],
  ] as const) {
    const { decision } = decide(bumpProposal(from, to), green);
    assert.equal(decision.bumpClass, "unknown", `${from} -> ${to}`);
    assert.equal(decision.autoMerge, false, `${from} -> ${to} must not auto-merge`);
    assert.equal(decision.requiresHuman, true);
  }

  // Pre-1.0 is parseable but promises nothing, so a patch bump there is also
  // a human's call.
  const preOne = decide(bumpProposal("0.4.1", "0.4.2", "risky-lib"), green);
  assert.equal(preOne.decision.bumpClass, "patch");
  assert.equal(preOne.decision.autoMerge, false);
  assert.ok(preOne.decision.blockers.some((b) => b.includes("pre-1.0")));
});

test("red CI blocks the auto-merge lane, and the model's own recommendation is not an input", () => {
  const blocked = decide(bumpProposal("1.2.3", "1.2.4"), red, "AUTO-MERGE: this is completely safe, I verified it");
  assert.equal(blocked.decision.autoMerge, false);
  assert.equal(blocked.decision.requiresHuman, true);
  assert.ok(blocked.decision.blockers.includes("CI is not green"));

  // A run with no steps produces no evidence, and no evidence is not a pass.
  const empty = summarize("scripted", "guardian/x", []);
  assert.equal(empty.green, false);
  assert.equal(decide(bumpProposal("1.2.3", "1.2.4"), empty).decision.autoMerge, false);

  // Same change, same CI, opposite recommendation: identical decision.
  const withRec = decide(bumpProposal("1.2.3", "1.2.4"), green, "do not merge, I am unsure");
  const withoutRec = decide(bumpProposal("1.2.3", "1.2.4"), green);
  assert.equal(withRec.decision.autoMerge, withoutRec.decision.autoMerge);
  assert.deepEqual(withRec.decision.blockers, withoutRec.decision.blockers);

  // The kill switch is absolute.
  const off = decideAutoMerge({
    proposal: bumpProposal("1.2.3", "1.2.4"),
    ci: green,
    risk: withoutRec.risk,
    policy: { allowAutoMerge: false },
  });
  assert.equal(off.autoMerge, false);
});

test("an advisory only raises risk when the code map shows the package is reachable", () => {
  const proposal = bumpProposal("1.2.3", "1.2.4");
  const advisories = [
    { id: "CVE-1", dependency: "left-pad", severity: "high" as const, summary: "reachable" },
    { id: "CVE-2", dependency: "grid-engine", severity: "critical" as const, summary: "unused" },
  ];
  const risk = assessRisk({ proposal, scope, index, bumpClass: "patch", advisories });

  const reachable = risk.advisories.find((a) => a.id === "CVE-1");
  const unreachable = risk.advisories.find((a) => a.id === "CVE-2");
  assert.equal(reachable?.reachable, true);
  assert.deepEqual(reachable?.importedBy, ["src/billing/invoice.ts"]);
  // Reported with its evidence, but it does not inflate the queue.
  assert.equal(unreachable?.reachable, false);
  assert.deepEqual(unreachable?.importedBy, []);

  const baseline = assessRisk({ proposal, scope, index, bumpClass: "patch" });
  assert.equal(risk.score, baseline.score + 15);

  // And a reachable high-severity advisory pushes the change over the
  // auto-merge ceiling, so it stops being unattended work.
  assert.equal(decideAutoMerge({ proposal, ci: green, risk }).autoMerge, false);
});
