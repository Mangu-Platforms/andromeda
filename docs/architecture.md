# Architecture

## Why there is a substrate at all

The ten products in the blueprint have different blockers — prompt injection,
citation hallucination, contact-force physics, formal safety guarantees — but
the blueprint's answer to all ten is the same shape: contain the blocker with a
workflow chain and a human-in-the-loop compensating control, rather than solve
it. That shared answer needs the same five mechanisms every time:

| Mechanism | Why every product needs it |
|---|---|
| Durable checkpointed workflow with interrupts | A run that waits for a human may wait for days, across process restarts, and must not redo its work when it resumes. |
| Append-only audit log | The compensating control is only worth something if a reviewer can see what the agent did and an operator can reconstruct it afterwards. |
| Approval gate | Irreversible actions become proposals; a named human turns a proposal into an action. |
| Cost meter with a hard ceiling | Token-heavy agents on flat pricing are the failure mode the blueprint warns about. Spend must be bounded per run and attributable per step. |
| Provider-agnostic LLM access with tier routing | Mechanical sub-tasks must not reach a frontier model, and no product should be rewritten when routing changes. |

Those live in `packages/core`. A product supplies its pipeline and its
domain-specific controls, and inherits the rest.

## `packages/core`

### Workflow runner (`workflow.ts`)

LangGraph's model, minus the infrastructure. Steps are memoized by name in a
`RunRecord`; a run that suspends is persisted and can be resumed in a different
process; resuming re-enters the workflow from the top while completed steps
return instantly from their checkpoints.

```ts
const value = await ctx.step("name", async () => { /* runs at most once */ });
ctx.suspend("waiting for a human", payload);   // persists and returns control
await runner.resume(workflow, runId, decision); // decision becomes the step's result
```

The contract that makes replay safe: a step body must be idempotent, and any
side effect must live *inside* a step rather than between steps. Checkpoints are
JSON round-tripped at write time, so a non-serializable result fails loudly in
the step that produced it rather than at persistence time.

`ctx.hasCheckpoint(name)` lets a workflow skip setting up resources only the
un-run steps would need — the auto-builder uses it to avoid creating a sandbox
on resume.

### Approval gate (`approval.ts`)

No auto-approve path and no timeout-approves default. A request nobody answers
stays pending forever, which is the safe resting state. Decisions are final,
must carry a name, and are written before the workflow resumes — so a crash
between the two leaves a build waiting rather than half-delivered.

Consumers should re-read the stored decision before acting on it rather than
trusting a resume value, which is what the auto-builder's `deliver` step does.

### Cost meter (`metering.ts`)

Cost is only knowable after a completion returns, so the ceiling is enforced on
the call *following* the one that crossed it. A single call can overshoot by at
most one completion — bound that with `maxTokens`, not with the meter. The
budget is seeded from prior spend on resume, so a run cannot get a fresh budget
by suspending.

`MeteredProvider` wraps any provider. Products should only ever hold a metered
one; an unwrapped provider is an unbounded bill.

### LLM access (`llm/`)

Call sites declare a *tier* (`cheap` / `standard` / `frontier`), not a model.
`AnthropicProvider` streams every request and resolves via `finalMessage()`,
which removes the HTTP-timeout class of failure on long generations. Per-model
capability flags decide the request shape, because sending adaptive thinking or
`output_config.effort` to a model that predates them is a 400, not a preference.

Structured output uses a **forced strict tool call** rather than asking for JSON
in prose: `strict: true` guarantees the arguments validate against the schema.

`MockLLMProvider` is deterministic and scripts replies per purpose, which is
what lets the whole pipeline — including a failing first attempt and its repair
— be tested with no network.

### HTTP (`http/router.ts`)

Handlers are `(Request, params) => Response`: the signature of a Next.js App
Router route handler *and* of a Cloudflare Workers fetch handler. The console's
`server.ts` is a 40-line `node:http` adapter over the same router, so moving to
Vercel or Workers means re-exporting functions, not rewriting them.

## `packages/autobuilder`

```
spec/       compiler + strict validator + JSON schema     trust boundary
templates/  registry, renderer, SQL/RLS generator         deterministic half
sandbox/    execution boundary                            swappable
features/   test-gated generation + static guard          gated half
pr/         risk scoring + delivery target                irreversible step
pipeline.ts the workflow that wires them together
```

The layering rule: **anything security-relevant or easy to get wrong is
hand-written and rendered; only business logic is generated, and only behind
tests it cannot edit.**

Three controls are worth calling out because they are load-bearing rather than
decorative:

- `validateSpec` rejects rather than escapes. Identifiers going into SQL DDL are
  checked against an allowlist pattern and a reserved-word list; an owner column
  must be `uuid`, because a `text` owner column would make every row-level
  security policy compare against `auth.uid()` and silently deny everything.
- `checkFeatureSource` is an import allowlist that runs *before* anything is
  written to the sandbox — so a module that reaches for the filesystem is
  rejected without ever executing.
- Tables get RLS enabled unconditionally. A table with an owner column gets
  owner-scoped policies; one without gets no policy, which in Postgres means
  deny-all. Forgetting to configure access locks the table down instead of
  exposing it.

## Reusing the substrate

A second product is a new pipeline plus its own controls. The blueprint's
recommended next two both fit without changing `core`:

**#8 Universal API Translator.** `compileSpec`'s propose/validate/repair loop
becomes doc-normalizer → canonical OpenAPI; the template registry becomes the
OpenAPI Generator wrapper; the test-gate becomes a live smoke test against the
real API. The scheduled contract test that opens a patch PR is a workflow with
the same approval gate.

**#2 Self-Updating Codebase Guardian.** The workflow runner already provides the
per-repo durable state; the test-gate becomes "full suite green before a human
sees the PR"; risk scoring already exists. What it adds is a diff-scoped
retrieval index, so a change loads only its dependency subgraph rather than the
whole repository.

The pattern generalises to the advisory-mode products (#3 research, #9 traffic,
#10 negotiation) in the same way: they differ in what the gate is protecting,
not in how gating works.

## Deliberate limits

- `LocalSandbox` is containment, not a security boundary. It confines paths,
  strips the environment, runs without a shell, caps output and kills by process
  group — enough for a test suite the pipeline just wrote, not enough for
  untrusted multi-tenant work.
- Model pricing in `llm/pricing.ts` is a snapshot. `npm run check` does not
  validate it against the live pricing page.
- The risk score is a hand-tuned sum, on purpose. A reviewer has to be able to
  read why a build scored what it did, and a score a model can talk itself into
  is not a control.
