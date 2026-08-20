/**
 * All non-determinism in the substrate flows through these two interfaces.
 *
 * Agent pipelines are replayed from checkpoints and are asserted to be
 * byte-reproducible in tests, so nothing may call `Date.now()` or `Math.random()`
 * directly. Inject a `FixedClock` / `SeededIds` in tests and the system clock in
 * production.
 */
export interface Clock {
  now(): number;
}

export interface Ids {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => Date.now() };

export const randomIds: Ids = {
  next: (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
};

export class FixedClock implements Clock {
  #t: number;
  readonly #stepMs: number;

  constructor(startMs = 1_700_000_000_000, stepMs = 1_000) {
    this.#t = startMs;
    this.#stepMs = stepMs;
  }

  now(): number {
    const value = this.#t;
    this.#t += this.#stepMs;
    return value;
  }
}

export class SeededIds implements Ids {
  readonly #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, "0")}`;
  }
}
