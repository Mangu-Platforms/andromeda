import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { TemplateRegistry } from "../src/templates/registry.ts";
import { topologicallySort } from "../src/templates/sql.ts";
import { assertPinned } from "../src/templates/render.ts";
import type { TemplateDefinition } from "../src/templates/types.ts";
import { sampleSpec } from "./fixtures.ts";

const registry = new TemplateRegistry();

const fileMap = (spec = sampleSpec()) =>
  new Map(registry.render(spec).files.map((f) => [f.path, f.contents]));

const digest = (spec = sampleSpec()) =>
  createHash("sha256")
    .update(registry.render(spec).files.map((f) => `${f.path} ${f.contents}`).join(""))
    .digest("hex");

test("rendering the same spec twice produces identical bytes", () => {
  // The deterministic scaffold layer is the entire blocker workaround. If this
  // fails, generated projects are not reproducible and diffs are unreviewable.
  assert.equal(digest(), digest());
});

test("a changed spec produces different output", () => {
  assert.notEqual(digest(), digest(sampleSpec({ name: "other-project" })));
});

test("every registered template pins exact dependency versions", () => {
  for (const template of registry.list()) {
    const all = { ...template.dependencies, ...template.devDependencies };
    for (const version of Object.values(all)) {
      assert.match(version, /^\d+\.\d+\.\d+/, `${template.id} has an unpinned dependency`);
    }
  }
  assert.throws(() => assertPinned("bad", { next: "^15.0.0" }), /must pin exact versions/);
  assert.throws(() => assertPinned("bad", { next: "latest" }), /must pin exact versions/);
});

test("the scaffold carries config, schema and CI but no business logic", () => {
  const files = fileMap();
  for (const path of [
    "package.json",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "supabase/migrations/0001_init.sql",
    "features/contract.ts",
    ".env.example",
  ]) {
    assert.ok(files.has(path), `expected the scaffold to contain ${path}`);
  }
  // Feature modules are the model's job; the template must not ship stubs
  // that would silently pass a test-gate.
  assert.ok(!files.has("features/invoice-total.ts"));
});

test("CI installs from the lockfile so a drifted dependency fails the build", () => {
  assert.match(fileMap().get(".github/workflows/ci.yml") ?? "", /npm ci/);
});

test("every table gets row-level security, owner-scoped where an owner exists", () => {
  const sql = fileMap().get("supabase/migrations/0001_init.sql") ?? "";
  assert.match(sql, /alter table public\.invoices enable row level security;/);
  assert.match(sql, /alter table public\.line_items enable row level security;/);
  assert.match(sql, /create policy "invoices_select_own"/);
  assert.match(sql, /\(select auth\.uid\(\)\) = owner_id/);
  assert.match(sql, /create policy "invoices_delete_own"/);
});

test("a table with no owner is left deny-all rather than open", () => {
  const spec = sampleSpec();
  spec.entities[1]!.ownerField = "";
  const rendered = registry.render(spec).files;
  const sql = rendered.find((f) => f.path.endsWith("0001_init.sql"))?.contents ?? "";
  assert.match(sql, /alter table public\.invoices enable row level security;/);
  assert.ok(!/create policy "invoices_/.test(sql), "expected no permissive policy");
  assert.match(sql, /client request is denied/);
});

test("foreign keys are created after the tables they point at", () => {
  const sql = fileMap().get("supabase/migrations/0001_init.sql") ?? "";
  // line_items references invoices but is declared first in the spec.
  assert.ok(
    sql.indexOf("create table if not exists public.invoices") <
      sql.indexOf("create table if not exists public.line_items"),
    "invoices must be created before the table referencing it",
  );
});

test("self-references are allowed but a real cycle is rejected", () => {
  const selfRef = sampleSpec();
  selfRef.entities[1]!.fields.push({
    name: "parent_id",
    type: "uuid",
    required: false,
    unique: false,
    references: "invoices",
  });
  assert.doesNotThrow(() => registry.render(selfRef));

  assert.throws(
    () =>
      topologicallySort([
        {
          name: "a",
          summary: "",
          ownerField: "",
          fields: [
            { name: "b_id", type: "uuid", required: true, unique: false, references: "b" },
          ],
        },
        {
          name: "b",
          summary: "",
          ownerField: "",
          fields: [
            { name: "a_id", type: "uuid", required: true, unique: false, references: "a" },
          ],
        },
      ]),
    /circular foreign keys/,
  );
});

test("route handlers are generated only for routes backed by a feature", () => {
  const files = fileMap();
  assert.ok(files.has("app/api/invoices/total/route.ts"));
  assert.ok(!files.has("app/api/invoices/route.ts"));
  const handler = files.get("app/api/invoices/total/route.ts") ?? "";
  assert.match(handler, /import \{ handle as invoiceTotal \} from "#features\/invoice-total\.ts";/);
  assert.match(handler, /export async function POST/);
});

test("generated code resolves feature modules without a build step", () => {
  const pkg = JSON.parse(fileMap().get("package.json") ?? "{}");
  // Node subpath imports, not a tsconfig alias: the test-gate runs bare
  // `node --test` against a repo with nothing installed.
  assert.deepEqual(pkg.imports, { "#features/*": "./features/*", "#lib/*": "./lib/*" });
  assert.match(pkg.scripts.test, /node --test/);
});

test("secrets are documented but never written into deployment config", () => {
  const spec = sampleSpec({ template: "worker-api" });
  const files = new Map(registry.render(spec).files.map((f) => [f.path, f.contents]));
  const toml = files.get("wrangler.toml") ?? "";
  assert.match(toml, /wrangler secret put SUPABASE_SERVICE_ROLE_KEY/);
  assert.ok(
    !/SUPABASE_SERVICE_ROLE_KEY\s*=/.test(toml),
    "a secret must not be assigned in wrangler.toml",
  );
});

test("every template exposes the identical feature contract", () => {
  // Portability of generated features between scaffolds depends on the
  // contract being byte-identical, not merely shaped alike.
  const contracts = registry.ids().map((template) => {
    const files = new Map(
      registry.render(sampleSpec({ template })).files.map((f) => [f.path, f.contents]),
    );
    const contract = files.get("features/contract.ts") ?? "";
    assert.match(contract, /export interface FeatureInput/, `${template} lacks the contract`);
    assert.match(contract, /export type FeatureHandler/, `${template} lacks the contract`);
    return contract;
  });
  for (const contract of contracts) assert.equal(contract, contracts[0]);
});

test("node-service renders a runnable zero-dependency server", () => {
  const spec = sampleSpec({ template: "node-service" });
  const files = new Map(registry.render(spec).files.map((f) => [f.path, f.contents]));

  const pkg = JSON.parse(files.get("package.json") ?? "{}");
  assert.deepEqual(pkg.dependencies, {}, "the service must have zero runtime dependencies");
  assert.deepEqual(pkg.imports, { "#features/*": "./features/*" });
  assert.match(pkg.scripts.test, /node --test/);

  const server = files.get("src/server.ts") ?? "";
  assert.match(server, /node:http/);
  assert.match(server, /\/health/);
  // Identity is proxy-attested, never a bare client header.
  assert.match(server, /PROXY_AUTH_SECRET/);
  assert.match(server, /resolveUserId/);
  // Clients get a generic 500; internals go to the log.
  assert.match(server, /"internal error"/);
  // The same routed feature the other templates wire up.
  assert.match(files.get("src/router.ts") ?? "", /#features\/invoice-total\.ts/);
  // Same RLS-bearing migration as the other scaffolds.
  assert.match(files.get("supabase/migrations/0001_init.sql") ?? "", /enable row level security/);

  const digestOf = () =>
    createHash("sha256")
      .update(registry.render(spec).files.map((f) => `${f.path} ${f.contents}`).join(""))
      .digest("hex");
  assert.equal(digestOf(), digestOf());
});

test("a rendered node-service scaffold passes its own typecheck", () => {
  // The regression this guards: a tsconfig flag that made every scaffold's
  // `npm run typecheck` fail with TS2877 shipped because no test ever ran
  // tsc against rendered output. This one does, with a stub feature standing
  // in for the model's half.
  const out = mkdtempSync(join(tmpdir(), "andromeda-scaffold-"));
  try {
    const { files } = registry.render(sampleSpec({ template: "node-service" }));
    for (const file of files) {
      mkdirSync(dirname(join(out, file.path)), { recursive: true });
      writeFileSync(join(out, file.path), file.contents);
    }
    writeFileSync(
      join(out, "features/invoice-total.ts"),
      'import type { FeatureInput, FeatureResult } from "#features/contract.ts";\n' +
        "export async function handle(_input: FeatureInput): Promise<FeatureResult> {\n" +
        "  return { status: 200, body: {} };\n" +
        "}\n",
    );
    // The scaffold's devDependencies (typescript, @types/node) are pinned to
    // the same versions this repo installs, so its node_modules stands in.
    symlinkSync(resolve("node_modules"), join(out, "node_modules"));
    execFileSync(resolve("node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
      cwd: out,
      stdio: "pipe",
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the registry refuses unsafe paths and duplicate files", () => {
  const escaping: TemplateDefinition = {
    id: "escaping",
    version: "1.0.0",
    description: "",
    dependencies: {},
    devDependencies: {},
    render: () => [{ path: "../../etc/authorized_keys", contents: "pwned" }],
  };
  const absolute: TemplateDefinition = {
    ...escaping,
    id: "absolute",
    render: () => [{ path: "/etc/passwd", contents: "" }],
  };
  const duplicating: TemplateDefinition = {
    ...escaping,
    id: "duplicating",
    render: () => [
      { path: "a.ts", contents: "1" },
      { path: "a.ts", contents: "2" },
    ],
  };

  const hostile = new TemplateRegistry([escaping, absolute, duplicating]);
  assert.throws(() => hostile.render(sampleSpec({ template: "escaping" })), /unsafe path/);
  assert.throws(() => hostile.render(sampleSpec({ template: "absolute" })), /unsafe path/);
  assert.throws(() => hostile.render(sampleSpec({ template: "duplicating" })), /twice/);
});

test("registering a template with a dependency range fails loudly", () => {
  assert.throws(
    () =>
      new TemplateRegistry([
        {
          id: "loose",
          version: "1.0.0",
          description: "",
          dependencies: { next: "^16.0.0" },
          devDependencies: {},
          render: () => [],
        },
      ]),
    /must pin exact versions/,
  );
});
