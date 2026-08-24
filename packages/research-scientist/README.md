# Autonomous Research Scientist

A co-scientist that produces citation-verified literature reviews and drafts
experiments. Positioned as a systematic-review accelerator with mandatory human
sign-off, never as an autonomous author.

## The blocker

Citation hallucination, which is not a rare failure — it is the characteristic
one. A model asked for supporting literature will produce plausible authors,
plausible venues and plausible DOIs, and the resulting bibliography is
indistinguishable from a real one until somebody checks every entry.

## The containment

**A bibliography is not written; it is derived.** `CitationLedger` records every
paper an actual `LiteratureSource` search returned, and a claim may only cite a
key that is in it. A model that invents a paper produces a key that does not
resolve. There is no method anywhere in the package that adds a ledger entry
from model output — `runSearch` is the only way in.

**Provenance alone decides.** The verifier never needs to know whether
`10.1145/3579837` exists in the world, only whether it matches the entry the
search produced. That is what makes the control cheap and total: it works
offline, against any corpus, without the verifier knowing anything about the
literature.

**A real paper cited for something it does not say is still a failure.** Every
citation carries a verbatim quote, checked against the abstract the source
returned — stored verbatim and never rewritten by a model. A quote lifted from
a different paper in the same ledger is refused. So is one below
`MIN_QUOTE_CHARS`, because a substring check with no length floor would accept
"the" and call the claim supported.

**Bounded experiments.** A hard max-iteration budget, a wall-clock timeout, and
multi-seed evaluation where a result holding on one seed is reported as not
reproducible.

**Nothing is publishable without a named human.** The pipeline suspends at an
`ApprovalGate` and the artifact is stamped with the reviewer.

> **Audit result: clean.** Twelve adversarial tests — invented keys, a
> real-looking DOI on a real entry, fabricated title and year, a quote the paper
> does not contain, a quote from the wrong paper, a too-short quote, an empty
> ledger, an uncited claim, a checkpoint round-trip, and a snapshot mutated to
> smuggle in a ghost paper. No defect found. Entries carry the ids of the
> searches that returned them, so a smuggled entry leaves no originating search
> and is detectable from the snapshot alone.

## Layout

```
literature/   the ledger, the source interface, an offline fixture corpus
experiment/   the bounded runner and its guard
review/       draft types and the citation verifier
sandbox/      execution boundary for experiment code
```

The ledger is plain data (`snapshot` / `fromSnapshot`), so a run that suspends
for a human and resumes days later verifies against exactly the papers it
retrieved rather than whatever an index returns today.

## What is not built

- **No real literature source.** `FixtureLiteratureSource` searches a small
  synthetic corpus. Semantic Scholar and OpenAlex go behind the same interface.
- **No figures, no LaTeX.** The deliverable is a structured review — question,
  sources, an evidence table, experiment results with seeds, and limitations.
- **No AI reviewer stage.** The blueprint's self-review node is not implemented.
- **Quote matching is normalized substring**, not semantic entailment. It
  catches fabrication, not subtle misreading of a real quote.

## Positioning

Sakana's own AI-Scientist-v2 papers reached workshop level at best, and its
authors say so. Sell this as the thing that makes a systematic review faster and
checkable, and keep the human sign-off in the product rather than in the
marketing.
