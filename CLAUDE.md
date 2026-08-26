# CLAUDE.md

Guidance for AI-assisted work in this repository.

## Commands

```bash
npm ci                 # install (lockfile-strict; drift should fail, not resolve)
npm run check          # typecheck + full test suite — the CI gate; run before every push
npm run typecheck      # tsc --noEmit against the root tsconfig
npm test               # node --test over packages/**/test and apps/**/test
npm run console        # review UI on :4200 (demo mode without ANTHROPIC_API_KEY)
npm run autobuild -- build "<intent>" --by you@example.com   # CLI pipeline
node --test --experimental-test-module-mocks <file>          # one test file
```

There is no build step: Node 22 strips types natively, and there is no lint or
format script. Tests use the built-in runner; test files live in each
workspace's `test/` directory and end in `.test.ts`.

## Architecture

npm workspaces: `packages/*` + `apps/*`. `packages/core` is the substrate —
checkpointed workflows with human-in-the-loop suspend/resume (`workflow.ts`),
approval gate with no auto-approve path (`approval.ts`), append-only audit log,
per-run + global cost metering, tier-routed LLM access (`llm/`), Web-standard
router with auth/CSRF guards (`http/router.ts`), and the three-method `Store`
(memory / file / Supabase-over-PostgREST). The other ten packages are products
on that substrate; only `autobuilder` (product #1) is wired to an app.
`apps/console` is a plain `node:http` server + CLI over Web-standard handlers;
`apps/web` re-exports the same router as a Next.js catch-all for Vercel.

Pipeline shape (the core design): intent → spec (model proposes, strict
validator decides, bounded repairs) → scaffold (pure function of the spec,
byte-deterministic, version-pinned templates) → features (model output boxed in
by frozen tests it cannot edit) → risk score (hand-tuned sum, never a model) →
human approval (suspends indefinitely) → delivery (local directory or GitHub
draft PR; the only irreversible step).

## Conventions that are load-bearing

- **One dependency exception.** Runtime deps beyond the Anthropic SDK are not
  added; small REST clients (Supabase, GitHub) are hand-written over `fetch`
  with an injectable `fetchImpl` for tests.
- **Determinism is asserted.** `render()` in a template must be a pure function
  of the spec — no clock, randomness, or network; a test renders twice and
  compares digests, and another renders a scaffold and runs `tsc` on it.
  Template dependencies must pin exact versions (checked at registration).
  Bump a template's `version` whenever its rendered bytes change.
- **All non-determinism flows through `Clock`/`Ids`** (`core/src/clock.ts`).
  Never call `Date.now()` or `Math.random()` directly in substrate or pipeline
  code; tests inject `FixedClock`/`SeededIds`.
- **Fail closed, loudly.** Invalid config throws at construction (budgets,
  auth passwords, delivery repos); missing data never defaults to permissive
  (RLS with no policy is deny-all; unclassified contact requires a human).
- **Side effects live inside `ctx.step`** so resume-replay is safe, and
  anything security-relevant is hand-written and rendered, never generated.
- Comments explain *why* a control exists, not what the next line does; match
  the existing voice.

## Environment

Everything is optional — no API key means demo mode against fixtures. See
`.env.example` for the full matrix: `ANTHROPIC_API_KEY`,
`ANDROMEDA_BUDGET_USD` (per-run ceiling), `ANDROMEDA_GLOBAL_BUDGET_USD`
(rolling 24h ceiling across runs), `ANDROMEDA_CONSOLE_PASSWORD` (HTTP Basic on
every console route), `SUPABASE_URL` + key (durable store; apply
`supabase/migrations/` first), `ANDROMEDA_DELIVERY_REPO` + `GITHUB_TOKEN`
(approved builds open a draft PR).

## Gotchas

- `apps/web/**` is excluded from the root typecheck; Next's own build checks it
  (`ignoreBuildErrors` is set there deliberately — root `tsc` is the truth for
  workspace packages).
- The console renders model-authored content: every value goes through
  `escapeHtml`, and the CSP (`script-src 'none'; form-action 'self'`) plus the
  same-origin POST guard are pinned by tests — keep them that way.
- `LocalSandbox` is containment, not a security boundary; multi-tenant use
  needs a container behind the `Sandbox` seam.
