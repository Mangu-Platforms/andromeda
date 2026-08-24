import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ApprovalGate,
  FixedClock,
  MemoryStore,
  MockLLMProvider,
  SeededIds,
  WorkflowRunner,
  type RunRecord,
} from "@andromeda/core";

import { buildMandate, sealMandate, verifyMandate, DISCLAIMER } from "../src/mandate.ts";
import { decide, askUtilityFor, counterPackage } from "../src/decide.ts";
import { checkScope, assertInScope } from "../src/scope.ts";
import { MandateTamperedError, ScopeRefusedError } from "../src/errors.ts";
import { improve, packageUtility, paretoDominates } from "../src/utility.ts";
import { createNegotiator, type NegotiationResult } from "../src/pipeline.ts";
import type { MandateInput, Package } from "../src/types.ts";

const KEY = "operator-held-key";

/** A salary negotiation. Start date is "days until start" so higher = better. */
function input(over: Partial<MandateInput> = {}): MandateInput {
  return {
    domain: "salary",
    subject: "Senior engineer offer at Northwind",
    preparedBy: "dana@example.com",
    headlineIssueId: "base",
    issues: [
      { id: "base", label: "Base salary", unit: "USD", floor: 150_000, target: 210_000, weight: 6, counterpartWeight: 7, step: 1_000 },
      { id: "equity", label: "Equity", unit: "RSU units", floor: 0, target: 4_000, weight: 3, counterpartWeight: 1, step: 100 },
      { id: "pto", label: "PTO", unit: "days", floor: 15, target: 30, weight: 2, counterpartWeight: 1, step: 1 },
      { id: "start", label: "Days until start", unit: "days", floor: 14, target: 75, weight: 1, counterpartWeight: 4, step: 7 },
    ],
    alternatives: [
      {
        label: "competing offer at Contoso",
        package: { base: 178_000, equity: 1_200, pto: 20, start: 45 },
        probability: 0.9,
      },
    ],
    walkAwayFloor: 172_000,
    riskTolerance: 0.5,
    rounds: 4,
    concessionShape: "linear",
    counterpartReservationEstimate: 0.2,
    ...over,
  };
}

const sealedOf = (over: Partial<MandateInput> = {}) =>
  sealMandate(buildMandate(input(over), 1_000), { key: KEY, now: 1_000 });

const lowball: Package = { base: 152_000, equity: 200, pto: 15, start: 14 };

test("the reservation value is fixed before any offer is scored", () => {
  const sealed = sealedOf();
  const m = sealed.mandate;
  // Derived from the user's own BATNA and declared floor, nothing else.
  assert.ok(m.reservationUtility > 0);
  assert.ok(m.reservationHeadline >= 150_000 && m.reservationHeadline <= 210_000);
  assert.equal(m.reservationHeadlineAttainable, true);
  assert.equal(verifyMandate(sealed, KEY).reservationUtility, m.reservationUtility);
});

test("no anchor, threat, or injection moves the decision", () => {
  const sealed = sealedOf();
  const reservation = sealed.mandate.reservationUtility;

  // Each of these is a real tactic. None of them is a parameter of `decide`:
  // there is no argument through which any of them could arrive. The test
  // asserts the consequence — the same lowball offer is refused identically
  // no matter what accompanies it.
  const decisions = [1, 2, 3].map((round) =>
    decide({ sealed, offer: { round, package: lowball }, key: KEY }),
  );

  for (const decision of decisions) {
    assert.notEqual(decision.kind, "accept");
    assert.equal(decision.reservationUtility, reservation);
    assert.equal(decision.mandateDigest, sealed.digest);
    assert.ok(decision.offerUtility < reservation);
  }
});

test("an exploding offer does not become acceptable by being final", () => {
  const sealed = sealedOf();
  // The counterpart declares round 4 the last one. It is, and the answer to
  // "is this better than walking" was computed before they said anything.
  const decision = decide({ sealed, offer: { round: 4, package: lowball }, key: KEY });
  assert.equal(decision.kind, "walk_away");
  assert.match(decision.rationale.join(" "), /below the reservation line/);
});

test("a mandate edited mid-negotiation fails closed", () => {
  const sealed = sealedOf();

  // Exactly what a successful injection would have to achieve: lower the line.
  const tampered = structuredClone(sealed);
  tampered.mandate.reservationUtility = 0.01;
  tampered.mandate.reservationHeadline = 140_000;

  assert.throws(
    () => decide({ sealed: tampered, offer: { round: 1, package: lowball }, key: KEY }),
    MandateTamperedError,
  );
  // Re-sealing with the wrong key does not help either.
  const resealed = sealMandate(tampered.mandate, { key: "attacker-key", now: 2_000 });
  assert.throws(() => verifyMandate(resealed, KEY), MandateTamperedError);
});

test("the seal is checked on every decision, not just the first", () => {
  const sealed = sealedOf();
  assert.equal(decide({ sealed, offer: { round: 1, package: lowball }, key: KEY }).kind, "counter");

  const tampered = structuredClone(sealed);
  tampered.mandate.rounds = 99;
  assert.throws(
    () => decide({ sealed: tampered, offer: { round: 2, package: lowball }, key: KEY }),
    MandateTamperedError,
  );
});

test("a genuinely good offer is accepted", () => {
  const sealed = sealedOf();
  const strong: Package = { base: 208_000, equity: 3_800, pto: 29, start: 70 };
  assert.equal(decide({ sealed, offer: { round: 2, package: strong }, key: KEY }).kind, "accept");
});

test("the concession schedule falls to the reservation line and never below", () => {
  for (const shape of ["linear", "boulware", "conceder"] as const) {
    const sealed = sealedOf({ concessionShape: shape });
    const m = sealed.mandate;
    const asks = [1, 2, 3, 4].map((r) => askUtilityFor(m, r));

    for (const ask of asks) {
      assert.ok(ask >= m.reservationUtility - 1e-9, `${shape}: ask fell below reservation`);
      assert.ok(ask <= m.aspirationUtility + 1e-9);
    }
    // Monotonically non-increasing, ending at the line.
    for (let i = 1; i < asks.length; i++) {
      assert.ok((asks[i] as number) <= (asks[i - 1] as number) + 1e-9, `${shape}: ask went up`);
    }
    assert.ok(Math.abs((asks.at(-1) as number) - m.reservationUtility) < 1e-9);
  }
});

test("boulware concedes later than conceder", () => {
  const mid = 2;
  const b = askUtilityFor(sealedOf({ concessionShape: "boulware" }).mandate, mid);
  const c = askUtilityFor(sealedOf({ concessionShape: "conceder" }).mandate, mid);
  assert.ok(b > c, "boulware should still be asking for more at the midpoint");
});

test("a counter is never Pareto-dominated by an available alternative", () => {
  const sealed = sealedOf();
  for (const round of [1, 2, 3, 4]) {
    const pkg = counterPackage(sealed.mandate, round);
    assert.equal(
      improve(sealed.mandate.issues, pkg),
      null,
      `round ${round}: a package better for both sides was left on the table`,
    );
  }
});

test("log-rolling finds trades a split-the-difference package misses", () => {
  const sealed = sealedOf();
  const issues = sealed.mandate.issues;

  // Naive: everything at the midpoint of floor and target.
  const naive: Package = {};
  for (const issue of issues) naive[issue.id] = (issue.floor + issue.target) / 2;

  const better = improve(issues, naive);
  assert.ok(better, "the midpoint package should not already be efficient");
  assert.equal(paretoDominates(issues, better as Package, naive), true);
});

test("utility is oriented consistently for both sides", () => {
  const issues = sealedOf().mandate.issues;
  const best: Package = { base: 210_000, equity: 4_000, pto: 30, start: 75 };
  const worst: Package = { base: 150_000, equity: 0, pto: 15, start: 14 };

  assert.equal(packageUtility(issues, best, "user"), 1);
  assert.equal(packageUtility(issues, worst, "user"), 0);
  // What is best for the user is worst for the counterpart.
  assert.equal(packageUtility(issues, best, "counterpart"), 0);
  assert.equal(packageUtility(issues, worst, "counterpart"), 1);
});

test("an incomplete package is an error, not a low score", () => {
  const issues = sealedOf().mandate.issues;
  assert.throws(() => packageUtility(issues, { base: 200_000 }), /missing issue "equity"/);
});

test("legal matters are refused with a referral, never attempted", () => {
  const cases: Array<[string, string]> = [
    ["salary", "They fired me and I want to sue for wrongful termination"],
    ["salary", "Negotiating severance after workplace harassment"],
    ["vendor_contract", "We need to file an SEC complaint about this vendor"],
    ["vendor_contract", "Can you represent me at the hearing next month"],
    ["salary", "Is this non-compete legal in my state — I need legal advice"],
    ["immigration", "H-1B transfer negotiation"],
    ["custody", "Splitting time with my ex"],
  ];

  for (const [domain, subject] of cases) {
    const check = checkScope(domain, subject);
    assert.equal(check.ok, false, `should refuse: ${subject}`);
    assert.match(check.referral, /licensed attorney/);
    assert.throws(() => assertInScope(domain, subject), ScopeRefusedError);
  }
});

test("the two supported lanes are not over-refused", () => {
  // Word-boundary matching, so "issue" does not trip "sue" and "goodwill"
  // does not trip "will".
  for (const subject of [
    "Senior engineer offer at Northwind",
    "Annual SaaS renewal, seat count and support tier",
    "Raising the issue of on-call pay in the offer",
    "Vendor goodwill credit after the outage",
  ]) {
    assert.equal(checkScope("salary", subject).ok, true, `should allow: ${subject}`);
  }
});

// ---- pipeline ----

function harness(over: Partial<MandateInput> = {}) {
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const gate = new ApprovalGate(store, clock, ids);
  const llm = new MockLLMProvider({
    handlers: {
      "negotiator.draft": [
        "Thanks for the offer. Based on a competing offer I'm holding, I'd need base at 195,000 to move forward.",
      ],
    },
  });
  return {
    gate,
    llm,
    runner: new WorkflowRunner({ store, clock, ids, budgetUsd: 25 }),
    workflow: createNegotiator({ llm, gate, mandateKey: KEY }),
    mandate: input(over),
  };
}

const resultOf = (r: RunRecord): NegotiationResult => r.result as NegotiationResult;

test("the pipeline drafts, stops for a human, and sends nothing itself", async () => {
  const { runner, workflow, gate, mandate } = harness();

  const suspended = await runner.start(workflow, {
    mandate,
    offers: [{ round: 1, package: lowball }],
  });

  assert.equal(suspended.status, "suspended");
  const pending = await gate.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.action, "negotiator.send_draft");

  await gate.decide(pending[0]!.id, "approved", "dana@example.com", "looks right");
  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "dana@example.com",
  });

  const result = resultOf(done);
  assert.equal(result.outcome, "drafted");
  assert.equal(result.decision?.kind, "counter");
  // "drafted", not "sent": the artifact goes back to the user to send.
  assert.equal(result.draft?.disclaimer, DISCLAIMER);
  assert.match(result.draft?.disclaimer ?? "", /not legal advice/);
});

test("the mandate is sealed before the offer is scored", async () => {
  const { runner, workflow, mandate } = harness();
  const suspended = await runner.start(workflow, {
    mandate,
    offers: [{ round: 1, package: lowball }],
  });

  // Checkpoint order is the proof: the seal exists as a completed step before
  // the decide step ran at all.
  const keys = Object.keys(suspended.checkpoints);
  assert.ok(keys.indexOf("seal-mandate") < keys.indexOf("decide"));
  assert.ok(keys.indexOf("scope") < keys.indexOf("seal-mandate"));
});

test("an out-of-scope request is refused before any model call or mandate", async () => {
  const { runner, workflow, gate, llm } = harness();

  const record = await runner.start(workflow, {
    mandate: input({ subject: "I want to sue my employer for wrongful termination" }),
    offers: [],
  });

  assert.equal(record.status, "completed");
  assert.equal(resultOf(record).outcome, "refused_out_of_scope");
  assert.equal(resultOf(record).sealed, null);
  assert.equal(llm.calls.length, 0, "a refused request must not cost a model call");
  assert.deepEqual(await gate.listPending(), []);
});

test("a rejected draft releases nothing", async () => {
  const { runner, workflow, gate, mandate } = harness();
  const suspended = await runner.start(workflow, {
    mandate,
    offers: [{ round: 1, package: lowball }],
  });
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "dana@example.com", "too soft");

  const done = await runner.resume(workflow, suspended.id, {
    status: "rejected",
    decidedBy: "dana@example.com",
  });
  assert.equal(resultOf(done).outcome, "rejected");
});

test("a forged approval cannot release the draft", async () => {
  const { runner, workflow, gate, mandate } = harness();
  const suspended = await runner.start(workflow, {
    mandate,
    offers: [{ round: 1, package: lowball }],
  });
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "dana@example.com", "no");

  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "attacker",
  });
  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /is rejected, not approved/);
});
