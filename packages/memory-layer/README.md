# Real-Time Memory Augmentation — as software

A bring-your-own-device, privacy-first memory layer. It assumes somebody else's
microphone and provides the part that is hard to get right: where each piece of
processing may run, what may leave the user's own hardware, whose words may be
written down at all, and when a memory is allowed to surface.

## The blockers

The wearable's compute and thermal envelope, and the impossibility of reliable
continuous predictive intent. Both are answered by refusing the framing rather
than solving it — offload the compute, and replace prediction with explicit
triggers.

## The containment

**Tiered processing, metadata-only egress.** Stages declare their compute cost
and their data class. A stage exceeding the device tier's budget must be
scheduled on the edge, and raw audio may never cross the cloud boundary.
`assertCloudPayload` refuses a payload structurally rather than relying on
somebody remembering to call `toCloudRecord` — handing it a `MemoryEntry`
instead of its projection is caught on shape, because the entry carries `text`
and `speakerId`.

**Explicit triggers, opt-in proactivity.** No always-on inference. Recall fires
on a wake phrase, a calendar context or a location, and proactive surfacing is
opt-in per trigger type and defaults to off. With default settings, nothing
surfaces on its own.

**Consent and retention are enforced, not documented.** This product records
other people, so:

- An utterance from a non-consenting speaker is neither indexed nor retrievable
  by any route — search, direct get, or the cloud projection.
- Expiry is enforced at *read* time, not only by a sweep that might never run.
- A hard delete leaves no string containing the text anywhere in the index, and
  is surgical: a neighbour's memory survives.
- Speakers are pseudonymised per install as `sha256(salt ‖ NUL ‖ speakerId)`, so
  two installs cannot be joined on the pseudonym and the cloud cannot reverse it
  into a name it was never given.

> **Audit finding, fixed — and the one that would have shipped.** Search scored
> `semantic×0.5 + keyword×0.3 + recency×0.2` additively, so recency alone
> reached the default threshold: the query `"zzzz"` scored exactly 0.200 against
> a line about a contract renewal, with semantic 0 and keyword 0. Every fresh
> memory matched every query. For a product answering "what did she say about
> X?", confidently returning something she did not say about X is the failure
> that ends it. Results now require `MIN_TOPICAL_SIGNAL` before recency is
> allowed to speak — recency ranks relevant memories, it never creates
> relevance. The package's own delete test had been asserting the old behaviour.

> **Second finding, fixed.** `memory-index.ts` contained a *literal* NUL byte as
> that hash separator. The separator is correct and hashes are byte-identical
> after the change, but written as a raw byte it made git and grep treat the
> file as binary — diffs did not render in review and repository-wide greps
> skipped it silently. It is now a unicode escape.

## Retrieval

Deterministic hashed bag-of-words embeddings (256 dims), cosine similarity,
combined with keyword overlap and a recency half-life. No dependencies, no
network, no model. Every result is attributable to a source utterance and a
timestamp, because an unattributable memory is a rumour.

## What is not built

- **No transcription.** Whisper or an on-device ASR goes in front of this;
  `Utterance` is the input contract.
- **No device integrations.** PLAUD, Ray-Ban and phone-mic capture are all
  outside the package.
- **No speaker diarisation.** `speakerId` arrives already resolved, which is a
  substantial assumption given consent is keyed on it.
- **Embeddings are hashed, not learned.** Good enough to demonstrate the
  ranking and the controls; a real deployment wants a proper embedding model,
  which is also the point where "on-device" gets harder.

## Positioning

The market just consolidated — Limitless absorbed by Meta, Bee by Amazon — which
leaves an orphaned base of people who bought a memory device and would rather
own the memory. Sell the layer, not the hardware, and make the consent and
delete guarantees the reason to trust it.
