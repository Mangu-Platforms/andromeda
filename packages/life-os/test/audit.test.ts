import { test } from "node:test";
import assert from "node:assert/strict";

import { coordinate, detectConflicts, MAX_PROPOSALS_PER_DOMAIN } from "../src/coordinator.ts";
import { classifyAction, isAutonomous, ACTION_CATALOG } from "../src/catalog.ts";
import type { Commitment, DomainId, DomainReport, Proposal } from "../src/types.ts";

/**
 * Adversarial audit of the two claims this product rests on:
 *
 *   1. cross-domain conflicts are surfaced, never silently resolved
 *   2. anything not provably reversible requires a human
 *
 * Written against the claims rather than the implementation. A coordinator that
 * quietly picks a winner would still pass a test that only checked it produced
 * *some* output, so every case below checks what it must refuse to do.
 */

const HOUR = 3_600_000;
const DAY = 1_700_000_000_000;

/** Action kinds are namespaced per domain; a generic one is rejected by lane. */
const DEFAULT_KIND: Record<DomainId, string> = {
  calendar: "calendar.hold_tentative",
  finance: "finance.draft_budget_note",
  health: "health.schedule_workout",
  mail: "mail.draft_reply",
};

function proposal(over: Partial<Proposal> & { id: string; domain: DomainId }): Proposal {
  return {
    actionKind: DEFAULT_KIND[over.domain],
    title: "A proposal",
    detail: "Detail.",
    urgency: 1,
    confidence: 0.5,
    effects: [],
    sources: [],
    ...over,
  } as Proposal;
}

function report(domain: DomainId, proposals: Proposal[], commitments: Commitment[] = []): DomainReport {
  return { domain, proposals, commitments, quarantined: [], note: "" };
}

const timeEffect = (startMs: number, endMs: number) =>
  ({ kind: "time", startMs, endMs, label: "block" }) as Proposal["effects"][number];

test("two domains wanting the same hour produce a conflict, not a winner", () => {
  const calendar = proposal({
    id: "cal-1",
    domain: "calendar",
    title: "Hold 09:00 for deep work",
    confidence: 0.99,
    effects: [timeEffect(DAY + 9 * HOUR, DAY + 10 * HOUR)],
  });
  const health = proposal({
    id: "hea-1",
    domain: "health",
    title: "Run at 09:30",
    confidence: 0.2,
    effects: [timeEffect(DAY + 9.5 * HOUR, DAY + 10.5 * HOUR)],
  });

  const result = coordinate([report("calendar", [calendar]), report("health", [health])]);

  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict?.kind, "time_overlap");
  assert.deepEqual([...(conflict?.domains ?? [])].sort(), ["calendar", "health"]);

  // The failure this guards: a confident domain quietly winning. Both
  // proposals must survive into the ranked output for the user to choose.
  const rankedIds = result.ranked.map((r) => r.proposal.id);
  assert.ok(rankedIds.includes("cal-1"), "high-confidence proposal was dropped");
  assert.ok(rankedIds.includes("hea-1"), "low-confidence proposal was silently discarded");

  // And the conflict record itself must not encode an outcome.
  assert.ok(!("winner" in (conflict as object)));
  assert.ok(!("resolution" in (conflict as object)));
});

test("confidence cannot break a conflict no matter how lopsided", () => {
  for (const [a, b] of [
    [1, 0],
    [0, 1],
    [0.999, 0.001],
  ]) {
    const result = coordinate([
      report("calendar", [
        proposal({
          id: "cal",
          domain: "calendar",
          confidence: a as number,
          effects: [timeEffect(DAY, DAY + HOUR)],
        }),
      ]),
      report("health", [
        proposal({
          id: "hea",
          domain: "health",
          confidence: b as number,
          effects: [timeEffect(DAY, DAY + HOUR)],
        }),
      ]),
    ]);
    assert.equal(result.conflicts.length, 1, `confidences ${a}/${b} lost the conflict`);
    assert.equal(result.ranked.length, 2, `confidences ${a}/${b} dropped a proposal`);
  }
});

test("a domain cannot conflict with itself into an auto-resolution", () => {
  // Two overlapping proposals from the SAME domain are that domain's business
  // to rank; they must not be reported as a cross-domain trade-off.
  const result = coordinate([
    report("calendar", [
      proposal({ id: "a", domain: "calendar", effects: [timeEffect(DAY, DAY + HOUR)] }),
      proposal({ id: "b", domain: "calendar", effects: [timeEffect(DAY, DAY + HOUR)] }),
    ]),
  ]);
  assert.equal(result.conflicts.length, 0);
});

test("a proposal that overruns a published budget conflicts with it", () => {
  const spend = proposal({
    id: "fin-1",
    domain: "finance",
    actionKind: "finance.schedule_transfer",
    effects: [
      { kind: "spend", amountCents: 90_000, account: "checking", label: "flights" },
    ],
  });
  const ceiling: Commitment = {
    domain: "finance",
    id: "budget-checking",
    effect: {
      kind: "budget",
      account: "checking",
      capCents: 100_000,
      committedCents: 85_000,
      label: "monthly cap",
    },
  };

  const conflicts = detectConflicts([spend], [ceiling]);
  assert.ok(
    conflicts.some((c) => c.kind === "budget_exceeded"),
    "a spend beyond the remaining budget must be surfaced",
  );
});

test("a domain cannot flood the brief", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    proposal({ id: `cal-${i}`, domain: "calendar" }),
  );
  const result = coordinate([report("calendar", many)]);

  const kept = result.ranked.filter((r) => r.proposal.domain === "calendar");
  assert.ok(
    kept.length <= MAX_PROPOSALS_PER_DOMAIN,
    `a domain placed ${kept.length} proposals in the brief`,
  );
  assert.ok(result.rejected.length > 0, "dropped proposals must be recorded, not vanish");
});

test("a domain cannot publish effects belonging to another domain", () => {
  // The coordinator is the only component that sees every domain, so lane
  // violations can only be caught here.
  const result = coordinate([
    report("calendar", [
      // Filed under calendar, but proposing a finance action.
      { ...proposal({ id: "cal-x", domain: "calendar" }), actionKind: "finance.pay_bill" },
    ]),
  ]);
  assert.equal(result.ranked.length, 0);
  assert.ok(result.rejected.length > 0);
});

// ---- the reversibility gate ----

test("reversibility comes from the catalog, never from the proposal", () => {
  // A domain claiming its own irreversible action is reversible is the exact
  // move the gate exists to defeat.
  const sendMail = ACTION_CATALOG.find((a) => a.reversibility === "irreversible");
  assert.ok(sendMail, "the catalog needs at least one irreversible action");

  const spec = classifyAction(sendMail.kind);
  assert.equal(spec.reversibility, "irreversible");
  assert.equal(isAutonomous(spec), false, `${sendMail.kind} must not run unattended`);
});

test("an unknown action kind fails closed", () => {
  for (const kind of [
    "wire_funds",
    "",
    "DRAFT_MESSAGE",
    "draft_message ",
    "a-brand-new-capability",
    "__proto__",
    "constructor",
  ]) {
    const spec = classifyAction(kind);
    assert.equal(
      isAutonomous(spec),
      false,
      `"${kind}" was treated as autonomous`,
    );
    assert.equal(spec.reversibility, "irreversible", `"${kind}" was treated as reversible`);
  }
});

test("every autonomous action in the catalog is genuinely low-stakes and reversible", () => {
  // The gate is only as good as the table behind it, so the table is audited
  // too: nothing may be autonomous unless it is both reversible and low-stakes.
  for (const spec of ACTION_CATALOG) {
    if (!isAutonomous(spec)) continue;
    assert.equal(spec.reversibility, "reversible", `${spec.kind} is autonomous but irreversible`);
    assert.equal(spec.stakes, "low", `${spec.kind} is autonomous but high-stakes`);
  }
});

test("no catalog action both sends money and runs unattended", () => {
  // A blunt sanity check on the table's contents, phrased the way an operator
  // would ask it.
  const dangerous = /send|pay|transfer|wire|purchase|cancel|delete|share|post/i;
  for (const spec of ACTION_CATALOG) {
    if (dangerous.test(spec.kind) && isAutonomous(spec)) {
      assert.fail(`${spec.kind} matches a dangerous verb and is autonomous`);
    }
  }
});
