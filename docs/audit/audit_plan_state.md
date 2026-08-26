# Andromeda — Audit & Release Plan State

Date: 2026-08-25 · Auditor: automated audit run for renee@mangu-publishers.com
Repository: `Mangu-Platforms/andromeda` · Verified against a fresh checkout, `npm ci && npm run check` = **PASS (typecheck clean, 274/274 tests green)** on Node v22.22.2 (engine requirement `>=22.18.0` satisfied).

---

## 0. Root map & initial findings

- **Default branch:** `git remote show origin` reports `HEAD branch: claude/10-ai-agent-products-p42qb1`. This is a mis-set remote HEAD — `main` exists, is where PRs #2/#3 merged, and is clearly the intended default. **Action: repoint the GitHub default branch to `main`.**
- Branches: `main`, `claude/andromeda-audit-release-0749eq` (this audit).
- Root files: `package.json` (npm workspaces), `tsconfig.json` (strict, NodeNext, type-stripping — **no build step**), `README.md`, `.github/workflows/ci.yml`, `docs/`, `.gitignore`. **No `vercel.json` at root** (one lives in `apps/web/`). **No `supabase/` folder** — notable because `packages/core/src/store/supabase.ts:10` says "See `supabase/migrations/` for the schema this expects" and that directory does not exist. `[GAP]`
- **No `.env.example` anywhere** in the repo. `[GAP]`

### Workspaces (from root `package.json`: `packages/*`, `apps/*`)

| Workspace | Path | Type | Main entry | package.json | Tests |
|---|---|---|---|---|---|
| core | `packages/core` | library (substrate) | `src/index.ts` | yes | yes |
| autobuilder | `packages/autobuilder` | library (product #1) | `src/index.ts` | yes | yes |
| api-translator | `packages/api-translator` | library (product #8) | `src/index.ts` | yes | yes |
| codebase-guardian | `packages/codebase-guardian` | library (product #2) | `src/index.ts` | yes | yes |
| computer-use | `packages/computer-use` | library | `src/index.ts` | yes | yes |
| life-os | `packages/life-os` | library | `src/index.ts` | yes | yes |
| memory-layer | `packages/memory-layer` | library (no core dep) | `src/index.ts` | yes | yes |
| negotiator | `packages/negotiator` | library | `src/index.ts` | yes | yes |
| research-scientist | `packages/research-scientist` | library | `src/index.ts` | yes | yes |
| robotics-data | `packages/robotics-data` | library | `src/index.ts` | yes | yes |
| traffic-twin | `packages/traffic-twin` | library | `src/index.ts` | yes | yes |
| console | `apps/console` | **plain `node:http` app + CLI** (not Next.js) | `src/server.ts` | yes | yes |
| web | `apps/web` | Next.js 16.3.1 shell for Vercel | `app/[[...slug]]/route.ts` | yes | via console |

Correction to the audit brief: the brief assumed 2 packages and 2 Next.js apps. Reality: **11 packages** (substrate + 10 products, all with real code, READMEs and tests), one plain-Node console, and one Next.js catch-all wrapper that re-exports the console's router for Vercel.

---

## 1. Phase findings

### 1.1 Root lifecycle & scripts (`package.json`)

| Script | Command | Notes |
|---|---|---|
| `test` | `node --test --experimental-test-module-mocks "packages/**/test/*.test.ts" "apps/**/test/*.test.ts"` | Node built-in runner — no jest/vitest. 274 tests. |
| `typecheck` | `tsc --noEmit` | root tsconfig; `apps/web/**` excluded (checked by Next). |
| `check` | `typecheck` + `test` | the CI gate. README says "74 tests" — stale, it is 274. |
| `console` | `node apps/console/src/server.ts` | review UI on :4200. |
| `autobuild` | `node apps/console/src/cli.ts` | CLI over the same pipeline. |
| `web` | `next dev` in `apps/web` | Vercel-shaped shell. |

No `postinstall`/`prepare` hooks. **No `lint`/`format` scripts.** No env vars needed for tests — `MockLLMProvider` and fixtures make the whole pipeline (including a failing attempt + repair) run offline; the approval gate genuinely blocks in demo mode.

### 1.2 `packages/core` (substrate)

Files: `workflow.ts`, `approval.ts`, `audit.ts`, `metering.ts`, `store.ts`, `store/supabase.ts`, `llm/{anthropic,capabilities,mock,pricing,types}.ts`, `http/router.ts`, `errors.ts`, `clock.ts`.

- **Stores:** `MemoryStore` and `FileStore` in `store.ts`; `SupabaseStore` in `store/supabase.ts` speaks PostgREST directly (no supabase-js dependency), 3-method interface (`get`/`put`/`list`/`delete`) over one `andromeda_store` table (`collection`,`id` composite PK, `value jsonb`). `supabaseStoreFromEnv` prefers `SUPABASE_SERVICE_ROLE_KEY`, falls back to anon/publishable key. Interchangeable via the `Store` interface — console selects at `apps/console/src/app.ts:51`: `options.store ?? (stateDir ? new FileStore(stateDir) : new MemoryStore())`.
- **HITL interrupt:** `workflow.ts` — `ctx.suspend(reason, payload)` persists the run and returns control; `runner.resume(workflow, runId, decision)` re-enters from checkpoints. `approval.ts` — `ApprovalGate` has **no auto-approve path and no timeout-approves default**; pending forever is the safe resting state; decisions are final, must carry a name, and are written before resume.
- **Budget:** `metering.ts` — `CostMeter` + `MeteredProvider` throw `BudgetExceededError`; ceiling enforced on the call *after* the one that crossed it (overshoot bounded by `maxTokens`, not the meter); budget is **seeded from prior spend on resume** so suspending cannot refresh it. Enforcement is entirely server-side.
- **LLM:** call sites declare a tier (`cheap`/`standard`/`frontier`), not a model. `AnthropicProvider` streams everything; structured output is a **forced strict tool call**. `llm/pricing.ts` is a static snapshot (unvalidated against live pricing — documented limit).
- **Scaffold determinism** lives in autobuilder, not core (see 1.3).

### 1.3 `packages/autobuilder` (product #1)

Layout: `spec/` (compiler + strict validator + JSON schema — the trust boundary), `templates/` (registry, renderer, SQL/RLS generator — the deterministic half), `sandbox/` (execution boundary), `features/` (test-gated generation + static import guard), `pr/` (risk + delivery), `pipeline.ts`.

- **Flow (pipeline.ts steps):** `compile-spec` → `render-scaffold` → feature generation → `assess-risk` (= `PROPOSAL_STEP`, its checkpoint holds the whole reviewable proposal) → `request-approval` → `await-approval` (**`ctx.suspend` — the HITL interrupt**) → `deliver` (re-reads the stored approval from the gate before acting: `pipeline.ts:207-216`).
- **Determinism:** rendering the same spec twice is byte-identical, asserted by a test; dependency ranges are rejected at template registration.
- **Test gate:** tests generated first from acceptance criteria, then frozen; digest re-checked after every run; red builds complete as `blocked_by_test_gate` and **never create an approval request**.
- **Guard:** `features/guard.ts` `checkFeatureSource` — import allowlist runs before anything is written to the sandbox.
- **Risk (`pr/risk.ts` `assessRisk`):** transparent hand-tuned sum — failed gate +60, repairs +5 each, ownerless (deny-all) tables +10, auth +10, secrets +5 each, deploy target +10, write routes +3 each (cap 15), >40 files +10. A score of 0 still requires human approval.
- **Delivery seam (`pr/delivery.ts`):** `DeliveryTarget` interface; implementations: `LocalDirectoryDelivery` (path-traversal-checked) and `NullDelivery`. **No GitHub PR implementation** — the seam is documented as where it goes. `[GAP]`
- **Templates:** three as of this branch — `next-supabase-app` (complete Vercel + Supabase project: config, migrations with RLS on by default, CI, route handlers), `worker-api` (Cloudflare Workers), and `node-service` (self-hosted zero-dependency Node 22 service). All render the byte-identical `features/contract.ts` from one canonical source. So "one official Mangu Next+Supabase scaffold" **already exists**.

### 1.4 `apps/console`

Not Next.js: a Web-standard `Router` (`core/http/router.ts`) driven by a ~40-line `node:http` adapter (`server.ts`), plus a CLI (`cli.ts`) and fixture-driven demo mode (`demo.ts`). Pages: dashboard (`GET /`), run detail (`GET /runs/:id` — spec, risk breakdown, every file, per-feature test output, audit trail, approve/reject), `POST /runs`, `POST /runs/:id/decision`, JSON API (`/api/runs`, `/api/templates`).

- **Auth: none.** No login, no token check, nothing. See risk B2.
- **CSP:** every HTML response carries `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'` + `nosniff` (`router.ts:88-90`). Two problems — see risk B3, including a functional bug.
- All model-authored values are escaped via `escapeHtml` (`views.ts:13`).
- Store/provider selected from env at boot (`server.ts:59-66`): Supabase if configured, else `FileStore(./.andromeda/state)`; live Anthropic if `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, else demo fixtures.

### 1.5 `apps/web`

A deliberately near-empty Next.js 16 app: `app/[[...slug]]/route.ts` builds the same console router (Supabase store from env, else **in-memory per warm serverless instance**) and re-exports `GET`/`POST`. `vercel.json` sets framework/build. `next.config.js` transpiles the workspace packages and sets `typescript.ignoreBuildErrors: true` (rationale documented in-file; root typecheck is the source of truth). So "web" is **the console deployed to Vercel**, not a marketing site. There is no landing/marketing page. `[GAP]` if one is wanted.

### 1.6 Docs & the ten products

`docs/architecture.md` (the substrate and how the other nine products reuse it) and `docs/product-01-auto-builder.md` (blueprint mapping, monetization hooks, competitive position). The audit brief expected "the other nine" to be vapor. They are not — every one exists as a bounded library with a README stating its blocker and containment, plus tests:

| # | Product | Package | Status |
|---|---|---|---|
| 1 | Universal Project Auto-Builder | `autobuilder` + console + web | **[BUILT]** — end-to-end with HITL, demo mode, CLI, UI |
| 2 | Self-Updating Codebase Guardian | `codebase-guardian` | [BUILT-LIB] diff-scoped context budget, own `ci/local.ts` |
| 3 | Autonomous Research Scientist | `research-scientist` | [BUILT-LIB] citation ledger — bibliography derived, never written |
| 4 | AI Computer Use Generalist | `computer-use` | [BUILT-LIB] dual-LLM reader/planner split vs prompt injection |
| 5 | Personal Life OS | `life-os` | [BUILT-LIB] conflicts surfaced, `Conflict` has no `winner` field |
| 6 | Real-Time Memory Augmentation | `memory-layer` | [BUILT-LIB] tiered processing, structural cloud-payload refusal |
| 7 | Autonomous Robotics (data play) | `robotics-data` | [BUILT-LIB] `classifyContact` fails closed |
| 8 | Universal API Translator | `api-translator` | [BUILT-LIB] canonical `ApiSpec`, propose/validate/repair |
| 9 | Traffic Twin | `traffic-twin` | [BUILT-LIB] advisory-only, a test greps for actuation imports |
| 10 | Autonomous Negotiator | `negotiator` | [BUILT-LIB] HMAC-sealed reservation value; decisions are pure functions |

[BUILT-LIB] = real, tested library code demonstrating the containment; no app/UI/connector wiring yet. Only #1 is a runnable product.

**Swarm-City:** not mentioned anywhere in this repository (no grep hits). The claimed division of labour — Andromeda generates new repos, Swarm-City patches existing ones — is not documented here, and `codebase-guardian` (watches a repo, proposes risk-scored test-gated PRs) **overlaps Swarm-City's stated territory**. Flagged in `questions_for_stakeholders.md`.

### 1.7 Tests & CI

`.github/workflows/ci.yml`: one `check` job on every push and PR — checkout, Node 22 (npm cache), `npm ci` (deliberately not `install`, so lockfile drift fails), `npm run typecheck`, `npm test`. **No Vercel preview job, no deploy job, no lint job.** Local run: 274/274 pass in ~4.6s, typecheck clean.

### 1.8 Environment variables

| Variable | Default | Where used | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | unset → demo mode | `apps/console/src/app.ts:84` | live model access (SDK loaded lazily only when set) |
| `ANDROMEDA_BUDGET_USD` | `5` | `server.ts:64`, `cli.ts:65`, `web route.ts:36` | per-run spend ceiling, server-side |
| `ANDROMEDA_STATE_DIR` | `./.andromeda/state` | `server.ts:62`, `cli.ts:63` | FileStore location |
| `ANDROMEDA_OUT_DIR` | `./.andromeda/out` (Vercel: `/tmp/andromeda/out`) | `server.ts:63`, `cli.ts:64`, `web route.ts:35` | delivery destination |
| `PORT` | `4200` | `server.ts:59` | console port |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` \| `SUPABASE_ANON_KEY` \| `SUPABASE_PUBLISHABLE_KEY` | unset → local store | `core/src/store/supabase.ts:93-101` | durable store |
| `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` | — | *generated* template code only | belongs to scaffolded projects, not Andromeda itself |

None documented in a root `.env.example`. `[GAP]`

---

## 2. Deliverables A–L

### A. Package map, run lifecycle, where the HITL interrupt lives

```
apps/web (Next.js/Vercel shell)──┐
                                 ├──▶ apps/console (router, views, CLI, demo fixtures)
        node:http :4200 ─────────┘            │
                                              ▼
                              packages/autobuilder (pipeline)
                                              │
                                              ▼
                              packages/core (substrate)
   workflow.ts · approval.ts · audit.ts · metering.ts · store.ts|supabase.ts · llm/ · http/router.ts

   9 other product packages ──▶ depend only on @andromeda/core (memory-layer: not even that)
```

Lifecycle: intent (`POST /runs` or CLI) → `compile-spec` (model proposes `project.yaml`, `validateSpec` decides, bounded repair loop) → `render-scaffold` (pure function, byte-deterministic, version-pinned) → feature generation (frozen tests, sandboxed `node --test`, digest re-checked) → `assess-risk` (checkpoint = the reviewable proposal) → `request-approval` → **`await-approval` = the HITL interrupt: `ctx.suspend` in `packages/autobuilder/src/pipeline.ts:186-190`, gated by `ApprovalGate` in `packages/core/src/approval.ts`** → resume on decision → `deliver` (re-reads stored approval first; `LocalDirectoryDelivery`). Red test gate short-circuits to `blocked_by_test_gate` with no approval request created.

### B. Risks (with evidence)

1. **`LocalSandbox` is not a security boundary** — self-declared: "*not a security boundary against hostile code. A determined program running here can still reach the network and read world-readable files*" (`sandbox/local.ts` doc comment; also README and `architecture.md` "Deliberate limits"). It does confine paths, strip env (child gets only `PATH`, `HOME`/`TMPDIR` inside the sandbox — API keys unreachable), run shell-less, cap output at 512 KiB, and kill by process group. **Mitigation before multi-tenancy: bind `Sandbox` to a disposable container (the seam exists).**
2. **The console has no authentication.** No login, token, or session anywhere in `apps/console/src`; `apps/web` deploys that same router to Vercel. Anyone who can reach the URL can submit intents (spending model budget) and **approve deliveries** — the named-human gate degrades to "whatever name the visitor typed". Highest-priority gap for any deployment. Mitigations: Vercel Deployment Protection today; Supabase Auth (or at minimum a bearer token checked in the router) before any shared deployment.
3. **CSP is both too loose and too strict** (`core/src/http/router.ts:88-89`): `script-src 'unsafe-inline'` contradicts the comment "keeps a prompt-injected `<script>` inert" (escaping in `views.ts` is the real control; the CSP as written would execute an inline script if escaping ever regressed), and **`form-action 'none'` blocks the console's own `<form method="post">` submissions** (`views.ts:114`, `views.ts:183`) in real browsers — the approve/reject and new-build forms will not submit. Tests pass because they call the router directly, never a browser. **Fix: `script-src 'none'; form-action 'self'`.** This is a release blocker for the UI path (CLI unaffected).
4. **API key handling** — read from env, never persisted, never logged by Andromeda code, and explicitly stripped from sandbox children. Residual risk: generated-code stdout/stderr is stored and rendered (escaped) in the console; keys aren't in the sandbox env so leakage risk is low. Acceptable.
5. **Budget enforcement is server-side and resume-safe** (`metering.ts`: ceiling seeded from prior spend on resume; `MeteredProvider` wraps the provider itself), so no client-side bypass exists. Bounded overshoot of one completion is documented. ~~Residual risk: no global/daily ceiling~~ **Fixed on this branch:** `ANDROMEDA_GLOBAL_BUDGET_USD` bounds spend across all runs in a rolling 24h window — new runs refused at the limit, in-flight meters capped to the remaining headroom, and delivery of already-approved builds never blocked (spend already happened). Worst-case overshoot: per-run ceilings of runs already started.
6. **Store trade-offs:** `MemoryStore` loses everything on restart (and per warm serverless instance on Vercel — documented in `web/app/[[...slug]]/route.ts`); `FileStore` is single-writer, no locking (fine single-operator); `SupabaseStore` ships but **its migration is missing** — `store/supabase.ts:10` references `supabase/migrations/` which does not exist, and the store is typically configured with the **service-role key, which bypasses RLS** — table policy is then decorative. Ship the migration (see G) and RLS policy.
7. **Drift/small:** README "74 tests" vs actual 274; remote HEAD points at a merged feature branch instead of `main`; `apps/web` sets `ignoreBuildErrors: true` (documented rationale, but it also masks real errors in `apps/web`-only code); model pricing snapshot unvalidated against live pricing.

### C. Competitor matrix

| Player | Target | Model | HITL gate | Cost control | Persistence | Deterministic scaffold | Price (public) |
|---|---|---|---|---|---|---|---|
| Bolt.new | new app, hosted | Claude | preview-only, no gate | token packs | hosted | no — full-gen | free/$20+/mo |
| v0 (Vercel) | new UI/app | proprietary blend | iterate in chat | credits | hosted | partial (shadcn base) | free/$20+/mo |
| Lovable | new app, hosted | mixed | chat iterate | credits | hosted + Supabase | no | free/$25+/mo |
| Cursor (agents) | existing repo | user's choice | user reviews diffs | usage-based | local repo | n/a | $20+/mo |
| Devin | existing + new | proprietary | plan approval, slack | ACU metering (the cautionary tale the docs cite) | hosted | no | $20+/ACU-priced |
| Factory | existing repo | mixed | review gates | usage | hosted | no | enterprise |
| Sweep | existing repo (issues→PRs) | mixed | PR review | usage | GitHub | no | per-seat |
| GitHub Spark | new micro-apps | mixed | none (personal) | Copilot sub | hosted | partial | Copilot tiers |
| Replit Agent | new app, hosted | mixed | checkpoint rollback | effort-based billing | hosted | no | $25+/mo |
| **Andromeda #1** | **new repo you own** | Anthropic, tier-routed | **hard approval gate, no rubber-stamp path, red builds never offered** | **per-run USD ceiling, per-purpose metering** | Memory/File/Supabase seam | **yes — byte-identical, version-pinned, RLS-on-by-default** | unpriced (blueprint: $25 Pro/$99 seat/API+30%) |
| Swarm-City (per stakeholder claim) | existing repos (patches) | — | — | — | — | — | — layer must not be duplicated; see codebase-guardian overlap question |

Differentiators that survive contact: pinned deps, migrations with RLS by default, frozen-test gate, audit trail, spend ceiling. Missing to compete: PR delivery into the customer's repo, template breadth, DB-touching features.

### D. 14-day wins

1. **Ship the Supabase leg for real** (mostly exists): write `supabase/migrations/0001_andromeda_store.sql` (schema in G), a root `.env.example`, and a smoke test of `SupabaseStore` against PostgREST fixtures (unit tests exist; add one integration doc). Effort: ~1 day.
2. **Deploy the console to Vercel behind auth** (`apps/web` already is the deployable): fix the CSP bug (B3), turn on Vercel Deployment Protection, set `SUPABASE_URL` + key so state survives instances, set `ANDROMEDA_BUDGET_USD`. Effort: ~2 days including the CSP fix + a browser-level form test.
3. **Bless `next-supabase-app` as the official Mangu scaffold** — it already renders a complete Vercel+Supabase project with RLS and CI. Work: brand it, add the 1–2 fields Mangu apps always need, and write `docs/template-next-supabase.md`. Effort: ~2 days.
4. *(stretch)* **`GitHubPullRequestDelivery`** implementing the existing `DeliveryTarget` seam — the single highest-leverage product gap (docs: "No pull request" is the #2 thing a customer hits).

### E. PRD + MVP

**Persona:** Priya, a Mangu staff developer. They need an internal "letters-style inbox" (submissions in, statuses, assignments) and don't want to hand-roll the 40 files of auth/RLS/CI boilerplate.
**Problem:** prototype generators stop at ~70% with an unhardened app; hand-building the hardened version takes days.
**MVP (nearly all exists):** intent → validated spec → deterministic `next-supabase-app` scaffold → test-gated features → risk score → **named-human approval in the console** → delivery. MVP delta from today: CSP fix, deployed authed console, Supabase store migration, delivery as **zip download or draft GitHub PR**.
**Non-goals (MVP):** multi-tenant sandboxing (container work), billing (metering already provides the numbers), template marketplace, products #2–#10 productization.
**Proposed SLAs:** spec compiled ≤60s; full build to review-ready ≤10min; approval-to-delivery ≤60s; per-run cost ≤ configured ceiling, ever, enforced server-side.

### F. User stories with acceptance criteria

1. *Submit an intent* — Given a logged-in user posts an intent, When compilation succeeds, Then a run appears with a validated spec within 60s, and When the model proposes an invalid spec, Then it is repaired ≤N bounded attempts or fails loudly with the issue list. *(exists: `spec/compiler.ts`; missing: "logged-in")*
2. *Review before anything happens* — Given a build passed its test gate, When I open `/runs/:id`, Then I see spec, risk factors, every file, per-feature test output and audit trail, and nothing has been delivered anywhere. *(exists)*
3. *Approve/reject by name* — Given a pending approval, When I decide with my name and note, Then the decision is stored immutably before the run resumes, and delivery re-verifies the stored decision. *(exists: `pipeline.ts:207-216`; blocked in browsers by B3 until fixed)*
4. *Red builds never reach me* — Given any feature never passed its frozen tests, Then the run completes `blocked_by_test_gate` with code+output preserved and no approval request exists. *(exists, tested)*
5. *Budget ceiling* — Given `ANDROMEDA_BUDGET_USD=5`, When cumulative spend passes $5, Then the next completion throws `BudgetExceededError`, the run fails visibly, and resuming does not refresh the budget. *(exists, tested)*
6. *Delivered project works* — Given an approved delivery, When I run `npm ci && npm test` in the output, Then install succeeds from pinned versions and generated tests pass. *(exists for local delivery)*
7. **[NEW]** *PR delivery* — Given a GitHub target is configured, When I approve, Then a draft PR opens in my repo containing exactly the reviewed files, traceable to the approval id.
8. **[NEW]** *Operator audit* — As an admin I can list all runs with requester, spend, outcome and approval decision (data already in `RunRecord`/audit log; needs a page).

### G. Supabase schema

What `SupabaseStore` needs today (the missing migration) — collections observed: runs, approvals, audit events all round-trip through the one-table Store seam:

```sql
create table andromeda_store (
  collection text not null,
  id         text not null,
  value      jsonb not null,
  primary key (collection, id)
);
alter table andromeda_store enable row level security;
-- service-role access bypasses RLS; add per-operator policies when console auth lands:
-- create policy operator_rw on andromeda_store for all
--   using (auth.uid() in (select user_id from andromeda_operators));
```

Proposed v2 (relational, when billing/entitlements arrive): `runs(id, intent, requested_by, status, outcome, risk_score, spent_usd, created_at)`, `checkpoints(run_id, step, value, created_at)`, `approvals(id, run_id, status, decided_by, note, decided_at)`, `audit_events(id, run_id, actor, action, details, at)`, `spend(run_id, purpose, model, usd, at)`, `operators(user_id, email, role)` — all RLS-scoped to operators. The v1 jsonb table is the honest 14-day move; v2 only when a query pattern demands it.

### H. Env matrix — see §1.8. Deltas to ship: root `.env.example` documenting every row, plus future `DELIVERY_TARGET` (`local`|`github`) and `GITHUB_TOKEN` when D4 lands, and a global `ANDROMEDA_DAILY_BUDGET_USD` (B5).

### I. CI

Exists: `check` (npm ci → typecheck → test) on all pushes/PRs. Add: (1) Vercel Git integration for `apps/web` preview deploys (zero-workflow route: connect repo in Vercel, root dir `apps/web`) — or a workflow step with `vercel deploy --prebuilt` if previews must live in Actions; (2) a lint/format job once a linter is chosen; (3) *(later)* a browser-level Playwright smoke test of the console forms — the exact class of bug B3 that router-level tests cannot see.

### J. Prerequisites — Node ≥22.18 + npm; nothing else for demo mode (no API key, no cloud, no Docker, no build step). Live mode: `ANTHROPIC_API_KEY`, optional budget. Durable state: Supabase project + G migration. Future PR delivery: GitHub token. Multi-tenant: container runtime for the sandbox.

### K. Prosperity

- **Cash engine:** the operator/creator factory — hardened, human-approved new repos. Blueprint tiers on record in `docs/product-01-auto-builder.md`: Free (1 project) → Pro $25/mo → Team $99/seat → overage at API cost + 30%. Metering + ceiling (the hard half of billing) already exist; entitlements/seats go in `Store`.
- **Mangu positioning:** included in Mangu Studio, or $29/run packs for externals — both bill off `RunRecord.spentUsd`, which is already per-purpose and per-model.
- **90-day target:** 5 internal Mangu repos scaffolded via the official template, approved and merged; every run under ceiling; zero un-audited deliveries.
- **Kill criterion:** if effort drifts to productizing products #2–#10 before console auth + Supabase store + PR delivery ship for #1, stop and re-focus. (The nine libraries are good collateral; they are not the wedge.)

### L. Andromeda + Swarm-City sharing a console

The console is already architected for this: routes are `(Request, params) => Response` on a shared `Router`, and the substrate (runs, approvals, audit, spend) is product-agnostic. Proposal: one operator dashboard, two tabs — **Create** (Andromeda runs) and **Patch** (Swarm-City / codebase-guardian runs) — over shared Supabase tables keyed by `collection` (`andromeda.runs` vs `guardian.runs`), one approval queue sorted by the same `RiskAssessment` shape, one audit trail, one spend meter per org. Precondition: settle the codebase-guardian/Swarm-City overlap (see questions) so one layer owns "patch existing repos" before both grow a UI.

---

## 2b. Adversarial review round (post-fix)

After the punch-list fixes landed, a 25-agent adversarial review (5 dimensions × find-then-refute) was run over the branch diff; 20 raw findings, 18 confirmed, all fixed on this branch:

- **Auth:** Basic-auth guard double-encoded credentials, so any non-ASCII password could never authenticate (fail-closed lockout) — now compares raw decoded bytes, with a `café🔑` test. **CSRF:** browsers attach Basic credentials automatically, so a foreign page could submit the approve form; a `sameOriginPostGuard` (Origin/Sec-Fetch-Site) now refuses cross-origin state changes unconditionally.
- **Global budget:** window was keyed on `createdAt`, letting post-resume spend escape every window — now keyed on last activity (conservative over-count). Overlapping starts in one process saw only persisted spend — the runner now reports live in-flight meters to the gate (cross-process gap remains, bounded by per-run ceilings and documented). `windowMs`/`limitUsd` are validated; a NaN/0/negative `ANDROMEDA_GLOBAL_BUDGET_USD` now fails app construction loudly instead of silently uncapping.
- **Delivery:** GitHub Free private repos reject draft PRs with 422 — the delivery now falls back to a regular PR rather than stranding the created branch (non-draft 422s still fail).
- **Templates (all three):** the rendered tsconfig's `rewriteRelativeImportExtensions` made every scaffold's own `npm run typecheck` fail with TS2877 on `#features/*.ts` imports — removed, and a new test renders `node-service` and runs `tsc` against it so this class of bug cannot ship silently again. `node-service`'s server no longer crashes on a malformed Host header or an unserializable feature result, returns generic 500s (details go to the log), and honors `x-user-id` only with a proxy-attested shared secret (`PROXY_AUTH_SECRET`) instead of trusting a bare client header. Router import bindings are de-duplicated (`a-b` vs `a--b`). Its CI uses `npm install` with instructions to commit the lockfile and switch to `npm ci` (a rendered scaffold cannot contain a real lockfile).
- **Docs:** the Vercel route notes that the global ceiling is per-warm-instance without the Supabase store.

Notable refuted claims (checked, not real): empty-string password "fails open" (it correctly means auth-off), and the anon-key store fallback being nonfunctional under the shipped migration (deny-all is the documented intent).

## 3. Release-blocking punch list (ordered)

Statuses updated as fixes landed on this branch after the audit:

1. ✅ **Done** — CSP now `script-src 'none'; form-action 'self'` with both directives pinned by test.
2. ✅ **Done (single-operator)** — `ANDROMEDA_CONSOLE_PASSWORD` gates every route behind HTTP Basic auth (constant-time compare, portable guard in `Router`). Real accounts (Supabase Auth) remain future work; Vercel Deployment Protection still recommended in depth.
3. ✅ **Done** — `supabase/migrations/0001_andromeda_store.sql` and root `.env.example` committed.
4. ✅ README fixed. ⏳ Repointing the GitHub default branch to `main` needs an admin in repo settings — still open.
5. ✅ **Done** — `GitHubPullRequestDelivery` ships behind the approval gate (`ANDROMEDA_DELIVERY_REPO` + `GITHUB_TOKEN`), create-only refs, draft PRs; console server, CLI and Vercel route all select it from the environment.
