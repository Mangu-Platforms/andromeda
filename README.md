# Andromeda

A shared substrate for autonomous agent products, and the first product built on
it: the **Universal Project Auto-Builder** — natural-language intent in, a
test-covered, reviewable repository out, with a human in the loop before
anything is written anywhere.

```bash
npm ci
npm run check                                        # typecheck + the full test suite
npm run autobuild -- build "A tool to shorten URLs" --by you@example.com
npm run console                                      # review UI on :4200
```

No API key is needed to try it. Without credentials the pipeline replays
recorded fixtures, and everything except the model responses is real — the
scaffold is rendered, the generated code is executed, the tests actually run,
and the approval gate actually blocks.

## The idea

Multi-step code generation fails through non-deterministic dependency-graph
cascades: each generated step can invalidate the last, and the failure surfaces
somewhere far from its cause. Rather than trying to make generation reliable,
this splits the work in two and gates the half that cannot be made reliable.

```
intent ──▶ spec ──────▶ scaffold ──────▶ features ──────▶ risk ──▶ HUMAN ──▶ delivery
           validated    deterministic    test-gated       scored    gate      irreversible
           & repaired   & version-pinned & frozen tests
           ~~~~~~~~~~   ~~~~~~~~~~~~~~~~ ~~~~~~~~~~~~~~   ~~~~~~~   ~~~~~     ~~~~~~~~~~~
           model         no model         model, boxed    no model  stop      only after
           proposes      involved         in by tests               here      approval
```

Four properties hold this up:

**The spec is a trust boundary.** A model proposes `project.yaml`; a strict
zero-dependency validator decides. Identifiers destined for SQL are checked
against an allowlist, unknown keys are rejected, collections are capped, and
foreign keys must resolve. Invalid specs go back to the model with the exact
issue list, up to a bounded number of repairs. A prompt-injected model still
cannot get `users; drop table x` past `validateSpec`.

**The scaffold is a pure function.** Auth wiring, migrations, row-level
security, config and CI come from hand-written, version-pinned templates —
never from a model. Rendering the same spec twice produces byte-identical
output, which is asserted by a test. Dependency ranges are rejected at template
registration, so a build is reproducible and `npm ci` fails fast.

**Generated logic is boxed in by tests it cannot edit.** Tests are written
first, from the acceptance criteria, and then frozen. The implementation loop
may rewrite the implementation as often as its budget allows, never the tests,
and the test file's digest is re-checked after every run. An agent that can edit
its own tests will eventually edit its own tests.

**The last reversible step is where autonomy stops.** Delivery happens only
after a named human approves, and a build whose tests are red is never put in
front of a reviewer at all — asking someone to approve known-broken code is how
approval becomes a rubber stamp.

## What's in the box

| Package | What it is |
|---|---|
| `packages/core` | The substrate: durable checkpointed workflows with human-in-the-loop interrupts, an append-only audit log, an approval gate, a cost meter with a per-run ceiling, provider-agnostic LLM access, and a Web-standard HTTP router. |
| `packages/autobuilder` | Product #1: spec compiler, template registry, execution sandbox, test-gated feature generation, risk scoring, delivery. |
| `apps/console` | The review UI and CLI over the same pipeline. |

The substrate is the reusable part. Nine of the ten products in the blueprint
need the same five things — durable state, an audit trail, an approval gate,
metered spend, and a model-agnostic provider — so those live in `core` and the
product supplies only its own pipeline. See [docs/architecture.md](docs/architecture.md).

## Trying it

### CLI

```bash
npm run autobuild -- build "Track invoices and line items" --by you@example.com
npm run autobuild -- list
npm run autobuild -- show <run-id>
npm run autobuild -- approve <run-id> --by you@example.com --note "reviewed"
npm run autobuild -- templates          # registered scaffolds and their pins
```

A build stops at the gate and prints its risk factors. `approve` resumes it from
its checkpoints — no recompilation, no regeneration — and delivers.

### Console

```bash
npm run console        # http://localhost:4200
```

The review page shows the compiled spec, the risk breakdown, every generated
file, each feature's test output, and the full audit trail, with approve and
reject buttons. It renders model-authored content, so every value is escaped and
every response carries a restrictive CSP.

### Live mode

```bash
export ANTHROPIC_API_KEY=...           # or: ant auth login
export ANDROMEDA_BUDGET_USD=5          # per-run ceiling, enforced
npm run console
```

Requests route by tier — mechanical sub-tasks to Haiku, reasoning to Opus 5 —
and every completion is metered against the run's budget. Structured output uses
a forced strict tool call, so the spec compiler receives a record or an error,
never a paragraph explaining the record.

## Running it for real

Three things are deliberately swappable, and two of them must be swapped before
this handles anyone else's work:

- **`Sandbox`** — `LocalSandbox` confines paths, strips the environment, runs
  without a shell, caps output and kills by process group. That is enough to run
  a test suite the pipeline just wrote; it is **not** a security boundary
  against hostile code. Bind it to a disposable container for multi-tenant use.
- **`Store`** — `MemoryStore`, `FileStore` and a PostgREST-backed
  `SupabaseStore` ship; set `SUPABASE_URL` and a key after applying
  `supabase/migrations/0001_andromeda_store.sql` and run state becomes durable.
- **`DeliveryTarget`** — `LocalDirectoryDelivery` writes to disk. A GitHub
  implementation opening a pull request goes through the same seam, and stays
  behind the same approval gate.

## Development

```bash
npm run typecheck
npm test
npm run check
```

Zero runtime dependencies beyond the Anthropic SDK. TypeScript runs natively on
Node 22 via type stripping, and tests use the built-in runner — so there is no
build step, and the test-gate can execute generated code with nothing installed.

## Documentation

- [docs/architecture.md](docs/architecture.md) — the substrate, and how the
  remaining nine products reuse it.
- [docs/product-01-auto-builder.md](docs/product-01-auto-builder.md) — how the
  blueprint's blocker, pricing and build sequence map onto what is here.
