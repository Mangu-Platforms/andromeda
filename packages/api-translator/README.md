# Universal API Translator

Typed SDKs from *any* documentation format — an OpenAPI fragment, a Postman
collection, a scraped HTML table — kept honest by probing the live API. Aimed at
API **consumers** integrating somebody else's service, unlike Stainless,
Speakeasy and Fern, which serve API producers and require a clean spec.

## The blocker

Human documentation is incomplete and frequently wrong, and the second half —
edge-case auth handshakes — turns a wrong guess into an SDK that 401s in
production.

## The containment

**Model proposes, validator decides.** Every input format is normalized into one
canonical `ApiSpec`, then validated hard: operation ids, path templating and
parameter agreement (every `{param}` declared and vice versa), method and status
legality, duplicates, unknown keys rejected. Failures feed the exact issue list
back for a bounded number of repairs, then fail loudly. A spec that "mostly"
validates produces an SDK that compiles and then 404s.

The compiler's prompt forbids invention outright: undocumented type means
`unknown`, undocumented required-ness means `false`, and `auth.confirmation` is
*always* `unconfirmed` — the model is not permitted to conclude that an auth
scheme works.

**The live probe outranks the documentation.** `reconcileWithProbe` treats the
docs as a hypothesis and the API as the observation. It omits each documented
field in turn and lets the response decide required-ness **in both directions**:
a field the docs called optional that draws a 400 becomes required, and one
called required that the API accepts without becomes optional — leaving it
required makes an SDK force callers to invent a value.

Three refusals matter as much as the rewrites:

- **A 5xx is not evidence.** The server broke, which says nothing about the
  contract. The documented claim stands, marked `human-decision`.
- **An operation with no sample for its path parameters is skipped**, not probed
  with an invented id. The resulting 404 would make every field look required.
- **Auth confirmation only rises on positive evidence** — a 401 or 403 without
  credentials. Ambiguity stays `unconfirmed`, which is what codegen refuses to
  emit. An API answering 2xx unauthenticated is reported loudly instead.

Every rewrite carries a `ProvenanceRecord` naming the concrete request that
settles it. A claim without a receipt is exactly what the documentation already
was.

> **Audit finding, implemented.** This control did not exist. The types
> anticipated it in full — `AuthConfirmation` with a `"probe"` state, a
> `ProvenanceRecord` with `resolution: "probe-wins"`, prompts telling the model
> that "a live probe, not you, establishes real required-ness" — and there was
> an `ApiProbe` interface and an offline `ScriptedProbe`. Nothing consumed any
> of it. Separately, `index.ts` exported only `spec/types` and `spec/validate`,
> so the compiler, the normalizers and the probe were all unreachable.

## What is not built

- **No code generation.** The canonical spec and its provenance are produced;
  nothing emits TypeScript from them yet. The determinism requirement — same
  spec in, byte-identical SDK out — is stated and untested because there is no
  generator to test.
- **No drift detection or self-healing.** The scheduled contract test that
  re-probes, detects drift and opens a gated patch PR is not implemented.
- **No real probe.** `ScriptedProbe` only. Nothing here implements `ApiProbe`
  against `fetch`, which keeps the suite hermetic and leaves the network seam
  empty.
- **No HTML scraping.** `sources.ts` normalizes OpenAPI fragments and
  Postman-style collections; the scraped-table path is a stub.

## Why this one first

The blueprint rates it the highest-priority build after the auto-builder: the
most deterministic core, the clearest B2B pricing, and a blocker that a
validator plus a probe genuinely contains. That still holds — but note that the
two pieces a customer would pay for on day one, codegen and self-healing, are
the two that are missing.
