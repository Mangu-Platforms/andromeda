/**
 * Static admission checks for model-authored source.
 *
 * A feature module is meant to be a pure function from a request to a
 * response, and this is where that claim is enforced rather than hoped for. It
 * runs before anything is written to the sandbox, so code that reaches for the
 * filesystem, spawns a process, or builds a function out of a string is
 * rejected without ever being executed — which matters because the next thing
 * the pipeline does is run it.
 *
 * This is an allowlist, not a scanner. It does not attempt to detect malice in
 * general; it constrains what a feature module is allowed to be.
 */

/** Modules a feature implementation may import. */
const IMPLEMENTATION_IMPORTS = [/^#features\/[\w./-]+$/];

/** Test files additionally need the runner and assertions. */
const TEST_IMPORTS = [
  /^#features\/[\w./-]+$/,
  /^node:test$/,
  /^node:assert(?:\/strict)?$/,
];

/** Constructs that turn data into code, or reach outside the module. */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\beval\s*\(/, reason: "eval() is not allowed in generated code" },
  { pattern: /new\s+Function\s*\(/, reason: "the Function constructor is not allowed" },
  { pattern: /\brequire\s*\(/, reason: "use ESM imports, not require()" },
  { pattern: /\bprocess\s*\.\s*binding\b/, reason: "process.binding is not allowed" },
  { pattern: /\bchild_process\b/, reason: "generated features must not spawn processes" },
  { pattern: /\bglobalThis\s*\[/, reason: "dynamic global access is not allowed" },
];

export class UnsafeSourceError extends Error {
  readonly reasons: string[];

  constructor(featureId: string, kind: string, reasons: string[]) {
    super(`generated ${kind} for "${featureId}" was rejected:\n  - ${reasons.join("\n  - ")}`);
    this.name = "UnsafeSourceError";
    this.reasons = reasons;
  }
}

/** Every static and dynamic import specifier in a source file. */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:[\w*{}\n\r\t, ]+)\s+from\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export type SourceKind = "implementation" | "test";

export function checkFeatureSource(
  featureId: string,
  source: string,
  kind: SourceKind,
): string[] {
  const reasons: string[] = [];
  const allowed = kind === "test" ? TEST_IMPORTS : IMPLEMENTATION_IMPORTS;

  for (const specifier of importSpecifiers(source)) {
    if (!allowed.some((pattern) => pattern.test(specifier))) {
      reasons.push(
        `imports "${specifier}", which a feature ${kind} may not import ` +
          `(allowed: ${kind === "test" ? "#features/*, node:test, node:assert" : "#features/*"})`,
      );
    }
  }

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) reasons.push(reason);
  }

  if (kind === "implementation") {
    if (!/export\s+(?:async\s+)?(?:function|const)\s+handle\b/.test(source)) {
      reasons.push('must export a "handle" function, per features/contract.ts');
    }
  } else {
    if (!/\btest\s*\(/.test(source)) {
      reasons.push("contains no test() calls, so it cannot gate anything");
    }
    if (!/\bassert\b/.test(source)) {
      reasons.push("contains no assertions, so it would pass unconditionally");
    }
    if (!source.includes(`#features/${featureId}.ts`)) {
      reasons.push(`does not import the module under test (#features/${featureId}.ts)`);
    }
  }

  return reasons;
}

export function assertSafeFeatureSource(
  featureId: string,
  source: string,
  kind: SourceKind,
): void {
  const reasons = checkFeatureSource(featureId, source, kind);
  if (reasons.length > 0) throw new UnsafeSourceError(featureId, kind, reasons);
}
