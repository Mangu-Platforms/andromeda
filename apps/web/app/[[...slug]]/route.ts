import { createConsoleApp, providerFromEnv, storeFromEnv, type ConsoleApp } from "@andromeda/console/app";
import { createRouter } from "@andromeda/console/api";
import type { Router } from "@andromeda/core";

/**
 * Vercel entry point.
 *
 * This file is deliberately almost empty: `apps/console/src/api.ts` builds
 * its routes as plain `(Request, params) => Response` handlers so that
 * moving them here means re-exporting them, not rewriting them. The optional
 * catch-all segment (`[[...slug]]`) matches every path this app serves,
 * including `/`, and hands each request straight to the same `Router` that
 * `apps/console/src/server.ts` drives over `node:http` locally.
 *
 * Run state persists to Supabase when `SUPABASE_URL` and a key are set in
 * the environment (see `packages/core/src/store/supabase.ts`); otherwise it
 * falls back to in-memory per warm serverless instance. Either way this is
 * the `stateDir ? FileStore : MemoryStore` seam from `apps/console/src/app.ts`
 * with one more option — swap to a real service via env vars, not by
 * rewriting the route.
 */

let routerPromise: Promise<Router> | undefined;

async function getRouter(): Promise<Router> {
  routerPromise ??= build();
  return routerPromise;
}

async function build(): Promise<Router> {
  const [llm, store] = await Promise.all([providerFromEnv(), storeFromEnv()]);
  const app: ConsoleApp = await createConsoleApp({
    // Vercel's serverless filesystem is read-only outside /tmp; write there
    // rather than defaulting to a relative path under the deployment bundle.
    outputDir: process.env.ANDROMEDA_OUT_DIR ?? "/tmp/andromeda/out",
    budgetUsd: Number(process.env.ANDROMEDA_BUDGET_USD ?? 5),
    ...(llm ? { llm } : {}),
    ...(store ? { store } : {}),
  });
  return createRouter(app);
}

async function handle(request: Request): Promise<Response> {
  const router = await getRouter();
  return router.handle(request);
}

export const GET = handle;
export const POST = handle;
