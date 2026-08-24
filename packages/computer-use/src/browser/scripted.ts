import type { BrowserDriver, PageSnapshot } from "./types.ts";

/**
 * An offline browser built from a fixed map of URL to page.
 *
 * Enough to exercise every control — including the ones that only fire on a
 * redirect — with no network and no real browser, so the injection tests run
 * in CI in milliseconds and are deterministic.
 */
export interface ScriptedPage {
  title: string;
  text: string;
  elements?: Array<{ id: string; role: string; label: string }>;
  /** Where this URL actually lands, if it redirects. */
  redirectsTo?: string;
  /** Element id -> URL that interacting with it navigates to. */
  links?: Record<string, string>;
}

export class ScriptedBrowser implements BrowserDriver {
  readonly interactions: Array<{ kind: string; elementId: string; value: string }> = [];
  readonly #pages: Record<string, ScriptedPage>;
  #url: string;

  constructor(pages: Record<string, ScriptedPage>, startUrl = "about:blank") {
    this.#pages = pages;
    this.#url = startUrl;
  }

  currentUrl(): string {
    return this.#url;
  }

  #snapshot(url: string): PageSnapshot {
    const page = this.#pages[url];
    if (!page) throw new Error(`scripted browser has no page for ${url}`);
    const landed = page.redirectsTo ?? url;
    if (landed !== url) return this.#snapshot(landed);
    this.#url = landed;
    return {
      url: landed,
      title: page.title,
      text: page.text,
      elements: page.elements ?? [],
    };
  }

  async navigate(url: string): Promise<PageSnapshot> {
    return this.#snapshot(url);
  }

  async observe(): Promise<PageSnapshot> {
    return this.#snapshot(this.#url);
  }

  async interact(kind: string, elementId: string, value: string): Promise<PageSnapshot> {
    this.interactions.push({ kind, elementId, value });
    const page = this.#pages[this.#url];
    const target = page?.links?.[elementId];
    return this.#snapshot(target ?? this.#url);
  }
}
