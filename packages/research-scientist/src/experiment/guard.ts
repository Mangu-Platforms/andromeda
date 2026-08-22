/**
 * Static admission check for model-authored experiment code.
 *
 * A trial is meant to be a pure function from a seed to a number, and this is
 * where that claim is enforced rather than hoped for. It runs before anything
 * is written to the sandbox, so code that reaches for the filesystem, spawns a
 * process, opens a socket or builds a function out of a string is rejected
 * without ever being executed.
 *
 * This is an allowlist, not a scanner. It does not attempt to detect a bad
 * experiment; it constrains what a trial module is allowed to be. The harness
 * that calls it — argv parsing, result serialisation, exit codes — is hand-
 * written and never generated, because that is the part whose failure would be
 * silent.
 */

const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\beval\s*\(/, reason: "eval() is not allowed in experiment code" },
  { pattern: /new\s+Function\s*\(/, reason: "the Function constructor is not allowed" },
  { pattern: /\brequire\s*\(/, reason: "use ESM syntax, not require()" },
  { pattern: /\bprocess\b/, reason: "a trial may not touch process; the harness owns argv and exit" },
  { pattern: /\bchild_process\b/, reason: "a trial may not spawn processes" },
  { pattern: /\bfetch\s*\(/, reason: "a trial may not use the network" },
  { pattern: /\bglobalThis\b/, reason: "global access is not allowed" },
  { pattern: /\bDate\s*\.\s*now\b|\bnew\s+Date\b/, reason: "a trial must be a pure function of its seed, so it may not read the clock" },
  { pattern: /\bMath\s*\.\s*random\b/, reason: "a trial must be seeded; Math.random() would make it irreproducible by construction" },
];

export class UnsafeExperimentError extends Error {
  readonly reasons: string[];

  constructor(experimentId: string, reasons: string[]) {
    super(`experiment code for "${experimentId}" was rejected:\n  - ${reasons.join("\n  - ")}`);
    this.name = "UnsafeExperimentError";
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

export function checkExperimentSource(source: string): string[] {
  const reasons: string[] = [];

  // A trial imports nothing at all. Everything it needs — a seeded RNG in
  // particular — has to be written out where a reviewer can read it.
  for (const specifier of importSpecifiers(source)) {
    reasons.push(`imports "${specifier}"; a trial module may not import anything`);
  }

  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(source)) reasons.push(reason);
  }

  if (!/export\s+(?:default\s+)?function\s+runTrial\b/.test(source)) {
    reasons.push('must export a function named "runTrial" taking a numeric seed');
  }

  return reasons;
}

export function assertSafeExperimentSource(experimentId: string, source: string): void {
  const reasons = checkExperimentSource(source);
  if (reasons.length > 0) throw new UnsafeExperimentError(experimentId, reasons);
}
