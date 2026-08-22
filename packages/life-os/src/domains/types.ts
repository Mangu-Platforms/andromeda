import type { LLMProvider } from "@andromeda/core";

import type { ScopedConnectors } from "../connectors.ts";
import type { DomainId, DomainReport } from "../types.ts";

/**
 * Everything a domain agent is allowed to see.
 *
 * There is no registry here and no other domain's report — a domain agent
 * reasons about its own slice and publishes typed effects. Cross-domain
 * reasoning happens exactly once, in the coordinator, and produces conflicts
 * rather than decisions.
 */
export interface DomainContext {
  connectors: ScopedConnectors;
  llm: LLMProvider;
  /** When the brief is being produced. */
  nowMs: number;
  /** Midnight of the day the brief covers, in the user's timezone offset. */
  dayStartMs: number;
}

export interface DomainAgent {
  readonly domain: DomainId;
  /** Connectors this agent expects. Checked against its scope before it runs. */
  readonly connectorIds: readonly string[];
  propose(ctx: DomainContext): Promise<DomainReport>;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

/** Cents to a display string. Money is never floated. */
export const money = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** UTC HH:MM. The brief is deterministic, so no locale formatting anywhere. */
export const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
