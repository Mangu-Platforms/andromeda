import { createHash } from "node:crypto";

import type {
  DatasetEntry,
  DatasetStats,
  RawEpisode,
  RejectedEpisode,
  ValidationIssue,
} from "./types.ts";
import type { RoutingDecision } from "../tasks/types.ts";
import { labelEpisode, validateEpisode, type EpisodeValidationOptions, type LabelOptions } from "./validate.ts";

/**
 * The dataset itself: the only way an episode becomes training data.
 *
 * `ingest` is the whole record -> validate -> label -> store path in one call,
 * and the order is not negotiable. There is no `add(entry)` that skips
 * validation, because the failure mode this package exists to prevent is a bad
 * episode entering the corpus quietly and being discovered months later in a
 * policy that grips too hard.
 */

export interface IngestInput {
  episode: RawEpisode;
  /**
   * The routing verdict for this episode's task. `null` means the batch has no
   * verdict for it, which is a rejection rather than a default.
   */
  decision: RoutingDecision | null;
  validation: EpisodeValidationOptions;
  label?: LabelOptions;
}

export interface IngestResult {
  admitted: boolean;
  entry: DatasetEntry | null;
  issues: ValidationIssue[];
}

/** Stable encoding so the digest does not depend on key insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * Content address for a recording.
 *
 * Deliberately excludes `episodeId`: the id is a label assigned at upload time,
 * not part of what was recorded. Hashing it in would mean the same recording
 * re-submitted under a fresh id produced a different digest, which is exactly
 * the double-count this digest exists to prevent — and, since demonstrations
 * are sold per episode, the one that gets paid for twice.
 */
export function episodeDigest(episode: RawEpisode): string {
  const { episodeId: _episodeId, ...recording } = episode;
  return createHash("sha256").update(JSON.stringify(canonicalize(recording))).digest("hex");
}

export class DemonstrationDataset {
  readonly #entries = new Map<string, DatasetEntry>();
  readonly #rejected: RejectedEpisode[] = [];
  readonly #digests = new Set<string>();

  ingest(input: IngestInput): IngestResult {
    const { episode } = input;

    const reject = (issues: ValidationIssue[]): IngestResult => {
      this.#rejected.push({ episodeId: episode.episodeId, taskId: episode.taskId, issues });
      return { admitted: false, entry: null, issues };
    };

    if (this.#entries.has(episode.episodeId)) {
      return reject([
        { code: "duplicate_episode", detail: `episode ${episode.episodeId} is already in the dataset` },
      ]);
    }

    const validation = validateEpisode(episode, input.validation);
    if (!validation.ok) return reject(validation.issues);

    const decision = input.decision;
    if (!decision) {
      return reject([
        {
          code: "unknown_task",
          detail: `no routing decision for task "${episode.taskId}"; an episode cannot be labelled without one`,
        },
      ]);
    }

    // Content-addressed duplicate: the same recording re-uploaded under a new
    // episode id would otherwise be double-counted and double-paid.
    const digest = episodeDigest(episode);
    if (this.#digests.has(digest)) {
      return reject([
        { code: "duplicate_episode", detail: `an identical recording is already stored (${digest.slice(0, 12)})` },
      ]);
    }

    const entry: DatasetEntry = {
      episode,
      label: labelEpisode(episode, decision, validation, input.label),
      digest,
    };
    this.#entries.set(episode.episodeId, entry);
    this.#digests.add(digest);
    return { admitted: true, entry, issues: [] };
  }

  has(episodeId: string): boolean {
    return this.#entries.has(episodeId);
  }

  get(episodeId: string): DatasetEntry | null {
    return this.#entries.get(episodeId) ?? null;
  }

  entries(): DatasetEntry[] {
    return [...this.#entries.values()];
  }

  rejected(): RejectedEpisode[] {
    return [...this.#rejected];
  }

  stats(): DatasetStats {
    const byTask: Record<string, number> = {};
    const byContactClass: Record<string, number> = {};
    const byExecutor: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    const byOperator: Record<string, number> = {};
    let frames = 0;
    let durationMs = 0;
    let successes = 0;

    for (const { label } of this.#entries.values()) {
      byTask[label.taskId] = (byTask[label.taskId] ?? 0) + 1;
      byContactClass[label.contactClass] = (byContactClass[label.contactClass] ?? 0) + 1;
      byExecutor[label.clearedExecutor] = (byExecutor[label.clearedExecutor] ?? 0) + 1;
      byOutcome[label.outcome] = (byOutcome[label.outcome] ?? 0) + 1;
      byOperator[label.operator] = (byOperator[label.operator] ?? 0) + 1;
      frames += label.frameCount;
      durationMs += label.durationMs;
      if (label.outcome === "success") successes += 1;
    }

    const episodes = this.#entries.size;
    const submitted = episodes + this.#rejected.length;
    const rejectionsByCode: Record<string, number> = {};
    for (const rejection of this.#rejected) {
      for (const issue of rejection.issues) {
        rejectionsByCode[issue.code] = (rejectionsByCode[issue.code] ?? 0) + 1;
      }
    }

    return {
      episodes,
      frames,
      durationMs,
      successes,
      byTask,
      byContactClass,
      byExecutor,
      byOutcome,
      byOperator,
      rejected: this.#rejected.length,
      rejectionsByCode,
      admissionRate: submitted === 0 ? 0 : episodes / submitted,
    };
  }
}
