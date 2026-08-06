# Mutation-based freshness eval

Answers one question: **when source changes in a way that should make a wiki
page stale, does OpenWiki's freshness check flag the right pages, and does it
leave the pages it should not touch alone?**

It measures source-grounded staleness detection and nothing else. It does **not**
measure hallucination or overall wiki factual accuracy.

## Run it

```
tsx evals/freshness-mutation/run.ts            # summary to stdout
tsx evals/freshness-mutation/run.ts --json     # also write results.json
```

The deterministic core also runs in CI via `test/staleness/mutation-eval.test.ts`.

Exit code is non-zero when the head-to-head claim breaks, a category-1 case
fails, the durability case fails, or the coverage pass produces a false positive.

## The headline: without vs with source freshness

The first section is a literal head-to-head of OpenWiki's real update gate
**without** source freshness against **with** source freshness, on the same
repo, wiki, and mutations. The only variable between the two arms is whether
recorded sidecars exist.

The corpus is OpenWiki's own wiki and source: real pages under `openwiki/` are
grounded in real symbols from `src/` using the production recorder, so the
sidecars are the ones OpenWiki itself would author, not hand-written. Ground
truth (which page each mutation should stale) is hand-labeled in
`HEAD_TO_HEAD_CASES`, never taken from the agent or the sidecars.

**No model is invoked.** Today source freshness only ever runs inside the
deterministic `getUpdateNoopStatus` gate (`src/agent/utils.ts`), as a skip-veto,
*after* Git has already reported nothing meaningful moved. So the entire
difference between the arms lives in that gate, and the eval measures it
directly. "Recovered" / "run triggered" means the real gate decided to run
(`shouldSkip === false`). Whether the agent then repairs the page is out of
scope: it is the same agent in both arms once a run is triggered, so it cannot
be the differentiator. Because the differentiator is deterministic, this
head-to-head is fast and reproducible rather than token-costed.

The claim under test:

> Git is sufficient while the relevant change is still visible. Source freshness
> makes stale state durable after Git no longer contains the evidence needed to
> rediscover it.

The table it produces:

| Situation                                | Without freshness | With freshness |
| ---------------------------------------- | ----------------- | -------------- |
| Normal in-range change (run triggered)   | 5/5               | 5/5            |
| Stale page after Git cursor advanced     | 0/5 recovered     | 5/5 recovered  |
| Cosmetic/unrelated edit, cursor advanced | 0/3 spurious      | 0/3 spurious   |
| Median added preflight cost              | —                 | ~6 ms          |

In-range changes are byte-identical across arms (Git still sees the change, so
freshness is never consulted). The behind-cursor row is the product claim: once
the Git cursor advances past an unrepaired change so `git diff` is empty, only
the with-freshness arm still forces a run, because the sidecar disagrees with the
source. The controls confirm freshness adds no spurious reruns.

## Real-agent head-to-head (`agent-head-to-head.ts`)

The deterministic head-to-head above measures the update **gate**. This one
measures the **whole update**: it invokes the real update agent in both arms and
compares the final synchronized wiki. The question is the product one, "given
the same realistic code change, does OpenWiki maintain the wiki better WITH
source freshness than WITHOUT?", not "does the gate decide to run?".

Both arms run `runOpenWikiAgent("update", …)` against an isolated throwaway copy
of a small but architecturally real HTTP-client library (`Flux`) and its
hand-authored conceptual wiki. The library is deliberately multi-module —
config resolution, a pluggable auth strategy, retry/backoff, a transport, a
client that wires them together, and an error model — so a realistic change
touches real functions and classes across files. The wiki has seven conceptual
pages (quickstart, architecture, configuration, authentication, retries, client,
errors), each grounded in real symbols. The **only** variable between the arms
is whether recorded source-dependency sidecars exist:

- **WITHOUT**: no sidecars, so freshness contributes nothing and the agent must
  infer which pages a change affects from the git diff alone (the pre-feature
  behavior).
- **WITH**: real sidecars from the production recorder, so the update gate hands
  the agent an explicit "these pages must be revalidated" list.

The git diff is identical and available to both arms, so any difference is
attributable to the source→page routing the recorded dependencies provide.

The changes under test are **behavioral and architectural, not constant
tweaks** — this is the whole point. A constant that appears verbatim in the
docs is trivially routable from the diff; a contract flip or a moved
responsibility is not, and a page can be stale without quoting the line that
changed.

Ground truth is hand-labeled per scenario and never taken from the agent or the
sidecars. Each expected-affected page carries a `staleMarker` (a substring a
correct update must remove) and/or a `requiredMarker` (a substring a correct
update must add, for changes where the page must now describe new behavior).
Grading is a content oracle — a page is correctly updated when its stale marker
is gone and its required marker present. An edit to a **source-grounded** page
outside the expected set is an unnecessary update; generated/operational pages
(`index.md`, `log.md`, `_plan.md`, `INSTRUCTIONS.md`) are excluded via the
production `isSourceGroundedPage`, so they never distort the metric. Wall time
is captured around each run. Token/cost is **not** reported: the telemetry
record does not surface per-run token counts, and adding a provider-usage hook
was out of scope.

Scenarios:

- `behind-cursor` (durability) — `shouldRetry` starts retrying HTTP 429, then
  the change is committed and the update cursor advanced past it so `git diff`
  is empty. The only scenario where the arms *must* diverge (see below).
- `auth-async` (behavioral) — the auth contract flips from a synchronous Bearer
  header (`AuthStrategy.apply`) to async request signing
  (`AuthStrategy.authenticate`), touching the interface, the auth class, and the
  client call site.
- `add-middleware` (feature addition) — a request/response middleware layer is
  added across new modules, a config option, the client pipeline, the barrel,
  and a test (~10 files); pages must now describe it.
- `move-retries` (cross-cutting refactor) — the retry responsibility moves out
  of `HttpClient` into a dedicated retrying-transport module; several pages that
  describe where retries live must move together.
- `remove-env-config` (feature removal) — `FLUX_*` environment-variable
  configuration is removed, so documentation describing the env vars and their
  precedence becomes actively wrong and must be forgotten.

### Recall vs. precision (validated deterministically, no agent)

Before any agent runs, the freshness pipeline itself is exercised on every
scenario deterministically (see `scratchpad`/`validate.ts` pattern): record the
sidecars, apply the change, run the real `checkWikiFreshness`, and compare the
flagged pages to the hand-labeled expected set. The result:

- **Recall is 100%** on all five scenarios — every page that a human labeled as
  needing an update is flagged non-fresh.
- **Precision is imperfect and realistically so.** Definition-level tracking
  over-approximates: pages grounded on a widely cited symbol (e.g. `HttpClient`)
  are flagged whenever that symbol changes, even when the specific claim on that
  page still holds. `auth-async` over-flags `quickstart`/`retries`;
  `add-middleware` over-flags three; `move-retries` over-flags one;
  `behind-cursor` and `remove-env-config` are perfectly precise.

This is why the real-agent head-to-head measures both sides: the WITH arm gets
better **recall** (it is told about stale pages the diff alone would not reveal),
but pays a **precision cost** (it is asked to revalidate pages that may not need
changes, which can turn into unnecessary edits). The head-to-head captures both.

### Where the arms diverge, and where they may not

`behind-cursor` is the clearest separation: the change is committed and the
cursor moved past it, so `git diff` is empty. The WITHOUT arm's gate then skips
(no git change, no sidecar) and leaves the page stale forever; the WITH arm's
sidecar disagrees with the source, forces a run, and hands the agent the stale
page to repair.

For the in-range scenarios the change is left uncommitted, so git sees it in
both arms. Whether the WITHOUT arm then misses any pages depends on how obvious
the source→page mapping is from the diff: freshness helps most when a stale page
does not textually correspond to the changed file.

### Measured result

Running the full matrix against a real provider (Anthropic), on realistic
behavioral/architectural changes rather than constants:

| Scenario                    | WITHOUT (correct/expected) | WITH (correct/expected) | Divergence |
| --------------------------- | -------------------------- | ----------------------- | ---------- |
| behind-cursor (durability)  | 0/1 (gate skips)           | 1/1 (repaired)          | **WITH wins** |
| auth-async (behavioral)     | 3/3                        | 3/3                     | tie        |
| add-middleware (feature)    | 3/3                        | 3/3                     | tie        |
| move-retries (refactor)     | 3/3                        | 3/3                     | tie        |
| remove-env-config (removal) | 2/2                        | 2/2                     | tie        |

Two honest conclusions:

1. **In-range, the arms tie on correctness across every realistic change.** Even
   for a contract flip, a cross-cutting refactor, a spanning feature addition,
   and a feature removal, the WITHOUT arm correctly repaired *every* expected
   page. On a seven-page wiki the agent reads all pages and routes a complex
   change correctly from the git diff alone; the recorded stale-page list does
   not change which pages get repaired. WITH is consistently slower (e.g.
   add-middleware 202s vs 122s), the cost of the extra preflight, revalidation,
   and re-recording.
2. **The mechanism's decisive, unique value is durability.** `behind-cursor` is
   the only scenario where the outcome differs: once the change is committed and
   the git cursor advances, the WITHOUT arm skips entirely and the doc stays
   wrong forever, while the WITH arm's sidecar still flags the page and repairs
   it. This holds for a real behavioral change, not just a constant.

Caveat on the **unnecessary-edits** count: on a wiki this small the agent
rewrites nearly every page once it runs, regardless of arm. In `behind-cursor`
freshness flagged only `retries.md` (perfect precision, per
`validate-scenarios.ts`), yet the agent still edited all six other pages. So the
"extra" column reflects the agent's global-rewrite habit, not freshness
precision. Measuring the real precision *cost* (unnecessary edits attributable
to over-flagging) needs a wiki large enough that the agent is selective — the
Tier B corpus below, still deliberately unwired.

### Run it

```
tsx evals/freshness-mutation/agent-run.ts                    # behind-cursor only (cheap smoke)
tsx evals/freshness-mutation/agent-run.ts --all              # full five-scenario matrix
tsx evals/freshness-mutation/agent-run.ts --scenario=auth-async
tsx evals/freshness-mutation/agent-run.ts --all --json       # + agent-results.json (0600, gitignored)
```

This calls the configured provider, so it costs tokens and wall time and is
**not** part of CI. It needs `~/.openwiki/.env` to have a provider configured.
All filesystem state stays in `os.tmpdir()` throwaway git repos.

## The two categories, kept separate

The point of the split is that a missing dependency can never be mistaken for a
broken checker.

**1. Deterministic mechanism.** We write a known-correct sidecar, change the
cited symbol, and assert the page goes not-fresh (and that unrelated changes
leave it fresh). This isolates the checker from the agent, so it should be 100%.
A failure here means the machinery itself is broken. This is the CI regression
core.

**2. End-to-end coverage.** The real production recorder grounds pages in real
symbols from this repo's own `src/`, then a semantic change is applied (must be
detected) and a cosmetic change is applied (must stay fresh). Because category 1
already proves the checker sound, a miss here is a dependency-coverage gap in
what was grounded, not a checker bug. Judging the *agent's* symbol-selection
judgment needs a real generated wiki with committed sidecars (Tier B, below).

## What each case does

Per case: build a throwaway repo in a known-fresh state (asserted, so a dirty
baseline fails loudly), apply exactly one byte-level mutation, run the real
`checkWikiFreshness`, and compare the actual page states to an expectation the
eval defines independently. Nothing lets OpenWiki generate its own ground truth.
The temp repo is thrown away per case, so no state leaks.

Mutations are byte-level only (a verified tree-sitter splice, or a whole-file
overwrite with a known variant). Mutated source is never evaluated or executed.

### Mutation kinds

Positive (page should become not-fresh):

- `constant-change` / `python-constant-change`: a cited literal changes → `stale`
- `signature-change`: a cited method's signature changes → `stale`
- `body-change`: a cited method's body changes meaning → `stale`
- `rename`: the cited symbol is renamed → `unknown` (the anchor moved)
- `delete`: the cited symbol is removed → `unknown`

Negative controls (page should stay fresh):

- `neighbor-symbol-same-file`: an unrelated symbol in the same file changes →
  fresh (proves detection is definition-level, not file-level)
- `reformat-only`: the cited definition is reformatted → fresh (canonicalization)
- `unrelated-file`: a completely unrelated file changes → fresh

### The gitHead durability case

A first-class case, because it proves freshness is independent of the git
cursor: change a cited definition (page goes stale), advance `gitHead` past the
change without repairing the page, and confirm that with an empty `git diff` the
page is **still** not-fresh and the real `getUpdateNoopStatus` refuses to skip.

## Metrics

Per category the run reports:

- **stale-page recall** = detected / expected not-fresh
- **missed** pages (with recorded dependencies, for debugging)
- **unnecessary invalidations** = expected-fresh pages that came back not-fresh
- **case pass rate**
- **preflight cost** (the freshness sweep only, never agent generation):
  wall-clock duration, files hashed, files parsed, definitions re-resolved. The
  counters come from a counting reader plus the public per-dependency reason, so
  production code is untouched.

## Output

- Human-readable summary to stdout (pasteable into the design doc).
- Structured JSON (`--json` or `OPENWIKI_FRESHNESS_JSON=1`) to `results.json`,
  with the same numbers, for run-to-run comparison.

## Adding a case

Append a `MutationCase` to `MECHANISM_CASES` in `mutation-eval.ts`: give it a
starting `sources` + `pages` world, one `mutation`, and the `expectedNotFresh`
map (any page not listed is expected fresh). The CI test picks it up
automatically.

## Tier B: real generated wikis (not yet wired)

Category 2 above uses the real recorder over real source, which proves the
recorder + preflight pipeline but not the agent's own choice of what to ground.
Testing that needs a repository with committed OpenWiki sidecars from a real
run. This repo has none, so that layer is deliberately left as the next step: a
config file listing `{ repo, ref, mutations, expectedNotFresh }`, cloned to a
temp dir (never mutating the source repo), run through the same grader. It is
local/manual by design and would not run in CI.

## Relationship to `evals/freshness/`

`evals/freshness/` is a *strategy comparison* (content-hash vs git-range vs
source-grounded, "which rebuild-or-skip decision is right"). This eval is a
different shape: *per-mutation expected-vs-actual stale pages*. They share the
harness primitives but answer different questions.
