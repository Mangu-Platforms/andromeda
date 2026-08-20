import type { ProjectSpec } from "../spec/types.ts";

export interface GeneratedFile {
  /** Repo-relative POSIX path. Never absolute, never containing "..". */
  path: string;
  contents: string;
}

/**
 * A version-pinned scaffold.
 *
 * Templates are the deterministic half of the auto-builder. Auth wiring,
 * migrations, row-level security, config and CI all come from here — hand-
 * written code, reviewed once, rendered identically every time — so the
 * language model is never in a position to improvise the parts that are
 * security-relevant or that everyone gets wrong. `render` must be a pure
 * function of the spec: no clock, no randomness, no network.
 */
export interface TemplateDefinition {
  id: string;
  /** Bump when rendered output changes; recorded in every build's provenance. */
  version: string;
  description: string;
  /** Exact versions, never ranges — see `assertPinned`. */
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  render(spec: ProjectSpec): GeneratedFile[];
}
