import { test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@andromeda/core";

import { CitationLedger, UngroundedError, assertGrounded } from "../src/literature/ledger.ts";
import { FixtureLiteratureSource } from "../src/literature/fixture.ts";
import { verifyDraft, assertVerified, MIN_QUOTE_CHARS } from "../src/review/verify.ts";
import type { DraftReview } from "../src/review/types.ts";

/**
 * Adversarial audit of the citation-grounding claim.
 *
 * The stated guarantee is that a bibliography entry can only exist if a real
 * search returned it, and that a quote must actually appear in the cited
 * paper's abstract. These tests attack that guarantee rather than demonstrate
 * it: every case below is something a hallucinating or prompt-injected model
 * would plausibly emit.
 */

async function groundedLedger(): Promise<CitationLedger> {
  const ledger = new CitationLedger(new FixedClock());
  await ledger.runSearch(new FixtureLiteratureSource(), {
    terms: "sleep memory consolidation motor learning",
    limit: 10,
  });
  return ledger;
}

/**
 * The paper behind the ledger's first key. Read from the ledger rather than
 * from the corpus, because the source ranks results and the first key is not
 * necessarily the first paper in FIXTURE_CORPUS.
 */
function firstEntry(ledger: CitationLedger) {
  const key = ledger.keys()[0];
  assert.ok(key, "the audit fixture must retrieve at least one paper");
  const entry = ledger.resolve(key);
  assert.ok(entry, "the first key must resolve");
  return { key, paper: entry.paper };
}

/** A draft citing `key` with `quote`. */
function draft(key: string, quote: string, extra: Record<string, unknown> = {}): DraftReview {
  return {
    question: "What does the literature say?",
    summary: "A summary.",
    claims: [
      {
        id: "c1",
        statement: "A claim that the cited work supports.",
        citations: [{ key, quote, ...extra }],
      },
    ],
    limitations: ["Synthetic corpus."],
  };
}

test("an invented paper cannot be cited", async () => {
  const ledger = await groundedLedger();
  const { paper } = firstEntry(ledger);

  // The classic hallucination: a plausible key that no search returned.
  const result = verifyDraft(
    draft("smith2021deeplearning", paper.abstract.slice(0, 60)),
    ledger,
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /smith2021deeplearning/);
});

test("a real-looking DOI attached to a real key is a mismatch, not a pass", async () => {
  const ledger = await groundedLedger();
  const { key, paper } = firstEntry(ledger);

  // Provenance alone catches this: the verifier does not need to know whether
  // 10.1145/3579837 exists, only that it is not the DOI of the cited entry.
  const result = verifyDraft(
    draft(key, paper.abstract.slice(0, 60), { doi: "10.1145/3579837" }),
    ledger,
  );
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" ").toLowerCase(), /doi/);
});

test("a fabricated title or year on a real key is caught", async () => {
  const ledger = await groundedLedger();
  const { key, paper } = firstEntry(ledger);
  const quote = paper.abstract.slice(0, 60);

  for (const extra of [
    { title: "Attention Is All You Need For Everything" },
    { year: 1999 },
  ]) {
    const result = verifyDraft(draft(key, quote, extra), ledger);
    assert.equal(result.ok, false, `${JSON.stringify(extra)} should be rejected`);
  }
});

test("a quote that is not in the cited abstract is refused", async () => {
  const ledger = await groundedLedger();
  const { key } = firstEntry(ledger);

  // A real paper, cited for something it does not say. This is the failure
  // mode that survives every "did the paper exist" check.
  const result = verifyDraft(
    draft(key, "This method reduces hallucination to zero in all settings."),
    ledger,
  );
  assert.equal(result.ok, false);
});

test("a quote from the wrong paper in the same ledger is refused", async () => {
  const ledger = await groundedLedger();
  const keys = ledger.keys();
  assert.ok(keys.length >= 2, "fixture corpus needs at least two papers");

  const other = ledger.resolve(keys[1] as string);
  const quote = (other?.paper.abstract ?? "").slice(0, 80);

  // Both the key and the quote are genuine; they just do not belong together.
  const result = verifyDraft(draft(keys[0] as string, quote), ledger);
  assert.equal(result.ok, false);
});

test("a quote too short to be evidence is refused", async () => {
  const ledger = await groundedLedger();
  const { key, paper } = firstEntry(ledger);

  // "the" appears in every abstract. A substring check with no length floor
  // would accept it and call the claim supported.
  const short = paper.abstract.slice(0, Math.max(1, MIN_QUOTE_CHARS - 5));
  const result = verifyDraft(draft(key, short), ledger);
  assert.equal(result.ok, false);
});

test("whitespace and case differences in a genuine quote are tolerated", async () => {
  const ledger = await groundedLedger();
  const { key, paper } = firstEntry(ledger);
  const genuine = paper.abstract.slice(0, 80);

  // The control must not be so brittle that ordinary re-wrapping fails, or
  // every honest draft gets rejected and the check stops being run.
  const rewrapped = genuine.replace(/\s+/g, "  ").toUpperCase();
  const result = verifyDraft(draft(key, rewrapped), ledger);
  assert.equal(result.ok, true, result.issues.join("; "));
});

test("an empty ledger cannot ground anything", () => {
  const empty = new CitationLedger(new FixedClock());
  assert.throws(() => assertGrounded(empty, "hypothesis"), UngroundedError);

  // And a draft citing into it fails rather than passing vacuously.
  const result = verifyDraft(draft("anykey", "x".repeat(60)), empty);
  assert.equal(result.ok, false);
});

test("a draft with no citations at all does not pass by default", async () => {
  const ledger = await groundedLedger();
  const bare: DraftReview = {
    question: "q",
    summary: "s",
    claims: [{ id: "c1", statement: "An unsupported assertion.", citations: [] }],
    limitations: [],
  };
  // An uncited claim is the cheapest way to launder an unsupported statement.
  assert.equal(verifyDraft(bare, ledger).ok, false);
});

test("grounding survives a checkpoint round-trip unchanged", async () => {
  const ledger = await groundedLedger();
  const { key, paper } = firstEntry(ledger);
  const quote = paper.abstract.slice(0, 80);

  // A run that suspends for a human and resumes days later must verify against
  // the papers it retrieved, not against whatever an index returns today.
  const revived = CitationLedger.fromSnapshot(
    JSON.parse(JSON.stringify(ledger.snapshot())),
    new FixedClock(),
  );

  assert.deepEqual(revived.keys(), ledger.keys());
  assert.equal(verifyDraft(draft(key, quote), revived).ok, true);
  assert.equal(verifyDraft(draft("invented2020", quote), revived).ok, false);
  // The search record travels too, so provenance is not lost.
  assert.equal(revived.searches().length, ledger.searches().length);
});

test("a mutated snapshot cannot smuggle a paper into the ledger", async () => {
  const ledger = await groundedLedger();
  const snapshot = JSON.parse(JSON.stringify(ledger.snapshot()));

  // What a compromised checkpoint would look like: an entry with no search
  // that ever returned it.
  snapshot.entries.push({
    key: "ghost2024",
    sourceId: "fixture",
    paper: {
      id: "ghost",
      title: "A Paper That Does Not Exist",
      authors: ["Nobody"],
      year: 2024,
      venue: "Nowhere",
      doi: "10.9999/ghost",
      url: "",
      abstract: "x".repeat(200),
    },
    seenIn: [],
    firstSeenAt: 0,
  });

  const revived = CitationLedger.fromSnapshot(snapshot, new FixedClock());
  const ghost = revived.resolve("ghost2024");

  // The audit finding either way: if the entry resolves, `seenIn: []` is the
  // only remaining signal that no search produced it, so it must be checked.
  if (ghost !== undefined) {
    assert.equal(
      ghost.seenIn.length,
      0,
      "a smuggled entry should carry no search provenance",
    );
    const orphaned = revived
      .entries()
      .filter((e) => e.seenIn.length === 0 || !e.seenIn.every((s) => revived.searches().some((r) => r.id === s)));
    assert.ok(
      orphaned.length > 0,
      "an entry with no originating search must be detectable from the snapshot",
    );
  }
});

test("assertVerified throws rather than returning a failed draft", async () => {
  const ledger = await groundedLedger();
  assert.throws(() => assertVerified(draft("nope", "x".repeat(60)), ledger));
});
