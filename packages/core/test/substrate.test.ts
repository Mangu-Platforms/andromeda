import { test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock, SeededIds } from "../src/clock.ts";
import { MemoryStore } from "../src/store.ts";
import { AuditLog } from "../src/audit.ts";
import { ApprovalGate } from "../src/approval.ts";
import { CostMeter, MeteredProvider } from "../src/metering.ts";
import { WorkflowRunner, type StepContext } from "../src/workflow.ts";
import { BudgetExceededError } from "../src/errors.ts";
import { MockLLMProvider } from "../src/llm/mock.ts";
import { Router, json } from "../src/http/router.ts";
import { costUsd } from "../src/llm/pricing.ts";

const harness = () => ({
  store: new MemoryStore(),
  clock: new FixedClock(),
  ids: new SeededIds(),
});

test("a step runs once and is replayed from its checkpoint on resume", async () => {
  const { store, clock, ids } = harness();
  const runner = new WorkflowRunner({ store, clock, ids });
  let sideEffects = 0;

  const workflow = {
    name: "gated",
    async run(ctx: StepContext) {
      const built = await ctx.step("build", async () => {
        sideEffects++;
        return { artifact: "dist.tgz" };
      });
      const decision = await ctx.step("approval", async () => {
        ctx.suspend("needs human sign-off", { artifact: built.artifact });
      });
      return { built, decision };
    },
  };

  const suspended = await runner.start(workflow, null);
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspension?.step, "approval");
  assert.deepEqual(suspended.suspension?.payload, { artifact: "dist.tgz" });
  assert.equal(sideEffects, 1);

  const done = await runner.resume(workflow, suspended.id, { approved: true });
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, {
    built: { artifact: "dist.tgz" },
    decision: { approved: true },
  });
  // The whole point of checkpointing: resuming must not rebuild.
  assert.equal(sideEffects, 1);
});

test("a failing step marks the run failed and records why", async () => {
  const { store, clock, ids } = harness();
  const runner = new WorkflowRunner({ store, clock, ids });

  const record = await runner.start(
    {
      name: "boom",
      async run(ctx: StepContext) {
        await ctx.step("explode", async () => {
          throw new Error("compiler said no");
        });
      },
    },
    null,
  );

  assert.equal(record.status, "failed");
  assert.equal(record.error?.message, "compiler said no");
  const events = await new AuditLog(store, clock, record.id).events();
  assert.ok(events.some((e) => e.kind === "step.failed"));
  assert.ok(events.some((e) => e.kind === "run.failed"));
});

test("the budget ceiling survives a resume instead of resetting", async () => {
  const { store, clock, ids } = harness();
  const runner = new WorkflowRunner({ store, clock, ids, budgetUsd: 0.3 });
  const provider = new MockLLMProvider({
    handlers: { think: () => "x".repeat(40_000) },
  });

  const workflow = {
    name: "spendy",
    async run(ctx: StepContext) {
      await ctx.step("first", async () => {
        const metered = new MeteredProvider(provider, ctx.meter);
        await metered.complete({ purpose: "think", tier: "frontier", prompt: "go" });
        return "ok";
      });
      await ctx.step("gate", async () => ctx.suspend("check in", null));
      await ctx.step("second", async () => {
        const metered = new MeteredProvider(provider, ctx.meter);
        await metered.complete({ purpose: "think", tier: "frontier", prompt: "go" });
        return "ok";
      });
    },
  };

  const suspended = await runner.start(workflow, null);
  assert.equal(suspended.status, "suspended");
  assert.ok(suspended.spentUsd > 0);

  const resumed = await runner.resume(workflow, suspended.id, null);
  assert.equal(resumed.status, "failed");
  assert.match(resumed.error?.message ?? "", /budget exceeded/);
});

test("the meter throws once the running total passes the ceiling", () => {
  const meter = new CostMeter(1);
  meter.record({ purpose: "a", model: "claude-opus-5", costUsd: 0.6, inputTokens: 1, outputTokens: 1 });
  assert.equal(meter.snapshot().calls, 1);
  assert.throws(
    () =>
      meter.record({ purpose: "b", model: "claude-opus-5", costUsd: 0.6, inputTokens: 1, outputTokens: 1 }),
    BudgetExceededError,
  );
  assert.throws(() => new CostMeter(1).assertHeadroom(2), BudgetExceededError);
});

test("cost is computed from published per-model rates", () => {
  // 1M input + 1M output on Opus 5 at $5/$25.
  const cost = costUsd("claude-opus-5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(cost, 30);
  // Cheap tier must actually be cheap, or routing buys nothing.
  const haiku = costUsd("claude-haiku-4-5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(haiku, 6);
  assert.throws(() => costUsd("gpt-imaginary", {
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  }), /no pricing entry/);
});

test("an approval decision is attributable, final, and audited", async () => {
  const { store, clock, ids } = harness();
  const gate = new ApprovalGate(store, clock, ids);
  const audit = new AuditLog(store, clock, "run_000001");

  const request = await gate.request({
    runId: "run_000001",
    action: "autobuilder.open_pr",
    summary: "Open PR for invoice-tracker",
    risk: { score: 40, factors: ["touches auth config"] },
    payload: { files: 12 },
    audit,
  });
  assert.equal(request.status, "pending");
  assert.equal((await gate.listPending()).length, 1);

  await assert.rejects(
    () => gate.decide(request.id, "approved", "   ", "", audit),
    /attributable to a named human/,
  );

  const decided = await gate.decide(request.id, "approved", "dana@example.com", "looks fine", audit);
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, "dana@example.com");
  assert.equal((await gate.listPending()).length, 0);

  await assert.rejects(
    () => gate.decide(request.id, "rejected", "someone-else"),
    /already approved/,
  );

  const events = await audit.events();
  assert.deepEqual(
    events.map((e) => e.kind),
    ["gate.requested", "gate.approved"],
  );
});

test("audit events keep causal order past the tenth entry", async () => {
  const { store, clock } = harness();
  const audit = new AuditLog(store, clock, "run_000001");
  for (let i = 0; i < 12; i++) await audit.record("step.started", `step ${i}`);
  const events = await audit.events();
  assert.equal(events.length, 12);
  assert.deepEqual(events.map((e) => e.seq), [...Array(12).keys()]);
});

test("a reopened audit log continues numbering rather than overwriting", async () => {
  const { store, clock } = harness();
  await new AuditLog(store, clock, "run_000001").record("run.started", "first");
  const reopened = await AuditLog.open(store, clock, "run_000001");
  await reopened.record("run.resumed", "second");
  const events = await reopened.events();
  assert.deepEqual(events.map((e) => e.summary), ["first", "second"]);
});

test("the router matches params, methods, and turns throws into 500s", async () => {
  const router = new Router()
    .get("/api/runs/:id", (_req, params) => json({ id: params.id }))
    .post("/api/runs/:id/approve", async (req, params) =>
      json({ id: params.id, body: await req.json() }),
    )
    .get("/api/boom", () => {
      throw new Error("kaboom");
    });

  const ok = await router.handle(new Request("http://x/api/runs/run_1"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: "run_1" });

  const posted = await router.handle(
    new Request("http://x/api/runs/run_1/approve", {
      method: "POST",
      body: JSON.stringify({ by: "dana" }),
    }),
  );
  assert.deepEqual(await posted.json(), { id: "run_1", body: { by: "dana" } });

  assert.equal((await router.handle(new Request("http://x/nope"))).status, 404);
  assert.equal(
    (await router.handle(new Request("http://x/api/runs/run_1", { method: "POST" }))).status,
    405,
  );
  assert.equal((await router.handle(new Request("http://x/api/boom"))).status, 500);
});

test("the mock provider scripts a retry sequence per purpose", async () => {
  const provider = new MockLLMProvider({
    handlers: { fix: ["first attempt", "second attempt"] },
  });
  assert.equal((await provider.complete({ purpose: "fix", tier: "cheap", prompt: "x" })).text, "first attempt");
  assert.equal((await provider.complete({ purpose: "fix", tier: "cheap", prompt: "x" })).text, "second attempt");
  assert.equal(provider.callCount("fix"), 2);
  await assert.rejects(
    () => provider.complete({ purpose: "unknown", tier: "cheap", prompt: "x" }),
    /no handler for purpose/,
  );
});
