/**
 * Per-model request-shape rules.
 *
 * These are not preferences — sending the wrong shape is a 400. Adaptive
 * thinking and `output_config.effort` exist on the 4.6-and-later family;
 * Haiku 4.5 predates both and rejects them. Anything routed through the
 * `cheap` tier therefore has to go out with a plainer request.
 */
export interface ModelCapabilities {
  /** Accepts `thinking: {type: "adaptive"}`. */
  adaptiveThinking: boolean;
  /** Accepts `output_config: {effort}`. */
  effort: boolean;
  /** Thinking is always on and the parameter must be omitted entirely. */
  thinkingAlwaysOn: boolean;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  adaptiveThinking: true,
  effort: true,
  thinkingAlwaysOn: false,
};

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-5": DEFAULT_CAPABILITIES,
  "claude-sonnet-5": DEFAULT_CAPABILITIES,
  "claude-fable-5": { adaptiveThinking: false, effort: true, thinkingAlwaysOn: true },
  "claude-haiku-4-5": { adaptiveThinking: false, effort: false, thinkingAlwaysOn: false },
};

export function capabilitiesFor(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
}
