import type { JsonSchema } from "@andromeda/core";

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength ? { maxLength } : {}),
});

/**
 * JSON Schema handed to the model as a forced strict tool.
 *
 * It duplicates part of `validateSpec` on purpose. The schema gets the model
 * close on the first attempt; the validator is what actually decides, because
 * schema conformance says nothing about whether `references` names a real
 * entity or whether a field name is a SQL keyword.
 */
export const PROJECT_SPEC_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "specVersion", "name", "summary", "template", "auth",
    "entities", "routes", "features", "env", "deploy",
  ],
  properties: {
    specVersion: { type: "string", enum: ["1"] },
    name: str("Lowercase kebab-case project slug, 2-40 characters", 40),
    summary: str("One-paragraph description of what the project does", 400),
    template: str("Id of the scaffold template to build on", 64),
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "providers"],
      properties: {
        enabled: { type: "boolean" },
        providers: {
          type: "array",
          maxItems: 4,
          items: { type: "string", enum: ["email", "oauth_github", "oauth_google"] },
        },
      },
    },
    entities: {
      type: "array",
      maxItems: 24,
      description: "Database tables. Do not declare id, created_at or updated_at; they are generated.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "summary", "fields", "ownerField"],
        properties: {
          name: str("snake_case table name", 48),
          summary: str("What this table stores", 400),
          ownerField: str('Field holding the owning user id, or "" if the table is not user-scoped', 48),
          fields: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "type", "required", "unique", "references"],
              properties: {
                name: str("snake_case column name", 48),
                type: {
                  type: "string",
                  enum: ["text", "integer", "numeric", "boolean", "timestamptz", "uuid", "jsonb"],
                },
                required: { type: "boolean" },
                unique: { type: "boolean" },
                references: str('Entity name this column is a foreign key to, or ""', 48),
              },
            },
          },
        },
      },
    },
    routes: {
      type: "array",
      maxItems: 48,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "method", "summary", "feature"],
        properties: {
          path: str("URL path beginning with /", 120),
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
          summary: str("What this route does", 400),
          feature: str('Id of the feature implementing it, or "" if the template provides it', 48),
        },
      },
    },
    features: {
      type: "array",
      maxItems: 16,
      description: "Units of business logic that must be generated and tested.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "summary", "acceptance"],
        properties: {
          id: str("kebab-case feature id", 48),
          summary: str("What the feature does", 400),
          acceptance: {
            type: "array",
            maxItems: 8,
            description:
              "Observable pass/fail criteria stated as concrete input-to-output behaviour. These become the generated test suite, so each one must be mechanically checkable.",
            items: str("A single checkable criterion", 300),
          },
        },
      },
    },
    env: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "required", "secret"],
        properties: {
          name: str("SCREAMING_SNAKE_CASE variable name", 64),
          description: str("What it configures", 400),
          required: { type: "boolean" },
          secret: { type: "boolean" },
        },
      },
    },
    deploy: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: { target: { type: "string", enum: ["vercel", "cloudflare", "none"] } },
    },
  },
};
