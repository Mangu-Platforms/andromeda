/**
 * `project.yaml` — the contract between natural-language intent and generated code.
 *
 * This type is the deterministic boundary of the product. Everything upstream
 * of it is a language model guessing at what someone meant; everything
 * downstream is ordinary, testable code that consumes a validated record. The
 * spec is small on purpose: each field has to be something a template can
 * render deterministically or a feature can be tested against.
 */
export type FieldType =
  | "text"
  | "integer"
  | "numeric"
  | "boolean"
  | "timestamptz"
  | "uuid"
  | "jsonb";

export interface FieldSpec {
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  /** Entity name this field is a foreign key to, or "" for none. */
  references: string;
}

export interface EntitySpec {
  name: string;
  summary: string;
  fields: FieldSpec[];
  /**
   * Field holding the owning user's id. When set, the generated migration
   * emits row-level-security policies keyed on it; when empty the table is
   * generated with RLS enabled and no permissive policy, which denies all
   * client access rather than silently exposing the table.
   */
  ownerField: string;
}

export interface RouteSpec {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  summary: string;
  /** Feature id implementing this route, or "" for a template-provided route. */
  feature: string;
}

export interface FeatureSpec {
  id: string;
  summary: string;
  /**
   * Observable acceptance criteria. These are what the generated test suite
   * asserts, so they must be checkable statements about inputs and outputs —
   * not aspirations. The test-gate is only as good as this list.
   */
  acceptance: string[];
}

export interface EnvVarSpec {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
}

export interface ProjectSpec {
  specVersion: "1";
  name: string;
  summary: string;
  template: string;
  auth: {
    enabled: boolean;
    providers: Array<"email" | "oauth_github" | "oauth_google">;
  };
  entities: EntitySpec[];
  routes: RouteSpec[];
  features: FeatureSpec[];
  env: EnvVarSpec[];
  deploy: { target: "vercel" | "cloudflare" | "none" };
}
