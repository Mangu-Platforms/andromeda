/**
 * Semver parsing and bump classification.
 *
 * The auto-merge lane hangs off this, so it is written to fail closed: only an
 * exact release version is parsed. Range operators (`^1.2.3`, `~1.2`, `>=2`,
 * `1.x`, `*`) are *not* versions — they describe a set of versions, and which
 * one is installed depends on a lockfile the code map does not carry. Treating
 * `^1.2.3 -> ^1.2.4` as a patch bump would be a guess, and a guess is not
 * something to hang an unattended merge on. Anything unparseable classifies as
 * `unknown`, which every policy rule reads as "requires a human".
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, empty when this is a release. */
  prerelease: string[];
  build: string | null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(version: string): Semver | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease, build] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  // Leading zeroes are invalid semver and usually mean the string is not a
  // version at all (a date, a build number); refuse rather than coerce.
  for (const part of [major, minor, patch]) {
    if (part.length > 1 && part.startsWith("0")) return null;
  }
  const ids = prerelease === undefined || prerelease === "" ? [] : prerelease.split(".");
  if (ids.some((id) => id === "")) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: ids,
    build: build ?? null,
  };
}

export type BumpClass =
  | "same"
  | "patch"
  | "minor"
  | "major"
  | "prerelease"
  | "downgrade"
  | "unknown";

/**
 * Classify a version transition. Never throws — an input it cannot understand
 * comes back as `unknown` so callers cannot forget to handle the case.
 */
export function classifyBump(from: string, to: string): BumpClass {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (a === null || b === null) return "unknown";

  // A prerelease on either end has no compatibility promise at all, whichever
  // number moved, so it is never a patch bump.
  if (a.prerelease.length > 0 || b.prerelease.length > 0) {
    return comparePrecedence(a, b) > 0 ? "downgrade" : "prerelease";
  }

  if (b.major !== a.major) return b.major > a.major ? "major" : "downgrade";
  if (b.minor !== a.minor) return b.minor > a.minor ? "minor" : "downgrade";
  if (b.patch !== a.patch) return b.patch > a.patch ? "patch" : "downgrade";
  return "same";
}

/** Standard semver precedence: -1, 0 or 1. Build metadata is ignored. */
export function comparePrecedence(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether a version lives in the pre-1.0 range, where semver grants no
 * compatibility promise even across a patch bump.
 */
export function isPreRelease1(version: string): boolean {
  const parsed = parseSemver(version);
  return parsed !== null && parsed.major === 0;
}
