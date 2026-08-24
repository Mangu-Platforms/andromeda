import type { Clock } from "@andromeda/core";
import { systemClock } from "@andromeda/core";
import type { LiteratureSource, Paper, SearchQuery } from "./types.ts";

/**
 * One paper, as returned by a real search, with the key the model is allowed
 * to cite it by.
 */
export interface LedgerEntry {
  key: string;
  /** Which `LiteratureSource` produced it. */
  sourceId: string;
  paper: Paper;
  /** Ids of every search in this run that returned the paper. */
  seenIn: string[];
  firstSeenAt: number;
}

export interface SearchRecord {
  id: string;
  sourceId: string;
  query: SearchQuery;
  at: number;
  /** Citation keys returned, in the order the source returned them. */
  keys: string[];
}

export interface CitationLedgerSnapshot {
  entries: LedgerEntry[];
  searches: SearchRecord[];
}

/**
 * The record of every paper this run has actually seen.
 *
 * This is the structural half of the citation control. A bibliography is not
 * something the model writes — it is derived from these entries — and a claim
 * may only cite a key that a completed `runSearch` put here. A model that
 * invents a plausible paper produces a key that does not resolve, and a model
 * that attaches a real-looking DOI to a real key produces a mismatch. Neither
 * needs the verifier to know anything about the literature; both fail on
 * provenance alone.
 *
 * The ledger is plain data (`snapshot` / `fromSnapshot`) so it survives a
 * workflow checkpoint. A run that suspends for a human and resumes days later
 * verifies against exactly the papers it originally retrieved, not against
 * whatever the index returns today.
 */
export class CitationLedger {
  readonly #clock: Clock;
  readonly #entries = new Map<string, LedgerEntry>();
  readonly #searches: SearchRecord[] = [];
  /** `${sourceId}:${paperId}` -> key, so a repeated hit reuses its key. */
  readonly #byIdentity = new Map<string, string>();

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  static fromSnapshot(snapshot: CitationLedgerSnapshot, clock: Clock = systemClock): CitationLedger {
    const ledger = new CitationLedger(clock);
    for (const entry of snapshot.entries) {
      ledger.#entries.set(entry.key, structuredClone(entry));
      ledger.#byIdentity.set(identity(entry.sourceId, entry.paper.id), entry.key);
    }
    for (const search of snapshot.searches) ledger.#searches.push(structuredClone(search));
    return ledger;
  }

  /**
   * Perform a search and record everything it returned.
   *
   * This is the only way a paper enters the ledger. Nothing else in the
   * package has a method that adds an entry from model output.
   */
  async runSearch(source: LiteratureSource, query: SearchQuery): Promise<SearchRecord> {
    const papers = await source.search(query);
    const at = this.#clock.now();
    const id = `search-${String(this.#searches.length + 1).padStart(3, "0")}`;
    const keys: string[] = [];

    for (const paper of papers) {
      keys.push(this.#admit(source.id, paper, id, at));
    }

    const record: SearchRecord = {
      id,
      sourceId: source.id,
      query: { ...query },
      at,
      keys,
    };
    this.#searches.push(record);
    return record;
  }

  #admit(sourceId: string, paper: Paper, searchId: string, at: number): string {
    const existingKey = this.#byIdentity.get(identity(sourceId, paper.id));
    if (existingKey !== undefined) {
      const entry = this.#entries.get(existingKey);
      if (entry && !entry.seenIn.includes(searchId)) entry.seenIn.push(searchId);
      return existingKey;
    }

    const key = this.#uniqueKey(citationKey(paper));
    this.#entries.set(key, {
      key,
      sourceId,
      paper: structuredClone(paper),
      seenIn: [searchId],
      firstSeenAt: at,
    });
    this.#byIdentity.set(identity(sourceId, paper.id), key);
    return key;
  }

  /** Two different papers must never share a key, or a citation is ambiguous. */
  #uniqueKey(base: string): string {
    if (!this.#entries.has(base)) return base;
    for (let i = 0; i < 26; i++) {
      const candidate = `${base}${String.fromCharCode(97 + i)}`;
      if (!this.#entries.has(candidate)) return candidate;
    }
    let n = 2;
    while (this.#entries.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  resolve(key: string): LedgerEntry | undefined {
    const entry = this.#entries.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()].sort();
  }

  entries(): LedgerEntry[] {
    return this.keys().map((key) => structuredClone(this.#entries.get(key) as LedgerEntry));
  }

  searches(): SearchRecord[] {
    return this.#searches.map((s) => structuredClone(s));
  }

  /** Completed search calls. Zero means nothing in this run may be cited. */
  get searchCount(): number {
    return this.#searches.length;
  }

  get size(): number {
    return this.#entries.size;
  }

  snapshot(): CitationLedgerSnapshot {
    return { entries: this.entries(), searches: this.searches() };
  }

  /** Everything a drafting model is allowed to know about the literature. */
  briefing(): string {
    if (this.#entries.size === 0) return "(no papers retrieved)";
    return this.entries()
      .map(
        (e) =>
          `[${e.key}] ${e.paper.authors.join("; ")} (${e.paper.year}). ${e.paper.title}. ` +
          `${e.paper.venue}. doi:${e.paper.doi || "none"}\n  ABSTRACT: ${e.paper.abstract}`,
      )
      .join("\n\n");
  }
}

/** Thrown when a step that requires grounding runs before any search completed. */
export class UngroundedError extends Error {
  constructor(what: string) {
    super(
      `${what} requires at least one completed literature search in this run; ` +
        "the citation ledger is empty",
    );
    this.name = "UngroundedError";
  }
}

/**
 * A hypothesis is a claim about the literature, so it cannot be finalized
 * before the run has actually looked at any. Called before the model is even
 * asked, so an ungrounded run costs nothing.
 */
export function assertGrounded(ledger: CitationLedger, what: string): void {
  if (ledger.searchCount === 0) throw new UngroundedError(what);
}

const identity = (sourceId: string, paperId: string): string => `${sourceId}:${paperId}`;

/** `okonkwo2019sleep`-style key: readable in a draft, unique within the run. */
export function citationKey(paper: Paper): string {
  // "Bergström, H." -> "bergstrom": the part before the comma is the surname.
  const surname = asciiWord((paper.authors[0] ?? "anon").split(",")[0] ?? "anon");
  const word = paper.title
    .split(/[^A-Za-z0-9]+/)
    .map((w) => asciiWord(w))
    .find((w) => w.length > 3 && !KEY_STOPWORDS.has(w));
  return `${surname || "anon"}${paper.year}${word ?? "untitled"}`;
}

const KEY_STOPWORDS = new Set(["the", "and", "with", "from", "into", "does", "study", "using"]);

const asciiWord = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase();
