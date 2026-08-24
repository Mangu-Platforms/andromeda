# Autonomous Negotiator

Game-theoretic support for **salary and vendor-contract** negotiations. The
agent computes positions and drafts messages; a human sends and signs.

## Two blockers, two different containments

### Conversational anchoring

An LLM in a negotiation loop is anchorable. Show it an aggressive first offer, a
deadline, or a confident claim about market rates, and its sense of what is
acceptable moves. Prompting it to "be firm" does not fix this — firmness is a
disposition, and dispositions are what persuasion works on.

So the reservation value is not a disposition here. It is **computed before any
counterpart text exists, sealed with an HMAC, and re-verified on every
decision**, and the accept/counter/walk-away call is a pure function:

```ts
decide({ sealed, offer, key }): Decision
```

Note what is not a parameter: no message text, no model output, no provider, no
counterpart-authored string of any kind. There is no argument through which
persuasion could arrive, so persuasion cannot change the outcome. The model is
called once, afterwards, to write prose around a decision it had no part in
making.

The strongest attack left is to mutate the mandate itself. That fails the
integrity check and stops the run — `verifyMandate` runs before *every*
decision, not once at the start, so a mandate edited between rounds is caught at
the next decision rather than quietly negotiated against.

### Unauthorized practice of law

The FTC's 2025 order against DoNotPay — $193,000 in monetary relief and a
prohibition on advertising that the service performs like a lawyer without
evidence — makes this concrete. UPL is prohibited in all fifty states, and ABA
Formal Opinion 512 is explicit that AI cannot replace an attorney's professional
judgment.

`scope.ts` is the gate and it fails closed. Two lanes are allowed, `salary` and
`vendor_contract`; litigation, court proceedings, immigration, family law,
estates, IP disputes, criminal matters, employment claims, regulatory
proceedings, and direct requests for legal advice are **refused with a bar
referral rather than attempted**. Refusal happens before the mandate is built,
so an out-of-scope request costs no model call.

Matching is word-boundary based, so "issue" does not trip `sue` and "goodwill"
does not trip `will` — over-refusal is the intended bias, but only on real
signals, since refusing at random just teaches users to phrase around the
filter.

And the system never sends. Messages are drafts, every artifact carries a
non-removable disclaimer, and a human approves through `ApprovalGate` before
anything is released back to them to send under their own name.

## The game theory

No dependencies; all of it in `utility.ts` and `decide.ts`.

Every issue is oriented so a **higher raw value is better for the user**, which
is why a start date is modelled as "days until start". That one convention lets
a single formula serve both sides — the counterpart's utility is the complement
— and removes the per-issue direction flag that every call site would otherwise
get wrong.

- **BATNA** — probability-weighted best outside option. An option you probably
  cannot take is not worth its face value.
- **Reservation utility** — `max(BATNA + switching premium, declared floor)`.
  The declared floor is a hard limit, not a term in an average.
- **Concession schedule** — linear, boulware (decays slowly, collapses at the
  deadline) or conceder (gives most away early). All three descend to the
  reservation line and stop; none goes below it.
- **Log-rolling** — counters are built by conceding first where the user's cost
  per unit of counterpart gain is lowest, then pushed onto the Pareto frontier
  by pairwise trades until nothing better for both sides remains.

## What the tests prove

19 tests. The ones that matter:

- A lowball offer is refused identically at every round, with the reservation
  value and mandate digest unchanged.
- An "exploding offer" does not become acceptable by being final — the
  final-round question was answered before the negotiation opened.
- A mandate edited to lower the line fails the integrity check; re-sealing it
  with an attacker's key does not help.
- The seal is checked on round 2, not just round 1.
- No recommended counter is Pareto-dominated by an available alternative, and
  log-rolling beats a split-the-difference package.
- Legal matters are refused with a referral; the two supported lanes are not
  over-refused.
- A forged approval on resume cannot release the draft.

## What is not built

- **No dialogue loop.** One round per run: offers come in as structured terms,
  a draft goes out. Multi-round state across sessions is the workflow runner's
  job and is not wired up.
- **Offers are parsed by a human.** Terms arrive as a `Package`; nothing reads a
  counterpart's email and extracts numbers. That extraction step is where
  untrusted text would first enter, and it would need the quarantine treatment
  the computer-use package uses.
- **Counterpart weights are estimates.** They come from the user's market
  research and are never revised from what the counterpart says — a counterpart
  who calls an issue untouchable is making a claim, not supplying data. Useful
  discipline, but it means the Pareto analysis is only as good as the research.
- **No success-fee billing.** The blueprint proposes 10–15% of the first-year
  raise. Metering exists in the substrate; attribution of an outcome to this
  tool does not.

## Positioning

Never claim this performs like a lawyer, and do not extend it into legal
disputes on the strength of the model getting better. The lane restriction is
what keeps the product on the safe side of a rule that fifty state bars enforce,
and it is enforced in `scope.ts` rather than in the marketing copy.
