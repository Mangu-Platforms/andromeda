/**
 * The operator's pre-committed answer to "where may this agent go?".
 *
 * A computer-use agent reads attacker-controlled text on every page, so the
 * question is not whether it can be talked into navigating somewhere: it can.
 * The allowlist is what makes that harmless. It is a hostname allowlist rather
 * than a URL one because paths are cheap to disguise and hosts are not, and it
 * is checked on the *landed* URL after every single action, not just on the URL
 * the planner asked for — see `GuardedBrowser`.
 *
 * Everything here is decided by `new URL(...)`, the same parser the browser
 * uses, so the agent and the guard can never disagree about what a string
 * means. Anything the parser cannot understand is refused.
 */

export type UrlVerdict =
  | { ok: true; url: URL; host: string }
  | { ok: false; reason: string };

/** Hosts are names; a literal address is never a match for one. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Labels a valid registrable hostname can be built from. */
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isIpLiteral(host: string): boolean {
  // WHATWG URL wraps IPv6 in brackets and canonicalises IPv4, including the
  // decimal and octal forms (`http://2130706433/`), so both collapse to one of
  // these two shapes by the time we see them.
  return host.startsWith("[") || IPV4.test(host);
}

/**
 * Validate one allowlist entry.
 *
 * Entries are plain hostnames. A malformed entry throws at construction rather
 * than silently never matching, because an allowlist that matches nothing looks
 * exactly like an allowlist that is working.
 */
function normalizeEntry(raw: string): string {
  const entry = raw.trim().toLowerCase();
  if (entry === "") throw new Error("allowlist entry is empty");
  if (entry.includes("/") || entry.includes(":") || entry.includes("*")) {
    throw new Error(
      `allowlist entry "${raw}" must be a bare hostname (no scheme, port, path or wildcard)`,
    );
  }
  if (isIpLiteral(entry)) {
    throw new Error(`allowlist entry "${raw}" is an IP literal; allowlist names, not addresses`);
  }
  const labels = entry.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new Error(`allowlist entry "${raw}" is not a valid hostname`);
  }
  if (labels.some((label) => label.startsWith("xn--"))) {
    // Allowing a punycode entry would mean an operator approved a host they
    // could not read. Register the unicode form and let the URL parser encode
    // it, or do not allowlist it at all.
    throw new Error(`allowlist entry "${raw}" is punycode; use the unicode hostname`);
  }
  return entry;
}

export interface AllowlistOptions {
  /**
   * When true a matching entry also covers its subdomains. Left off by default
   * because `*.example.com` is a much larger surface than operators picture,
   * and a hijacked subdomain is a normal way to lose an allowlist.
   */
  includeSubdomains?: boolean;
}

export class DomainAllowlist {
  readonly hosts: readonly string[];
  readonly #includeSubdomains: boolean;

  constructor(hosts: readonly string[], options: AllowlistOptions = {}) {
    if (hosts.length === 0) throw new Error("an empty allowlist would block every navigation");
    this.hosts = hosts.map(normalizeEntry);
    this.#includeSubdomains = options.includeSubdomains ?? false;
  }

  /**
   * Decide a URL string. Every branch that is not a positive match returns a
   * refusal, including the parse failure itself, so an input this function does
   * not understand is an input the agent does not get to visit.
   */
  check(raw: unknown): UrlVerdict {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: false, reason: "not a non-empty string" };
    }

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "unparseable as an absolute URL" };
    }

    // `javascript:`, `data:`, `blob:`, `file:` and friends never reach a host
    // check at all, because they have no meaningful host to check.
    if (url.protocol !== "https:") {
      return { ok: false, reason: `scheme "${url.protocol}" is not https:` };
    }

    // `https://example.com@evil.com/` — the host is evil.com and the parser
    // already knows it, but embedded credentials are refused outright so the
    // audit log never contains a URL a human would misread.
    if (url.username !== "" || url.password !== "") {
      return { ok: false, reason: "URL carries embedded credentials" };
    }

    if (url.port !== "") {
      return { ok: false, reason: `non-default port "${url.port}"` };
    }

    // Already lowercased and IDNA-encoded by the parser, so case tricks and
    // unicode lookalikes are normalised before we compare anything.
    const host = url.hostname;

    if (isIpLiteral(host)) {
      return { ok: false, reason: "host is an IP literal" };
    }
    if (host.endsWith(".")) {
      return { ok: false, reason: "host has a trailing dot" };
    }
    if (host.split(".").some((label) => label.startsWith("xn--"))) {
      // A unicode lookalike lands here: `exаmple.com` with a Cyrillic а becomes
      // `xn--exmple-4nf.com`, which is not the allowlisted string and is also
      // not something an operator can have meant to allow.
      return { ok: false, reason: `host "${host}" is punycode` };
    }

    for (const entry of this.hosts) {
      if (host === entry) return { ok: true, url, host };
      // Suffix matching is done label-wise. Plain `endsWith` would accept
      // `notexample.com` for `example.com`, and substring matching would accept
      // `evil-example.com.attacker.net`.
      if (this.#includeSubdomains && host.endsWith(`.${entry}`)) {
        return { ok: true, url, host };
      }
    }

    return { ok: false, reason: `host "${host}" is not on the allowlist` };
  }

  allows(raw: unknown): boolean {
    return this.check(raw).ok;
  }
}
