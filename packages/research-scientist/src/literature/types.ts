/**
 * The literature-search boundary.
 *
 * Everything in a finished review has to trace back through this interface. A
 * `LiteratureSource` is the only thing in the package allowed to introduce a
 * paper; the model is never a source of bibliographic facts, only of prose
 * about papers a source already returned.
 */

export interface Paper {
  /** Stable id within the source, e.g. an OpenAlex work id or S2 corpus id. */
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  /** Canonical DOI without a resolver prefix, or "" when the source has none. */
  doi: string;
  url: string;
  /**
   * The abstract as the source returned it. This is the text a quoted claim is
   * checked against, so it is stored verbatim and never rewritten by a model.
   */
  abstract: string;
}

export interface SearchQuery {
  /** Free-text query terms. */
  terms: string;
  /** Maximum papers to return. Bounded by the source. */
  limit?: number;
  /** Ignore papers published before this year. */
  yearFrom?: number;
}

export interface LiteratureSource {
  /** Recorded on every ledger entry so provenance survives a source swap. */
  readonly id: string;
  search(query: SearchQuery): Promise<Paper[]>;
}
