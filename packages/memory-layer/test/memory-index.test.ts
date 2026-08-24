import { test } from "node:test";
import assert from "node:assert/strict";

import { ConsentRegistry, DAY_MS } from "../src/consent.ts";
import { MemoryIndex, sanitizeTopics, type Utterance } from "../src/memory-index.ts";
import { assertCloudPayload, CloudBoundaryError } from "../src/tiers.ts";

const NOW = 1_700_000_000_000;
const daysAgo = (n: number) => NOW - n * DAY_MS;

const say = (over: Partial<Utterance> & { id: string; speakerId: string; text: string }): Utterance => ({
  sessionId: "standup",
  at: daysAgo(1),
  placeId: "office",
  ...over,
});

function harness(): { consent: ConsentRegistry; index: MemoryIndex } {
  const consent = new ConsentRegistry();
  consent.grant("owner", daysAgo(30), 365);
  consent.grant("dana", daysAgo(30), 365);
  const index = new MemoryIndex(consent, { salt: "test-install" });
  return { consent, index };
}

test("an utterance from a non-consenting speaker is neither indexed nor retrievable", () => {
  const { consent, index } = harness();

  const refused = index.index(
    say({ id: "u1", speakerId: "stranger", text: "the merger closes on Tuesday" }),
    { now: NOW },
  );
  assert.equal(refused.indexed, false);
  assert.equal(refused.entryId, null);
  assert.match(refused.reason, /consent state is unknown/);
  assert.equal(index.size, 0);

  // Not merely filtered at query time — the words were never written down.
  assert.deepEqual(index.search("merger Tuesday", { now: NOW }), []);
  assert.ok(!index.retainedStrings().some((s) => s.includes("merger")));

  // An explicit refusal is not consent either.
  consent.revoke("stranger", daysAgo(1));
  assert.equal(
    index.index(say({ id: "u2", speakerId: "stranger", text: "the merger closes" }), { now: NOW })
      .indexed,
    false,
  );
  assert.equal(index.size, 0);

  // And a speaker who did agree is indexed, with model-supplied topics
  // normalised rather than trusted: a whole sentence is not a topic.
  const ok = index.index(say({ id: "u3", speakerId: "dana", text: "the warehouse invoice is due" }), {
    now: NOW,
    topics: ["Invoices!", "the warehouse invoice is due on Friday", "invoices", 42 as unknown as string],
  });
  assert.equal(ok.indexed, true);
  assert.equal(ok.entryId, "mem_u3");
  assert.deepEqual(index.get("mem_u3", NOW)?.topics, ["invoices"]);
  assert.deepEqual(sanitizeTopics(["a b c d e", "roof-repair"]), ["roof-repair"]);
});

test("revoked consent and expired retention both remove reach, and purge reclaims", () => {
  const { consent, index } = harness();
  consent.grant("chris", daysAgo(20), 7); // short retention, granted

  index.index(say({ id: "u1", speakerId: "dana", text: "warehouse lease renewal in March" }), {
    now: NOW,
  });
  index.index(
    say({ id: "u2", speakerId: "chris", text: "warehouse alarm code changed", at: daysAgo(10) }),
    { now: NOW },
  );
  assert.equal(index.size, 2);

  // u2 was captured 10 days ago under a 7-day retention: already unreachable,
  // before anyone has swept.
  const found = index.search("warehouse", { now: NOW });
  assert.deepEqual(found.map((r) => r.entryId), ["mem_u1"]);
  assert.equal(index.get("mem_u2", NOW), null);

  // Revocation reaches backwards over what was already captured.
  consent.revoke("dana", NOW);
  assert.deepEqual(index.search("warehouse", { now: NOW }), []);
  assert.equal(index.get("mem_u1", NOW), null);
  assert.equal(index.cloudRecords(NOW).length, 0);

  const purged = index.purgeExpired(NOW);
  assert.deepEqual(purged, ["mem_u1", "mem_u2"]);
  assert.equal(index.size, 0);
  assert.deepEqual(index.retainedStrings(), []);
});

test("a hard delete leaves no retrievable residue", () => {
  const { index } = harness();
  const secret = "the passphrase is orange marmalade";
  index.index(say({ id: "u1", speakerId: "dana", text: secret }), {
    now: NOW,
    topics: ["passphrase"],
  });
  index.index(say({ id: "u2", speakerId: "owner", text: "remember to buy marmalade" }), { now: NOW });

  assert.equal(index.search("passphrase", { now: NOW })[0]?.entryId, "mem_u1");

  assert.equal(index.forget("mem_u1"), true);
  assert.equal(index.forget("mem_u1"), false, "a second delete is a no-op, not an error");

  assert.equal(index.get("mem_u1", NOW), null);
  // The deleted line is unreachable by its own words...
  assert.deepEqual(index.search("passphrase orange", { now: NOW }), []);
  // ...and the neighbour is still reachable by its own. This previously
  // asserted that "passphrase orange" returned mem_u2, which shares no tokens
  // with "remember to buy marmalade" — it matched on recency alone, which is
  // the behaviour MIN_TOPICAL_SIGNAL now refuses.
  assert.deepEqual(index.search("marmalade", { now: NOW }).map((r) => r.entryId), ["mem_u2"]);
  assert.equal(index.cloudRecords(NOW).some((r) => r.entryId === "mem_u1"), false);

  // Nothing derived from the deleted line survives anywhere in the index: not
  // the text, not its tokens, not its topics, not its posting-list entries.
  const residue = index.retainedStrings();
  for (const gone of ["passphrase", "orange", "mem_u1", "u1", secret]) {
    assert.ok(!residue.includes(gone), `"${gone}" survived a hard delete`);
  }
  // The untouched neighbour is intact, so deletion was surgical rather than a
  // convenient wipe.
  assert.ok(residue.includes("marmalade"));
  assert.equal(index.size, 1);

  assert.deepEqual(index.forgetSpeaker("owner"), ["mem_u2"]);
  assert.deepEqual(index.retainedStrings(), []);
});

test("ranking blends similarity, keywords and recency, and every result is attributable", () => {
  const { index } = harness();
  const lines: Array<[string, string, number]> = [
    ["u1", "Dana said the warehouse invoice is due on Friday", 2],
    ["u2", "the warehouse roof repair quote arrived", 1],
    ["u3", "that invoice was paid already", 10],
    ["u4", "lunch with Sam at the noodle place", 1],
  ];
  for (const [id, text, age] of lines) {
    index.index(say({ id, speakerId: "dana", text, at: daysAgo(age) }), { now: NOW });
  }

  const results = index.search("warehouse invoice", { now: NOW, limit: 3 });
  assert.equal(results.length, 3);

  const top = results[0];
  assert.ok(top);
  assert.equal(top.entryId, "mem_u1");
  // Attribution: which utterance, from whom, in which session, and when.
  assert.equal(top.utteranceId, "u1");
  assert.equal(top.speakerId, "dana");
  assert.equal(top.sessionId, "standup");
  assert.equal(top.at, daysAgo(2));
  assert.match(top.text, /warehouse invoice/);
  // Both query terms hit, and the score is explainable term by term.
  assert.equal(top.keyword, 1);
  assert.ok(top.semantic > 0);
  assert.ok(Math.abs(top.score - (0.5 * top.semantic + 0.3 * top.keyword + 0.2 * top.recency)) < 1e-9);

  // The unrelated line does not make the cut at all.
  assert.ok(!results.some((r) => r.entryId === "mem_u4"));

  // Recency is a real term: same words, fresher line wins.
  const { index: recencyIndex } = harness();
  const text = "the quarterly budget spreadsheet is finished";
  recencyIndex.index(say({ id: "old", speakerId: "dana", text, at: daysAgo(12) }), { now: NOW });
  recencyIndex.index(say({ id: "new", speakerId: "dana", text, at: daysAgo(1) }), { now: NOW });
  const byRecency = recencyIndex.search("budget spreadsheet", { now: NOW });
  assert.deepEqual(byRecency.map((r) => r.entryId), ["mem_new", "mem_old"]);
  assert.ok((byRecency[0]?.recency ?? 0) > (byRecency[1]?.recency ?? 1));
  assert.equal(byRecency[0]?.semantic, byRecency[1]?.semantic);

  // Same query, same answer, every time.
  assert.deepEqual(index.search("warehouse invoice", { now: NOW, limit: 3 }), results);

  // A whole entry is not a cloud record; only its projection is.
  const entry = index.get("mem_u1", NOW);
  assert.ok(entry);
  assert.throws(() => assertCloudPayload([entry]), CloudBoundaryError);
  assert.doesNotThrow(() => assertCloudPayload(index.cloudRecords(NOW)));
});

test("search stays interactive over a few thousand entries", () => {
  const consent = new ConsentRegistry();
  consent.grant("dana", daysAgo(400), 3650);
  const index = new MemoryIndex(consent, { salt: "bench" });

  const nouns = ["invoice", "warehouse", "lease", "roof", "quote", "budget", "vendor", "shipment"];
  const verbs = ["approved", "delayed", "renewed", "cancelled", "signed", "queried"];
  const total = 3_000;
  for (let i = 0; i < total; i++) {
    const noun = nouns[i % nouns.length];
    const verb = verbs[i % verbs.length];
    index.index(
      say({
        id: `u${i}`,
        speakerId: "dana",
        sessionId: `session-${i % 40}`,
        text: `the ${noun} for project ${i} was ${verb} by the ${nouns[(i + 3) % nouns.length]} team`,
        at: daysAgo((i % 300) + 1),
      }),
      { now: NOW },
    );
  }
  assert.equal(index.size, total);

  const queries = [
    "warehouse lease renewed",
    "invoice project 1234",
    "vendor shipment delayed",
    "roof quote signed",
  ];
  // Warm up so the assertion measures steady-state work rather than first-call
  // JIT, then take the worst of several runs.
  for (const q of queries) index.search(q, { now: NOW });

  let worstMs = 0;
  for (let round = 0; round < 5; round++) {
    for (const q of queries) {
      const started = performance.now();
      const hits = index.search(q, { now: NOW, limit: 5 });
      worstMs = Math.max(worstMs, performance.now() - started);
      assert.ok(hits.length > 0);
    }
  }

  // Recall is on the interaction path: a wake phrase that takes a quarter of a
  // second to answer is a feature nobody uses. Generous headroom so the bound
  // is a regression tripwire, not a flake.
  assert.ok(worstMs < 150, `slowest search over ${total} entries was ${worstMs.toFixed(1)}ms`);
});
