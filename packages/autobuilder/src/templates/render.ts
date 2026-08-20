import type { FieldType, ProjectSpec } from "../spec/types.ts";

/** JSON with keys sorted, so rendering is byte-stable across Node versions. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const SQL_TYPES: Record<FieldType, string> = {
  text: "text",
  integer: "integer",
  numeric: "numeric",
  boolean: "boolean",
  timestamptz: "timestamptz",
  uuid: "uuid",
  jsonb: "jsonb",
};

export const sqlType = (type: FieldType): string => SQL_TYPES[type];

const TS_TYPES: Record<FieldType, string> = {
  text: "string",
  integer: "number",
  numeric: "number",
  boolean: "boolean",
  timestamptz: "string",
  uuid: "string",
  jsonb: "unknown",
};

export const tsType = (type: FieldType): string => TS_TYPES[type];

/**
 * Reject dependency ranges.
 *
 * The blueprint's rule is to pin every dependency so a build is reproducible
 * and `npm ci` fails fast. A caret in a template would quietly reintroduce the
 * non-determinism the whole scaffold layer exists to remove, so a range is a
 * template bug and fails at registration rather than at some customer's build.
 */
export function assertPinned(id: string, deps: Record<string, string>): void {
  for (const [pkg, version] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
      throw new Error(
        `template "${id}" declares ${pkg}@${version}; templates must pin exact versions`,
      );
    }
  }
}

/** Route path to a Next.js App Router directory: /api/x/[id] -> app/api/x/[id]. */
export function routeDirectory(path: string): string {
  return `app${path.replace(/\/+$/, "")}`.replace(/\/{2,}/g, "/");
}

/** Stable, human-meaningful ordering for generated file lists. */
export function sortFiles<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function envExample(spec: ProjectSpec): string {
  const lines = [
    `# Environment for ${spec.name}.`,
    "# Copy to .env.local and fill in. Values marked secret must never be committed.",
    "",
  ];
  for (const entry of spec.env) {
    lines.push(`# ${entry.description}`);
    lines.push(`# required: ${entry.required} | secret: ${entry.secret}`);
    lines.push(`${entry.name}=`);
    lines.push("");
  }
  return lines.join("\n");
}
