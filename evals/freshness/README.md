# Source-grounded freshness eval

Run it:

```
tsx evals/freshness/run.ts
```

It exits non-zero if the source-grounded strategy makes any wrong call, so it
doubles as a regression guard.

## What it measures

Every OpenWiki update run makes one decision per page:

- **REBUILD** the page, because the code it documents changed, or
- **SKIP** it, because nothing meaningful changed.

There are exactly two ways to get that wrong, and the eval counts both:

| Failure | What happened | Why it matters |
| --- | --- | --- |
| **Missed drift** | Skipped a page whose code changed | The wiki now describes code that no longer exists. Silent, and the wiki is trusted precisely when nobody is re-reading the source. **This is the one the feature exists to stop.** |
| **Wasted rebuild** | Rebuilt a page nothing changed for | An LLM run and a commit were spent producing a no-op diff. Merely expensive. |

## The three strategies

Each one is actually executed against real inputs; none of their decisions are
hard-coded.

| Strategy | Rule | Where it is used |
| --- | --- | --- |
| `content-hash` | Rebuild if the source **file's bytes** changed at all. | A naive file watcher. |
| `git-range` | Rebuild only if `git diff <last wiki commit>..HEAD` touches a non-wiki file. | **What OpenWiki ships today** (the pre-PR no-op check). |
| `source-grounded` | Rebuild only if the specific **definitions** a page cites changed meaning, ignoring comments and formatting. | **This PR.** |

Because the harness makes every edit itself, the correct rebuild-or-skip answer
is always known, so each strategy can be graded exactly.

## The four sections

Section 1 is the headline; the rest are supporting evidence.

1. **Turning silent staleness into detected staleness.** The feature is a
   detector, not a fixer: it does not write pages and does not assume the agent
   updates docs correctly. It changes whether a page's staleness is *detected* or
   stays *silent*, so this section measures detection accuracy over a labeled
   population. One real git repository, seeded from this repo's own `src/`: dozens
   of pages, each grounded in a real definition and placed in one of four
   situations (an even mix of genuinely stale and genuinely fresh). Each detector
   answers, per page, "does this still match the code it cites?" On
   `behind-cursor-drift` the change sits at or behind the cursor, so `git diff
   cursor..HEAD` is empty and git leaves the stale page silent; `source-grounded`
   compares fingerprints and detects it, with zero false alarms on the fresh
   half. The per-situation table is the assumption-free result; the aggregate
   silent-staleness and false-alarm rates use an illustrative 50/50 mix.

2. **The git blind spot, one mechanism at a time.** The same failure shown as
   individual real throwaway git repositories, one everyday history per row
   (`advanced-cursor` is Section 1's mechanism in miniature). Every decision is
   read back from real `git` and the real `getUpdateNoopStatus`. The
   `shipped-today` column is exactly what OpenWiki does now with this PR merged.

3. **Real repository, at scale (the cost side).** Parses this repo's own `src/`
   with the real resolver (hundreds of real definitions), grounds a page in a
   sample of them, and applies four realistic edits to each: a neighbor symbol
   changing, cosmetic comment/blank-line churn, a rename of the cited symbol, and
   a literal change inside it. This is where `content-hash`'s wasted rebuilds pile
   up and `source-grounded` stays perfect.

4. **The mechanism across languages.** Confirms the canonicalization tells
   semantic edits from cosmetic ones in TypeScript, JavaScript, Python, and Go:
   reformatting and comment edits stay `fresh`, behavior and signature changes go
   `stale`.

## Why git structurally cannot catch it

`git-range` is not buggy in Section 1: HEAD really does equal the recorded
cursor, so there is nothing in its diff. That is the point. Git's whole
vocabulary is "did bytes change in this commit range?" It has no way to ask "does
this page still match the code it cites?" Any time the cursor advances past a
change without the page being re-grounded, the page is stale and git is blind to
it. Source grounding asks the second question directly.

## Honest notes

- Section 1 measures detection, not repair. Whether a flagged page ever gets
  fixed depends on the (imperfect) agent and is deliberately out of scope; the
  claim is only that a stale page is detected instead of shipping silently. It
  models one realistic cause of drift (a run advanced the cursor without
  re-grounding every page). This is not a strawman: an LLM generation pass
  missing or skipping a page is exactly the failure the feature targets, and git
  offers no way to audit whether a pass actually refreshed everything it should
  have. Half the corpus is stale and half is genuinely fresh, so the section also
  proves source-grounded does not just flag everything (zero false alarms on the
  fresh half). The 50/50 mix is illustrative, not a field rate.
- The scale section skips any symbol whose mutation cannot be built precisely
  (for example a non-ASCII offset mismatch); it reports exactly how many
  definitions were sampled and how many edits ran, so nothing is silently
  dropped.
- On `reformat-commit`, `shipped-today` still rebuilds, because the current
  integration applies freshness only as a veto on the *skip* path; the git gate
  fires first on a cosmetic commit. The `source-grounded` column shows the
  fingerprints alone would have skipped it, i.e. the remaining win available if
  freshness also gates the rebuild path.
