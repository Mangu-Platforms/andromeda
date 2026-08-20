/** Provider-agnostic LLM surface. Every product in the monorepo talks to this. */

/**
 * Routing tiers, not model names. Call sites declare how much brain a step
 * needs; the router maps that to a model. This is the cost lever the blueprint
 * calls model routing: mechanical sub-tasks must never reach a frontier model.
 */
export type ModelTier = "cheap" | "standard" | "frontier";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of JSON Schema the strict-tool path accepts. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  [key: string]: unknown;
}

export interface JsonFormat {
  name: string;
  description: string;
  schema: JsonSchema;
}

export interface LLMRequest {
  /** Free-text label recorded in the audit log and used to pick mock fixtures. */
  purpose: string;
  tier: ModelTier;
  prompt: string;
  system?: string;
  maxTokens?: number;
  effort?: Effort;
  /**
   * When set, the reply is constrained to JSON matching this schema. The
   * Anthropic provider implements it with a forced strict tool call, so the
   * model cannot return prose where the pipeline expects a record.
   */
  json?: JsonFormat;
  /** Cache the system prefix. Only worth it above ~1024 tokens. */
  cacheSystem?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LLMResult {
  text: string;
  /** Populated when `json` was requested. */
  json?: unknown;
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResult>;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
