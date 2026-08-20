import type { ModelTier, TokenUsage } from "./types.ts";

/**
 * Published Anthropic API rates in USD per million tokens, current as of the
 * skill reference dated 2026-06-24. Prices move; `npm run check` does not
 * validate them against the live pricing page, so re-confirm before you bill a
 * customer from these numbers.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Context window, for pre-flight guards on long inputs. */
  contextTokens: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, contextTokens: 1_000_000 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15, contextTokens: 1_000_000 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, contextTokens: 200_000 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50, contextTokens: 1_000_000 },
};

/** Cache reads bill at ~0.1x input; cache writes at ~1.25x input. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Default tier mapping. Frontier work gets Opus 5; mechanical work gets Haiku. */
export const DEFAULT_TIER_MODELS: Record<ModelTier, string> = {
  cheap: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  frontier: "claude-opus-5",
};

export function priceFor(model: string): ModelPricing {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(
      `no pricing entry for model "${model}" — add it to MODEL_PRICING so runs stay metered`,
    );
  }
  return pricing;
}

export function costUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const perToken = p.inputPerMTok / 1_000_000;
  return (
    usage.inputTokens * perToken +
    usage.cacheReadTokens * perToken * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken * CACHE_WRITE_MULTIPLIER +
    (usage.outputTokens * p.outputPerMTok) / 1_000_000
  );
}
