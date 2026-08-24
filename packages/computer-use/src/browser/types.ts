/**
 * The browser, behind an interface.
 *
 * Everything the agent learns about the world arrives through `PageSnapshot`,
 * and everything in a snapshot is attacker-controlled: the title, the text, the
 * labels on the elements. Naming that explicitly is the point of this file —
 * the type that carries untrusted bytes is separate from every type the planner
 * is allowed to see, so "did this string come from a page?" is answerable by
 * looking at its type rather than by tracing where it came from.
 */

/** One interactive element the page offered. */
export interface PageElement {
  /** Handle the driver assigns. The agent may only address elements by these. */
  id: string;
  /** "button", "link", "textbox", … — the accessibility role. */
  role: string;
  /** UNTRUSTED. The visible label, written by the page. */
  label: string;
}

/**
 * A page as observed. Every field is untrusted input.
 *
 * There is deliberately no method here that turns a snapshot into anything the
 * planner consumes; that conversion only happens through the quarantined
 * reader, which cannot emit actions.
 */
export interface PageSnapshot {
  url: string;
  /** UNTRUSTED. */
  title: string;
  /** UNTRUSTED. The rendered text of the page, as a model would read it. */
  text: string;
  /** UNTRUSTED labels, trusted ids. */
  elements: readonly PageElement[];
}

export interface BrowserDriver {
  /** Current landed URL, which may differ from the one that was requested. */
  currentUrl(): string;
  navigate(url: string): Promise<PageSnapshot>;
  /** Re-read the current page without acting on it. */
  observe(): Promise<PageSnapshot>;
  /**
   * Perform an interaction. `elementId` must be a handle from the current
   * snapshot; drivers reject anything else rather than guessing.
   */
  interact(kind: string, elementId: string, value: string): Promise<PageSnapshot>;
}
