import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIndex, repoFile } from "../src/repo/snapshot.ts";
import {
  ContextBudgetExceededError,
  UnknownPathError,
  computeScope,
  renderScope,
  renderScopeWithinBudget,
  scopePaths,
} from "../src/repo/scope.ts";
import { billingSnapshot, caught, fatFile, syntheticRepo } from "./fixtures.ts";

test("a one-file change gets the same bounded context in a 500-file repo as in a 50-file one", () => {
  const small = buildIndex(syntheticRepo(50));
  const large = buildIndex(syntheticRepo(500));
  assert.equal(large.fileCount, 501);

  const request = { seeds: ["src/mod-0007.ts"] };
  const smallScope = computeScope(small, request);
  const largeScope = computeScope(large, request);

  // The seed plus its one import and its one importer. Not 501 files.
  assert.deepEqual(scopePaths(largeScope), [
    "src/mod-0007.ts",
    "src/mod-0006.ts",
    "src/mod-0008.ts",
  ]);
  assert.equal(largeScope.truncated, false);
  assert.ok(
    largeScope.chargedBytes < 2_000,
    `expected a small context, charged ${largeScope.chargedBytes} bytes`,
  );

  // The property the whole control rests on: repository size does not leak
  // into the prompt.
  assert.equal(largeScope.chargedBytes, smallScope.chargedBytes);
  assert.equal(
    renderScopeWithinBudget(large, largeScope),
    renderScopeWithinBudget(small, smallScope),
  );
});

test("a change whose own edited files overflow the budget is refused, not truncated", () => {
  const snapshot = syntheticRepo(4);
  snapshot.files.push(fatFile("src/huge-a.ts", 60_000));
  snapshot.files.push(fatFile("src/huge-b.ts", 60_000));
  const index = buildIndex(snapshot);

  const error = caught(
    () => computeScope(index, { seeds: ["src/huge-a.ts", "src/huge-b.ts"] }),
    ContextBudgetExceededError,
  );

  assert.equal(error.stage, "seeds");
  assert.equal(error.attemptedFiles, 2);
  assert.ok(error.attemptedBytes > error.budget.maxBytes);

  // Same seeds also fail on the file-count ceiling rather than dropping seeds.
  assert.throws(
    () => computeScope(index, { seeds: ["src/mod-0000.ts", "src/mod-0001.ts"], budget: { maxFiles: 1 } }),
    ContextBudgetExceededError,
  );
});

test("neighbours that do not fit are named in `omitted`, never silently dropped", () => {
  const index = buildIndex(syntheticRepo(60));
  const scope = computeScope(index, {
    seeds: ["src/mod-0030.ts"],
    budget: { maxFiles: 2 },
  });

  assert.deepEqual(scope.seeds, ["src/mod-0030.ts"]);
  assert.equal(scope.files.length, 2);
  assert.equal(scope.truncated, true);
  assert.deepEqual(scope.omitted, ["src/mod-0031.ts"]);

  // Truncation is visible to the reviewer in the rendered prompt too, so a
  // model is never told it is looking at a complete neighbourhood.
  assert.match(renderScope(index, scope), /did not fit the context budget/);
});

test("scoping refuses paths that are not in the code map, and the render backstop fails closed", () => {
  const index = buildIndex(billingSnapshot());

  assert.throws(
    () => computeScope(index, { seeds: ["src/does/not/exist.ts"] }),
    UnknownPathError,
  );
  assert.throws(
    () => computeScope(index, { seeds: ["package.json"], alsoConsider: ["src/ghost.ts"] }),
    UnknownPathError,
  );

  // A scope whose budget was tightened after it was computed must not be
  // rendered anyway: the render step re-checks and throws.
  const scope = computeScope(index, { seeds: ["src/billing/invoice.ts"] });
  const shrunk = { ...scope, budget: { ...scope.budget, maxBytes: 10 } };
  const error = caught(() => renderScopeWithinBudget(index, shrunk), ContextBudgetExceededError);
  assert.equal(error.stage, "render");

  // The map itself refuses inputs it cannot account for, so "everything the
  // agent may edit is a node in the map" holds by construction.
  const noManifest = billingSnapshot();
  noManifest.files = noManifest.files.filter((f) => f.path !== "package.json");
  assert.throws(() => buildIndex(noManifest), /manifest package\.json is not present/);

  const duplicated = billingSnapshot();
  duplicated.files.push(repoFile({ path: "src/billing/tax.ts", source: "" }));
  assert.throws(() => buildIndex(duplicated), /duplicate path/);
});
