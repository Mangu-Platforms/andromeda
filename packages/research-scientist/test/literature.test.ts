import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedClock } from "@andromeda/core";

import { CitationLedger, UngroundedError, assertGrounded } from "../src/literature/ledger.ts";
import { FixtureLiteratureSource } from "../src/literature/fixture.ts";
import { verifyDraft } from "../src/review/verify.ts";

test("a search admits its papers into the ledger and the record survives a checkpoint", async () => {
  const source = new FixtureLiteratureSource();
  const ledger = new CitationLedger(new FixedClock());

  const first = await ledger.runSearch(source, { terms: "sleep consolidation motor", limit: 3 });
  assert.equal(first.id, "search-001");
  assert.equal(first.keys.length, 3);
  assert.equal(ledger.size, 3);
  assert.equal(ledger.searchCount, 1);

  // The key is derived from the retrieved record, never from model output.
  assert.ok(ledger.has("okonkwo2019sleep"), `expected okonkwo2019sleep in ${ledger.keys().join(", ")}`);
  const entry = ledger.resolve("okonkwo2019sleep");
  assert.equal(entry?.sourceId, "fixture");
  assert.equal(entry?.paper.doi, "10.9999/jcnr.2019.0141");
  assert.deepEqual(entry?.seenIn, ["search-001"]);

  // A second search that returns the same paper reuses its key rather than
  // creating a second entry, so a bibliography cannot double-count.
  const second = await ledger.runSearch(source, { terms: "motor consolidation overnight", limit: 3 });
  assert.equal(second.id, "search-002");
  assert.ok(second.keys.includes("okonkwo2019sleep"));
  assert.deepEqual(ledger.resolve("okonkwo2019sleep")?.seenIn, ["search-001", "search-002"]);
  assert.ok(ledger.size <= 6);

  // A run that suspends for a human resumes against the papers it actually
  // retrieved, so the ledger has to round-trip through JSON unchanged.
  const revived = CitationLedger.fromSnapshot(
    JSON.parse(JSON.stringify(ledger.snapshot())) as ReturnType<CitationLedger["snapshot"]>,
  );
  assert.deepEqual(revived.keys(), ledger.keys());
  assert.equal(revived.searchCount, 2);
  assert.deepEqual(revived.resolve("okonkwo2019sleep"), ledger.resolve("okonkwo2019sleep"));
  assert.ok(revived.briefing().includes("restricted sleepers showed a 12 percent"));
});

test("nothing can be cited in a run that never searched", async () => {
  const ledger = new CitationLedger(new FixedClock());

  assert.throws(
    () => assertGrounded(ledger, "hypothesis"),
    (err: unknown) => err instanceof UngroundedError && /at least one completed literature search/.test((err as Error).message),
  );

  // The verifier refuses independently of the pre-flight check, so a draft
  // written from the model's own recollection cannot become a review even if
  // the pipeline forgot to call `assertGrounded`.
  const result = verifyDraft(
    {
      question: "Does sleep restriction impair motor consolidation?",
      summary: "It does.",
      claims: [
        {
          id: "c1",
          statement: "Sleep restriction impairs consolidation.",
          citations: [{ key: "okonkwo2019sleep", quote: "restricted sleepers showed a 12 percent smaller overnight improvement in tapping speed" }],
        },
      ],
      limitations: ["Small samples."],
    },
    ledger,
  );
  assert.equal(result.ok, false);
  assert.equal(result.review, null);
  assert.match(result.issues.join("\n"), /no literature search completed in this run/);

  // ...and once a search has run, grounding is satisfied.
  await ledger.runSearch(new FixtureLiteratureSource(), { terms: "sleep consolidation", limit: 2 });
  assert.doesNotThrow(() => assertGrounded(ledger, "hypothesis"));
});
