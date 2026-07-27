# OpenWiki trace findings: Koota DeepSWE

## Scope

This analysis compares 15 baseline and 15 OpenWiki trials: three attempts on each of five `pmndrs/koota` tasks. Wiki-generation tokens are excluded from the coding-agent token comparison. Wall-clock results are directionally useful but are confounded by concurrency, retries, and infrastructure variance.

## Executive diagnosis

OpenWiki improved full solves from **3/15 to 6/15** and reduced file-edit actions by **31%**. Its clearest benefit is better change-surface coverage: agents search less broadly, modify fewer files repeatedly, and more consistently validate package exports and consumer paths. It is most useful on changes that cross lifecycle, relation, and publish boundaries.

That gain currently costs context. OpenWiki increased uncached coding-agent input by **36.5%**, cumulative input by **24.4%**, and total tool calls from **52.3 to 57.9** per trial. Output tokens were essentially flat. The excess comes primarily from large retrieval responses, direct full-page wiki reads that duplicate retrieval, and verbose build/test output—not from longer reasoning or more editing.

The reported **35.5% lower mean end-to-end time should not yet be treated as a product claim**. The difficult pair, query, and composite tasks were much faster, but deferred mutation and entity snapshot were slower; run scheduling and infrastructure varied. A controlled sequential rerun is needed to isolate the effect.

## Where OpenWiki helped

| Signal | Baseline | OpenWiki | Interpretation |
| --- | ---: | ---: | --- |
| Full solves | 3/15 | 6/15 | Promising quality improvement; sample is still small |
| Mean partial score | 0.9892 | 0.9928 | Failures became narrower |
| File-edit actions/trial | 23.2 | 16.0 | Less rework and patch churn |
| `rg` commands/trial | 4.93 | 2.40 | Retrieval replaced broad text search |
| Tool calls/trial | 52.3 | 57.9 | Retrieval added more calls than it eliminated |
| Uncached input | baseline | +36.5% | Retrieval remains too expensive |

The strongest task-level result was pair-relation tracking. Baseline trials failed across cancellation, exclusive replacement, destruction, wildcard removal, coexistence, and transition cases. OpenWiki narrowed this to one repeated mixed-requirement edge case and achieved one full solve. The traces show agents explicitly converting requirements into lifecycle checks, following the public package surface, and finding a bundler-only issue through consumer validation.

Entity snapshots improved from 2/3 to 3/3 solves. Deferred mutation improved from 1/3 to 2/3, although its remaining failure exposed unmodeled net/coalesced effects such as add→remove and remove→add. Composite-aspect failures narrowed to unchanged-update, constructor-arity, and one `Not(aspect)` transition edge.

## Where it did not help enough

Query predicates remained 0/3. All OpenWiki trials missed the held-out `Changed(predicate)` and `Removed(predicate)` truth-transition semantics; some also missed `Added(predicate)` and tracker independence. Agents found the right subsystem and wrote plausible tests, but their tests did not reproduce the verifier's observation-window behavior. This is a semantic-modeling and test-design failure, not a navigation failure.

The wiki should describe these runtime contracts explicitly:

- Observation-window boundaries: when added, removed, and changed state becomes visible and when it resets.
- Tracker identity and isolation across predicate/query instances.
- Truth-transition state machines, including false→true, true→false, and unchanged updates.
- The interaction between static query constraints and temporal tracking constraints.
- Net/coalesced effects of deferred and re-entrant mutations.
- No-op update semantics and constructor invariants for composed aspects.

These should be expressed as compact behavior matrices with links to authoritative source and focused tests. More architectural prose or more file snippets will not address the observed failures.

## Experiment verdicts

- **H1 surface gate and H2 OKF retrieval:** quality scores are invalid because these ran before patch transport was fixed. H2 still demonstrated a clear payload failure: `change_surface` returned 177k characters initially and 148k at final verification.
- **H3b compact retrieval plus `symbol_trace`:** compaction worked. `change_surface` fell to roughly 8–10k characters and the query task scored 39/43, but the run still used 126k uncached input tokens and 14 retrieval calls.
- **H4 behavior matrix:** the clearest win. It retained the same 39/43 score with 107k uncached input tokens and only five retrieval calls. Keep this policy.
- **H5 mandatory `test_search`:** no quality gain; the score remained 39/43 while uncached input rose to 130.5k and retrieval calls to nine. Keep test search optional until its precision improves.

## Retrieval-tool decisions

Across OpenWiki trials, retrieval was called 135 times, averaging nine calls and about 70k returned characters per trial. Fourteen calls (10.4%) were invalid because requested limits exceeded 20 or `symbol_trace` rejected dotted/multiple symbols. Fixing these retries is the first priority.

| Tool | Calls | Decision |
| --- | ---: | --- |
| `symbol_trace` | 54 | Keep, but batch symbols, accept dotted names, cap output, and replace per-symbol prompting with one final surface audit |
| `change_surface` | 32 | Keep; make the initial result pointer-first and run final verification only for public/export/generated/registration changes |
| `test_search` | 16 | Keep optional; deduplicate canonical/generated mirrors and return exact test names plus short behavioral snippets |
| `hybrid_search` | 13 | Keep as the default broad discovery tool; it already incorporates semantic ranking |
| Keyword/BM25/OKF graph | 20 total | Preserve as retrieval engines, but consider exposing them as modes or fallbacks behind hybrid search rather than separate default tools |
| Standalone semantic search | 0 | Hide from the default surface unless it gains a distinct workflow; do not remove semantic ranking from hybrid search |

`symbol_trace` is overused: 29 of its 54 calls came from the entity-snapshot task. `change_surface` is commonly called twice and sometimes three times with overlapping results. The tool surface should guide agents toward four workflows—change mapping, broad discovery, focused test discovery, and batched public-surface verification—rather than exposing every ranking implementation as a separate choice.

## Recommended next experiments

1. **Fix tool ergonomics:** clamp limits, accept dotted symbols, add multi-symbol tracing, and eliminate identical retry calls.
2. **Run the H4 policy with batched tracing:** compare current `symbol_trace` against one final batch audit.
3. **Make retrieval pointer-first:** return paths, symbols, test names, and small snippets by default; expand only on request. Target under 20k retrieval characters per trial.
4. **Improve `test_search`:** rank by requested transition behavior and observation phase, deduplicate generated mirrors, then compare optional use against H4 alone.
5. **Add quiet validation guidance:** capture failures in full but suppress successful build/test logs. OpenWiki trials produced substantially more validation output.
6. **Use query predicates as the discriminator:** test whether new observation-window and tracker-state wiki content converts the repeated 39/43 result into a full solve.
7. **Repeat timing under controlled scheduling:** same task order, concurrency, warmup, and infrastructure; report medians and successful-trial timing separately.

The near-term objective should be to preserve OpenWiki's solve-rate and rework gains while removing duplicated context. The best current direction is **behavior-matrix prompting plus compact, workflow-oriented retrieval**, not mandatory use of more tools.
