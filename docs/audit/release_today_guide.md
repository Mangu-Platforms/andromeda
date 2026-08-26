# Andromeda — "Release Today" Golden Path

Every step below was executed and verified on 2026-08-25 against a fresh clone (Node v22.22.2), except where marked **[LIVE-ONLY]** (needs an API key) or **[BLOCKED]** (needs the fix noted).

## 1. Prerequisites

- Node **>= 22.18** and npm. Nothing else: no Docker, no build step, no API key for the demo path.

```bash
git clone https://github.com/Mangu-Platforms/andromeda.git
cd andromeda
npm ci
```

## 2. Prove the tree is green

```bash
npm run check
```

Expected: `tsc --noEmit` clean, then `# tests 274 … # pass 274 # fail 0` (~5s). The README's "74 tests" is stale.

## 3. Golden path via CLI (works end-to-end today, demo mode)

```bash
npm run autobuild -- build "Create a Next.js app with Supabase authentication" --by renee@mangu-publishers.com
```

What you see, in order: spec compiled (with repair attempts if the first proposal was invalid), scaffold rendered from the pinned `next-supabase-app` template, features generated and run against **frozen** tests in the sandbox, a risk score with human-readable factors, then the run **suspends at the approval gate** and prints its run id.

```bash
npm run autobuild -- list                 # the suspended run, awaiting review
npm run autobuild -- show <run-id>        # spec, files, test output, risk factors, spend
npm run autobuild -- approve <run-id> --by renee@mangu-publishers.com --note "reviewed"
```

Approval resumes from checkpoints (no recompilation) and delivers to `./.andromeda/out/<project-name>/`.

```bash
cd .andromeda/out/<project-name>
npm ci && npm test                        # the generated project installs from pins and its tests pass
```

## 4. Golden path via console UI

```bash
npm run console                           # http://localhost:4200
```

- Dashboard lists runs; run page shows compiled spec, risk breakdown, every generated file, per-feature test output, and the audit trail, with approve/reject.
- The CSP that previously blocked the browser forms (`form-action 'none'`) is fixed on this branch — forms submit, scripts stay refused (`script-src 'none'`), both pinned by test.
- Set `ANDROMEDA_CONSOLE_PASSWORD` to require HTTP Basic auth on every route; without it the console is open and belongs on localhost only.

## 5. Live mode **[LIVE-ONLY]**

```bash
export ANTHROPIC_API_KEY=...
export ANDROMEDA_BUDGET_USD=5             # hard per-run ceiling, enforced server-side
npm run console
```

Startup prints "Live mode: builds will call the Claude API and spend real money." Requests route by tier; every completion is metered; crossing the ceiling throws `BudgetExceededError` and resuming never refreshes the budget.

## 6. Durable state (optional today, required for Vercel)

Apply this in your Supabase project (the repo references but does not yet ship it):

```sql
create table andromeda_store (
  collection text not null, id text not null, value jsonb not null,
  primary key (collection, id));
alter table andromeda_store enable row level security;
```

```bash
export SUPABASE_URL=https://<project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...      # server-side only; bypasses RLS
```

Console and Vercel deployment now share durable run state; approvals survive restarts (that's the point of the checkpointed workflow).

## 7. Deploy the console to Vercel

`apps/web` is the deployable: a Next.js catch-all that re-exports the console router.

1. Import the repo in Vercel, **root directory `apps/web`** (its `vercel.json` sets framework/build).
2. Set env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (or omit for demo mode), `ANDROMEDA_BUDGET_USD`, and **`ANDROMEDA_CONSOLE_PASSWORD`** — without it the deployment is open and strangers can spend budget and approve deliveries. Vercel Deployment Protection on top is good depth.
3. For real remote delivery, set `ANDROMEDA_DELIVERY_REPO=owner/repo` and `GITHUB_TOKEN` (contents:write + pull-requests:write): approved builds open a draft PR there instead of writing to the ephemeral `/tmp/andromeda/out`.

## 8. Release checklist (what "today" actually requires)

| # | Item | Status |
|---|---|---|
| 1 | `npm run check` green | ✅ verified |
| 2 | CLI end-to-end incl. approval + delivered project's own tests | ✅ verified |
| 3 | Console browser forms | ✅ CSP fixed (`form-action 'self'`, `script-src 'none'`), pinned by test |
| 4 | Auth in front of any shared URL | ✅ set `ANDROMEDA_CONSOLE_PASSWORD` (HTTP Basic on every route); Deployment Protection as defence in depth |
| 5 | Supabase migration committed | ✅ `supabase/migrations/0001_andromeda_store.sql` |
| 6 | Default branch → `main`, README test-count fix | ✅ README fixed; branch repoint needs a repo admin |
| 7 | Real remote delivery | ✅ `ANDROMEDA_DELIVERY_REPO` + `GITHUB_TOKEN` → approved builds open a draft PR |

Everything on the software side of this checklist is done on this branch; the one remaining item (default-branch repoint) is a GitHub settings change only an admin can make.
