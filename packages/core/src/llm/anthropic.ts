import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMRequest, LLMResult, ModelTier } from "./types.ts";
import { DEFAULT_TIER_MODELS, costUsd } from "./pricing.ts";
import { capabilitiesFor } from "./capabilities.ts";

export interface AnthropicProviderOptions {
  /** Override the tier-to-model mapping, e.g. to pin every tier to one model. */
  models?: Partial<Record<ModelTier, string>>;
  client?: Anthropic;
}

/**
 * Live provider.
 *
 * Two shape decisions worth knowing about:
 *
 * - Requests always stream and resolve via `finalMessage()`. Streaming costs
 *   nothing extra and removes the HTTP-timeout class of failure on the long
 *   generations this pipeline produces.
 * - JSON requests are served by a *forced strict tool call* rather than by
 *   asking for JSON in prose. `strict: true` guarantees the arguments validate
 *   against the schema, so the spec compiler gets a record or an error — never
 *   a paragraph explaining the record.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly #client: Anthropic;
  readonly #models: Record<ModelTier, string>;

  constructor(options: AnthropicProviderOptions = {}) {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile, in that order.
    this.#client = options.client ?? new Anthropic();
    this.#models = { ...DEFAULT_TIER_MODELS, ...options.models };
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const model = this.#models[req.tier];
    const caps = capabilitiesFor(model);

    const params: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 16_000,
      messages: [{ role: "user", content: req.prompt }],
    };

    if (req.system) {
      params.system = req.cacheSystem
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
    }
    if (caps.adaptiveThinking && !req.json) {
      // Forced tool choice and thinking do not combine cleanly, so structured
      // extraction runs on the model's default thinking behaviour.
      params.thinking = { type: "adaptive" };
    }
    if (caps.effort && req.effort) {
      params.output_config = { effort: req.effort };
    }
    if (req.json) {
      params.tools = [
        {
          name: req.json.name,
          description: req.json.description,
          input_schema: req.json.schema,
          strict: true,
        },
      ];
      params.tool_choice = { type: "tool", name: req.json.name };
    }

    const message = await this.#client.messages
      .stream(params as Parameters<Anthropic["messages"]["stream"]>[0])
      .finalMessage();

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category ?? "unspecified";
      throw new Error(`Claude declined the request (category: ${category})`);
    }

    let text = "";
    let json: unknown;
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use" && block.name === req.json?.name) {
        json = block.input;
      }
    }
    if (req.json && json === undefined) {
      throw new Error(
        `expected a "${req.json.name}" tool call but the model returned none ` +
          `(stop_reason: ${message.stop_reason})`,
      );
    }

    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    };

    const result: LLMResult = {
      text: json !== undefined ? JSON.stringify(json) : text,
      model: message.model,
      usage,
      costUsd: costUsd(message.model, usage),
    };
    if (json !== undefined) result.json = json;
    return result;
  }
}
