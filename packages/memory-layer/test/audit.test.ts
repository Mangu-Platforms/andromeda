import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { ConsentRegistry, DAY_MS } from "../src/consent.ts";
import { MemoryIndex, speakerRefFor, toCloudRecord } from "../src/memory-index.ts";
import { assertCloudPayload, cloudRecordIssues, CloudBoundaryError } from "../src/tiers.ts";
import type { Utterance } from "../src/memory-index.ts";

/**
 * Adversarial audit of the privacy claims.
 *
 * This product records other people, so the claims are not conveniences —
 * they are the reason it is publishable at all:
 *
 *   1. an utterance from a non-consenting speaker is neither indexed nor retrievable
 *   2. an entry past its retention window is not retrievable and is purgeable
 *   3. a hard delete leaves no retrievable residue
 *   4. raw text never crosses the cloud boundary
 *
 * Every test below tries to retrieve something the product promised nobody
 * could.
 */

const NOW = 1_700_000_000_000;

const utterance = (over: Partial<Utterance> = {}): Utterance => ({
  id: "utt-1",
  sessionId: "sess-1",
  speakerId: "alice",
  text: "The contract renewal is due on the fourteenth of March and Dana owns it.",
  at: NOW,
  placeId: "office",
  ...over,
});

function consenting(): ConsentRegistry {
  const registry = new ConsentRegistry();
  registry.grant("alice", NOW, 14);
  return registry;
}

test("a speaker who never consented is not indexed and cannot be retrieved", () => {
  const index = new MemoryIndex(consenting());

  const outcome = index.index(utterance({ speakerId: "stranger" }), { now: NOW });
  assert.equal(outcome.indexed, false);
  assert.equal(outcome.entryId, null);

  // And nothing about them is reachable by any route.
  assert.deepEqual(index.search("contract renewal", { now: NOW }), []);
  assert.deepEqual(index.cloudRecords(NOW), []);
  assert.ok(!index.retainedStrings().some((s) => s.includes("contract")));
});

test("revoking consent stops future indexing", () => {
  const registry = consenting();
  const index = new MemoryIndex(registry);

  assert.equal(index.index(utterance(), { now: NOW }).indexed, true);
  registry.revoke("alice", NOW + 1);

  const after = index.index(utterance({ id: "utt-2" }), { now: NOW + 2 });
  assert.equal(after.indexed, false, "a revoked speaker was still indexed");
});

test("an expired entry is not retrievable and purges cleanly", () => {
  const index = new MemoryIndex(consenting());
  const outcome = index.index(utterance(), { now: NOW });
  assert.equal(outcome.indexed, true);

  const later = NOW + 15 * DAY_MS; // retention was 14 days
  assert.deepEqual(index.search("contract renewal", { now: later }), []);
  assert.equal(index.get(outcome.entryId as string, later), null);
  // Not retrievable *before* it is purged: expiry is enforced at read time,
  // not only by a sweep that might never run.
  assert.deepEqual(index.cloudRecords(later), []);

  const purged = index.purgeExpired(later);
  assert.deepEqual(purged, [outcome.entryId]);
});

test("a hard delete leaves no retrievable residue", () => {
  const index = new MemoryIndex(consenting());
  const outcome = index.index(utterance(), { now: NOW });
  const entryId = outcome.entryId as string;

  assert.equal(index.forget(entryId), true);

  assert.equal(index.get(entryId, NOW), null);
  assert.deepEqual(index.search("contract renewal", { now: NOW }), []);
  assert.deepEqual(index.search("Dana", { now: NOW }), []);
  assert.deepEqual(index.cloudRecords(NOW), []);
  // The strongest form: no string held anywhere in the index still contains it.
  const retained = index.retainedStrings().join(" ");
  assert.ok(!retained.includes("contract"), "deleted text survived in the index");
  assert.ok(!retained.includes("Dana"), "deleted text survived in the index");
});

test("forgetting a speaker removes everything of theirs, and nothing of anyone else's", () => {
  const registry = consenting();
  registry.grant("bob", NOW, 14);
  const index = new MemoryIndex(registry);

  index.index(utterance({ id: "a1", speakerId: "alice", text: "Alice said the alpha thing." }), { now: NOW });
  index.index(utterance({ id: "b1", speakerId: "bob", text: "Bob said the bravo thing." }), { now: NOW });

  const removed = index.forgetSpeaker("alice");
  assert.equal(removed.length, 1);

  const retained = index.retainedStrings().join(" ");
  assert.ok(!retained.includes("alpha"), "alice's text survived");
  assert.ok(retained.includes("bravo"), "bob's text was collateral damage");
});

test("the speaker pseudonym is stable, salted, and not reversible by joining installs", () => {
  const a = speakerRefFor("alice", "install-salt-1");
  const b = speakerRefFor("alice", "install-salt-1");
  const c = speakerRefFor("alice", "install-salt-2");

  assert.equal(a, b, "the pseudonym must be stable within an install");
  assert.notEqual(a, c, "two installs must not produce the same pseudonym");
  assert.ok(!a.includes("alice"), "the pseudonym leaks the speaker id");

  // The separator between salt and id is a real NUL byte, so that
  // ("ab", "c") and ("a", "bc") cannot collide.
  assert.notEqual(speakerRefFor("c", "ab"), speakerRefFor("bc", "a"));
  const expected = `spk_${createHash("sha256")
    .update(`install-salt-1\u0000alice`)
    .digest("hex")
    .slice(0, 12)}`;
  assert.equal(a, expected);
});

test("raw text cannot cross the cloud boundary", () => {
  const index = new MemoryIndex(consenting());
  index.index(utterance(), { now: NOW });

  const records = index.cloudRecords(NOW);
  assert.equal(records.length, 1);

  const serialized = JSON.stringify(records);
  assert.ok(!serialized.includes("contract"), "transcript text reached the cloud projection");
  assert.ok(!serialized.includes("Dana"), "transcript text reached the cloud projection");
  assert.ok(!serialized.includes("alice"), "the raw speaker id reached the cloud projection");

  // And the boundary check accepts the legitimate projection.
  assert.doesNotThrow(() => assertCloudPayload(records));
});

test("an entry smuggled at the cloud boundary is refused structurally", () => {
  const index = new MemoryIndex(consenting());
  const outcome = index.index(utterance(), { now: NOW });
  const entry = index.get(outcome.entryId as string, NOW);
  assert.ok(entry);

  // The mistake this guards: handing the boundary a MemoryEntry instead of its
  // projection. It carries `text` and `speakerId`, and must be refused on
  // shape rather than on anyone remembering to call toCloudRecord.
  assert.throws(() => assertCloudPayload([entry]), CloudBoundaryError);
  assert.ok(cloudRecordIssues(entry).length > 0);

  // The correct projection of the same entry passes.
  assert.deepEqual(cloudRecordIssues(toCloudRecord(entry)), []);
});

test("hand-built payloads carrying transcript-shaped fields are refused", () => {
  const legitimate = toCloudRecord({
    entryId: "e1",
    utteranceId: "u1",
    sessionId: "s1",
    speakerId: "alice",
    speakerRef: "spk_abc",
    text: "secret",
    at: NOW,
    retentionUntil: NOW + DAY_MS,
    topics: ["contract"],
    vector: [0.1, 0.2],
    dataClass: "transcript",
  });

  for (const smuggled of [
    { ...legitimate, text: "secret" },
    { ...legitimate, speakerId: "alice" },
    { ...legitimate, transcript: "secret" },
    { ...legitimate, dataClass: "transcript" },
  ]) {
    assert.ok(
      cloudRecordIssues(smuggled).length > 0,
      `${Object.keys(smuggled).join(",")} was accepted at the boundary`,
    );
  }
});

test("search returns attributable results and nothing below the score floor", () => {
  const index = new MemoryIndex(consenting());
  index.index(utterance(), { now: NOW });
  index.index(
    utterance({ id: "u2", text: "We should reorder the espresso beans." }),
    { now: NOW },
  );

  const hits = index.search("contract renewal March", { now: NOW, limit: 5 });
  assert.ok(hits.length >= 1);
  const top = hits[0];
  // Every answer must be traceable to a source utterance and a time.
  assert.ok(top?.utteranceId);
  assert.ok(typeof top?.at === "number");
  assert.ok(top?.score !== undefined && top.score > 0);

  // An unrelated query must not dredge up the contract line on recency alone.
  const unrelated = index.search("bicycle tyre pressure", { now: NOW, minScore: 0.2 });
  assert.ok(!unrelated.some((h) => h.text.includes("contract")));
});
