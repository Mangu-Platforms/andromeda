import {
  AuditLog,
  Router,
  basicAuthGuard,
  composeGuards,
  html,
  json,
  sameOriginPostGuard,
  systemClock,
} from "@andromeda/core";
import type { ApprovalRequest, RunRecord } from "@andromeda/core";
import type { ConsoleApp } from "./app.ts";
import { dashboard, errorPage, reviewPage } from "./views.ts";

/**
 * The console's HTTP surface.
 *
 * Handlers are plain `(Request, params) => Response` functions, which is the
 * signature of a Next.js App Router route handler and of a Cloudflare Workers
 * fetch handler. Moving this to Vercel or to Workers means re-exporting these
 * functions from route files, not rewriting them; `server.ts` is only a local
 * `node:http` adapter over the same router.
 *
 * With a `password` set, every route — pages, form posts and JSON API alike —
 * demands HTTP Basic auth before it runs. Without one the console is open,
 * which is only acceptable bound to localhost.
 */
export interface RouterOptions {
  /** Require HTTP Basic auth with this password on every route. */
  password?: string;
}

export function createRouter(app: ConsoleApp, options: RouterOptions = {}): Router {
  // CSRF protection is unconditional: the browser attaches Basic credentials
  // by itself, so the auth guard alone would not stop a foreign page from
  // posting an approval with the operator's ambient credentials.
  const router = new Router({
    guard: options.password
      ? composeGuards(basicAuthGuard(options.password), sameOriginPostGuard())
      : sameOriginPostGuard(),
  });

  router.get("/", async () => html(dashboard(await app.runner.list(), app.demoMode)));

  router.get("/runs/:id", async (_req, params) => {
    const view = await loadRun(app, params.id ?? "");
    if (!view) return html(errorPage(`No build ${params.id}`, 404), 404);
    return html(reviewPage(view.record, view.approval, view.events));
  });

  // Starting a build is a POST because it spends money.
  router.post("/runs", async (req) => {
    const form = await readInput(req);
    const intent = String(form.intent ?? "").trim();
    const requestedBy = String(form.requestedBy ?? "").trim();
    if (!intent || !requestedBy) {
      return respond(req, { error: "intent and requestedBy are required" }, 400);
    }

    const record = await app.runner.start(app.workflow, { intent, requestedBy });
    return respond(req, record, 201, `/runs/${record.id}`);
  });

  router.post("/runs/:id/decision", async (req, params) => {
    const runId = params.id ?? "";
    const form = await readInput(req);
    const status = String(form.status ?? "");
    const decidedBy = String(form.decidedBy ?? "").trim();
    const note = String(form.note ?? "");

    if (status !== "approved" && status !== "rejected") {
      return respond(req, { error: 'status must be "approved" or "rejected"' }, 400);
    }
    if (!decidedBy) {
      return respond(req, { error: "decidedBy is required: a decision needs a name on it" }, 400);
    }

    const record = await app.runner.get(runId);
    if (!record) return respond(req, { error: `no build ${runId}` }, 404);
    if (record.status !== "suspended") {
      return respond(req, { error: `build ${runId} is ${record.status}, not awaiting review` }, 409);
    }

    const pending = (await app.gate.listForRun(runId)).find((r) => r.status === "pending");
    if (!pending) return respond(req, { error: "no pending approval for this build" }, 409);

    const audit = await AuditLog.open(app.store, systemClock, runId);
    await app.gate.decide(pending.id, status, decidedBy, note, audit);

    // Resume only after the decision is durably recorded, so a crash between
    // the two leaves the build waiting rather than half-delivered.
    const resumed = await app.runner.resume(app.workflow, runId, { status, decidedBy, note });
    return respond(req, resumed, 200, `/runs/${runId}`);
  });

  // JSON mirrors, for scripting and for the CLI.
  router.get("/api/runs", async () => json(await app.runner.list()));
  router.get("/api/runs/:id", async (_req, params) => {
    const view = await loadRun(app, params.id ?? "");
    return view
      ? json({ run: view.record, approval: view.approval, events: view.events })
      : json({ error: `no build ${params.id}` }, 404);
  });
  router.get("/api/templates", async () =>
    json(
      app.registry.list().map((t) => ({
        id: t.id,
        version: t.version,
        description: t.description,
        dependencies: t.dependencies,
      })),
    ),
  );

  return router;
}

interface RunView {
  record: RunRecord;
  approval: ApprovalRequest | null;
  events: Awaited<ReturnType<AuditLog["events"]>>;
}

async function loadRun(app: ConsoleApp, runId: string): Promise<RunView | null> {
  const record = await app.runner.get(runId);
  if (!record) return null;
  const approvals = await app.gate.listForRun(runId);
  return {
    record,
    approval: approvals.at(-1) ?? null,
    events: await new AuditLog(app.store, systemClock, runId).events(),
  };
}

/** Accept both a browser form post and a JSON API call. */
async function readInput(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

/** Redirect a browser back to the page; answer an API client with JSON. */
function respond(req: Request, body: unknown, status: number, redirectTo?: string): Response {
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  if (redirectTo && !wantsJson) {
    return new Response(null, { status: 303, headers: { location: redirectTo } });
  }
  return json(body, status);
}
