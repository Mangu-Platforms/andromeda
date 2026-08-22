/**
 * Execution boundary for experiment code.
 *
 * Adapted from `packages/autobuilder/src/sandbox` rather than imported: the two
 * products should be able to evolve their execution boundaries independently,
 * and a research experiment is a different workload from a generated test suite
 * (longer-running, repeated across seeds, and killed far more often).
 */

export interface SandboxFile {
  /** Root-relative POSIX path. Never absolute, never containing "..". */
  path: string;
  contents: string;
}

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

export interface Sandbox {
  /** Absolute path of the sandbox root. */
  readonly root: string;
  writeFiles(files: SandboxFile[]): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Run a binary directly. No shell, so nothing here is shell-interpolated. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  dispose(): Promise<void>;
}
