# Self-Updating Codebase Guardian

An async daemon that watches a repository and proposes dependency updates and
small refactors as risk-scored, test-gated pull requests. It never merges
anything a human did not approve, except patch-level version bumps.

## The blocker

Attention degrades across a long context, and a refactoring agent that has read
"the codebase" has usually read a truncated, lossy version of it. The second
half of the blocker is that unsafe refactors look exactly like safe ones until
something regresses in production.

## The containment

**Context is bounded independently of repository size.** A change is scoped to
the dependency subgraph of the files it edits — seeds, plus their importers and
imports, bounded by depth, file count and bytes. Seeds are non-negotiable: a
change whose own edited files overflow the budget is *refused*, because a
change no reviewer could hold in their head is not one to make from a truncated
copy of the code being rewritten.

> **Audit finding, fixed.** The file walk honoured this; the renderer did not.
> `renderScope` emitted `imported by: <every importer>`, so a hub file in a
> large repository put thousands of paths into the prompt however few files the
> walk admitted — 113,590 bytes against a 96,000-byte budget on a 5,000-file
> repo. The importer list is now limited to importers within the scope, with a
> count of the rest. Same change now renders ~5,100 bytes at 50, 500 and 5,000
> files.

**One change per proposal, behind a green run.** Each proposal carries exactly
one logical change and is only offered for review after the `CiRunner` comes
back green. Red CI means the proposal is dropped, not shown with a warning.

**Patch-only auto-merge.** `decideAutoMerge` is the policy layer, and only
patch-level semver bumps may merge unattended. Minor, major, prerelease,
downgrades and anything unparseable require a human. Pre-1.0 is parsed as a
patch bump by the version arithmetic and then blocked by the policy with an
explicit `pre-1.0` blocker — semver §4 promises nothing below 1.0.

The model's own recommendation is not an input to that decision. A proposal
whose body says `AUTO-MERGE: I verified this is completely safe` merges on
exactly the same evidence as one that does not.

## Layout

```
repo/      snapshot, index, and the scoping budget
change/    semver arithmetic, drafts, proposals
ci/        the test gate — a real local runner and a scripted fake
policy/    auto-merge policy and risk scoring
pipeline   the workflow: scope, draft, run CI, score, propose
```

## What is not built

- **No real VCS.** The repository is modelled as a `RepoSnapshot` of paths,
  exports and import edges. Reading a real git tree and opening a real pull
  request are both behind seams that have no implementation here.
- **No reachability analysis for CVEs.** Risk scoring knows whether a
  vulnerable dependency is imported, not whether the vulnerable *function* is
  called.
- **The import graph is declared, not parsed.** Snapshots carry import
  specifiers; nothing here parses TypeScript to derive them.

## Deploying it

Bind `CiRunner` to the repository's own CI rather than a local shell, and keep
the budget low — the scoping guarantee is what makes cost predictable per
change, and raising `maxFiles` to "just fit this one refactor" is how it
becomes unpredictable again.
