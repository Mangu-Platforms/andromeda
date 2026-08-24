import { test } from "node:test";
import assert from "node:assert/strict";

import { validateApiSpec, pathParameterNames } from "../src/spec/validate.ts";
import type { ApiSpec } from "../src/spec/types.ts";
import { sampleSpec } from "./fixtures.ts";

/** Mutate a fresh valid spec, expect rejection, return the issue text. */
const reject = (mutate: (spec: ApiSpec) => void): string => {
  const spec = sampleSpec();
  mutate(spec);
  const result = validateApiSpec(spec);
  assert.equal(result.ok, false, "expected the spec to be rejected");
  return result.ok ? "" : result.issues.join("\n");
};

test("a well-formed canonical spec validates", () => {
  const result = validateApiSpec(sampleSpec());
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
  assert.deepEqual(pathParameterNames("/customers/{customerId}/invoices/{invoiceId}"), [
    "customerId",
    "invoiceId",
  ]);
});

test("path templating and parameters must agree in both directions", () => {
  // A {param} in the path that nothing declares generates a client that
  // interpolates `undefined` into the URL.
  assert.match(
    reject((s) => {
      s.operations[0]!.path = "/customers/{customerId}/invoices/{invoiceId}/lines/{lineId}";
    }),
    /path template uses \{lineId\} but no path parameter declares it/,
  );
  // And a declared path parameter with nowhere to go is silently dropped.
  assert.match(
    reject((s) => {
      s.operations[0]!.parameters.push({
        name: "regionId",
        in: "path",
        type: "string",
        required: true,
        description: "Never appears in the path.",
      });
    }),
    /path parameter "regionId" does not appear in the path/,
  );
  assert.match(
    reject((s) => {
      s.operations[0]!.parameters[0]!.required = false;
    }),
    /a path parameter is always required/,
  );
  assert.match(
    reject((s) => {
      s.operations[0]!.path = "/customers/{customerId}/invoices/{customerId}";
    }),
    /appears more than once/,
  );
});

test("unknown keys are rejected rather than ignored", () => {
  // A key we do not understand is a claim we cannot check, so it fails closed
  // instead of being dropped on the floor.
  assert.match(
    reject((s) => {
      (s.operations[0] as unknown as Record<string, unknown>).deprecated = true;
    }),
    /operations\[0\]\.deprecated: unknown field/,
  );
  assert.match(
    reject((s) => {
      (s as unknown as Record<string, unknown>).servers = [];
    }),
    /spec\.servers: unknown field/,
  );
  assert.match(
    reject((s) => {
      delete (s.operations[0] as unknown as Record<string, unknown>).summary;
    }),
    /operations\[0\]\.summary: is missing/,
  );
});

test("duplicate operations and colliding client members are refused", () => {
  assert.match(
    reject((s) => {
      s.operations[1]!.operationId = "getInvoice";
    }),
    /duplicate operationId "getInvoice"/,
  );
  // Same route at runtime, different variable name in the docs: the second
  // operation would silently shadow the first.
  assert.match(
    reject((s) => {
      s.operations[1]!.method = "GET";
      s.operations[1]!.path = "/customers/{cid}/invoices/{iid}";
      s.operations[1]!.parameters = [
        { name: "cid", in: "path", type: "string", required: true, description: "c" },
        { name: "iid", in: "path", type: "string", required: true, description: "i" },
      ];
      s.operations[1]!.requestBody = [];
      s.operations[1]!.requestContentType = "";
    }),
    /duplicate route "GET \/customers\/\{\}\/invoices\/\{\}"/,
  );
  assert.match(
    reject((s) => {
      s.operations[0]!.operationId = "constructor";
    }),
    /collides with a member of the generated client/,
  );
  assert.match(
    reject((s) => {
      s.operations[1]!.requestBody[1]!.name = "amount";
    }),
    /duplicate body field "amount"/,
  );
});

test("methods, statuses, content types and field types must be legal", () => {
  assert.match(
    reject((s) => {
      (s.operations[0] as unknown as Record<string, unknown>).method = "TRACE";
    }),
    /method: must be one of/,
  );
  assert.match(
    reject((s) => {
      s.operations[0]!.requestBody = [
        { name: "q", type: "string", required: true, description: "x" },
      ];
      s.operations[0]!.requestContentType = "application/json";
    }),
    /a GET request has no body/,
  );
  assert.match(
    reject((s) => {
      s.operations[1]!.requestContentType = "application/xml";
    }),
    /requestContentType: must be one of/,
  );
  assert.match(
    reject((s) => {
      s.operations[0]!.responses[0]!.status = 999;
    }),
    /must be an integer HTTP status/,
  );
  // No 2xx means there is no return type to generate at all.
  assert.match(
    reject((s) => {
      s.operations[0]!.responses = [
        { status: 404, contentType: "application/json", fields: [] },
      ];
    }),
    /at least one 2xx response/,
  );
  // Query and header parameters cannot be structured; they are stringified.
  assert.match(
    reject((s) => {
      s.operations[0]!.parameters[2]!.type = "object";
    }),
    /must be a scalar/,
  );
  assert.match(
    reject((s) => {
      (s.operations[1]!.requestBody[0] as unknown as Record<string, unknown>).type = "float";
    }),
    /requestBody\[0\]\.type: must be one of/,
  );
});

test("base URL and auth headers cannot produce a leaking or self-overwriting client", () => {
  assert.match(
    reject((s) => {
      s.baseUrl = "http://api.example.com";
    }),
    /must be https/,
  );
  assert.match(
    reject((s) => {
      s.baseUrl = "https://user:pw@api.example.com";
    }),
    /must not embed credentials/,
  );
  assert.match(
    reject((s) => {
      s.baseUrl = "https://api.example.com/v1/";
    }),
    /must not end with a slash/,
  );
  // The generated client sets Authorization itself; a parameter of the same
  // name would overwrite the credential at call time.
  assert.match(
    reject((s) => {
      s.operations[0]!.parameters.push({
        name: "Authorization",
        in: "header",
        type: "string",
        required: false,
        description: "Injected by the docs.",
      });
    }),
    /is set by the generated client/,
  );
  assert.match(
    reject((s) => {
      s.auth = { kind: "api_key_header", headerName: "X-Api-Key", confirmation: "probe" };
      s.operations[0]!.parameters.push({
        name: "x-api-key",
        in: "header",
        type: "string",
        required: false,
        description: "Also the auth header.",
      });
    }),
    /is the auth header and must not also be a parameter/,
  );
  assert.match(
    reject((s) => {
      s.auth = { kind: "bearer", headerName: "X-Token", confirmation: "probe" };
    }),
    /must be "" when kind is "bearer"/,
  );
});
