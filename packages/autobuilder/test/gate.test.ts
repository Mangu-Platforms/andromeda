import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLLMProvider } from "@andromeda/core";
import { LocalSandbox } from "../src/sandbox/local.ts";
import { TemplateRegistry } from "../src/templates/registry.ts";
import { generateFeature, extractCode } from "../src/features/generate.ts";
import { checkFeatureSource } from "../src/features/guard.ts";
import { sampleSpec } from "./fixtures.ts";

const TESTS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "#features/invoice-total.ts";

const call = (body: unknown) =>
  handle({ method: "POST", path: "/api/invoices/total", query: {}, body, userId: "u1" });

test("returns 400 when body.lineItems is missing", async () => {
  const result = await call({});
  assert.equal(result.status, 400);
});

test("sums amount_cents across all line items", async () => {
  const result = await call({ lineItems: [{ amount_cents: 1000 }, { amount_cents: 2500 }] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { subtotalCents: 3500, taxCents: 0, totalCents: 3500 });
});

test("applies the tax rate and rounds to the nearest cent", async () => {
  const result = await call({ lineItems: [{ amount_cents: 1000 }], taxRate: 0.0825 });
  assert.deepEqual(result.body, { subtotalCents: 1000, taxCents: 83, totalCents: 1083 });
});
`;

/** Plausible-looking, and wrong: it never validates the input. */
const BROKEN_IMPL = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(input: FeatureInput): Promise<FeatureResult> {
  const body = input.body as { lineItems?: Array<{ amount_cents: number }>; taxRate?: number };
  const items = body.lineItems ?? [];
  const subtotalCents = items.reduce((sum, item) => sum + item.amount_cents, 0);
  const taxCents = Math.round(subtotalCents * (body.taxRate ?? 0));
  return { status: 200, body: { subtotalCents, taxCents, totalCents: subtotalCents + taxCents } };
}
`;

const FIXED_IMPL = `import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(input: FeatureInput): Promise<FeatureResult> {
  const body = input.body as { lineItems?: Array<{ amount_cents: number }>; taxRate?: number };
  if (!Array.isArray(body?.lineItems)) {
    return { status: 400, body: { error: "lineItems is required" } };
  }
  const subtotalCents = body.lineItems.reduce((sum, item) => sum + item.amount_cents, 0);
  const taxCents = Math.round(subtotalCents * (body.taxRate ?? 0));
  return { status: 200, body: { subtotalCents, taxCents, totalCents: subtotalCents + taxCents } };
}
`;

const spec = sampleSpec();
const feature = spec.features[0]!;

/** A sandbox preloaded with the scaffold, so #features/* resolves. */
async function scaffoldedSandbox() {
  const sandbox = await LocalSandbox.create();
  await sandbox.writeFiles(new TemplateRegistry().render(spec).files);
  return sandbox;
}

test("a feature ships only after its own tests pass", async (t) => {
  const sandbox = await scaffoldedSandbox();
  t.after(() => sandbox.dispose());

  const llm = new MockLLMProvider({
    handlers: {
      "feature.tests": [TESTS],
      "feature.implement": [BROKEN_IMPL],
      "feature.repair": [FIXED_IMPL],
    },
  });

  const build = await generateFeature({ llm, spec, feature, sandbox });

  assert.equal(build.passed, true);
  assert.equal(build.attempts.length, 2);
  assert.equal(build.attempts[0]?.passed, false);
  assert.equal(build.attempts[1]?.passed, true);
  // The failing run's output is what the repair prompt was built from.
  assert.match(build.attempts[0]?.output ?? "", /fail 1|not ok/);
});

test("the tests are written once and never regenerated", async (t) => {
  const sandbox = await scaffoldedSandbox();
  t.after(() => sandbox.dispose());

  const llm = new MockLLMProvider({
    handlers: {
      "feature.tests": [TESTS],
      "feature.implement": [BROKEN_IMPL],
      "feature.repair": [BROKEN_IMPL, FIXED_IMPL],
    },
  });

  await generateFeature({ llm, spec, feature, sandbox });

  // An agent that can rewrite its own tests can always pass them.
  assert.equal(llm.callCount("feature.tests"), 1);
  assert.equal(await sandbox.readFile(`features/${feature.id}.test.ts`), TESTS);
});

test("a feature that never passes is reported, not thrown", async (t) => {
  const sandbox = await scaffoldedSandbox();
  t.after(() => sandbox.dispose());

  const llm = new MockLLMProvider({
    handlers: {
      "feature.tests": [TESTS],
      "feature.implement": [BROKEN_IMPL],
      "feature.repair": [BROKEN_IMPL],
    },
  });

  const build = await generateFeature({ llm, spec, feature, sandbox, maxAttempts: 3 });

  assert.equal(build.passed, false);
  assert.equal(build.attempts.length, 3);
  // The reviewer still gets the code and the evidence.
  assert.equal(build.files.length, 2);
  assert.match(build.testOutput, /not ok|fail/);
});

test("an implementation reaching outside the contract is refused before it runs", async (t) => {
  const sandbox = await scaffoldedSandbox();
  t.after(() => sandbox.dispose());

  const exfiltrating = `import { readFileSync } from "node:fs";
import type { FeatureInput, FeatureResult } from "#features/contract.ts";

export async function handle(_input: FeatureInput): Promise<FeatureResult> {
  return { status: 200, body: readFileSync("/etc/passwd", "utf8") };
}
`;

  const llm = new MockLLMProvider({
    handlers: {
      "feature.tests": [TESTS],
      "feature.implement": [exfiltrating],
      "feature.repair": [FIXED_IMPL],
    },
  });

  const build = await generateFeature({ llm, spec, feature, sandbox });

  assert.equal(build.passed, true);
  assert.equal(build.attempts[0]?.passed, false);
  assert.match(build.attempts[0]?.output ?? "", /may not import/);
  // Rejected source is never written to disk, so it never executes.
  assert.equal(await sandbox.readFile(`features/${feature.id}.ts`), FIXED_IMPL);
});

test("the guard rejects the ways generated code usually escapes", () => {
  const reasons = (source: string, kind: "implementation" | "test" = "implementation") =>
    checkFeatureSource(feature.id, source, kind).join("\n");

  assert.match(reasons('import { spawn } from "node:child_process";\nexport const handle = 1;'), /may not import/);
  assert.match(reasons('export const handle = () => eval("1");'), /eval/);
  assert.match(reasons("export const handle = () => new Function(\"return 1\")();"), /Function constructor/);
  assert.match(reasons('const fs = require("node:fs");\nexport const handle = 1;'), /require/);
  assert.match(reasons("export const somethingElse = 1;"), /must export a "handle" function/);

  // A test file with no assertions passes unconditionally, which is worse
  // than having no gate at all.
  assert.match(
    reasons('import { test } from "node:test";\nimport "#features/invoice-total.ts";\ntest("x", () => {});', "test"),
    /no assertions/,
  );
  assert.match(
    reasons('import assert from "node:assert";\nimport "#features/invoice-total.ts";\nassert.ok(1);', "test"),
    /no test\(\) calls/,
  );
  assert.match(
    reasons('import { test } from "node:test";\nimport assert from "node:assert";\ntest("x", () => assert.ok(1));', "test"),
    /does not import the module under test/,
  );

  assert.equal(reasons(FIXED_IMPL), "");
  assert.equal(reasons(TESTS, "test"), "");
});

test("code survives the markdown fences models add anyway", () => {
  assert.equal(extractCode("```typescript\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(extractCode("Here you go:\n```ts\nconst a = 1;\n```\nEnjoy!"), "const a = 1;");
  assert.equal(extractCode("const a = 1;"), "const a = 1;");
  // Prose containing a snippet plus the real file: take the larger block.
  assert.equal(extractCode("```ts\nx\n```\n```ts\nconst longer = 2;\n```"), "const longer = 2;");
});
