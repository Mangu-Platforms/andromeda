/**
 * The canonical internal API spec.
 *
 * Every documentation format the translator accepts — an OpenAPI fragment, a
 * Postman collection, a scraped HTML table — is normalized into exactly this
 * shape before anything downstream is allowed to look at it. Codegen, drift
 * detection and the live probe all read this and nothing else, so there is one
 * place to validate and one place that can be wrong.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "string[]"
  | "integer[]"
  | "object"
  | "unknown";

export type ParameterLocation = "path" | "query" | "header";

export type AuthKind = "none" | "bearer" | "api_key_header" | "basic";

/**
 * How the auth handshake came to be believed.
 *
 * Documentation is never enough on its own: the blueprint's second blocker for
 * this product is edge-case auth handshakes, and a silently-inferred one
 * produces an SDK that 401s in production. A spec stays `unconfirmed` until a
 * live probe demonstrates the scheme or a named human signs off, and codegen
 * refuses to emit an unconfirmed spec.
 */
export type AuthConfirmation = "unconfirmed" | "probe" | "human";

export interface AuthScheme {
  kind: AuthKind;
  /** Header carrying the key. Non-empty only for `api_key_header`. */
  headerName: string;
  confirmation: AuthConfirmation;
}

export interface Field {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
}

export interface Parameter extends Field {
  in: ParameterLocation;
}

export interface ResponseSpec {
  status: number;
  contentType: string;
  fields: Field[];
}

export interface Operation {
  /** camelCase; becomes a method name on the generated client. */
  operationId: string;
  method: HttpMethod;
  /** Templated path, e.g. `/users/{userId}/invoices`. */
  path: string;
  summary: string;
  parameters: Parameter[];
  requestBody: Field[];
  /** `""` when the operation sends no body. */
  requestContentType: string;
  responses: ResponseSpec[];
}

export interface ApiSpec {
  specVersion: "1";
  name: string;
  baseUrl: string;
  auth: AuthScheme;
  operations: Operation[];
}

/**
 * One recorded disagreement (or confirmation) between the documentation and the
 * live API. The probe is the source of truth; this is the receipt explaining why
 * the canonical spec says something the docs do not.
 */
export interface ProvenanceRecord {
  /** Dotted path into the spec, e.g. `createUser.body.email.required`. */
  target: string;
  claimedByDocs: string;
  observedByProbe: string;
  resolution: "probe-wins" | "docs-confirmed" | "human-decision";
  /** The concrete request/response that settles it. */
  evidence: string;
}

export interface SourceRef {
  kind: string;
  label: string;
  operationsFound: number;
}

/** The validated spec plus the trail of how it came to say what it says. */
export interface CanonicalSpec {
  api: ApiSpec;
  provenance: ProvenanceRecord[];
  sources: SourceRef[];
}
