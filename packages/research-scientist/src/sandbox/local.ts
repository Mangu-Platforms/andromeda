import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExecOptions, ExecResult, Sandbox, SandboxFile } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Truncation point for captured output, so a runaway loop cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface LocalSandboxOptions {
  /** Wall-clock ceiling applied when a call does not specify one. */
  defaultTimeoutMs?: number;
  /**
   * Extra environment variables. The child otherwise gets only PATH and a
   * HOME pointing inside the sandbox — API keys and cloud credentials in the
   * parent process must not be reachable from experiment code.
   */
  env?: Record<string, string>;
}

/**
 * Filesystem-and-child-process sandbox, adapted from the auto-builder's.
 *
 * The containment is real but modest, and worth stating plainly: paths are
 * confined to the sandbox root, commands run without a shell so nothing is
 * interpolated, the environment is stripped to a minimum, output is capped, and
 * every process has a hard timeout and is killed by process group so a spawned
 * child cannot outlive it. That last property is what makes the experiment
 * runner's iteration budget meaningful — a trial that never returns is killed
 * rather than waited on.
 *
 * What it is not: a security boundary against hostile code. A determined
 * program running here can still reach the network and read world-readable
 * files. Bind `Sandbox` to a disposable container before running experiment
 * code on behalf of anyone but yourself.
 */
export class LocalSandbox implements Sandbox {
  readonly root: string;
  readonly #defaultTimeoutMs: number;
  readonly #env: Record<string, string>;

  private constructor(root: string, options: LocalSandboxOptions) {
    this.root = root;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      NO_COLOR: "1",
      ...options.env,
    };
  }

  static async create(options: LocalSandboxOptions = {}): Promise<LocalSandbox> {
    const root = await mkdtemp(join(tmpdir(), "andromeda-experiment-"));
    return new LocalSandbox(root, options);
  }

  /** Resolve a root-relative path, refusing anything that escapes the root. */
  #resolve(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(`${sep}..`)) {
      throw new Error(`path "${path}" escapes the sandbox root`);
    }
    return absolute;
  }

  async writeFiles(files: SandboxFile[]): Promise<void> {
    for (const file of files) {
      const absolute = this.#resolve(file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.contents, "utf8");
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.#resolve(path), "utf8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.#resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const cwd = options.cwd ? this.#resolve(options.cwd) : this.root;
    const started = Date.now();

    return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd,
        env: this.#env,
        // No shell: arguments are passed as a vector, so nothing in an
        // experiment id or a seed can be interpreted as a command.
        shell: false,
        // Own process group, so the timeout kill reaches grandchildren too.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const collect = (into: "stdout" | "stderr") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (into === "stdout") {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text;
        }
      };
      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Negative pid targets the whole process group.
          process.kill(-(child.pid as number), "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({
          code,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          timedOut,
          durationMs: Date.now() - started,
        });
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    });
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

const truncate = (text: string): string =>
  text.length <= MAX_OUTPUT_BYTES
    ? text
    : `${text.slice(0, MAX_OUTPUT_BYTES)}\n... output truncated at ${MAX_OUTPUT_BYTES} bytes ...`;
