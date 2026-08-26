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

export class Router {
  readonly #routes: Route[] = [];

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
