/**
 * A router over the Web Fetch API's `Request`/`Response`.
 *
 * Handlers have the exact signature of a Next.js App Router route handler and
 * of a Cloudflare Workers fetch handler, so the console's API moves to Vercel
 * or to Workers by re-exporting these functions — no rewrite, no framework
 * lock-in, and it still runs under a 40-line `node:http` adapter locally.
 */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface Route {
  method: Method;
  segments: string[];
  handler: RouteHandler;
}

export interface RouterOptions {
  /**
   * Runs before any route. Returning a `Response` short-circuits the request
   * — the seam an authentication check plugs into (see `basicAuthGuard`) —
   * and returning `null` lets routing proceed.
   */
  guard?: (req: Request) => Response | null;
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #guard: RouterOptions["guard"];

  constructor(options: RouterOptions = {}) {
    this.#guard = options.guard;
  }

  #add(method: Method, path: string, handler: RouteHandler): this {
    this.#routes.push({ method, segments: split(path), handler });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.#add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.#add("POST", path, handler);
  }

  async handle(req: Request): Promise<Response> {
    const denied = this.#guard?.(req);
    if (denied) return denied;
    const segments = split(new URL(req.url).pathname);
    let pathMatched = false;

    for (const route of this.#routes) {
      const params = match(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      try {
        return await route.handler(req, params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 500);
      }
    }
    return pathMatched
      ? json({ error: "method not allowed" }, 405)
      : json({ error: "not found" }, 404);
  }
}

const split = (path: string): string[] => path.split("/").filter(Boolean);

function match(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const a = actual[i] as string;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(a);
    else if (p !== a) return null;
  }
  return params;
}

/**
 * HTTP Basic auth as a router guard.
 *
 * Basic rather than a bearer token because the console is plain HTML forms:
 * a browser can supply Basic credentials natively on every request — form
 * posts included — with no script, which keeps the CSP's `script-src 'none'`
 * intact. The username is ignored; only the password is compared, in
 * constant time over bytes so a mismatch reveals nothing about where it
 * mismatched. Web-standard only (`atob`, `TextEncoder`), so it runs
 * unchanged under node:http, Vercel and Workers.
 *
 * This protects a single-operator console. It is not accounts: everyone who
 * has the password is the same principal, and approval attribution still
 * comes from the name typed into the decision form.
 */
export function basicAuthGuard(password: string, realm = "andromeda"): RouterOptions["guard"] {
  if (!password) throw new Error("basicAuthGuard requires a non-empty password");
  const expected = new TextEncoder().encode(password);

  return (req: Request): Response | null => {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      let decoded = "";
      try {
        decoded = atob(header.slice("Basic ".length).trim());
      } catch {
        decoded = "";
      }
      // Credentials are `user:password`; the password may itself contain ':'.
      // Compare the raw decoded bytes: `atob` yields a Latin-1 view of the
      // client's UTF-8 bytes, and re-encoding that view through TextEncoder
      // would double-encode anything non-ASCII, locking out every correct
      // password that isn't plain ASCII.
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
        if (timingSafeEqual(bytes.subarray(colon + 1), expected)) return null;
      }
    }
    return new Response("authentication required\n", {
      status: 401,
      headers: {
        "www-authenticate": `Basic realm="${realm}", charset="UTF-8"`,
        "content-type": "text/plain; charset=utf-8",
      },
    });
  };
}

/**
 * Refuses state-changing requests that a browser attributes to another origin.
 *
 * Basic credentials are attached by the browser automatically, so without
 * this a page on any site could submit the console's approve form on behalf
 * of a logged-in operator (CSRF). Browsers send `Origin` (and increasingly
 * `Sec-Fetch-Site`) on such requests; when either says cross-origin the
 * request is refused. Non-browser clients send neither header and pass —
 * this guards the ambient-credential path, not the deliberate API call.
 */
export function sameOriginPostGuard(): RouterOptions["guard"] {
  const forbidden = (): Response =>
    new Response("cross-origin request refused\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  return (req: Request): Response | null => {
    if (req.method === "GET" || req.method === "HEAD") return null;

    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return forbidden();

    const origin = req.headers.get("origin");
    if (origin) {
      // "null" is what sandboxed and opaque contexts send; treat as foreign.
      if (origin === "null") return forbidden();
      try {
        if (new URL(origin).origin !== new URL(req.url).origin) return forbidden();
      } catch {
        return forbidden();
      }
    }
    return null;
  };
}

/** Run guards in order; the first refusal wins. */
export function composeGuards(
  ...guards: Array<RouterOptions["guard"]>
): RouterOptions["guard"] {
  return (req: Request): Response | null => {
    for (const guard of guards) {
      const denied = guard?.(req);
      if (denied) return denied;
    }
    return null;
  };
}

/** Byte comparison whose duration depends only on the supplied length. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i % b.length] ?? 0);
  }
  return diff === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The console renders agent-authored diffs and model text. A restrictive
      // CSP keeps a prompt-injected <script> in generated code inert: scripts
      // are refused outright, and forms may only post back to the console
      // itself — 'none' here would block the console's own approve/reject
      // forms, which no router-level test can observe.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
    },
  });
}
