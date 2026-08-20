import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Router } from "@andromeda/core";
import { createConsoleApp, providerFromEnv } from "./app.ts";
import { createRouter } from "./api.ts";

const MAX_BODY_BYTES = 1_000_000;

/**
 * Local `node:http` adapter over the Web-standard router.
 *
 * Deliberately thin, and deliberately the only Node-specific file in the app:
 * the routes themselves are portable to Vercel or Cloudflare Workers unchanged.
 */
export function nodeAdapter(router: Router) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const request = await toWebRequest(req);
      const response = await router.handle(request);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      const body = await response.arrayBuffer();
      res.end(Buffer.from(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  };
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  let body: string | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }

  return new Request(url, { method: req.method ?? "GET", headers, body });
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4200);
  const llm = await providerFromEnv();
  const app = await createConsoleApp({
    stateDir: process.env.ANDROMEDA_STATE_DIR ?? "./.andromeda/state",
    outputDir: process.env.ANDROMEDA_OUT_DIR ?? "./.andromeda/out",
    budgetUsd: Number(process.env.ANDROMEDA_BUDGET_USD ?? 5),
    ...(llm ? { llm } : {}),
  });

  createServer(nodeAdapter(createRouter(app))).listen(port, () => {
    console.log(`Andromeda console on http://localhost:${port}`);
    console.log(
      app.demoMode
        ? "Demo mode: replaying fixtures. Set ANTHROPIC_API_KEY to run against a live model."
        : "Live mode: builds will call the Claude API and spend real money.",
    );
  });
}

// Run the server only when this file is the entry point, so tests can import
// the adapter without binding a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
