/**
 * @andromeda/traffic-twin — an advisory-only traffic digital twin.
 *
 * Nothing exported from this package can actuate a signal. The public surface
 * is data types, a deterministic simulator, a safety validator that rejects,
 * and an export path that a named traffic engineer has to approve.
 */

export * from "./network/types.ts";
export * from "./safety/policy.ts";
export * from "./safety/conflicts.ts";
export * from "./safety/validate.ts";
