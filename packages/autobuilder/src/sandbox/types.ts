import type { GeneratedFile } from "../templates/types.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Milliseconds of wall time. */
  durationMs: number;
}

export interface ExecOptions {
  /** Hard wall-clock limit. The process is killed, not asked politely. */
  timeoutMs?: number;
  /** Working directory relative to the sandbox root. */
  cwd?: string;
}

/**
 * A place to write generated files and run commands against them.
 *
 * The interface exists so the execution boundary is a swappable component:
 * `LocalSandbox` is a temp directory and a child process, which is enough to
 * run a test suite in development and in CI. A production deployment should
 * bind this to a disposable container — an OpenHands runtime, a Fly machine, a
 * Cloudflare container — because that is the only place model-authored code
 * can run with a real security boundary around it.
 */
export interface Sandbox {
  /** Absolute path of the sandbox root. */
  readonly root: string;
  writeFiles(files: GeneratedFile[]): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Run a binary directly. No shell, so nothing here is shell-interpolated. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  dispose(): Promise<void>;
}
