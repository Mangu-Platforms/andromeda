import type { JsonSchema } from "@andromeda/core";

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength ? { maxLength } : {}),
});

const FIELD = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "required", "description"],
  properties: {
    name: str("Field name exactly as the API uses it on the wire", 64),
    type: {
      type: "string",
      enum: ["string", "integer", "number", "boolean", "string[]", "integer[]", "object", "unknown"],
      description: 'Use "unknown" when the documentation does not say. Never guess.',
    },
    required: {
      type: "boolean",
      description: "Only true when the documentation states it. A live probe decides the rest.",
    },
    description: str("What the field means, copied from the docs", 300),
  },
};

/**
 * Schema handed to the model as a forced strict tool call.
 *
 * It duplicates part of `validateApiSpec` deliberately. The schema gets the
 * model into the right shape on the first attempt; the validator is what
 * actually decides, because JSON-shape conformance says nothing about whether
 * `{customerId}` in a path has a matching parameter or whether two operations
 * collide on the same route.
 */
export const API_SPEC_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["specVersion", "name", "baseUrl", "auth", "operations"],
  properties: {
    specVersion: { type: "string", enum: ["1"] },
    name: str("Lowercase kebab-case slug naming the API, 2-40 characters", 40),
    baseUrl: str("Absolute https origin with no trailing slash", 200),
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "headerName", "confirmation"],
      properties: {
        kind: { type: "string", enum: ["none", "bearer", "api_key_header", "basic"] },
        headerName: str('Header carrying the key; "" unless kind is api_key_header', 64),
        confirmation: {
          type: "string",
          enum: ["unconfirmed"],
          description:
            'Always "unconfirmed". Only a live probe or a named human may raise it.',
        },
      },
    },
    operations: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "operationId",
          "method",
          "path",
          "summary",
          "parameters",
          "requestBody",
          "requestContentType",
          "responses",
        ],
        properties: {
          operationId: str("camelCase method name for the generated client", 48),
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
          path: str("Templated path such as /customers/{customerId}/invoices", 200),
          summary: str("One line describing the operation", 300),
          parameters: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "in", "type", "required", "description"],
              properties: {
                ...FIELD.properties,
                in: { type: "string", enum: ["path", "query", "header"] },
                type: { type: "string", enum: ["string", "integer", "number", "boolean"] },
              },
            },
          },
          requestBody: { type: "array", maxItems: 64, items: FIELD },
          requestContentType: str('"" when the operation sends no body', 64),
          responses: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["status", "contentType", "fields"],
              properties: {
                status: { type: "integer", minimum: 100, maximum: 599 },
                contentType: {
                  type: "string",
                  enum: ["application/json", "text/plain", "application/octet-stream"],
                },
                fields: { type: "array", maxItems: 64, items: FIELD },
              },
            },
          },
        },
      },
    },
  },
};
