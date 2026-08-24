# AI Computer Use Generalist

Auditable, injection-hardened browser automation for the long tail of web tasks
that have no API. Read-only work runs unattended; nothing irreversible happens
without a named human.

## The blocker

Indirect prompt injection, and it is not solved here — it is not solved
anywhere. Every page the agent reads is written by someone else, and any of it
can be addressed to the model. Published measurements put attack success against
GUI agents in the tens of percent at a single attempt and far higher under
repeated adaptive attempts, and both OpenAI and Anthropic have said publicly
that they expect it to remain unsolved.

So this package does not try to make the agent immune to being talked into
things. It assumes the agent *will* be talked into things, and removes what that
buys the attacker.

## The three controls

They are independent on purpose: each one is sufficient against a different
failure, and none depends on a model behaving well.

**1. The dual-LLM split** — `reader.ts` and `planner.ts`.

The reader sees untrusted page text and **cannot emit an action**, because the
only channel out of it is a `PageFacts` record and that type has no field
capable of expressing one. The planner emits actions and **never sees untrusted
text** — `buildPrompt` takes `PageFacts`, so handing it a `PageSnapshot` is a
compile error rather than a code-review question.

The strongest thing a fully compromised reader can do is produce a summary that
lies. It cannot produce a click. Extra fields, invented element handles, and
smuggled structure are all rejected by `sanitizeFacts`, and a rejection aborts
the run rather than being repaired — a malformed summary is what a successful
injection of the reader looks like from outside.

**2. The domain allowlist** — `policy/allowlist.ts`.

Hostname allowlist, decided by the same WHATWG parser the browser uses, checked
on the **landed** URL after every operation rather than on the URL that was
requested. That is the part that matters: a redirect, a meta refresh, or an
ordinary click can move the page after a perfectly allowlisted navigation.

Refused: subdomain and suffix lookalikes (`evil-example.com`,
`example.com.attacker.net`), embedded credentials (`https://example.com@evil.com`),
non-https schemes, IP literals in every encoding the parser canonicalises,
punycode and unicode lookalikes, non-default ports, and anything unparseable.
A malformed allowlist entry throws at construction, because an allowlist that
matches nothing looks exactly like one that works.

**3. The approval gate** — `pipeline.ts`.

Actions are classified read or write from the kind alone, computed here and
never taken from the model. Reads run unattended; **every write suspends for a
named human**. The classifier is an explicit membership test that defaults to
write, so an unknown kind — a typo, an invented capability, a future addition
nobody classified — is a write. On resume the pipeline re-reads the *stored*
approval rather than trusting the value it resumed with.

## What the tests actually prove

25 tests, offline and deterministic. The ones worth reading:

- Page text containing a forged `SYSTEM:` block, an "ignore all previous
  instructions", and an attacker URL reaches the reader and **never appears in
  the planner's prompt**.
- A compromised reader trying to add a `nextAction` field is rejected; so is one
  citing an element handle the page never offered.
- With the planner *fully compromised* — proposing exactly the wire transfer the
  page asked for — the run still stops at the approval gate with nothing
  clicked.
- A forged "approved" on resume does not authorise the write.
- A redirect off the allowlist, and a click that lands off it, are both caught.

## What is not built

- **The deterministic-flow recorder.** The blueprint's latency answer is to
  record a successful run as a replayable script and fall back to the model only
  on novel screens. Not implemented, so every step currently costs two model
  calls.
- **A real browser.** `BrowserDriver` has an offline scripted implementation
  only. A Playwright or CDP driver goes behind the same interface; `GuardedBrowser`
  wraps it unchanged.
- **Screenshots and vision.** Observation is text and an accessibility-style
  element list. A visual planner would need the same quarantine applied to
  images, which is harder and not attempted.
- **Per-tenant isolation.** One allowlist per agent, no notion of separate
  customers sharing an instance.

## Deploying it for real

The allowlist and the approval gate are the product; the browser is a
commodity. In production, put the driver in a disposable container per task,
keep the reader on a cheap model (it is called once per step and only
describes), and treat the audit log as the deliverable — an ops team buying this
is buying the ability to answer "what did it do, and who said yes".

Do not loosen the write gate on the strength of a model's injection resistance
improving. The gate is what makes the residual risk bounded rather than
unbounded, and the failure it prevents is the one that ends the engagement.
