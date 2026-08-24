import { dirname, join, normalize } from "node:path/posix";

/**
 * The repository, modelled as data.
 *
 * A `RepoSnapshot` is the *code map*: paths, exported symbols, and import
 * specifiers. It is deliberately not a git working tree — the guardian's
 * retrieval has to be reasoned about and tested offline, and a map that fits in
 * memory is what makes "load only the dependency subgraph" a checkable claim
 * rather than an aspiration.
 */
export interface RepoFile {
  /** Repo-relative POSIX path, e.g. `src/billing/invoice.ts`. */
  path: string;
  /** Exported symbol names. What an importer can actually reach. */
  exports: string[];
  /** Raw module specifiers as written in the source. */
  imports: string[];
  /** Source text, when the snapshot carries it. Drives the byte budget. */
  source: string | null;
  /** Size in bytes; derived from `source` when present. */
  bytes: number;
}

export interface DependencyManifest {
  /** Path of the manifest inside the repo. Must also appear in `files`. */
  path: string;
  /** Package name -> version string exactly as recorded in the manifest. */
  dependencies: Record<string, string>;
}

export interface RepoSnapshot {
  repo: string;
  /** Commit the snapshot was taken at. Recorded on every branch and receipt. */
  commit: string;
  files: RepoFile[];
  manifest: DependencyManifest;
}

export interface RepoFileInput {
  path: string;
  exports?: string[];
  imports?: string[];
  source?: string;
  /** Only used when `source` is absent — lets a map-only snapshot be sized. */
  bytes?: number;
}

export function repoFile(input: RepoFileInput): RepoFile {
  const source = input.source ?? null;
  return {
    path: normalize(input.path),
    exports: [...(input.exports ?? [])],
    imports: [...(input.imports ?? [])],
    source,
    bytes: source === null ? (input.bytes ?? 0) : Buffer.byteLength(source, "utf8"),
  };
}

/** Bare package name behind a specifier, or `null` for a relative import. */
export function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const first = parts[0] ?? "";
  if (first.startsWith("@")) return parts.length > 1 ? `${first}/${parts[1]}` : first;
  return first;
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", "/index.ts", "/index.js"];

/**
 * A queryable view of a snapshot: forward edges, reverse edges, and which
 * files touch which third-party package.
 *
 * The reverse-edge map is the part that matters. "What breaks if I change this
 * file" is a question about importers, and answering it from an index rather
 * than by reading the repository is the whole reason the context stays bounded.
 */
export class RepoIndex {
  readonly snapshot: RepoSnapshot;
  readonly #byPath = new Map<string, RepoFile>();
  readonly #imports = new Map<string, string[]>();
  readonly #importers = new Map<string, string[]>();
  readonly #packagesByFile = new Map<string, string[]>();
  readonly #filesByPackage = new Map<string, string[]>();
  /** Specifiers that resolved to nothing in the map, kept for diagnostics. */
  readonly dangling: Array<{ from: string; specifier: string }> = [];

  constructor(snapshot: RepoSnapshot) {
    this.snapshot = snapshot;
    for (const file of snapshot.files) {
      if (this.#byPath.has(file.path)) {
        throw new Error(`duplicate path in snapshot: ${file.path}`);
      }
      this.#byPath.set(file.path, file);
    }
    if (!this.#byPath.has(snapshot.manifest.path)) {
      // The manifest is edited by every dependency bump, so it has to be a
      // real node in the map — otherwise a bump would edit a file that the
      // scoping rules never admitted, and the "no edits outside the loaded
      // context" check would have to grow an exception.
      throw new Error(
        `manifest ${snapshot.manifest.path} is not present in the snapshot's files`,
      );
    }

    for (const file of snapshot.files) {
      const resolved: string[] = [];
      const packages: string[] = [];
      for (const specifier of file.imports) {
        const pkg = packageOf(specifier);
        if (pkg !== null) {
          if (!packages.includes(pkg)) packages.push(pkg);
          const list = this.#filesByPackage.get(pkg) ?? [];
          if (!list.includes(file.path)) list.push(file.path);
          this.#filesByPackage.set(pkg, list);
          continue;
        }
        if (specifier.startsWith("/")) continue;
        const target = this.#resolveRelative(file.path, specifier);
        if (target === null) {
          this.dangling.push({ from: file.path, specifier });
          continue;
        }
        if (!resolved.includes(target)) resolved.push(target);
        const importers = this.#importers.get(target) ?? [];
        if (!importers.includes(file.path)) importers.push(file.path);
        this.#importers.set(target, importers);
      }
      this.#imports.set(file.path, resolved);
      this.#packagesByFile.set(file.path, packages);
    }
  }

  #resolveRelative(from: string, specifier: string): string | null {
    const base = join(dirname(from), specifier);
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = normalize(`${base}${suffix}`);
      if (this.#byPath.has(candidate)) return candidate;
    }
    return null;
  }

  get fileCount(): number {
    return this.#byPath.size;
  }

  get totalBytes(): number {
    let total = 0;
    for (const file of this.#byPath.values()) total += file.bytes;
    return total;
  }

  has(path: string): boolean {
    return this.#byPath.has(normalize(path));
  }

  file(path: string): RepoFile | null {
    return this.#byPath.get(normalize(path)) ?? null;
  }

  paths(): string[] {
    return [...this.#byPath.keys()].sort();
  }

  /** Internal files that `path` imports. */
  importsOf(path: string): string[] {
    return [...(this.#imports.get(normalize(path)) ?? [])].sort();
  }

  /** Internal files that import `path`. */
  importersOf(path: string): string[] {
    return [...(this.#importers.get(normalize(path)) ?? [])].sort();
  }

  packagesUsedBy(path: string): string[] {
    return [...(this.#packagesByFile.get(normalize(path)) ?? [])].sort();
  }

  /**
   * Files that import a third-party package. An empty result is the code-map
   * evidence that an advisory against that package is not reachable from here.
   */
  filesImportingPackage(name: string): string[] {
    return [...(this.#filesByPackage.get(name) ?? [])].sort();
  }

  manifestVersion(name: string): string | null {
    return this.snapshot.manifest.dependencies[name] ?? null;
  }
}

export function buildIndex(snapshot: RepoSnapshot): RepoIndex {
  return new RepoIndex(snapshot);
}
