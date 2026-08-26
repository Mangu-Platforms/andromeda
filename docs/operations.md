# Operating Andromeda

The operator's guide: what to configure, what each control does, and what the
failure modes look like. The audience is whoever runs the console and answers
the approval queue. For architecture see [architecture.md](architecture.md);
for the product mapping see [product-01-auto-builder.md](product-01-auto-builder.md).

## The three deployment shapes

| Shape | Command | State | Who it's for |
|---|---|---|---|
| Local, single operator | `npm run console` | `./.andromeda/state` (FileStore) | trying it, single-machine use |
| Local CLI / scripting | `npm run autobuild -- …` | same FileStore — CLI and console see the same runs | CI, batch builds |
| Hosted on Vercel | deploy `apps/web` | Supabase (`SUPABASE_URL` + key) — **required**; the in-memory fallback resets per warm instance | a team sharing one review queue |

Before hosting anywhere: apply `supabase/migrations/0001_andromeda_store.sql`
to the project, set `ANDROMEDA_CONSOLE_PASSWORD`, and keep the platform's own
access protection on as a second layer.

## The control surface

Every control is server-side; nothing here can be bypassed from a browser.

- **`ANDROMEDA_CONSOLE_PASSWORD`** — HTTP Basic on every route (pages, forms,
  JSON API). Unset means open: acceptable only bound to localhost, and the
  server says so at startup. Any username works; the password decides. This is
  single-operator protection, not accounts — approval attribution still comes
  from the name typed into the decision form.
- **Cross-origin posts are always refused** (no configuration): browsers
  attach Basic credentials automatically, so a foreign page could otherwise
  submit an approval with the operator's ambient credentials.
- **`ANDROMEDA_BUDGET_USD`** (default 5) — per-run ceiling. Crossing it fails
  the run on its next completion; resuming never refreshes the budget.
- **`ANDROMEDA_GLOBAL_BUDGET_USD`** (unset = off) — ceiling on spend across
  *all* runs in a rolling 24-hour window. At the limit, new builds are refused
  outright and existing runs cannot add spend, but **approving and delivering
  an already-built run always still works** — that money is already spent.
  A nonsense value (zero, negative, not a number) refuses to start rather than
  silently meaning "no cap".
- **`ANDROMEDA_DELIVERY_REPO` + `GITHUB_TOKEN`** (unset = deliver to
  `ANDROMEDA_OUT_DIR`) — approved builds become a draft pull request in that
  repository: a new branch on top of the default branch, never a force-push.
  The token needs `contents: write` and `pull-requests: write`. If the branch
  for a project name already exists, delivery fails loudly instead of
  overwriting history — resolve by deleting or renaming the old branch.

## The approval queue, honestly

- A run that nobody decides stays suspended forever. That is the designed
  resting state, not a stuck job.
- A build whose generated tests never passed completes as
  `blocked_by_test_gate` and **never appears in the queue** — there is no
  button to approve known-broken code. Investigate from the run page, where
  the code and failing output are preserved.
- The dashboard shows who requested each run and who decided it; the run page
  shows spend by purpose and model, every file, per-feature test output, and
  the full audit trail. The risk score orders the queue; it never decides.

## Choosing a template

| Template | Deploys to | Choose when |
|---|---|---|
| `next-supabase-app` | Vercel + Supabase | a full web app with auth, database and RLS |
| `worker-api` | Cloudflare Workers | headless edge endpoints, no UI |
| `node-service` | any box with Node 22 | a self-hosted service; zero runtime dependencies |

All three share the same feature contract, migrations with row-level security
on by default, pinned dependencies, and CI. `node-service` note: its generated
server treats every request as anonymous unless fronted by a proxy that
authenticates users and stamps `x-user-id` alongside the `PROXY_AUTH_SECRET`
shared secret — never expose it directly while trusting that header.

## What to check when something looks wrong

- **"global budget exceeded" on new builds** — the rolling window is spent.
  Either wait for spend to age out, raise the ceiling deliberately, or approve
  and deliver what is already built (never blocked).
- **A delivered project's first CI run fails on `npm ci`** (`node-service`) —
  expected: run `npm install` once, commit `package-lock.json`, switch the
  workflow to `npm ci` as its comment says.
- **Console rejects a correct password** — check for a proxy stripping the
  `Authorization` header; the guard itself handles any UTF-8 password.
- **State vanished on Vercel** — the deployment is on the in-memory fallback;
  configure Supabase.
