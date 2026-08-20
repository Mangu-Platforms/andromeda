import { createHash } from "node:crypto";
import type { AuditLog, LLMProvider } from "@andromeda/core";
import type { FeatureSpec, ProjectSpec } from "../spec/types.ts";
import type { GeneratedFile } from "../templates/types.ts";
import type { Sandbox } from "../sandbox/types.ts";
import { assertSafeFeatureSource, UnsafeSourceError } from "./guard.ts";

export interface FeatureAttempt {
  attempt: number;
  passed: boolean;
  /** Test-runner output, or the rejection reasons when the guard refused it. */
  output: string;
}

export interface FeatureBuild {
  featureId: string;
  passed: boolean;
  attempts: FeatureAttempt[];
  files: GeneratedFile[];
  /** Output from the final attempt, kept for the reviewer. */
  testOutput: string;
}

export interface GenerateFeatureOptions {
  llm: LLMProvider;
  spec: ProjectSpec;
  feature: FeatureSpec;
  sandbox: Sandbox;
  audit?: AuditLog;
  /** Implementation attempts before the feature is declared failed. */
  maxAttempts?: number;
  testTimeoutMs?: number;
}

const TEST_SYSTEM = `You write the test suite for one feature of a generated project, before the implementation exists.

Output requirements:
- Emit a single TypeScript file and nothing else. No prose, no markdown fences.
- Use node:test and node:assert/strict only.
- Import the feature under test from "#features/<id>.ts" and its types from "#features/contract.ts".
- Write one test per acceptance criterion, named after that criterion.
- Assert on concrete values. A test that cannot fail is worse than no test.
- Do not import anything else. No filesystem, no network, no processes.

The implementation does not exist yet, and you will not get to change these tests later. Write the tests you would want to hold the implementation to.`;

const IMPL_SYSTEM = `You implement one feature of a generated project so that an existing, frozen test suite passes.

Output requirements:
- Emit a single TypeScript file and nothing else. No prose, no markdown fences.
- Export "handle" matching FeatureHandler from "#features/contract.ts".
- Import nothing except "#features/contract.ts". No filesystem, no network, no processes, no eval.
- Pure logic only: read the input, return { status, body }.

You cannot edit the tests. If a test looks wrong, implement what it asserts anyway.`;

/**
 * Generate one feature behind a test-gate.
 *
 * The sequence is what does the work. Tests are written first, from the
 * acceptance criteria, and then frozen: the implementation loop can rewrite the
 * implementation as many times as its budget allows but never the tests, and
 * the test file's digest is re-checked after every run. That closes the failure
 * mode that makes "the agent made the tests pass" meaningless — an agent that
 * can edit the tests will eventually edit the tests.
 *
 * A feature that never passes is returned as `passed: false` rather than
 * thrown. The pipeline needs the failure in the reviewer's hands, not an
 * exception that loses the evidence.
 */
export async function generateFeature(options: GenerateFeatureOptions): Promise<FeatureBuild> {
  const { llm, spec, feature, sandbox, audit } = options;
  const maxAttempts = options.maxAttempts ?? 3;
  const implPath = `features/${feature.id}.ts`;
  const testPath = `features/${feature.id}.test.ts`;

  const testSource = normalizeSource(
    extractCode(
      (
        await llm.complete({
          purpose: "feature.tests",
          tier: "frontier",
          effort: "high",
          system: TEST_SYSTEM,
          cacheSystem: true,
          prompt: testPrompt(spec, feature),
        })
      ).text,
    ),
  );
  assertSafeFeatureSource(feature.id, testSource, "test");
  const testDigest = digest(testSource);
  await audit?.record("llm.call", `wrote tests for ${feature.id}`, {
    feature: feature.id,
    bytes: testSource.length,
  });

  const attempts: FeatureAttempt[] = [];
  let implementation = "";
  let lastFailure = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await llm.complete({
      purpose: attempt === 1 ? "feature.implement" : "feature.repair",
      tier: "frontier",
      effort: "high",
      system: IMPL_SYSTEM,
      cacheSystem: true,
      prompt: implementationPrompt(spec, feature, testSource, lastFailure),
    });
    implementation = normalizeSource(extractCode(result.text));

    try {
      assertSafeFeatureSource(feature.id, implementation, "implementation");
    } catch (err) {
      if (!(err instanceof UnsafeSourceError)) throw err;
      // A rejected module is a failed attempt, not a crash: feed the reasons
      // back and let the next attempt fix them.
      lastFailure = err.message;
      attempts.push({ attempt, passed: false, output: err.message });
      await audit?.record("step.failed", `guard rejected ${feature.id} attempt ${attempt}`, {
        feature: feature.id,
        reasons: err.reasons,
      });
      continue;
    }

    // Rewrite the frozen tests every attempt so a previous run cannot have
    // left a weakened version behind.
    await sandbox.writeFiles([
      { path: testPath, contents: testSource },
      { path: implPath, contents: implementation },
    ]);

    const run = await sandbox.exec("node", ["--test", testPath], {
      timeoutMs: options.testTimeoutMs ?? 30_000,
    });
    const output = `${run.stdout}\n${run.stderr}`.trim();

    const onDisk = await sandbox.readFile(testPath);
    if (digest(onDisk) !== testDigest) {
      // Only reachable if executed code rewrote its own test file.
      const message = "the test file changed during the run; discarding this attempt";
      attempts.push({ attempt, passed: false, output: message });
      await audit?.record("step.failed", message, { feature: feature.id, attempt });
      lastFailure = message;
      continue;
    }

    const passed = run.code === 0 && !run.timedOut;
    attempts.push({ attempt, passed, output });
    await audit?.record(
      "sandbox.exec",
      `${feature.id} attempt ${attempt}: ${passed ? "tests passed" : "tests failed"}`,
      { feature: feature.id, attempt, exitCode: run.code, timedOut: run.timedOut },
    );

    if (passed) {
      return {
        featureId: feature.id,
        passed: true,
        attempts,
        files: [
          { path: implPath, contents: implementation },
          { path: testPath, contents: testSource },
        ],
        testOutput: output,
      };
    }
    lastFailure = run.timedOut
      ? `the test run exceeded its time limit after ${run.durationMs}ms`
      : output;
  }

  return {
    featureId: feature.id,
    passed: false,
    attempts,
    files: [
      { path: implPath, contents: implementation },
      { path: testPath, contents: testSource },
    ],
    testOutput: lastFailure,
  };
}

function testPrompt(spec: ProjectSpec, feature: FeatureSpec): string {
  return `Project: ${spec.name} — ${spec.summary}

Feature id: ${feature.id}
Feature: ${feature.summary}

Acceptance criteria:
${feature.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Relevant tables:
${describeEntities(spec)}

Write features/${feature.id}.test.ts.`;
}

function implementationPrompt(
  spec: ProjectSpec,
  feature: FeatureSpec,
  tests: string,
  failure: string,
): string {
  const base = `Project: ${spec.name} — ${spec.summary}

Feature id: ${feature.id}
Feature: ${feature.summary}

Acceptance criteria:
${feature.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Relevant tables:
${describeEntities(spec)}

The frozen test suite you must satisfy:
\`\`\`typescript
${tests}
\`\`\`

Write features/${feature.id}.ts.`;

  if (!failure) return base;

  return `${base}

Your previous attempt failed. Output from that run:
\`\`\`
${failure.slice(0, 8_000)}
\`\`\`

Fix the implementation. The tests are frozen and will not change.`;
}

const describeEntities = (spec: ProjectSpec): string =>
  spec.entities
    .map(
      (e) =>
        `- ${e.name}: ${e.fields.map((f) => `${f.name} ${f.type}`).join(", ")} (plus id, created_at, updated_at)`,
    )
    .join("\n") || "- none";

/** Generated files are real source files: they end with a newline. */
const normalizeSource = (source: string): string =>
  source.endsWith("\n") ? source : `${source}\n`;

/** Models wrap code in fences even when told not to; take the largest block. */
export function extractCode(text: string): string {
  const fenced = [...text.matchAll(/```(?:[\w-]*)\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  if (fenced.length === 0) return text.trim();
  return (fenced.sort((a, b) => b.length - a.length)[0] ?? "").trim();
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
