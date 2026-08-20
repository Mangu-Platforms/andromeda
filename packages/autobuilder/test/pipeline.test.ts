import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalGate,
  AuditLog,
  FixedClock,
  MemoryStore,
  MockLLMProvider,
  SeededIds,
  WorkflowRunner,
  type RunRecord,
} from "@andromeda/core";

import { createAutoBuilder, type BuildResult } from "../src/pipeline.ts";
import { TemplateRegistry } from "../src/templates/registry.ts";
import { LocalSandbox } from "../src/sandbox/local.ts";
import { LocalDirectoryDelivery, NullDelivery } from "../src/pr/delivery.ts";
import { sampleSpec } from "./fixtures.ts";

const TESTS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "#features/invoice-total.ts";

test("returns 400 when body.lineItems is missing", async () => {
  const result = await handle({ method: "POST", path: "/x", query: {}, body: {}, userId: "u1" });
  assert.equal(result.status, 400);
});
`;

const GOOD_IMPL = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(input: FeatureInput): Promise<FeatureResult> {
  const body = input.body as { lineItems?: Array<{ amount_cents: number }> };
  if (!Array.isArray(body?.lineItems)) {
    return { status: 400, body: { error: "lineItems is required" } };
  }
  const subtotalCents = body.lineItems.reduce((sum, item) => sum + item.amount_cents, 0);
  return { status: 200, body: { subtotalCents } };
}
`;

const BAD_IMPL = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(_input: FeatureInput): Promise<FeatureResult> {
  return { status: 200, body: {} };
}
`;

interface Harness {
  runner: WorkflowRunner;
  gate: ApprovalGate;
  llm: MockLLMProvider;
  delivery: NullDelivery;
  workflow: ReturnType<typeof createAutoBuilder>;
}

function harness(impl: string, options: { delivery?: NullDelivery } = {}): Harness {
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const gate = new ApprovalGate(store, clock, ids);
  const delivery = options.delivery ?? new NullDelivery();

  const llm = new MockLLMProvider({
    handlers: {
      "spec.compile": [sampleSpec()],
      "feature.tests": [TESTS],
      "feature.implement": [impl],
      "feature.repair": [impl],
    },
  });

  return {
    runner: new WorkflowRunner({ store, clock, ids, budgetUsd: 25 }),
    gate,
    llm,
    delivery,
    workflow: createAutoBuilder({
      llm,
      registry: new TemplateRegistry(),
      gate,
      delivery,
      createSandbox: () => LocalSandbox.create(),
    }),
  };
}

const resultOf = (record: RunRecord): BuildResult => record.result as BuildResult;

test("a green build stops for approval and only then delivers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "andromeda-out-"));
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const gate = new ApprovalGate(store, clock, ids);
  const delivery = new LocalDirectoryDelivery(dir);
  const llm = new MockLLMProvider({
    handlers: {
      "spec.compile": [sampleSpec()],
      "feature.tests": [TESTS],
      "feature.implement": [GOOD_IMPL],
    },
  });
  const runner = new WorkflowRunner({ store, clock, ids, budgetUsd: 25 });
  const workflow = createAutoBuilder({
    llm,
    registry: new TemplateRegistry(),
    gate,
    delivery,
    createSandbox: () => LocalSandbox.create(),
  });

  const suspended = await runner.start(workflow, {
    intent: "Track invoices and line items for a freelancer.",
    requestedBy: "dana@example.com",
  });

  // Autonomy stops here: nothing has been written anywhere yet.
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspension?.step, "await-approval");
  const pending = await gate.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.action, "autobuilder.deliver");

  await gate.decide(pending[0]!.id, "approved", "dana@example.com", "ship it");
  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "dana@example.com",
    note: "ship it",
  });

  assert.equal(done.status, "completed");
  const result = resultOf(done);
  assert.equal(result.outcome, "delivered");
  assert.equal(result.receipt?.fileCount, result.proposal.files.length);

  // The delivered repository is real: scaffold plus gated feature and its tests.
  const pkg = JSON.parse(await readFile(join(dir, "invoice-tracker", "package.json"), "utf8"));
  assert.equal(pkg.name, "invoice-tracker");
  assert.equal(
    await readFile(join(dir, "invoice-tracker", "features", "invoice-total.ts"), "utf8"),
    GOOD_IMPL,
  );
  await readFile(join(dir, "invoice-tracker", "supabase", "migrations", "0001_init.sql"), "utf8");

  await rm(dir, { recursive: true, force: true });
});

test("a red build is never offered for approval", async () => {
  const { runner, gate, workflow, delivery } = harness(BAD_IMPL);

  const record = await runner.start(workflow, {
    intent: "Track invoices.",
    requestedBy: "dana@example.com",
  });

  assert.equal(record.status, "completed");
  const result = resultOf(record);
  assert.equal(result.outcome, "blocked_by_test_gate");
  assert.equal(result.proposal.testsGreen, false);
  // No approval request exists, so there is no button for a human to press.
  assert.deepEqual(await gate.listPending(), []);
  assert.deepEqual(delivery.delivered, []);
  // The failing evidence is still on the proposal for whoever investigates.
  assert.match(result.proposal.featureBuilds[0]?.testOutput ?? "", /not ok|fail/);
  assert.ok(result.proposal.risk.score >= 60);
});

test("a rejected build is recorded and delivers nothing", async () => {
  const { runner, gate, workflow, delivery } = harness(GOOD_IMPL);

  const suspended = await runner.start(workflow, {
    intent: "Track invoices.",
    requestedBy: "dana@example.com",
  });
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "dana@example.com", "wrong data model");

  const done = await runner.resume(workflow, suspended.id, {
    status: "rejected",
    decidedBy: "dana@example.com",
    note: "wrong data model",
  });

  assert.equal(resultOf(done).outcome, "rejected");
  assert.deepEqual(delivery.delivered, []);
});

test("delivery re-checks the stored approval instead of trusting the resume value", async () => {
  const { runner, gate, workflow, delivery } = harness(GOOD_IMPL);

  const suspended = await runner.start(workflow, {
    intent: "Track invoices.",
    requestedBy: "dana@example.com",
  });
  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "rejected", "dana@example.com", "no");

  // A forged resume claiming approval must not be enough to deliver.
  const done = await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "attacker",
    note: "",
  });

  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /is rejected, not approved/);
  assert.deepEqual(delivery.delivered, []);
});

test("resuming does not regenerate work that already passed", async () => {
  const { runner, gate, workflow, llm } = harness(GOOD_IMPL);

  const suspended = await runner.start(workflow, {
    intent: "Track invoices.",
    requestedBy: "dana@example.com",
  });
  const callsBefore = llm.calls.length;

  const [pending] = await gate.listPending();
  await gate.decide(pending!.id, "approved", "dana@example.com");
  await runner.resume(workflow, suspended.id, {
    status: "approved",
    decidedBy: "dana@example.com",
    note: "",
  });

  // Checkpoints mean the resume costs nothing: no re-compilation, no
  // re-generation, no second sandbox.
  assert.equal(llm.calls.length, callsBefore);
  assert.equal(llm.callCount("spec.compile"), 1);
  assert.equal(llm.callCount("feature.tests"), 1);
});

test("every model call is metered and written to the audit trail", async () => {
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const llm = new MockLLMProvider({
    handlers: {
      "spec.compile": [sampleSpec()],
      "feature.tests": [TESTS],
      "feature.implement": [GOOD_IMPL],
    },
  });
  const workflow = createAutoBuilder({
    llm,
    registry: new TemplateRegistry(),
    gate: new ApprovalGate(store, clock, ids),
    delivery: new NullDelivery(),
    createSandbox: () => LocalSandbox.create(),
  });

  const suspended = await new WorkflowRunner({ store, clock, ids, budgetUsd: 25 }).start(
    workflow,
    { intent: "Track invoices.", requestedBy: "dana@example.com" },
  );

  assert.ok(suspended.spentUsd > 0, "a run that called a model must show spend");

  const events = await new AuditLog(store, clock, suspended.id).events();
  const calls = events.filter((e) => e.kind === "llm.call");
  assert.ok(calls.length >= 3, `expected a log line per model call, got ${calls.length}`);
  for (const call of calls) {
    if (!("costUsd" in call.data)) continue;
    assert.equal(typeof call.data.costUsd, "number");
    assert.equal(typeof call.data.model, "string");
  }
  // The gate request and the suspension are both on the record.
  assert.ok(events.some((e) => e.kind === "gate.requested"));
  assert.ok(events.some((e) => e.kind === "run.suspended"));
  // Every sandbox run is logged with its exit code.
  assert.ok(events.some((e) => e.kind === "sandbox.exec"));
});

test("an invalid spec from the model is repaired, and gives up loudly", async () => {
  const store = new MemoryStore();
  const clock = new FixedClock();
  const ids = new SeededIds();
  const broken = sampleSpec();
  broken.entities[0]!.name = "select";

  const llm = new MockLLMProvider({
    handlers: { "spec.compile": [broken], "spec.repair": [broken] },
  });
  const workflow = createAutoBuilder({
    llm,
    registry: new TemplateRegistry(),
    gate: new ApprovalGate(store, clock, ids),
    delivery: new NullDelivery(),
    createSandbox: () => LocalSandbox.create(),
  });

  const record = await new WorkflowRunner({ store, clock, ids, budgetUsd: 25 }).start(workflow, {
    intent: "Anything.",
    requestedBy: "dana@example.com",
  });

  assert.equal(record.status, "failed");
  assert.match(record.error?.message ?? "", /gave up after 3 attempts/);
  assert.match(record.error?.message ?? "", /reserved SQL keyword/);
  assert.equal(llm.callCount("spec.repair"), 2);
});
