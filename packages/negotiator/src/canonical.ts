import { createHash } from "node:crypto";

/**
 * Key-sorted JSON, so a hash over a record is stable across property insertion
 * order and across a checkpoint round-trip. The pre-committed mandate is
 * identified by a hash of exactly this encoding, so any change to the encoding
 * invalidates every previously frozen mandate — which is the intended
 * fail-closed behaviour rather than a hazard.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
