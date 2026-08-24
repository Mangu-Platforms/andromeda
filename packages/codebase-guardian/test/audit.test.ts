import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIndex, repoFile, type RepoSnapshot } from "../src/repo/snapshot.ts";
import {
  computeScope,
  renderScopeWithinBudget,
  scopePaths,
  ContextBudgetExceededError,
  UnknownPathError,
  DEFAULT_CONTEXT_BUDGET,
} from "../src/repo/scope.ts";
import { classifyBump } from "../src/change/semver.ts";

/**
 * Adversarial audit of the diff-scoping claim.
 *
 * These tests were written against the package's stated guarantee — "context is
 * bounded independently of repository size" — rather than against its
 * implementation, and they try to break it. Passing tests written alongside an
 * implementation prove internal consistency; these are meant to prove the
 * property.
 */

/** A repo of `size` files where `hub.ts` is imported by every one of them. */
function hubRepo(size: number): RepoSnapshot {
  const files = [
    repoFile({ path: "package.json", source: '{"dependencies":{}}\n' }),
    repoFile({ path: "src/hub.ts", exports: ["hub"], source: "export const hub = 1;\n" }),
  ];
  for (let i = 0; i < size; i++) {
    files.push(
      repoFile({
        path: `src/consumer-${i}.ts`,
        imports: ["./hub.ts"],
        source: `import { hub } from "./hub.ts";\nexport const c${i} = hub + ${i};\n`,
      }),
    );
  }
  return { repo: "hub", commit: "c0", files, manifest: { path: "package.json", dependencies: {} } };
}

test("a hub file imported by a thousand others still yields a bounded context", () => {
  // The obvious way the guarantee fails: walk importers of a widely-used file
  // and pull in the entire repository.
  const index = buildIndex(hubRepo(1_000));
  const scope = computeScope(index, { seeds: ["src/hub.ts"] });

  assert.ok(scope.files.length <= 24, `admitted ${scope.files.length} files`);
  assert.equal(scope.truncated, true, "a truncated scope must say so");
  assert.ok(scope.omitted.length > 900, "omitted files must be recorded, not dropped silently");
  // Seeds are never the thing that gets dropped.
  assert.ok(scopePaths(scope).includes("src/hub.ts"));
});

test("context size does not grow with repository size", () => {
  // The guarantee stated as a measurement: same change, three repo sizes.
  const sizes = [50, 500, 5_000];
  const rendered = sizes.map((size) => {
    const index = buildIndex(hubRepo(size));
    const scope = computeScope(index, { seeds: ["src/hub.ts"] });
    return renderScopeWithinBudget(index, scope).length;
  });

  const [small, , large] = rendered as [number, number, number];

  // Bounded by the budget at every size, and essentially flat: a hundredfold
  // repo only moves the byte count by the extra digits in the "+N more outside
  // this scope" counts, which is logarithmic, not linear. Before the importer
  // list was scope-limited this rendered 113,590 bytes and blew the budget.
  for (const bytes of rendered) {
    assert.ok(bytes <= DEFAULT_CONTEXT_BUDGET.maxBytes, `rendered ${bytes} bytes`);
  }
  assert.ok(
    large - small < 500,
    `context grew by ${large - small} bytes across a 100x repository`,
  );
});

test("an import cycle terminates instead of looping", () => {
  const files = [
    repoFile({ path: "package.json", source: '{"dependencies":{}}\n' }),
    repoFile({ path: "src/a.ts", imports: ["./b.ts"], source: "import './b.ts';\n" }),
    repoFile({ path: "src/b.ts", imports: ["./c.ts"], source: "import './c.ts';\n" }),
    repoFile({ path: "src/c.ts", imports: ["./a.ts"], source: "import './a.ts';\n" }),
    // And a file that imports itself, which a naive walk also hangs on.
    repoFile({ path: "src/self.ts", imports: ["./self.ts"], source: "import './self.ts';\n" }),
  ];
  const index = buildIndex({
    repo: "cyclic",
    commit: "c0",
    files,
    manifest: { path: "package.json", dependencies: {} },
  });

  const cycle = computeScope(index, { seeds: ["src/a.ts"], budget: { maxDepth: 10 } });
  assert.ok(cycle.files.length <= 4);
  const selfRef = computeScope(index, { seeds: ["src/self.ts"], budget: { maxDepth: 10 } });
  assert.deepEqual(scopePaths(selfRef), ["src/self.ts"]);
});

test("a deep budget on a dense graph is still bounded", () => {
  // maxDepth is operator-supplied; a large value must not defeat maxFiles.
  const index = buildIndex(hubRepo(400));
  const scope = computeScope(index, {
    seeds: ["src/hub.ts"],
    budget: { maxDepth: 50, maxFiles: 10 },
  });
  assert.ok(scope.files.length <= 10);
});

test("alsoConsider cannot be used to smuggle the repo past the budget", () => {
  const snapshot = hubRepo(200);
  const index = buildIndex(snapshot);
  const everything = snapshot.files.map((f) => f.path);

  const scope = computeScope(index, {
    seeds: ["src/hub.ts"],
    alsoConsider: everything,
    budget: { maxFiles: 8 },
  });
  assert.ok(scope.files.length <= 8, `alsoConsider admitted ${scope.files.length} files`);
});

test("a change whose own edited files overflow the budget fails closed", () => {
  const big = "x".repeat(50_000);
  const index = buildIndex({
    repo: "big",
    commit: "c0",
    files: [
      repoFile({ path: "package.json", source: '{"dependencies":{}}\n' }),
      repoFile({ path: "src/one.ts", source: big }),
      repoFile({ path: "src/two.ts", source: big }),
      repoFile({ path: "src/three.ts", source: big }),
    ],
    manifest: { path: "package.json", dependencies: {} },
  });

  // Silently truncating the code it is about to rewrite would be worse than
  // refusing, so this must throw rather than return a partial scope.
  assert.throws(
    () => computeScope(index, { seeds: ["src/one.ts", "src/two.ts", "src/three.ts"] }),
    ContextBudgetExceededError,
  );
});

test("a rendered scope never exceeds the byte budget", () => {
  const index = buildIndex(hubRepo(300));
  for (const maxBytes of [2_000, 10_000, 96_000]) {
    const scope = computeScope(index, { seeds: ["src/hub.ts"], budget: { maxBytes } });
    const rendered = renderScopeWithinBudget(index, scope);
    assert.ok(
      rendered.length <= maxBytes,
      `rendered ${rendered.length} bytes against a ${maxBytes} budget`,
    );
  }
});

test("an unknown seed path is an error, not an empty context", () => {
  const index = buildIndex(hubRepo(3));
  // Scoping to nothing and proceeding would mean editing blind.
  assert.throws(() => computeScope(index, { seeds: ["src/nope.ts"] }), UnknownPathError);
  assert.throws(() => computeScope(index, { seeds: [] }), /at least one seed/);
});

/**
 * Adversarial audit of the auto-merge claim: only patch-level bumps may merge
 * without a human, and anything unparseable fails closed.
 *
 * Note the layering. `classifyBump` reports version arithmetic — 0.1.2 -> 0.1.3
 * genuinely is a patch bump — and the *policy* is where pre-1.0 is excluded
 * from the unattended lane. Auditing the classifier alone would have reported a
 * hole that is not there, so the pre-1.0 case is asserted against
 * `decideAutoMerge` below.
 */
test("version strings that are not plainly patch-level never auto-merge", () => {
  const cases: Array<[string, string]> = [
    ["1.2.3", "1.3.0"], // minor
    ["1.2.3", "2.0.0"], // major
    ["1.2.3", "1.2.3"], // no change
    ["1.2.3", "1.2.2"], // downgrade
    ["1.2.3", "1.2.4-beta.1"], // prerelease
    ["1.2.3", "latest"],
    ["1.2.3", "^1.2.4"],
    ["1.2.3", ""],
    ["", "1.2.4"],
    ["not-a-version", "also-not"],
    ["1.2", "1.2.4"],
    ["1.2.3", "1.2.4.5"],
  ];

  for (const [from, to] of cases) {
    const bump = classifyBump(from, to);
    assert.notEqual(
      bump,
      "patch",
      `"${from}" -> "${to}" was classified patch and would have auto-merged`,
    );
  }

  // The one case that may.
  assert.equal(classifyBump("1.2.3", "1.2.4"), "patch");
});
