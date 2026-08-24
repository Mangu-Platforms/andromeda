import type { ApiSpec } from "./types.ts";

/**
 * Strict validation of a model-authored canonical API spec.
 *
 * This is the trust boundary for the whole product. Human API documentation is
 * the dominant blocker here — it is incomplete, stale and internally
 * inconsistent — and a model asked to normalize it will happily paper over the
 * gaps with something plausible. So the model is only allowed to *propose*:
 * this function decides.
 *
 * The checks that matter are the ones that would otherwise produce an SDK that
 * compiles and then fails at runtime — a `{userId}` in a path with no matching
 * parameter, two operations that collide on the same method and path shape, an
 * operation with no success response to type, a body on a GET. Unknown keys are
 * rejected outright rather than ignored, because a key we do not understand is
 * a claim we cannot check.
 */

const NAME_SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9]{0,47}$/;
/** Field and path-parameter names; these are emitted as TypeScript members. */
const IDENT_LIKE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Header names may contain dashes; they are emitted as quoted string keys. */
const HEADER_TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const PATH_CHARS = /^\/[A-Za-z0-9/_.\-{}~]*$/;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** Methods for which a request body is meaningful. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const FIELD_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "string[]",
  "integer[]",
  "object",
  "unknown",
]);
/** Parameters travel in a URL or a header, so they cannot be structured. */
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);
const PARAM_LOCATIONS = new Set(["path", "query", "header"]);
const AUTH_KINDS = new Set(["none", "bearer", "api_key_header", "basic"]);
const AUTH_CONFIRMATIONS = new Set(["unconfirmed", "probe", "human"]);
const REQUEST_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-www-form-urlencoded",
  "text/plain",
]);
const RESPONSE_CONTENT_TYPES = new Set([
  "application/json",
  "text/plain",
  "application/octet-stream",
]);

/**
 * Headers the generated client sets itself. A spec that also declares them as
 * parameters would produce a client that silently overwrites its own auth.
 */
const CLIENT_OWNED_HEADERS = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
  "accept",
]);

/**
 * Names already taken on the generated client class. An operation called
 * `constructor` or `then` does not fail at generation time — it fails much
 * later, in someone else's application.
 */
const RESERVED_MEMBERS = new Set([
  "constructor",
  "prototype",
  "then",
  "catch",
  "finally",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "baseUrl",
  "request",
  "fetch",
  "auth",
  "class",
  "function",
  "return",
  "await",
  "new",
  "delete",
  "typeof",
  "void",
]);

const LIMITS = {
  operations: 200,
  parametersPerOperation: 32,
  bodyFields: 64,
  responses: 12,
  responseFields: 64,
  summary: 300,
  description: 300,
  pathLength: 200,
} as const;

export type ApiSpecValidation =
  | { ok: true; spec: ApiSpec }
  | { ok: false; issues: string[] };

class Issues {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }

  object(
    path: string,
    value: unknown,
    allowedKeys: string[],
  ): Record<string, unknown> | null {
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
    for (const key of allowedKeys) {
      if (!Object.hasOwn(record, key)) this.add(`${path}.${key}`, "is missing");
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

  string(path: string, value: unknown, maxLength: number): string | null {
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
}

export function validateApiSpec(input: unknown): ApiSpecValidation {
  const issues = new Issues();
  const root = issues.object("spec", input, [
    "specVersion",
    "name",
    "baseUrl",
    "auth",
    "operations",
  ]);
  if (!root) return { ok: false, issues: issues.list };

  if (root.specVersion !== "1") issues.add("spec.specVersion", 'must be the string "1"');

  const name = issues.string("spec.name", root.name, 40);
  if (name !== null && !NAME_SLUG.test(name)) {
    issues.add("spec.name", `"${name}" must be a lowercase slug, 2-40 chars`);
  }

  validateBaseUrl(issues, root.baseUrl);
  const auth = validateAuth(issues, root.auth);
  validateOperations(issues, root.operations, auth);

  return issues.list.length === 0
    ? { ok: true, spec: input as ApiSpec }
    : { ok: false, issues: issues.list };
}

function validateBaseUrl(issues: Issues, value: unknown): void {
  const raw = issues.string("spec.baseUrl", value, 200);
  if (raw === null) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.add("spec.baseUrl", `"${raw}" is not an absolute URL`);
    return;
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    // An SDK that ships credentials over plaintext is a defect regardless of
    // what the documentation said.
    issues.add("spec.baseUrl", `must be https (got "${url.protocol}//")`);
  }
  if (url.username !== "" || url.password !== "") {
    issues.add("spec.baseUrl", "must not embed credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    issues.add("spec.baseUrl", "must not carry a query string or fragment");
  }
  if (raw.endsWith("/")) {
    // Paths are concatenated verbatim; a trailing slash makes `//users`.
    issues.add("spec.baseUrl", "must not end with a slash");
  }
  if (raw.includes("{")) issues.add("spec.baseUrl", "must not be templated");
}

interface AuthView {
  kind: string;
  headerName: string;
}

function validateAuth(issues: Issues, value: unknown): AuthView {
  const view: AuthView = { kind: "none", headerName: "" };
  const auth = issues.object("spec.auth", value, ["kind", "headerName", "confirmation"]);
  if (!auth) return view;

  const kind = typeof auth.kind === "string" ? auth.kind : "";
  if (!AUTH_KINDS.has(kind)) {
    issues.add("spec.auth.kind", `must be one of ${[...AUTH_KINDS].join(", ")}`);
  } else {
    view.kind = kind;
  }

  const headerName = issues.string("spec.auth.headerName", auth.headerName, 64);
  if (headerName !== null) {
    if (kind === "api_key_header") {
      if (!HEADER_TOKEN.test(headerName)) {
        issues.add("spec.auth.headerName", `"${headerName}" is not a valid header name`);
      } else {
        view.headerName = headerName;
      }
    } else if (headerName !== "") {
      issues.add("spec.auth.headerName", `must be "" when kind is "${kind}"`);
    }
  }

  if (typeof auth.confirmation !== "string" || !AUTH_CONFIRMATIONS.has(auth.confirmation)) {
    issues.add(
      "spec.auth.confirmation",
      `must be one of ${[...AUTH_CONFIRMATIONS].join(", ")}`,
    );
  }
  return view;
}

function validateOperations(issues: Issues, value: unknown, auth: AuthView): void {
  const operations = issues.array("spec.operations", value, LIMITS.operations);
  if (!operations) return;
  if (operations.length === 0) {
    issues.add("spec.operations", "a spec with no operations generates nothing");
  }

  const seenIds = new Set<string>();
  const seenRoutes = new Map<string, string>();

  operations.forEach((raw, i) => {
    const path = `spec.operations[${i}]`;
    const op = issues.object(path, raw, [
      "operationId",
      "method",
      "path",
      "summary",
      "parameters",
      "requestBody",
      "requestContentType",
      "responses",
    ]);
    if (!op) return;

    const operationId = issues.string(`${path}.operationId`, op.operationId, 48);
    if (operationId !== null) {
      if (!OPERATION_ID.test(operationId)) {
        issues.add(
          `${path}.operationId`,
          `"${operationId}" must be camelCase, starting with a lowercase letter`,
        );
      } else if (RESERVED_MEMBERS.has(operationId)) {
        issues.add(
          `${path}.operationId`,
          `"${operationId}" collides with a member of the generated client`,
        );
      } else if (seenIds.has(operationId)) {
        issues.add(`${path}.operationId`, `duplicate operationId "${operationId}"`);
      } else {
        seenIds.add(operationId);
      }
    }

    const method = typeof op.method === "string" ? op.method : "";
    if (!METHODS.has(method)) {
      issues.add(`${path}.method`, `must be one of ${[...METHODS].join(", ")}`);
    }

    const templated = validatePath(issues, `${path}.path`, op.path);

    if (templated !== null && METHODS.has(method)) {
      // Two operations differing only in what they call the path variable are
      // the same route at runtime, and the second silently shadows the first.
      const shape = `${method} ${templated.shape}`;
      const owner = seenRoutes.get(shape);
      if (owner !== undefined) {
        issues.add(path, `duplicate route "${shape}" (already declared by ${owner})`);
      } else {
        seenRoutes.set(shape, operationId ?? `operations[${i}]`);
      }
    }

    issues.string(`${path}.summary`, op.summary, LIMITS.summary);

    const declaredPathParams = validateParameters(
      issues,
      `${path}.parameters`,
      op.parameters,
      auth,
    );

    if (templated !== null) {
      for (const param of templated.names) {
        if (!declaredPathParams.has(param)) {
          issues.add(
            `${path}.parameters`,
            `path template uses {${param}} but no path parameter declares it`,
          );
        }
      }
      for (const declared of declaredPathParams) {
        if (!templated.names.includes(declared)) {
          issues.add(
            `${path}.parameters`,
            `path parameter "${declared}" does not appear in the path "${templated.raw}"`,
          );
        }
      }
    }

    const bodyFieldCount = validateBody(issues, path, op, method);
    validateResponses(issues, `${path}.responses`, op.responses);
    void bodyFieldCount;
  });
}

interface TemplatedPath {
  raw: string;
  /** Path with every `{param}` collapsed to `{}`, for collision detection. */
  shape: string;
  names: string[];
}

function validatePath(issues: Issues, path: string, value: unknown): TemplatedPath | null {
  const raw = issues.string(path, value, LIMITS.pathLength);
  if (raw === null) return null;

  if (!raw.startsWith("/")) {
    issues.add(path, `"${raw}" must start with "/"`);
    return null;
  }
  if (!PATH_CHARS.test(raw)) {
    issues.add(path, `"${raw}" contains characters not allowed in a path template`);
    return null;
  }
  if (raw.includes("..")) {
    issues.add(path, 'must not contain ".."');
    return null;
  }
  if (raw.includes("//")) {
    issues.add(path, 'must not contain an empty segment ("//")');
    return null;
  }
  if (raw.length > 1 && raw.endsWith("/")) {
    issues.add(path, "must not end with a slash");
    return null;
  }

  const names: string[] = [];
  let shape = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf("{", cursor);
    if (open === -1) {
      const tail = raw.slice(cursor);
      if (tail.includes("}")) {
        issues.add(path, "has a closing brace with no matching opening brace");
        return null;
      }
      shape += tail;
      break;
    }
    const before = raw.slice(cursor, open);
    if (before.includes("}")) {
      issues.add(path, "has a closing brace with no matching opening brace");
      return null;
    }
    shape += before;
    const close = raw.indexOf("}", open);
    if (close === -1) {
      issues.add(path, "has an opening brace with no matching closing brace");
      return null;
    }
    const inner = raw.slice(open + 1, close);
    if (inner.includes("{")) {
      issues.add(path, "has nested braces");
      return null;
    }
    if (!IDENT_LIKE.test(inner)) {
      issues.add(path, `"{${inner}}" is not a valid path parameter name`);
      return null;
    }
    if (names.includes(inner)) {
      issues.add(path, `path parameter "{${inner}}" appears more than once`);
      return null;
    }
    names.push(inner);
    shape += "{}";
    cursor = close + 1;
  }

  return { raw, shape, names };
}

function validateParameters(
  issues: Issues,
  path: string,
  value: unknown,
  auth: AuthView,
): Set<string> {
  const declaredPathParams = new Set<string>();
  const parameters = issues.array(path, value, LIMITS.parametersPerOperation);
  if (!parameters) return declaredPathParams;

  const seen = new Set<string>();
  parameters.forEach((raw, j) => {
    const p = `${path}[${j}]`;
    const param = issues.object(p, raw, ["name", "in", "type", "required", "description"]);
    if (!param) return;

    const location = typeof param.in === "string" ? param.in : "";
    if (!PARAM_LOCATIONS.has(location)) {
      issues.add(`${p}.in`, `must be one of ${[...PARAM_LOCATIONS].join(", ")}`);
    }

    const name = issues.string(`${p}.name`, param.name, 64);
    if (name !== null) {
      const pattern = location === "header" ? HEADER_TOKEN : IDENT_LIKE;
      if (!pattern.test(name)) {
        issues.add(`${p}.name`, `"${name}" is not a valid ${location || "parameter"} name`);
      } else {
        const key = `${location}:${name.toLowerCase()}`;
        if (seen.has(key)) issues.add(`${p}.name`, `duplicate ${location} parameter "${name}"`);
        seen.add(key);
        if (location === "path") declaredPathParams.add(name);
        if (location === "header") {
          const lower = name.toLowerCase();
          if (CLIENT_OWNED_HEADERS.has(lower)) {
            issues.add(`${p}.name`, `"${name}" is set by the generated client and must not be a parameter`);
          }
          if (auth.headerName !== "" && lower === auth.headerName.toLowerCase()) {
            issues.add(`${p}.name`, `"${name}" is the auth header and must not also be a parameter`);
          }
        }
      }
    }

    const type = typeof param.type === "string" ? param.type : "";
    if (!FIELD_TYPES.has(type)) {
      issues.add(`${p}.type`, `must be one of ${[...FIELD_TYPES].join(", ")}`);
    } else if (!SCALAR_TYPES.has(type)) {
      issues.add(`${p}.type`, `a ${location || "parameter"} parameter must be a scalar, got "${type}"`);
    }

    const required = issues.boolean(`${p}.required`, param.required);
    if (location === "path" && required === false) {
      // There is no such thing as an optional path segment in a template.
      issues.add(`${p}.required`, "a path parameter is always required");
    }
    issues.string(`${p}.description`, param.description, LIMITS.description);
  });

  return declaredPathParams;
}

function validateBody(
  issues: Issues,
  path: string,
  op: Record<string, unknown>,
  method: string,
): number {
  const body = issues.array(`${path}.requestBody`, op.requestBody, LIMITS.bodyFields);
  const contentType = issues.string(`${path}.requestContentType`, op.requestContentType, 64);

  if (!body) return 0;

  const seen = new Set<string>();
  body.forEach((raw, j) => {
    const p = `${path}.requestBody[${j}]`;
    const field = issues.object(p, raw, ["name", "type", "required", "description"]);
    if (!field) return;
    const name = issues.string(`${p}.name`, field.name, 64);
    if (name !== null) {
      if (!IDENT_LIKE.test(name)) {
        issues.add(`${p}.name`, `"${name}" is not a valid field name`);
      } else {
        if (seen.has(name)) issues.add(`${p}.name`, `duplicate body field "${name}"`);
        seen.add(name);
      }
    }
    if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) {
      issues.add(`${p}.type`, `must be one of ${[...FIELD_TYPES].join(", ")}`);
    }
    issues.boolean(`${p}.required`, field.required);
    issues.string(`${p}.description`, field.description, LIMITS.description);
  });

  if (body.length > 0 && !BODY_METHODS.has(method) && METHODS.has(method)) {
    issues.add(
      `${path}.requestBody`,
      `a ${method} request has no body; ${body.length} field(s) are declared`,
    );
  }
  if (contentType !== null) {
    if (body.length > 0 && !REQUEST_CONTENT_TYPES.has(contentType)) {
      issues.add(
        `${path}.requestContentType`,
        `must be one of ${[...REQUEST_CONTENT_TYPES].join(", ")} when a body is declared`,
      );
    }
    if (body.length === 0 && contentType !== "") {
      issues.add(`${path}.requestContentType`, 'must be "" when no body is declared');
    }
  }
  return body.length;
}

function validateResponses(issues: Issues, path: string, value: unknown): void {
  const responses = issues.array(path, value, LIMITS.responses);
  if (!responses) return;
  if (responses.length === 0) {
    issues.add(path, "an operation needs at least one documented response");
    return;
  }

  const seen = new Set<number>();
  let hasSuccess = false;

  responses.forEach((raw, j) => {
    const p = `${path}[${j}]`;
    const response = issues.object(p, raw, ["status", "contentType", "fields"]);
    if (!response) return;

    const status = response.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      issues.add(`${p}.status`, "must be an integer HTTP status between 100 and 599");
    } else {
      if (seen.has(status)) issues.add(`${p}.status`, `duplicate response status ${status}`);
      seen.add(status);
      if (status >= 200 && status < 300) hasSuccess = true;
    }

    const contentType = issues.string(`${p}.contentType`, response.contentType, 64);
    if (contentType !== null && !RESPONSE_CONTENT_TYPES.has(contentType)) {
      issues.add(
        `${p}.contentType`,
        `must be one of ${[...RESPONSE_CONTENT_TYPES].join(", ")}`,
      );
    }

    const fields = issues.array(`${p}.fields`, response.fields, LIMITS.responseFields);
    if (!fields) return;
    const seenFields = new Set<string>();
    fields.forEach((rawField, k) => {
      const fp = `${p}.fields[${k}]`;
      const field = issues.object(fp, rawField, ["name", "type", "required", "description"]);
      if (!field) return;
      const name = issues.string(`${fp}.name`, field.name, 64);
      if (name !== null) {
        if (!IDENT_LIKE.test(name)) {
          issues.add(`${fp}.name`, `"${name}" is not a valid field name`);
        } else {
          if (seenFields.has(name)) issues.add(`${fp}.name`, `duplicate response field "${name}"`);
          seenFields.add(name);
        }
      }
      if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) {
        issues.add(`${fp}.type`, `must be one of ${[...FIELD_TYPES].join(", ")}`);
      }
      issues.boolean(`${fp}.required`, field.required);
      issues.string(`${fp}.description`, field.description, LIMITS.description);
    });
  });

  if (!hasSuccess) {
    // Without a 2xx there is no return type to generate, and the operation can
    // only ever throw.
    issues.add(path, "an operation needs at least one 2xx response to type its return value");
  }
}

/** Path parameter names in a templated path, ignoring malformed templates. */
export function pathParameterNames(path: string): string[] {
  const issues = new Issues();
  return validatePath(issues, "path", path)?.names ?? [];
}

export { LIMITS };
