import { test } from "node:test";
import assert from "node:assert/strict";

import { ScriptedProbe } from "../src/probe/scripted.ts";
import { reconcileWithProbe } from "../src/probe/reconcile.ts";
import { validateApiSpec } from "../src/spec/validate.ts";
import type { ApiSpec, Operation } from "../src/spec/types.ts";

/**
 * Adversarial audit of the claim this product is sold on: where the live API
 * and the documentation disagree, the API wins and the disagreement is
 * recorded with the request that settles it.
 *
 * The failure mode being guarded is specific and expensive — an SDK that
 * compiles against the docs and then 400s in a customer's production because
 * a field the docs called optional is not.
 */

const operation = (over: Partial<Operation> = {}): Operation => ({
  operationId: "createInvoice",
  method: "POST",
  path: "/invoices",
  summary: "Create an invoice.",
  parameters: [],
  requestBody: [
    { name: "amount", type: "integer", required: true, description: "Cents." },
    // The docs say this one is optional. The live API disagrees.
    { name: "currency", type: "string", required: false, description: "ISO code." },
  ],
  requestContentType: "application/json",
  responses: [{ status: 201, contentType: "application/json", fields: [] }],
  ...over,
});

const spec = (over: Partial<ApiSpec> = {}): ApiSpec => ({
  specVersion: "1",
  name: "billing",
  baseUrl: "https://api.example.com",
  auth: { kind: "bearer", headerName: "", confirmation: "unconfirmed" },
  operations: [operation()],
  ...over,
});

test("a field the docs call optional becomes required when the API refuses without it", async () => {
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount", "currency"], successStatus: 201 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  const currency = result.spec.operations[0]?.requestBody.find((f) => f.name === "currency");
  assert.equal(currency?.required, true, "the probe's 400 did not override the docs");

  // And the change is not silent: there is a receipt naming the request.
  const record = result.provenance.find((p) => p.target === "createInvoice.body.currency.required");
  assert.equal(record?.resolution, "probe-wins");
  assert.equal(record?.claimedByDocs, "false");
  assert.equal(record?.observedByProbe, "true");
  assert.match(record?.evidence ?? "", /without "currency"/);
  assert.match(record?.evidence ?? "", /400/);
});

test("the probe wins in the other direction too", async () => {
  // A field the docs insist on that the API accepts without. Left required, an
  // SDK forces callers to invent a value.
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["currency"], successStatus: 201 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  const amount = result.spec.operations[0]?.requestBody.find((f) => f.name === "amount");
  assert.equal(amount?.required, false, "a documented-required field was never relaxed");

  const record = result.provenance.find((p) => p.target === "createInvoice.body.amount.required");
  assert.equal(record?.resolution, "probe-wins");
});

test("agreement is recorded as confirmation, not silence", async () => {
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount"], successStatus: 201 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  const amount = result.provenance.find((p) => p.target === "createInvoice.body.amount.required");
  assert.equal(amount?.resolution, "docs-confirmed");
  // A reviewer needs to distinguish "checked and agreed" from "never checked".
  assert.ok(result.provenance.length >= 2);
});

test("a server error is not evidence about the contract", async () => {
  // A 500 means the server broke, which says nothing about whether the field
  // is required. Treating it as a 4xx would mark the whole body required.
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount"], successStatus: 500 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  // The baseline itself failed, so nothing about individual fields was inferred.
  const fieldRecords = result.provenance.filter((p) => p.target.includes(".body."));
  for (const record of fieldRecords) {
    assert.notEqual(record.resolution, "probe-wins", `${record.target} was decided by a 5xx`);
  }
});

test("an operation with no usable sample is skipped rather than guessed at", async () => {
  // Inventing a customer id produces a 404, and every field then looks
  // required. Silence beats confident nonsense.
  const withPath = spec({
    operations: [
      operation({
        operationId: "getInvoice",
        method: "GET",
        path: "/customers/{customerId}/invoices/{invoiceId}",
        requestBody: [],
      }),
    ],
  });
  const probe = new ScriptedProbe([{ operationId: "getInvoice", successStatus: 200 }]);

  const result = await reconcileWithProbe({ spec: withPath, probe });

  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.reason ?? "", /customerId/);
  assert.equal(probe.calls.length, 0, "a probe was sent for an unaddressable operation");
});

test("auth is only confirmed on positive evidence", async () => {
  const enforced = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount"], requiresAuth: true, successStatus: 201 },
  ]);
  const confirmed = await reconcileWithProbe({
    spec: spec(),
    probe: enforced,
    samples: { createInvoice: {} },
    credentials: { authorization: "Bearer test" },
  });
  assert.equal(confirmed.spec.auth.confirmation, "probe");

  // An API that answers without credentials does not have the documented
  // scheme, and confirmation must not be raised on that.
  const unenforced = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount"], requiresAuth: false, successStatus: 201 },
  ]);
  const notConfirmed = await reconcileWithProbe({
    spec: spec(),
    probe: unenforced,
    samples: { createInvoice: {} },
    credentials: { authorization: "Bearer test" },
  });
  assert.equal(notConfirmed.spec.auth.confirmation, "unconfirmed");
  assert.ok(
    notConfirmed.provenance.some(
      (p) => p.target === "auth.confirmation" && /without credentials/.test(p.observedByProbe),
    ),
    "an unenforced auth scheme must be reported loudly",
  );
});

test("an undocumented status observed live is added to the spec", async () => {
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount"], successStatus: 202 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  const statuses = result.spec.operations[0]?.responses.map((r) => r.status) ?? [];
  assert.ok(statuses.includes(202), "the observed status was discarded");
  assert.ok(
    result.provenance.some((p) => p.target === "createInvoice.responses.202"),
    "the added status has no receipt",
  );
});

test("reconciliation never produces a spec the validator would reject", async () => {
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount", "currency"], successStatus: 201 },
  ]);

  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    credentials: { authorization: "Bearer test" },
  });

  // The probe may only tighten or relax facts, never break the invariants the
  // validator enforces.
  const verdict = validateApiSpec(result.spec);
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.issues.join("; "));
});

test("every provenance record carries a concrete request as evidence", async () => {
  const probe = new ScriptedProbe([
    { operationId: "createInvoice", requiredBody: ["amount", "currency"], successStatus: 201 },
  ]);
  const result = await reconcileWithProbe({
    spec: spec(),
    probe,
    samples: { createInvoice: {} },
    credentials: { authorization: "Bearer test" },
  });

  assert.ok(result.provenance.length > 0);
  for (const record of result.provenance) {
    // A claim without a receipt is exactly what the docs already were.
    assert.ok(record.evidence.length > 0, `${record.target} has no evidence`);
    assert.match(record.evidence, /\/invoices/);
    assert.ok(["probe-wins", "docs-confirmed", "human-decision"].includes(record.resolution));
  }
});
