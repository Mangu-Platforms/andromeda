import { test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock, SeededIds } from "../src/clock.ts";
import { MemoryStore } from "../src/store.ts";
import { AuditLog } from "../src/audit.ts";
import { ApprovalGate } from "../src/approval.ts";
import { CostMeter, MeteredProvider } from "../src/metering.ts";
import { WorkflowRunner, type StepContext } from "../src/workflow.ts";
import { BudgetExceededError, GlobalBudgetExceededError } from "../src/errors.ts";
import { MockLLMProvider } from "../src/llm/mock.ts";
import { Router, basicAuthGuard, composeGuards, json, sameOriginPostGuard } from "../src/http/router.ts";
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

test("the global budget refuses new runs, caps in-flight ones, and rolls with its window", async () => {
  const { store, ids } = harness();
  let t = 1_700_000_000_000;
  const clock = { now: () => t };
  const runner = new WorkflowRunner({
    store,
    clock,
    ids,
    budgetUsd: 5,
    globalBudget: { limitUsd: 6 },
  });

  const spender = (usd: number) => ({
    name: "spender",
    async run(ctx: StepContext) {
      await ctx.step("spend", async () => {
        ctx.meter.record({ purpose: "gen", model: "m", costUsd: usd, inputTokens: 1, outputTokens: 1 });
        return null;
      });
      return "done";
    },
  });

  // $4 of a $6 window: fine, and well under the $5 per-run ceiling.
  assert.equal((await runner.start(spender(4), null)).status, "completed");

  // The window still has $2 of headroom, so the run may start — but its meter
  // is capped to that headroom, so spending $4 fails as over-budget.
  const capped = await runner.start(spender(4), null);
  assert.equal(capped.status, "failed");
  assert.equal(capped.error?.name, "BudgetExceededError");

  // The window is now exhausted: starting anything is refused outright.
  await assert.rejects(runner.start(spender(0.01), null), GlobalBudgetExceededError);

  // Spend ages out of the rolling window; new work is admitted again.
  t += 24 * 60 * 60 * 1000 + 1;
  assert.equal((await runner.start(spender(1), null)).status, "completed");

  // Config that would silently neutralize the ceiling is refused loudly.
  for (const globalBudget of [
    { limitUsd: 0 },
    { limitUsd: Number.NaN },
    { limitUsd: 5, windowMs: 0 },
    { limitUsd: 5, windowMs: Number.NaN },
    { limitUsd: 5, windowMs: -1 },
  ]) {
    assert.throws(() => new WorkflowRunner({ store, clock, ids, globalBudget }));
  }
});

test("overlapping runs in one process see each other's in-flight spend", async () => {
  const { store, ids } = harness();
  const t = 1_700_000_000_000;
  const clock = { now: () => t };
  const runner = new WorkflowRunner({
    store,
    clock,
    ids,
    budgetUsd: 5,
    globalBudget: { limitUsd: 6 },
  });

  const spend = (ctx: StepContext, usd: number) =>
    ctx.meter.record({ purpose: "gen", model: "m", costUsd: usd, inputTokens: 1, outputTokens: 1 });

  const inner = {
    name: "inner",
    async run(ctx: StepContext) {
      await ctx.step("spend", async () => {
        spend(ctx, 4);
        return null;
      });
      return "done";
    },
  };

  // The outer run spends $4 and, while still executing (nothing persisted
  // yet), starts a second run on the same runner. Without live in-flight
  // metering the inner run would see $0 spent and receive the full per-run
  // ceiling; with it, its meter is capped to the $2 of real headroom.
  const outer = {
    name: "outer",
    async run(ctx: StepContext) {
      await ctx.step("spend", async () => {
        spend(ctx, 4);
        return null;
      });
      const innerOutcome = await ctx.step("overlap", async () => {
        const record = await runner.start(inner, null);
        return { status: record.status, error: record.error?.name ?? null };
      });
      return innerOutcome;
    },
  };

  const finished = await runner.start(outer, null);
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.result, { status: "failed", error: "BudgetExceededError" });
});

test("a resumed run's new spend counts against the current window, not its creation date", async () => {
  const { store, ids } = harness();
  let t = 1_700_000_000_000;
  const clock = { now: () => t };
  const runner = new WorkflowRunner({
    store,
    clock,
    ids,
    budgetUsd: 5,
    globalBudget: { limitUsd: 6 },
  });

  const gatedSpender = {
    name: "gated-spender",
    async run(ctx: StepContext) {
      await ctx.step("approval", async () => {
        ctx.suspend("waiting", null);
      });
      await ctx.step("late-spend", async () => {
        ctx.meter.record({ purpose: "gen", model: "m", costUsd: 4, inputTokens: 1, outputTokens: 1 });
        return null;
      });
      return "done";
    },
  };

  const suspended = await runner.start(gatedSpender, null);
  assert.equal(suspended.status, "suspended");

  // Two days later the run resumes and spends $4. Keyed on creation date
  // that spend would fall outside every future window; keyed on activity it
  // counts now, so a new maximal run is refused rather than doubling the cap.
  t += 2 * 24 * 60 * 60 * 1000;
  const resumed = await runner.resume(gatedSpender, suspended.id, { approved: true });
  assert.equal(resumed.status, "completed");

  const spender = {
    name: "spender",
    async run(ctx: StepContext) {
      await ctx.step("spend", async () => {
        ctx.meter.record({ purpose: "gen", model: "m", costUsd: 4, inputTokens: 1, outputTokens: 1 });
        return null;
      });
      return "done";
    },
  };
  const capped = await runner.start(spender, null);
  assert.equal(capped.status, "failed");
  assert.equal(capped.error?.name, "BudgetExceededError");
});

test("an exhausted global window never blocks delivering an approved run, only new spend", async () => {
  const { store, ids } = harness();
  const t = 1_700_000_000_000;
  const clock = { now: () => t };
  const runner = new WorkflowRunner({
    store,
    clock,
    ids,
    budgetUsd: 5,
    globalBudget: { limitUsd: 3 },
  });

  const gated = (spendAfterResume: number) => ({
    name: "gated",
    async run(ctx: StepContext) {
      const decision = await ctx.step("approval", async () => {
        ctx.suspend("waiting", null);
      });
      if (spendAfterResume > 0) {
        await ctx.step("late-spend", async () => {
          ctx.meter.record({
            purpose: "gen",
            model: "m",
            costUsd: spendAfterResume,
            inputTokens: 1,
            outputTokens: 1,
          });
          return null;
        });
      }
      return decision;
    },
  });

  const spender = {
    name: "spender",
    async run(ctx: StepContext) {
      await ctx.step("spend", async () => {
        ctx.meter.record({ purpose: "gen", model: "m", costUsd: 3, inputTokens: 1, outputTokens: 1 });
        return null;
      });
      return "done";
    },
  };

  // Two suspended runs start while there is headroom; then a third exhausts it.
  const deliverable = await runner.start(gated(0), null);
  const wantsMore = await runner.start(gated(0.5), null);
  assert.equal((await runner.start(spender, null)).status, "completed");
  await assert.rejects(runner.start(spender, null), GlobalBudgetExceededError);

  // Resuming to complete without new spend — the approval path — still works.
  const delivered = await runner.resume(gated(0), deliverable.id, { approved: true });
  assert.equal(delivered.status, "completed");

  // Resuming a run that then tries to spend hits the capped meter instead.
  const refused = await runner.resume(gated(0.5), wantsMore.id, { approved: true });
  assert.equal(refused.status, "failed");
  assert.equal(refused.error?.name, "BudgetExceededError");
});

test("a router guard runs before any route and can refuse the request", async () => {
  const guarded = new Router({ guard: basicAuthGuard("s3cret") }).get("/", () => json({ ok: true }));

  const anonymous = await guarded.handle(new Request("http://x/"));
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic realm=/);

  const credential = (user: string, password: string) =>
    new Request("http://x/", {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
    });

  assert.equal((await guarded.handle(credential("anyone", "s3cret"))).status, 200);
  // Any username passes; only the password decides.
  assert.equal((await guarded.handle(credential("", "s3cret"))).status, 200);
  assert.equal((await guarded.handle(credential("anyone", "wrong"))).status, 401);
  assert.equal((await guarded.handle(credential("anyone", ""))).status, 401);
  // A password that is a prefix of the real one must not pass.
  assert.equal((await guarded.handle(credential("anyone", "s3cre"))).status, 401);
  assert.equal((await guarded.handle(credential("anyone", "s3cretx"))).status, 401);

  // Non-ASCII passwords must round-trip: the guard advertises charset UTF-8,
  // so it must compare the client's raw UTF-8 bytes, not a re-encoding.
  const unicode = new Router({ guard: basicAuthGuard("café🔑") }).get("/", () => json({ ok: true }));
  assert.equal((await unicode.handle(credential("op", "café🔑"))).status, 200);
  assert.equal((await unicode.handle(credential("op", "cafe"))).status, 401);

  const garbled = await guarded.handle(
    new Request("http://x/", { headers: { authorization: "Basic %%%not-base64%%%" } }),
  );
  assert.equal(garbled.status, 401);

  assert.throws(() => basicAuthGuard(""), /non-empty password/);

  // No guard configured: the router is unchanged.
  const open = new Router().get("/", () => json({ ok: true }));
  assert.equal((await open.handle(new Request("http://x/"))).status, 200);
});

test("the same-origin guard refuses cross-origin browser posts and nothing else", async () => {
  const guarded = new Router({ guard: sameOriginPostGuard() })
    .get("/", () => json({ page: true }))
    .post("/runs", () => json({ started: true }));

  const post = (headers: Record<string, string>) =>
    guarded.handle(new Request("http://console/runs", { method: "POST", headers }));

  // Browser posting from another site: refused however it is signalled.
  assert.equal((await post({ origin: "http://evil.example" })).status, 403);
  assert.equal((await post({ origin: "null" })).status, 403);
  assert.equal((await post({ origin: "not a url" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "same-site" })).status, 403);

  // The console's own forms and non-browser API clients pass.
  assert.equal((await post({ origin: "http://console" })).status, 200);
  assert.equal((await post({ "sec-fetch-site": "same-origin", origin: "http://console" })).status, 200);
  assert.equal((await post({})).status, 200);

  // Reads are never blocked — CSRF is a state-change concern.
  const read = await guarded.handle(
    new Request("http://console/", { headers: { origin: "http://evil.example" } }),
  );
  assert.equal(read.status, 200);

  // composeGuards: first refusal wins, and order is respected.
  const both = new Router({
    guard: composeGuards(basicAuthGuard("pw"), sameOriginPostGuard()),
  }).post("/runs", () => json({ started: true }));
  const anonymous = await both.handle(new Request("http://console/runs", { method: "POST" }));
  assert.equal(anonymous.status, 401);
  const authedCrossSite = await both.handle(
    new Request("http://console/runs", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("op:pw").toString("base64")}`,
        origin: "http://evil.example",
      },
    }),
  );
  assert.equal(authedCrossSite.status, 403);
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
