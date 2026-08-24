/**
 * The local index: what is written down, what can be found again, and what is
 * gone.
 *
 * Everything privacy-shaped about this product ends up here, because a promise
 * that is not enforced at the point of retrieval is not a promise. So:
 *
 *  - Consent is checked when an utterance is offered *and* again when a query
 *    runs. Revoking consent removes reach over what was already captured, not
 *    merely the right to capture more.
 *  - Retention is a stored per-entry deadline, applied as a filter on every
 *    search and as the criterion for `purgeExpired`. An expired entry is
 *    unreachable the moment it expires, whether or not anyone has swept yet.
 *  - Deletion is deletion. `forget` removes the entry and every derived string
 *    the index held about it, and `retainedStrings` exists so a test — or an
 *    auditor — can assert that nothing came back.
 *
 * Ranking is deliberately three cheap, explainable terms rather than one opaque
 * one: hashed-embedding cosine, literal keyword overlap, and recency. The
 * embedding is weak on its own (see `embed.ts`), the keyword term is what makes
 * an exact name or number findable, and recency is what makes "the invoice" mean
 * the one from Tuesday. Every result carries its own breakdown so a surfaced
 * memory can be explained rather than trusted.
 */

import { createHash } from "node:crypto";

import { ConsentRegistry, DAY_MS } from "./consent.ts";
import { cosine, embed, tokenize } from "./embed.ts";

/** A transcribed line, as it exists on the edge tier and nowhere else. */
export interface Utterance {
  id: string;
  sessionId: string;
  speakerId: string;
  text: string;
  at: number;
  placeId: string;
}

/**
 * An indexed memory. `dataClass` is carried so that an entry handed to the cloud
 * boundary by mistake is recognised structurally and refused — see
 * `assertCloudPayload` in `tiers.ts`.
 */
export interface MemoryEntry {
  entryId: string;
  utteranceId: string;
  sessionId: string;
  speakerId: string;
  /** Salted pseudonym. The only speaker identifier permitted past the edge. */
  speakerRef: string;
  text: string;
  at: number;
  retentionUntil: number;
  topics: string[];
  vector: number[];
  dataClass: "transcript";
}

/** The projection of an entry that may leave the edge tier. Nothing else may. */
export interface CloudMemoryRecord {
  entryId: string;
  sessionId: string;
  speakerRef: string;
  at: number;
  retentionUntil: number;
  topics: string[];
  vector: number[];
}

export interface IndexOutcome {
  indexed: boolean;
  entryId: string | null;
  reason: string;
}

export interface SearchOptions {
  now: number;
  limit?: number;
  minScore?: number;
}

export interface SearchResult {
  entryId: string;
  /** The utterance this memory came from: results are attributable, always. */
  utteranceId: string;
  sessionId: string;
  speakerId: string;
  at: number;
  text: string;
  score: number;
  semantic: number;
  keyword: number;
  recency: number;
}

export const SCORE_WEIGHTS = { semantic: 0.5, keyword: 0.3, recency: 0.2 } as const;

/** A week. Conversation memory goes stale fast; a month-old line rarely wins. */
export const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Minimum topical signal an entry needs before recency is allowed to speak.
 *
 * Recency ranks relevant memories; it must never create relevance. Without
 * this floor a fresh entry scored 0.2 against *any* query — including one
 * sharing no tokens with it — because the recency term alone reached the
 * default threshold. For a product answering "what did she say about X?",
 * confidently returning something she did not say about X is the failure that
 * ends the product, so no topical signal means no result at any age.
 *
 * The value sits above the noise floor of a 256-dimension hashed bag of words,
 * where unrelated text lands around 0.05-0.10 on cosine by collision alone.
 */
export const MIN_TOPICAL_SIGNAL = 0.15;

export const MAX_TOPICS = 8;
export const MAX_TOPIC_TOKENS = 3;
export const MAX_TOPIC_CHARS = 24;

/**
 * Topics are the one field on a cloud record that a language model gets to
 * write, so they are normalised rather than trusted: lowercased, stripped to
 * word tokens, capped at three tokens and 24 characters, deduplicated, and
 * limited to eight. A model that returns the verbatim sentence as a "topic" —
 * accidentally or because an utterance told it to — produces nothing.
 */
export function sanitizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tokens = tokenize(item);
    if (tokens.length === 0 || tokens.length > MAX_TOPIC_TOKENS) continue;
    const topic = tokens.join("-").slice(0, MAX_TOPIC_CHARS);
    if (!out.includes(topic)) out.push(topic);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/**
 * Stable pseudonym for a speaker. The salt lives with the user's own install, so
 * two users' clouds cannot be joined on it and the cloud cannot reverse it into
 * a name it was never given.
 */
export function speakerRefFor(speakerId: string, salt: string): string {
  return `spk_${createHash("sha256").update(`${salt}\u0000${speakerId}`).digest("hex").slice(0, 12)}`;
}

export function toCloudRecord(entry: MemoryEntry): CloudMemoryRecord {
  return {
    entryId: entry.entryId,
    sessionId: entry.sessionId,
    speakerRef: entry.speakerRef,
    at: entry.at,
    retentionUntil: entry.retentionUntil,
    topics: [...entry.topics],
    vector: [...entry.vector],
  };
}

interface StoredEntry extends MemoryEntry {
  tokens: string[];
}

export interface MemoryIndexOptions {
  /** Per-install salt for speaker pseudonyms. */
  salt?: string;
  limit?: number;
}

export class MemoryIndex {
  readonly #entries = new Map<string, StoredEntry>();
  /** token -> entry ids. Kept in step with `#entries`; deletion clears both. */
  readonly #postings = new Map<string, Set<string>>();
  readonly #consent: ConsentRegistry;
  readonly #salt: string;

  constructor(consent: ConsentRegistry, options: MemoryIndexOptions = {}) {
    this.#consent = consent;
    this.#salt = options.salt ?? "local-install";
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Offer an utterance to the index.
   *
   * Idempotent by utterance id, because a workflow that resumes from a
   * checkpoint may replay ingestion and must not double-count.
   */
  index(utterance: Utterance, options: { now: number; topics?: string[] }): IndexOutcome {
    const state = this.#consent.stateFor(utterance.speakerId);
    if (state !== "granted") {
      // Not "index and filter later": an utterance from someone who did not
      // agree is never written down at all.
      return {
        indexed: false,
        entryId: null,
        reason: `speaker "${utterance.speakerId}" consent state is ${state}`,
      };
    }

    const tokens = tokenize(utterance.text);
    if (tokens.length === 0) {
      return { indexed: false, entryId: null, reason: "utterance has no indexable content" };
    }

    const entryId = `mem_${utterance.id}`;
    if (this.#entries.has(entryId)) this.#remove(entryId);

    const retentionDays = this.#consent.retentionDaysFor(utterance.speakerId);
    const entry: StoredEntry = {
      entryId,
      utteranceId: utterance.id,
      sessionId: utterance.sessionId,
      speakerId: utterance.speakerId,
      speakerRef: speakerRefFor(utterance.speakerId, this.#salt),
      text: utterance.text,
      at: utterance.at,
      retentionUntil: utterance.at + retentionDays * DAY_MS,
      topics: sanitizeTopics(options.topics ?? []),
      vector: embed(utterance.text),
      dataClass: "transcript",
      tokens,
    };
    this.#entries.set(entryId, entry);
    for (const token of new Set(tokens)) {
      let bucket = this.#postings.get(token);
      if (!bucket) {
        bucket = new Set();
        this.#postings.set(token, bucket);
      }
      bucket.add(entryId);
    }
    return { indexed: true, entryId, reason: "indexed" };
  }

  /** An entry is live if it has not expired and its speaker still consents. */
  #isLive(entry: StoredEntry, now: number): boolean {
    if (entry.retentionUntil <= now) return false;
    return this.#consent.isGranted(entry.speakerId);
  }

  get(entryId: string, now: number): MemoryEntry | null {
    const entry = this.#entries.get(entryId);
    if (!entry || !this.#isLive(entry, now)) return null;
    const { tokens: _tokens, ...rest } = entry;
    return { ...rest, topics: [...rest.topics], vector: [...rest.vector] };
  }

  search(query: string, options: SearchOptions): SearchResult[] {
    const queryTokens = tokenize(query);
    const queryVector = embed(query);
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;

    // Keyword hits come from the inverted index; the semantic term needs the
    // whole live set, which is cheap at the scale one person's memory reaches.
    const hits = new Map<string, number>();
    for (const token of new Set(queryTokens)) {
      for (const entryId of this.#postings.get(token) ?? []) {
        hits.set(entryId, (hits.get(entryId) ?? 0) + 1);
      }
    }

    const results: SearchResult[] = [];
    for (const entry of this.#entries.values()) {
      if (!this.#isLive(entry, options.now)) continue;
      const semantic = Math.max(0, cosine(queryVector, entry.vector));
      const keyword =
        queryTokens.length === 0 ? 0 : (hits.get(entry.entryId) ?? 0) / new Set(queryTokens).size;
      // Checked before recency is computed: an entry nobody asked about is not
      // a result, however recent it is.
      if (Math.max(semantic, keyword) < MIN_TOPICAL_SIGNAL) continue;

      const ageDays = Math.max(0, options.now - entry.at) / DAY_MS;
      const recency = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
      const score =
        SCORE_WEIGHTS.semantic * semantic +
        SCORE_WEIGHTS.keyword * keyword +
        SCORE_WEIGHTS.recency * recency;
      if (score < minScore) continue;
      results.push({
        entryId: entry.entryId,
        utteranceId: entry.utteranceId,
        sessionId: entry.sessionId,
        speakerId: entry.speakerId,
        at: entry.at,
        text: entry.text,
        score,
        semantic,
        keyword,
        recency,
      });
    }

    // Ties break on entry id so ordering is stable across processes.
    results.sort((a, b) => (b.score - a.score) || (a.entryId < b.entryId ? -1 : 1));
    return results.slice(0, limit);
  }

  /** Every live entry, projected to the fields allowed past the edge tier. */
  cloudRecords(now: number): CloudMemoryRecord[] {
    const out: CloudMemoryRecord[] = [];
    for (const entry of this.#entries.values()) {
      if (this.#isLive(entry, now)) out.push(toCloudRecord(entry));
    }
    return out.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  }

  /**
   * Drop everything past its retention deadline or belonging to a speaker who
   * has since revoked. Both classes are already unreachable via `search`; this
   * is what reclaims the bytes.
   */
  purgeExpired(now: number): string[] {
    const removed: string[] = [];
    for (const [entryId, entry] of [...this.#entries]) {
      if (this.#isLive(entry, now)) continue;
      this.#remove(entryId);
      removed.push(entryId);
    }
    return removed.sort();
  }

  /** Hard delete. Returns whether there was anything to delete. */
  forget(entryId: string): boolean {
    return this.#remove(entryId);
  }

  /** Hard delete everything ever indexed from one speaker. */
  forgetSpeaker(speakerId: string): string[] {
    const removed: string[] = [];
    for (const [entryId, entry] of [...this.#entries]) {
      if (entry.speakerId !== speakerId) continue;
      this.#remove(entryId);
      removed.push(entryId);
    }
    return removed.sort();
  }

  /**
   * Every string this index still holds, derived or verbatim.
   *
   * The point of a delete is that nothing comes back, and the only honest way to
   * check that is to look at all of it. Kept small and exact rather than
   * pretty — it is an assertion surface, not a UI.
   */
  retainedStrings(): string[] {
    const out = new Set<string>();
    for (const entry of this.#entries.values()) {
      out.add(entry.entryId);
      out.add(entry.utteranceId);
      out.add(entry.sessionId);
      out.add(entry.speakerId);
      out.add(entry.speakerRef);
      out.add(entry.text);
      for (const topic of entry.topics) out.add(topic);
      for (const token of entry.tokens) out.add(token);
    }
    for (const [token, bucket] of this.#postings) {
      if (bucket.size === 0) continue;
      out.add(token);
      for (const entryId of bucket) out.add(entryId);
    }
    return [...out].sort();
  }

  #remove(entryId: string): boolean {
    const entry = this.#entries.get(entryId);
    if (!entry) return false;
    this.#entries.delete(entryId);
    for (const token of new Set(entry.tokens)) {
      const bucket = this.#postings.get(token);
      if (!bucket) continue;
      bucket.delete(entryId);
      if (bucket.size === 0) this.#postings.delete(token);
    }
    return true;
  }
}
