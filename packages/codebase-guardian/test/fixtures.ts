import assert from "node:assert/strict";

import type { RepoFile, RepoSnapshot } from "../src/repo/snapshot.ts";
import { repoFile } from "../src/repo/snapshot.ts";

/**
 * `assert.throws` does not hand the error back, and these tests care about the
 * error's fields — which stage failed closed, what it was carrying.
 */
export function caught<E extends Error>(
  fn: () => unknown,
  type: new (...args: never[]) => E,
): E {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof type, `expected ${type.name}, got ${String(err)}`);
    return err;
  }
  assert.fail(`expected ${type.name} to be thrown`);
}

const pad = (n: number): string => String(n).padStart(4, "0");

const MANIFEST_DEPS: Record<string, string> = {
  "left-pad": "1.2.3",
  "risky-lib": "0.4.1",
  "grid-engine": "2.4.0",
};

function manifestSource(dependencies: Record<string, string>): string {
  return `${JSON.stringify({ name: "billing", version: "1.0.0", dependencies }, null, 2)}\n`;
}

/**
 * A small hand-written repo with a manifest, a dependency user and an importer
 * chain. Used wherever a test needs a change to be *about* something.
 */
export function billingSnapshot(): RepoSnapshot {
  return {
    repo: "acme/billing",
    commit: "c0ffee1",
    manifest: { path: "package.json", dependencies: { ...MANIFEST_DEPS } },
    files: [
      repoFile({ path: "package.json", source: manifestSource(MANIFEST_DEPS) }),
      repoFile({
        path: "src/billing/invoice.ts",
        exports: ["renderInvoice"],
        imports: ["./tax.ts", "left-pad"],
        source: "export function renderInvoice(): string {\n  return 'invoice';\n}\n",
      }),
      repoFile({
        path: "src/billing/tax.ts",
        exports: ["taxFor"],
        imports: [],
        source: "export function taxFor(cents: number): number {\n  return Math.round(cents * 0.2);\n}\n",
      }),
      repoFile({
        path: "src/api/routes.ts",
        exports: ["routes"],
        imports: ["../billing/invoice.ts"],
        source: "export const routes = ['/invoices'];\n",
      }),
      repoFile({
        path: "src/auth/session.ts",
        exports: ["sessionFor"],
        imports: [],
        source: "export function sessionFor(id: string): string {\n  return id;\n}\n",
      }),
    ],
  };
}

/**
 * `fileCount` modules in a chain: `mod-N` imports `mod-N-1`, so every module
 * has exactly one import and at most one importer.
 *
 * The point of the shape is that a given module's neighbourhood is identical
 * whatever the repo's size, which is what makes "context is a function of the
 * change, not of the repository" an assertable property rather than a claim.
 */
export function syntheticRepo(fileCount: number): RepoSnapshot {
  const files = [repoFile({ path: "package.json", source: manifestSource(MANIFEST_DEPS) })];
  for (let i = 0; i < fileCount; i += 1) {
    files.push(
      repoFile({
        path: `src/mod-${pad(i)}.ts`,
        exports: [`fn${pad(i)}`],
        imports: i > 0 ? [`./mod-${pad(i - 1)}.ts`] : [],
        source: `export function fn${pad(i)}(): number {\n  return ${i};\n}\n`,
      }),
    );
  }
  return {
    repo: "acme/synthetic",
    commit: "deadbee",
    manifest: { path: "package.json", dependencies: { ...MANIFEST_DEPS } },
    files,
  };
}

/** A module whose source is `bytes` long, for budget-pressure tests. */
export function fatFile(path: string, bytes: number, imports: string[] = []): RepoFile {
  return repoFile({ path, exports: ["big"], imports, source: `${"x".repeat(bytes)}\n` });
}
