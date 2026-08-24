import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedClock } from "@andromeda/core";

import { CitationLedger } from "../src/literature/ledger.ts";
import { FixtureLiteratureSource } from "../src/literature/fixture.ts";
import { CitationVerificationError, assertVerified, verifyDraft } from "../src/review/verify.ts";
import type { DraftClaim, DraftReview } from "../src/review/types.ts";

const OKONKWO_QUOTE =
  "restricted sleepers showed a 12 percent smaller overnight improvement in tapping speed than controls";
const HALVORSEN_QUOTE =
  "we failed to reproduce the reported association between slow-wave sleep duration and overnight motor improvement";

async function groundedLedger(): Promise<CitationLedger> {
  const ledger = new CitationLedger(new FixedClock());
  await ledger.runSearch(new FixtureLiteratureSource(), {
    terms: "sleep consolidation motor slow wave",
    limit: 6,
  });
  return ledger;
}

const draftWith = (claims: DraftClaim[]): DraftReview => ({
  question: "Does restricting sleep impair overnight motor consolidation?",
  summary: "The original effect does not survive a multi-site replication.",
  claims,
  limitations: ["Every retrieved study measures a different motor task."],
});

test("a draft grounded in retrieved papers verifies, and its bibliography is derived", async () => {
  const ledger = await groundedLedger();
  const result = verifyDraft(
    draftWith([
      {
        id: "c1",
        statement: "One single-site study reported a consolidation deficit under sleep restriction.",
        citations: [
          { key: "okonkwo2019sleep", quote: OKONKWO_QUOTE, doi: "10.9999/jcnr.2019.0141", year: 2019 },
        ],
      },
      {
        id: "c2",
        statement: "A pre-registered multi-site replication did not reproduce it.",
        citations: [{ key: "halvorsen2022registered", quote: HALVORSEN_QUOTE }],
      },
    ]),
    ledger,
  );

  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  const review = result.review;
  assert.ok(review);
  assert.equal(review.evidence.length, 2);
  assert.equal(review.evidence[0]?.support[0]?.paper.title.startsWith("Sleep restriction"), true);

  // The bibliography is exactly the cited ledger entries: papers this run
  // retrieved but never cited must not appear, and nothing else can.
  assert.deepEqual(
    review.bibliography.map((e) => e.key),
    ["halvorsen2022registered", "okonkwo2019sleep"],
  );
  assert.ok(ledger.size > review.bibliography.length, "the run retrieved more than it cited");
});

test("a fabricated paper is refused however plausible it looks", async () => {
  const ledger = await groundedLedger();
  const result = verifyDraft(
    draftWith([
      {
        id: "c1",
        statement: "Sleep restriction halves consolidation gains.",
        citations: [
          {
            // Nothing in this run returned such a paper. The verifier does not
            // need to know whether it exists in the world.
            key: "nakamura2021hippocampal",
            quote: "sleep restriction halved overnight consolidation gains across all measured tasks",
            doi: "10.1038/s41593-021-00891-w",
            title: "Hippocampal replay and the consolidation of procedural memory",
            year: 2021,
          },
        ],
      },
    ]),
    ledger,
  );

  assert.equal(result.ok, false);
  assert.equal(result.review, null);
  assert.match(result.issues.join("\n"), /cites \[nakamura2021hippocampal\], which no literature search in this run returned/);

  // assertVerified is the form the pipeline uses: it fails closed, loudly.
  assert.throws(
    () =>
      assertVerified(
        draftWith([
          {
            id: "c1",
            statement: "Sleep restriction halves consolidation gains.",
            citations: [{ key: "nakamura2021hippocampal", quote: OKONKWO_QUOTE }],
          },
        ]),
        ledger,
      ),
    (err: unknown) => err instanceof CitationVerificationError && err.issues.length > 0,
  );
});

test("guessed metadata on a real key is caught even when the key resolves", async () => {
  const ledger = await groundedLedger();
  const result = verifyDraft(
    draftWith([
      {
        id: "c1",
        statement: "A single-site study reported a consolidation deficit.",
        citations: [
          {
            key: "okonkwo2019sleep",
            quote: OKONKWO_QUOTE,
            // Every identity assertion below is wrong; each is checked against
            // the record the search returned, not against plausibility.
            doi: "10.1038/s41586-019-1234-5",
            title: "Sleep loss and the consolidation of motor memory",
            year: 2018,
          },
        ],
      },
    ]),
    ledger,
  );

  assert.equal(result.ok, false);
  assert.equal(result.review, null);
  const issues = result.issues.join("\n");
  assert.match(issues, /with doi "10\.1038\/s41586-019-1234-5", but the retrieved record has doi "10\.9999\/jcnr\.2019\.0141"/);
  assert.match(issues, /but the retrieved record is titled/);
  assert.match(issues, /as 2018, but the retrieved record is 2019/);
});

test("a real paper attached to a claim its abstract does not support is refused", async () => {
  const ledger = await groundedLedger();
  const result = verifyDraft(
    draftWith([
      {
        id: "c1",
        statement: "Sleep restriction also increased error rates by 40 percent.",
        citations: [
          {
            key: "okonkwo2019sleep",
            // Fluent, on-topic, and nowhere in the abstract that was retrieved.
            quote: "restricted sleepers made 40 percent more sequence errors than controls overnight",
          },
        ],
      },
      {
        id: "c2",
        statement: "Replications disagree.",
        // A fragment short enough to match half the corpus is not evidence.
        citations: [{ key: "halvorsen2022registered", quote: "we failed" }],
      },
    ]),
    ledger,
  );

  assert.equal(result.ok, false);
  assert.equal(result.review, null);
  const issues = result.issues.join("\n");
  assert.match(issues, /that text does not appear in the abstract that search returned/);
  assert.match(issues, /at least 40 characters of the abstract are required/);
});

test("structural gaps in a draft fail closed rather than degrade", async () => {
  const ledger = await groundedLedger();

  const uncited = verifyDraft(
    draftWith([{ id: "c1", statement: "Sleep matters for consolidation.", citations: [] }]),
    ledger,
  );
  assert.equal(uncited.ok, false);
  assert.match(uncited.issues.join("\n"), /cites nothing/);

  const noLimitations = verifyDraft(
    {
      ...draftWith([
        {
          id: "c1",
          statement: "A replication failed to reproduce the effect.",
          citations: [{ key: "halvorsen2022registered", quote: HALVORSEN_QUOTE }],
        },
      ]),
      limitations: [],
    },
    ledger,
  );
  assert.equal(noLimitations.ok, false);
  assert.equal(noLimitations.review, null);
  assert.match(noLimitations.issues.join("\n"), /states no limitations/);

  const duplicateIds = verifyDraft(
    draftWith([
      {
        id: "c1",
        statement: "A replication failed to reproduce the effect.",
        citations: [{ key: "halvorsen2022registered", quote: HALVORSEN_QUOTE }],
      },
      {
        id: "c1",
        statement: "The original study found a deficit.",
        citations: [{ key: "okonkwo2019sleep", quote: OKONKWO_QUOTE }],
      },
    ]),
    ledger,
  );
  assert.equal(duplicateIds.ok, false);
  assert.match(duplicateIds.issues.join("\n"), /more than one claim/);
});
