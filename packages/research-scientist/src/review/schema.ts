import type { JsonSchema } from "@andromeda/core";

/**
 * The shape the drafting model is constrained to.
 *
 * Note what is absent: there is no bibliography field. The model is not given
 * a place to write references, because a place to write references is a place
 * to invent them — the bibliography is derived from the verified citations.
 * `key` is deliberately described as a ledger key rather than "the citation",
 * so the only way to name a paper is to name one the run retrieved.
 */
export const DRAFT_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["question", "summary", "claims", "limitations"],
  properties: {
    question: { type: "string", description: "The research question, restated", maxLength: 300 },
    summary: {
      type: "string",
      description: "What the retrieved literature collectively supports",
      maxLength: 2000,
    },
    claims: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "citations"],
        properties: {
          id: { type: "string", description: "Short unique id, e.g. c1", maxLength: 32 },
          statement: {
            type: "string",
            description: "One checkable statement about the literature",
            maxLength: 600,
          },
          citations: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "quote"],
              properties: {
                key: {
                  type: "string",
                  description:
                    "A citation key from the supplied ledger. You may not cite anything else.",
                  maxLength: 64,
                },
                quote: {
                  type: "string",
                  description:
                    "A verbatim span of at least 40 characters from that paper's supplied abstract",
                  maxLength: 600,
                },
                doi: { type: "string", description: "Optional; checked against the record", maxLength: 128 },
                title: { type: "string", description: "Optional; checked against the record", maxLength: 300 },
                year: { type: "integer", description: "Optional; checked against the record" },
              },
            },
          },
        },
      },
    },
    limitations: {
      type: "array",
      maxItems: 12,
      description: "What this review cannot establish. Must not be empty.",
      items: { type: "string", maxLength: 400 },
    },
  },
};
