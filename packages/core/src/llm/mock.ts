import type { LLMProvider, LLMRequest, LLMResult } from "./types.ts";
import { costUsd } from "./pricing.ts";
import { DEFAULT_TIER_MODELS } from "./pricing.ts";

/** Return value of a mock handler: text, or any value when JSON was requested. */
export type MockReply = string | object;

/**
 * `callIndex` is the 0-based count of prior calls with the same `purpose`,
 * which is what lets a fixture script a first-attempt failure and a
 * second-attempt fix — exactly the shape the test-gate repair loop exercises.
 */
export type MockHandler = (req: LLMRequest, callIndex: number) => MockReply;

export interface MockOptions {
  /** Handler per `purpose`, or an array replayed in order for that purpose. */
  handlers: Record<string, MockHandler | MockReply[]>;
  /** Reply used when no handler matches. Throws instead when omitted. */
  fallback?: MockHandler;
}

/**
 * Deterministic in-process provider. Token counts are derived from string
 * length so cost metering and budget ceilings are exercised by the test suite
 * without a network call.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  readonly calls: Array<{ req: LLMRequest; result: LLMResult }> = [];
  readonly #handlers: Record<string, MockHandler>;
  readonly #fallback: MockHandler | undefined;
  readonly #counts = new Map<string, number>();

  constructor(options: MockOptions) {
    this.#handlers = {};
    for (const [purpose, handler] of Object.entries(options.handlers)) {
      this.#handlers[purpose] = Array.isArray(handler)
        ? (_req, i) => {
            const reply = handler[Math.min(i, handler.length - 1)];
            if (reply === undefined) {
              throw new Error(`mock script for "${purpose}" is empty`);
            }
            return reply;
          }
        : handler;
    }
    this.#fallback = options.fallback;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const handler = this.#handlers[req.purpose] ?? this.#fallback;
    if (!handler) {
      throw new Error(
        `MockLLMProvider has no handler for purpose "${req.purpose}" ` +
          `(known: ${Object.keys(this.#handlers).join(", ") || "none"})`,
      );
    }
    const callIndex = this.#counts.get(req.purpose) ?? 0;
    this.#counts.set(req.purpose, callIndex + 1);

    const reply = handler(req, callIndex);
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    const model = DEFAULT_TIER_MODELS[req.tier];
    const usage = {
      // ~4 chars per token is close enough to make budgets bite in tests.
      inputTokens: Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const result: LLMResult = {
      text,
      model,
      usage,
      costUsd: costUsd(model, usage),
    };
    if (req.json) {
      result.json = typeof reply === "string" ? JSON.parse(reply) : reply;
    }
    this.calls.push({ req, result });
    return result;
  }

  /** Number of completions issued for a purpose. Handy in assertions. */
  callCount(purpose: string): number {
    return this.#counts.get(purpose) ?? 0;
  }
}
