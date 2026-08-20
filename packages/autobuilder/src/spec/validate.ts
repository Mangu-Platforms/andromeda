import type { ProjectSpec } from "./types.ts";

/**
 * Strict validation of a model-authored `project.yaml`.
 *
 * This is a trust boundary, not a nicety. Entity and field names are
 * interpolated into generated SQL DDL, route paths into a filesystem, and env
 * names into shell-visible configuration — so every identifier is checked
 * against an allowlist pattern rather than escaped after the fact, unknown keys
 * are rejected outright, and every collection is capped so a runaway generation
 * cannot emit five hundred tables. A model that has been prompt-injected still
 * cannot get an identifier past this function.
 */

const IDENT = /^[a-z][a-z0-9_]{0,47}$/;
const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const FEATURE_ID = /^[a-z][a-z0-9-]{0,47}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROUTE_PATH = /^\/[A-Za-z0-9/_.\-[\]]*$/;

const FIELD_TYPES = new Set([
  "text",
  "integer",
  "numeric",
  "boolean",
  "timestamptz",
  "uuid",
  "jsonb",
]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const AUTH_PROVIDERS = new Set(["email", "oauth_github", "oauth_google"]);
const DEPLOY_TARGETS = new Set(["vercel", "cloudflare", "none"]);

/** Postgres keywords that break unquoted DDL, plus our own generated names. */
const RESERVED_IDENTIFIERS = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "authorization",
  "between", "both", "case", "cast", "check", "collate", "column", "constraint",
  "create", "cross", "current_date", "current_role", "current_time",
  "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct",
  "do", "else", "end", "except", "false", "for", "foreign", "from", "grant", "group",
  "having", "in", "initially", "inner", "intersect", "into", "is", "join", "leading",
  "left", "like", "limit", "localtime", "localtimestamp", "natural", "not", "null",
  "offset", "on", "only", "or", "order", "outer", "overlaps", "placing", "primary",
  "references", "returning", "right", "select", "session_user", "similar", "some",
  "symmetric", "table", "then", "to", "trailing", "true", "union", "unique", "user",
  "using", "verbose", "when", "where", "with",
]);

/** Columns every generated table already has. */
const IMPLICIT_COLUMNS = new Set(["id", "created_at", "updated_at"]);

/** Env names the runtime owns; a spec must not try to redefine them. */
const RESERVED_ENV = new Set(["PATH", "HOME", "NODE_ENV", "PORT", "SHELL", "PWD"]);

const LIMITS = {
  entities: 24,
  fieldsPerEntity: 32,
  routes: 48,
  features: 16,
  acceptancePerFeature: 8,
  env: 24,
  summary: 400,
  acceptance: 300,
} as const;

export type ValidationResult =
  | { ok: true; spec: ProjectSpec }
  | { ok: false; issues: string[] };

export interface ValidateOptions {
  /** Template ids the registry can actually render. */
  knownTemplates: string[];
}

class Issues {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }

  /** Returns the value when it is a plain object, else records an issue. */
  object(path: string, value: unknown, allowedKeys: string[]): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.add(path, "expected an object");
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowedKeys.includes(key)) {
        this.add(`${path}.${key}`, `unknown field (allowed: ${allowedKeys.join(", ")})`);
      }
    }
    return record;
  }

  array(path: string, value: unknown, max: number): unknown[] | null {
    if (!Array.isArray(value)) {
      this.add(path, "expected an array");
      return null;
    }
    if (value.length > max) {
      this.add(path, `has ${value.length} entries, limit is ${max}`);
      return null;
    }
    return value;
  }

  string(path: string, value: unknown, maxLength = 200): string | null {
    if (typeof value !== "string") {
      this.add(path, "expected a string");
      return null;
    }
    if (value.length > maxLength) {
      this.add(path, `is ${value.length} characters, limit is ${maxLength}`);
      return null;
    }
    return value;
  }

  boolean(path: string, value: unknown): boolean | null {
    if (typeof value !== "boolean") {
      this.add(path, "expected a boolean");
      return null;
    }
    return value;
  }

  identifier(path: string, value: unknown): string | null {
    const text = this.string(path, value, 48);
    if (text === null) return null;
    if (!IDENT.test(text)) {
      this.add(path, `"${text}" is not a valid identifier (lowercase, digits, underscores; must start with a letter)`);
      return null;
    }
    if (RESERVED_IDENTIFIERS.has(text)) {
      this.add(path, `"${text}" is a reserved SQL keyword`);
      return null;
    }
    return text;
  }
}

export function validateSpec(input: unknown, options: ValidateOptions): ValidationResult {
  const issues = new Issues();
  const root = issues.object("spec", input, [
    "specVersion", "name", "summary", "template", "auth",
    "entities", "routes", "features", "env", "deploy",
  ]);
  if (!root) return { ok: false, issues: issues.list };

  if (root.specVersion !== "1") {
    issues.add("spec.specVersion", 'must be the string "1"');
  }

  const name = issues.string("spec.name", root.name, 40);
  if (name !== null && !SLUG.test(name)) {
    issues.add("spec.name", `"${name}" must be a lowercase slug, 2-40 chars`);
  }
  issues.string("spec.summary", root.summary, LIMITS.summary);

  const template = issues.string("spec.template", root.template, 64);
  if (template !== null && !options.knownTemplates.includes(template)) {
    issues.add(
      "spec.template",
      `"${template}" is not a registered template (known: ${options.knownTemplates.join(", ")})`,
    );
  }

  validateAuth(issues, root.auth);
  const entityNames = validateEntities(issues, root.entities);
  const featureIds = validateFeatures(issues, root.features);
  validateRoutes(issues, root.routes, featureIds);
  validateEnv(issues, root.env);

  const deploy = issues.object("spec.deploy", root.deploy, ["target"]);
  if (deploy && !DEPLOY_TARGETS.has(String(deploy.target))) {
    issues.add("spec.deploy.target", `must be one of ${[...DEPLOY_TARGETS].join(", ")}`);
  }

  // Cross-cutting: foreign keys must resolve to a declared entity.
  if (Array.isArray(root.entities)) {
    root.entities.forEach((raw, i) => {
      const entity = raw as Record<string, unknown>;
      const fields = Array.isArray(entity?.fields) ? entity.fields : [];
      fields.forEach((f, j) => {
        const field = f as Record<string, unknown>;
        const ref = field?.references;
        if (typeof ref === "string" && ref !== "" && !entityNames.has(ref)) {
          issues.add(
            `spec.entities[${i}].fields[${j}].references`,
            `"${ref}" does not match any declared entity`,
          );
        }
      });
    });
  }

  return issues.list.length === 0
    ? { ok: true, spec: input as ProjectSpec }
    : { ok: false, issues: issues.list };
}

function validateAuth(issues: Issues, value: unknown): void {
  const auth = issues.object("spec.auth", value, ["enabled", "providers"]);
  if (!auth) return;
  const enabled = issues.boolean("spec.auth.enabled", auth.enabled);
  const providers = issues.array("spec.auth.providers", auth.providers, 4);
  if (!providers) return;
  providers.forEach((p, i) => {
    if (typeof p !== "string" || !AUTH_PROVIDERS.has(p)) {
      issues.add(`spec.auth.providers[${i}]`, `must be one of ${[...AUTH_PROVIDERS].join(", ")}`);
    }
  });
  if (enabled === true && providers.length === 0) {
    issues.add("spec.auth.providers", "auth is enabled but no provider is listed");
  }
}

function validateEntities(issues: Issues, value: unknown): Set<string> {
  const names = new Set<string>();
  const entities = issues.array("spec.entities", value, LIMITS.entities);
  if (!entities) return names;

  entities.forEach((raw, i) => {
    const path = `spec.entities[${i}]`;
    const entity = issues.object(path, raw, ["name", "summary", "fields", "ownerField"]);
    if (!entity) return;

    const name = issues.identifier(`${path}.name`, entity.name);
    if (name !== null) {
      if (names.has(name)) issues.add(`${path}.name`, `duplicate entity "${name}"`);
      names.add(name);
    }
    issues.string(`${path}.summary`, entity.summary, LIMITS.summary);

    const fields = issues.array(`${path}.fields`, entity.fields, LIMITS.fieldsPerEntity);
    const fieldNames = new Set<string>();
    if (fields) {
      if (fields.length === 0) issues.add(`${path}.fields`, "an entity needs at least one field");
      fields.forEach((rawField, j) => {
        const fieldPath = `${path}.fields[${j}]`;
        const field = issues.object(fieldPath, rawField, [
          "name", "type", "required", "unique", "references",
        ]);
        if (!field) return;
        const fieldName = issues.identifier(`${fieldPath}.name`, field.name);
        if (fieldName !== null) {
          if (fieldNames.has(fieldName)) {
            issues.add(`${fieldPath}.name`, `duplicate field "${fieldName}"`);
          }
          if (IMPLICIT_COLUMNS.has(fieldName)) {
            issues.add(
              `${fieldPath}.name`,
              `"${fieldName}" is generated automatically and must not be declared`,
            );
          }
          fieldNames.add(fieldName);
        }
        if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) {
          issues.add(`${fieldPath}.type`, `must be one of ${[...FIELD_TYPES].join(", ")}`);
        }
        issues.boolean(`${fieldPath}.required`, field.required);
        issues.boolean(`${fieldPath}.unique`, field.unique);
        if (typeof field.references !== "string") {
          issues.add(`${fieldPath}.references`, 'expected a string (use "" for none)');
        }
      });
    }

    const owner = entity.ownerField;
    if (typeof owner !== "string") {
      issues.add(`${path}.ownerField`, 'expected a string (use "" for none)');
    } else if (owner !== "" && !fieldNames.has(owner)) {
      issues.add(`${path}.ownerField`, `"${owner}" is not one of this entity's fields`);
    } else if (owner !== "" && fields) {
      // The generated policy compares this column to auth.uid(), which is a
      // uuid. A text owner column would make every policy silently fail closed.
      const ownerField = fields.find(
        (f) => (f as Record<string, unknown>)?.name === owner,
      ) as Record<string, unknown> | undefined;
      if (ownerField && ownerField.type !== "uuid") {
        issues.add(
          `${path}.ownerField`,
          `"${owner}" must be of type uuid to be compared against auth.uid(), got "${String(ownerField.type)}"`,
        );
      }
    }
  });

  return names;
}

function validateFeatures(issues: Issues, value: unknown): Set<string> {
  const ids = new Set<string>();
  const features = issues.array("spec.features", value, LIMITS.features);
  if (!features) return ids;

  features.forEach((raw, i) => {
    const path = `spec.features[${i}]`;
    const feature = issues.object(path, raw, ["id", "summary", "acceptance"]);
    if (!feature) return;

    const id = issues.string(`${path}.id`, feature.id, 48);
    if (id !== null) {
      if (!FEATURE_ID.test(id)) issues.add(`${path}.id`, `"${id}" must be a lowercase slug`);
      if (ids.has(id)) issues.add(`${path}.id`, `duplicate feature "${id}"`);
      ids.add(id);
    }
    issues.string(`${path}.summary`, feature.summary, LIMITS.summary);

    const acceptance = issues.array(
      `${path}.acceptance`,
      feature.acceptance,
      LIMITS.acceptancePerFeature,
    );
    if (acceptance) {
      if (acceptance.length === 0) {
        // Without acceptance criteria there is nothing for the test-gate to
        // check, and an ungated feature is exactly what this product refuses
        // to ship.
        issues.add(`${path}.acceptance`, "a feature needs at least one acceptance criterion");
      }
      acceptance.forEach((a, j) => issues.string(`${path}.acceptance[${j}]`, a, LIMITS.acceptance));
    }
  });

  return ids;
}

function validateRoutes(issues: Issues, value: unknown, featureIds: Set<string>): void {
  const routes = issues.array("spec.routes", value, LIMITS.routes);
  if (!routes) return;
  const seen = new Set<string>();

  routes.forEach((raw, i) => {
    const path = `spec.routes[${i}]`;
    const route = issues.object(path, raw, ["path", "method", "summary", "feature"]);
    if (!route) return;

    const routePath = issues.string(`${path}.path`, route.path, 120);
    if (routePath !== null) {
      if (!ROUTE_PATH.test(routePath)) {
        issues.add(`${path}.path`, `"${routePath}" contains characters not allowed in a route`);
      } else if (routePath.includes("..")) {
        issues.add(`${path}.path`, "must not contain \"..\"");
      }
    }
    const method = typeof route.method === "string" ? route.method : "";
    if (!METHODS.has(method)) {
      issues.add(`${path}.method`, `must be one of ${[...METHODS].join(", ")}`);
    }
    const key = `${method} ${routePath}`;
    if (routePath !== null && METHODS.has(method)) {
      if (seen.has(key)) issues.add(`${path}`, `duplicate route "${key}"`);
      seen.add(key);
    }
    issues.string(`${path}.summary`, route.summary, LIMITS.summary);

    const feature = route.feature;
    if (typeof feature !== "string") {
      issues.add(`${path}.feature`, 'expected a string (use "" for none)');
    } else if (feature !== "" && !featureIds.has(feature)) {
      issues.add(`${path}.feature`, `"${feature}" does not match any declared feature`);
    }
  });
}

function validateEnv(issues: Issues, value: unknown): void {
  const env = issues.array("spec.env", value, LIMITS.env);
  if (!env) return;
  const seen = new Set<string>();

  env.forEach((raw, i) => {
    const path = `spec.env[${i}]`;
    const entry = issues.object(path, raw, ["name", "description", "required", "secret"]);
    if (!entry) return;

    const name = issues.string(`${path}.name`, entry.name, 64);
    if (name !== null) {
      if (!ENV_NAME.test(name)) {
        issues.add(`${path}.name`, `"${name}" must be SCREAMING_SNAKE_CASE`);
      }
      if (RESERVED_ENV.has(name)) {
        issues.add(`${path}.name`, `"${name}" is owned by the runtime and cannot be redefined`);
      }
      if (seen.has(name)) issues.add(`${path}.name`, `duplicate env var "${name}"`);
      seen.add(name);
    }
    issues.string(`${path}.description`, entry.description, LIMITS.summary);
    issues.boolean(`${path}.required`, entry.required);
    issues.boolean(`${path}.secret`, entry.secret);
  });
}

export { LIMITS };
