/**
 * @andromeda/memory-layer — a bring-your-own-device, privacy-first memory layer.
 *
 * Software only: it assumes someone else's microphone. What it provides is the
 * part that is hard to get right — deciding where each piece of processing may
 * run, what may leave the user's own hardware, whose words may be written down
 * at all, and when a memory is allowed to surface.
 */

export * from "./tiers.ts";
export * from "./consent.ts";
export * from "./policy.ts";
export * from "./triggers.ts";
export * from "./embed.ts";
export * from "./memory-index.ts";
