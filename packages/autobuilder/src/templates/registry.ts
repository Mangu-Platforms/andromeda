import type { ProjectSpec } from "../spec/types.ts";
import type { GeneratedFile, TemplateDefinition } from "./types.ts";
import { assertPinned, sortFiles } from "./render.ts";
import { nextSupabaseApp } from "./next-supabase-app.ts";
import { nodeService } from "./node-service.ts";
import { workerApi } from "./worker-api.ts";

/** Repo-relative, no traversal, no absolute paths, no dotdot segments. */
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/\-[\]]+$/;

export interface RenderedScaffold {
  templateId: string;
  templateVersion: string;
  files: GeneratedFile[];
}

/**
 * The curated template library.
 *
 * Registration validates the two invariants the scaffold layer promises:
 * dependencies are pinned to exact versions, and generated paths stay inside
 * the repository. Both are checked here rather than at build time so a broken
 * template cannot reach a customer.
 */
export class TemplateRegistry {
  readonly #templates = new Map<string, TemplateDefinition>();

  constructor(templates: TemplateDefinition[] = [nextSupabaseApp, workerApi, nodeService]) {
    for (const template of templates) this.register(template);
  }

  register(template: TemplateDefinition): void {
    if (this.#templates.has(template.id)) {
      throw new Error(`template "${template.id}" is already registered`);
    }
    assertPinned(template.id, template.dependencies);
    assertPinned(template.id, template.devDependencies);
    this.#templates.set(template.id, template);
  }

  ids(): string[] {
    return [...this.#templates.keys()].sort();
  }

  list(): TemplateDefinition[] {
    return this.ids().map((id) => this.#templates.get(id) as TemplateDefinition);
  }

  get(id: string): TemplateDefinition {
    const template = this.#templates.get(id);
    if (!template) {
      throw new Error(`no template "${id}" (known: ${this.ids().join(", ") || "none"})`);
    }
    return template;
  }

  /** Render a spec into a scaffold. Pure: same spec in, same bytes out. */
  render(spec: ProjectSpec): RenderedScaffold {
    const template = this.get(spec.template);
    const files = sortFiles(template.render(spec));

    const seen = new Set<string>();
    for (const file of files) {
      if (!SAFE_PATH.test(file.path)) {
        throw new Error(`template "${template.id}" produced an unsafe path: ${file.path}`);
      }
      if (seen.has(file.path)) {
        throw new Error(`template "${template.id}" produced ${file.path} twice`);
      }
      seen.add(file.path);
    }

    return { templateId: template.id, templateVersion: template.version, files };
  }
}
