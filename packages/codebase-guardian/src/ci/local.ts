import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { CiReport, CiRunInput, CiRunner, CiStepResult, CiStepSpec } from "./types.ts";
import { summarize } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface LocalCiRunnerOptions {
  /** Checkout root. The proposal's edits are written here before steps run. */
  root: string;
  steps: CiStepSpec[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * Runs the configured lint/typecheck/test steps as real child processes in a
 * working directory, after applying the proposal's edits to it.
 *
 * Same honesty caveat as the auto-builder's sandbox: this confines paths, runs
 * without a shell, strips the environment, caps output and kills by process
 * group, which is enough to run a repository's own test suite. It is not a
 * security boundary against hostile code — for that, bind `CiRunner` to a
 * disposable container or the repository's own CI service.
 */
export class LocalCiRunner implements CiRunner {
  readonly name = "local";
  readonly #root: string;
  readonly #steps: CiStepSpec[];
  readonly #timeoutMs: number;
  readonly #env: Record<string, string>;

  constructor(options: LocalCiRunnerOptions) {
    this.#root = resolve(options.root);
    this.#steps = [...options.steps];
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.#root,
      TMPDIR: this.#root,
      NO_COLOR: "1",
      ...(options.env ?? {}),
    };
  }

  async run(input: CiRunInput): Promise<CiReport> {
    try {
      for (const edit of input.proposal.edits) {
        const absolute = resolve(this.#root, edit.path);
        const rel = relative(this.#root, absolute);
        if (rel.startsWith("..") || rel.startsWith(`${sep}..`) || rel === "") {
          throw new Error(`refusing to write outside the checkout: ${edit.path}`);
        }
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, edit.contents, "utf8");
      }
    } catch (err) {
      return summarize(this.name, input.branch, [], asMessage(err));
    }

    const results: CiStepResult[] = [];
    for (const step of this.#steps) {
      const result = await this.#exec(step);
      results.push(result);
      // Stop at the first red step: later steps add nothing to a report that
      // already cannot be green, and they cost real time.
      if (!result.passed) break;
    }
    return summarize(this.name, input.branch, results);
  }

  #exec(step: CiStepSpec): Promise<CiStepResult> {
    return new Promise((resolveStep) => {
      const startedAt = Date.now();
      const child = spawn(step.command, step.args, {
        cwd: this.#root,
        env: this.#env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      let bytes = 0;
      const capture = (chunk: Buffer): void => {
        if (bytes >= MAX_OUTPUT_BYTES) return;
        const text = chunk.toString("utf8");
        bytes += Buffer.byteLength(text, "utf8");
        output += text;
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Kill the group so a spawned child cannot outlive the step.
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, this.#timeoutMs);

      const finish = (exitCode: number, note?: string): void => {
        clearTimeout(timer);
        resolveStep({
          name: step.name,
          passed: !timedOut && exitCode === 0,
          exitCode,
          timedOut,
          output: (note ? `${note}\n` : "") + output.slice(0, MAX_OUTPUT_BYTES),
          durationMs: Date.now() - startedAt,
        });
      };

      child.on("error", (err) => finish(-1, `failed to spawn: ${err.message}`));
      child.on("close", (code) => finish(timedOut ? -1 : (code ?? -1)));
    });
  }
}

const asMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
