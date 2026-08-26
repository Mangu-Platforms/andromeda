# Product #1 — Universal Project Auto-Builder

How the blueprint's plan for product #1 maps onto what is in this repository,
and what is deliberately not here yet.

## The blocker, and the containment

> **Blocker:** non-deterministic dependency-graph cascades in multi-step code
> generation.
>
> **Workaround:** decompose into a deterministic scaffold layer and a
> non-deterministic feature layer. Ship from a curated, version-pinned template
> library. Only the business-logic layer is LLM-generated, behind a test-gate:
> the agent must make a generated test suite pass before the PR is offered for
> human approval.

Implemented as specified, with two additions the blueprint implies but does not
spell out:

**Tests are frozen.** The blueprint says the agent must make a generated test
suite pass. If the agent can also *edit* that suite, the gate measures nothing.
So tests are generated first from the acceptance criteria, then frozen: the
repair loop rewrites only the implementation, the frozen tests are re-written to
disk before every run, and their digest is re-checked after. Proven by
`gate.test.ts` — "the tests are written once and never regenerated".

**Red builds are never offered for approval.** The blueprint's sequence puts the
test-gate before the human. Taken literally, that means a build with failing
tests should not reach a reviewer at all — it completes as
`blocked_by_test_gate`, with the code and the failing output preserved for
whoever investigates, and no approval request is created. There is no button to
rubber-stamp.

## Blueprint build sequence

| Step | Status |
|---|---|
| 1. Template registry + spec compiler | Done. Two version-pinned templates, strict validator, propose/validate/repair loop. |
| 2. Wire one deploy target end-to-end | Partial. `next-supabase-app` renders a complete Vercel + Supabase project — config, migrations with RLS, CI, route handlers — and `DeliveryTarget` writes it out. Pushing to Vercel/Supabase APIs is not wired. |
| 3. Feature layer behind a test-gate | Done, and executing for real: generated code runs under `node --test` in a sandbox. |
| 4. PR-review UI | Done as a review console: spec, risk breakdown, every file, per-feature test output, audit trail, approve/reject. Delivery targets a directory, or opens a draft pull request in the customer's repository via `GitHubPullRequestDelivery`. |
| 5. Billing | Not built. Metering is — every completion is priced, attributed per purpose and per model, and bounded by a per-run ceiling — which is the half that has to be right before billing can be built on it. |

Deviations from the blueprint worth flagging:

- **OpenHands is not used.** The blueprint proposes it for the feature layer.
  Because features are constrained to pure request handlers behind a fixed
  contract, generation needs a completion and a test run, not a full agent
  runtime with a Docker sandbox and a CodeAct loop. `Sandbox` is the seam where
  an OpenHands runtime drops in if features later need to touch a real
  filesystem or run a dev server.
- **The scaffold is rendered, not templated from a git repo.** A `create-next-app`
  + Supabase CLI + Terraform chain is a shell pipeline whose output depends on
  what npm resolved that morning. Rendering from pinned data makes
  byte-determinism testable, which is the property the blocker workaround
  actually needs.

## Monetization hooks

The blueprint's tiers — Free (1 project) → Pro $25/mo → Team $99/seat → usage
overage at API cost + 30% — need three things from the runtime. Two exist:

- **Per-run metering.** `CostMeter` records every completion by purpose and
  model, and `RunRecord.spentUsd` persists it. Overage pricing has real numbers
  to bill from.
- **A hard ceiling.** `ANDROMEDA_BUDGET_USD` bounds a run, which is what makes
  a flat tier survivable. This is the Devin ACU lesson the blueprint cites: a
  $20 plan that can quietly cost $300 is not a $20 plan.
- **Seats, projects and entitlements.** Not built. `Store` is where they go.

Model routing is the margin lever. Call sites declare a tier rather than a
model, so moving mechanical sub-tasks to Haiku is a routing-table change, not a
code change. The spec compiler and feature generation currently both request
`frontier`, which is the honest default for work that has to be right; the
cheaper tiers are wired and unused.

## What a customer would hit first

Ordered by how quickly it would bite:

1. **The sandbox is not a security boundary.** Fine for a single-tenant build
   machine; not fine the moment someone else's prompt runs on it. Container
   first.
2. **Two templates.** The library is the moat the blueprint describes, and two
   templates is a demonstration of the registry, not a library.
3. **Features are pure request handlers.** The contract that makes generated
   code testable without a database also means a feature cannot yet query one.
   Widening it — a repository interface the template provides and the sandbox
   fakes — is the next real piece of product work.
4. **Acceptance criteria carry the whole gate.** Tests are only as good as the
   criteria the spec compiler wrote. The compiler is prompted hard for concrete,
   checkable statements and the validator rejects features with none, but
   nothing checks that a criterion is *meaningful*. A criterion that asserts
   nothing produces a test that asserts nothing.

## Competitive position

The blueprint's wedge — "idea → deployed, test-covered, IaC-managed repo you
own", against Lovable and Bolt stopping at ~70% with an unhardened prototype —
lines up with what is built. The parts that differentiate are the parts a
prototype-generator skips: pinned dependencies, migrations with row-level
security on by default, CI that installs from a lockfile, generated code that
arrives with tests it had to pass, and an audit trail of what the agent did.

The PR flow into a customer's own repository now exists
(`GitHubPullRequestDelivery`, behind the same approval gate). The parts that
would decide it commercially from here — a template library worth paying for,
and features that can talk to the database — are the first items above.
