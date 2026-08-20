import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSpec } from "../src/spec/validate.ts";
import { sampleSpec } from "./fixtures.ts";

const KNOWN = { knownTemplates: ["next-supabase-app", "worker-api"] };

const reject = (mutate: (spec: ReturnType<typeof sampleSpec>) => void): string[] => {
  const spec = sampleSpec();
  mutate(spec);
  const result = validateSpec(spec, KNOWN);
  assert.equal(result.ok, false, "expected the spec to be rejected");
  return result.ok ? [] : result.issues;
};

test("a well-formed spec validates", () => {
  const result = validateSpec(sampleSpec(), KNOWN);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("\n"));
});

test("SQL keywords and malformed identifiers are refused", () => {
  assert.match(
    reject((s) => { s.entities[0]!.name = "select"; }).join("\n"),
    /reserved SQL keyword/,
  );
  assert.match(
    reject((s) => { s.entities[0]!.name = "users; drop table x"; }).join("\n"),
    /not a valid identifier/,
  );
  assert.match(
    reject((s) => { s.entities[0]!.fields[0]!.name = "Owner-Id"; }).join("\n"),
    /not a valid identifier/,
  );
});

test("identifiers the scaffold already generates cannot be redeclared", () => {
  assert.match(
    reject((s) => { s.entities[0]!.fields[0]!.name = "created_at"; }).join("\n"),
    /generated automatically/,
  );
});

test("row-level security cannot be configured into a no-op", () => {
  // An owner column that is not a uuid would make every policy compare
  // auth.uid() against text and silently deny everything.
  assert.match(
    reject((s) => { s.entities[0]!.fields[0]!.type = "text"; }).join("\n"),
    /must be of type uuid/,
  );
  assert.match(
    reject((s) => { s.entities[0]!.ownerField = "nonexistent"; }).join("\n"),
    /is not one of this entity's fields/,
  );
});

test("dangling references are caught across the whole spec", () => {
  assert.match(
    reject((s) => { s.entities[0]!.fields[1]!.references = "ghosts"; }).join("\n"),
    /does not match any declared entity/,
  );
  assert.match(
    reject((s) => { s.routes[0]!.feature = "not-a-feature"; }).join("\n"),
    /does not match any declared feature/,
  );
});

test("a feature with no acceptance criteria is rejected", () => {
  // Nothing to test means nothing for the test-gate to enforce.
  assert.match(
    reject((s) => { s.features[0]!.acceptance = []; }).join("\n"),
    /at least one acceptance criterion/,
  );
});

test("unknown fields are rejected rather than ignored", () => {
  const issues = reject((s) => {
    (s as unknown as Record<string, unknown>).exfiltrateTo = "https://evil.example";
  });
  assert.match(issues.join("\n"), /unknown field/);
});

test("route paths cannot escape the app directory", () => {
  assert.match(
    reject((s) => { s.routes[0]!.path = "/api/../../etc/passwd"; }).join("\n"),
    /must not contain/,
  );
  assert.match(
    reject((s) => { s.routes[0]!.path = "/api/$(whoami)"; }).join("\n"),
    /characters not allowed/,
  );
});

test("duplicates are caught for entities, fields, routes and env vars", () => {
  assert.match(reject((s) => { s.entities[1]!.name = "line_items"; }).join("\n"), /duplicate entity/);
  assert.match(
    reject((s) => { s.entities[0]!.fields[1]!.name = "owner_id"; }).join("\n"),
    /duplicate field/,
  );
  assert.match(
    reject((s) => { s.routes[1]! = { ...s.routes[0]! }; }).join("\n"),
    /duplicate route/,
  );
  assert.match(
    reject((s) => { s.env[1]!.name = "NEXT_PUBLIC_SUPABASE_URL"; }).join("\n"),
    /duplicate env var/,
  );
});

test("runtime-owned env names are protected", () => {
  assert.match(reject((s) => { s.env[0]!.name = "PATH"; }).join("\n"), /owned by the runtime/);
  assert.match(reject((s) => { s.env[0]!.name = "lowercase"; }).join("\n"), /SCREAMING_SNAKE_CASE/);
});

test("an unregistered template is rejected", () => {
  assert.match(
    reject((s) => { s.template = "some-template-that-does-not-exist"; }).join("\n"),
    /is not a registered template/,
  );
});

test("oversized collections are refused before they become code", () => {
  const issues = reject((s) => {
    s.entities = Array.from({ length: 40 }, (_, i) => ({
      name: `table_${i}`,
      summary: "spam",
      ownerField: "",
      fields: [{ name: "x", type: "text" as const, required: true, unique: false, references: "" }],
    }));
  });
  assert.match(issues.join("\n"), /limit is 24/);
});

test("non-objects and wrong types fail without throwing", () => {
  for (const bad of [null, 42, "spec", [], undefined]) {
    const result = validateSpec(bad, KNOWN);
    assert.equal(result.ok, false);
  }
});
