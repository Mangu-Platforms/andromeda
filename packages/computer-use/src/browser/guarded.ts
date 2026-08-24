import { NavigationBlockedError } from "../errors.ts";
import type { DomainAllowlist } from "../policy/allowlist.ts";
import type { BrowserDriver, PageSnapshot } from "./types.ts";

/**
 * A driver wrapper that enforces the allowlist on the URL actually landed on.
 *
 * Checking the requested URL is not enough, and this is the part that is easy
 * to get wrong: a redirect, a meta refresh, or a script can move the page after
 * a perfectly allowlisted navigation, and an ordinary click on an allowlisted
 * page can land anywhere at all. So the check runs after *every* operation on
 * the landed URL, including interactions that never mentioned a URL.
 *
 * On a violation the run stops. There is no "navigate back and continue",
 * because by then the agent has already read a page it was never allowed to
 * see, and continuing would mean planning from it.
 */
export class GuardedBrowser implements BrowserDriver {
  readonly #inner: BrowserDriver;
  readonly #allowlist: DomainAllowlist;
  readonly #onBlocked: ((url: string, reason: string) => void) | undefined;

  constructor(
    inner: BrowserDriver,
    allowlist: DomainAllowlist,
    onBlocked?: (url: string, reason: string) => void,
  ) {
    this.#inner = inner;
    this.#allowlist = allowlist;
    this.#onBlocked = onBlocked;
  }

  currentUrl(): string {
    return this.#inner.currentUrl();
  }

  #assertAllowed(url: string, when: string): void {
    const verdict = this.#allowlist.check(url);
    if (!verdict.ok) {
      const reason = `${verdict.reason} (${when})`;
      this.#onBlocked?.(url, reason);
      throw new NavigationBlockedError(url, reason);
    }
  }

  #assertLanded(snapshot: PageSnapshot): PageSnapshot {
    this.#assertAllowed(snapshot.url, "landed URL");
    return snapshot;
  }

  async navigate(url: string): Promise<PageSnapshot> {
    // Checked before, so a blocked host is never fetched at all...
    this.#assertAllowed(url, "requested URL");
    // ...and after, so a redirect off the allowlist cannot be read from.
    return this.#assertLanded(await this.#inner.navigate(url));
  }

  async observe(): Promise<PageSnapshot> {
    return this.#assertLanded(await this.#inner.observe());
  }

  async interact(kind: string, elementId: string, value: string): Promise<PageSnapshot> {
    return this.#assertLanded(await this.#inner.interact(kind, elementId, value));
  }
}
