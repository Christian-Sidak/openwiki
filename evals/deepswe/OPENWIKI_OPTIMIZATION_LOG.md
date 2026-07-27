# OpenWiki optimization loop: Koota DeepSWE

## Objective and protocol

Primary objectives, in order: preserve or improve task score, then reduce coding-agent tokens and total tool calls. Wiki-generation tokens are excluded. Retrieval calls, returned characters, edit actions, and duration are diagnostic metrics.

Each hypothesis is cumulative unless its result causes an explicit rollback. The discriminator is `koota-pair-relation-tracking`, run three times concurrently with Codex `gpt-5.6-terra`, high reasoning, and OpenAI semantic reranking. This task was selected because it separates the old and current OpenWiki cohorts and exposes semantic-modeling failures rather than basic navigation failures. After five iterations, the best configuration is run on all five Koota tasks with three attempts each.

Runs stop for rate limits only after logs confirm a provider or HTTP 429. Infrastructure failures are diagnosed separately.

## Reference cohorts

| Cohort | Full solves | Mean partial | Uncached input/trial | Cumulative input/trial | Output/trial | Tool calls/trial | Retrieval calls/trial | Retrieval chars/trial | Edit actions/trial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline, 15 valid | 3/15 | 0.989192 | 100,184 | 4,175,334 | 30,345 | 51.13 | 0.00 | 0 | 23.2 |
| Old OpenWiki, 15 valid | 6/15 | 0.992832 | 136,772 | 5,192,270 | 30,478 | 57.93 | 9.00 | 70,413 | 16.0 |
| Current OpenWiki, 15 valid | 4/15 | 0.984533 | 125,617 | 5,838,432 | 32,721 | 60.73 | 5.73 | 30,650 | 21.0 |

The current retrieval surface eliminated invalid calls, cut retrieval calls 36%, retrieval payload 57%, broad `rg` 83%, and validation commands 26%. Those savings were outweighed by 75 additional edit actions across the cohort. Pair tracking was the dominant regression: old OpenWiki solved 1/3 with 0.9968 mean partial; current OpenWiki solved 0/3 with 0.9508 mean partial.

## Hypothesis 1: explicit state model, one canonical ledger, less prompt duplication

### Proposed change

- Before editing stateful behavior, require a compact model of all state identity axes, transitions, observation/reset windows, and the canonical owner or event ledger.
- Require explicit input/event/expected-result oracle rows mapped to focused tests.
- Remove the eval adapter's duplicated workflow essay and defer to the generated `AGENTS.md`, keeping only quickstart, read-only retrieval, and filesystem-isolation instructions.

### Expected benefit

The old full-solving pair trace centralized events by tracker/factory, entity, relation, and target. Current failures distributed state across modifier, trait, and query call sites, causing coexistence, cancellation, composition, and observation-window bugs. Making the design checkpoint salient should improve correctness and reduce edit churn without adding retrieval calls or payload.

### Outcome

H1 recovered quality and sharply reduced cost relative to the current pair cohort:

| Metric | Current pair | H1 | Change |
| --- | ---: | ---: | ---: |
| Full solves | 0/3 | 1/3 | +1 solve |
| Mean partial | 0.950794 | 0.990476 | +0.039683 |
| Uncached input/trial | 153,744 | 129,476 | -15.8% |
| Cumulative input/trial | 8,042,262 | 5,746,183 | -28.6% |
| Output/trial | 37,320 | 37,573 | +0.7% |
| Exec/apply calls/trial | 71.67 | 61.33 | -14.4% |
| Retrieval calls/trial | 6.00 | 3.00 | -50.0% |
| Retrieval chars/trial | 30,603 | 21,697 | -29.1% |
| Edit actions/trial | 24.00 | 23.67 | -1.4% |
| Tool calls/trial | 77.67 | 64.33 | -17.2% |

The full solve made only `change_surface` and `trace_symbols` retrieval calls and created a centralized pair-tracking module. The other attempts missed one coexistence case and five removal/lifecycle cases respectively.

The intended state-model guidance was not actually tested: all traces read upstream `/app/AGENTS.md`, while OpenWiki had written its managed block to the isolated `/tmp/openwiki-source/AGENTS.md`. The shorter treatment prompt therefore acted as a low-guidance/retrieval-restraint ablation. Its efficiency result is useful, but its quality gain cannot be attributed to the new managed prompt.

## Hypothesis 2: make the generated state-model guidance visible

### Proposed change

Point the concise treatment instruction directly to `/tmp/openwiki-source/AGENTS.md` after the quickstart. Keep the long workflow out of the task prompt and retain the `/app` source-of-truth boundary.

### Expected benefit

One small file read should expose the identity-axis, canonical-ledger, observation-window, and explicit-oracle checkpoint. This should turn more attempts into the centralized architecture seen in both full solves and close the coexistence/removal gaps, with much less context cost than restoring the duplicated treatment essay.

### Outcome

All three traces read the generated managed block, so the hypothesis was tested. It was a loss:

| Metric | H1 | H2 | Change |
| --- | ---: | ---: | ---: |
| Full solves | 1/3 | 0/3 | -1 solve |
| Mean partial | 0.990476 | 0.973016 | -0.017460 |
| Uncached input/trial | 129,476 | 153,067 | +18.2% |
| Cumulative input/trial | 5,746,183 | 6,980,095 | +21.5% |
| Output/trial | 37,573 | 38,454 | +2.3% |
| Exec/apply calls/trial | 61.33 | 66.33 | +8.2% |
| Retrieval calls/trial | 3.00 | 4.33 | +44.4% |
| Retrieval chars/trial | 21,697 | 25,776 | +18.8% |
| Edit actions/trial | 23.67 | 23.00 | -2.8% |
| Tool calls/trial | 64.33 | 70.67 | +9.8% |

The visible block increased retrieval and validation but did not improve the semantic design. All three attempts created centralized pair-tracking utilities, yet all missed specific/non-last/wildcard removal, exclusive replacement, and destruction. One also missed trait-plus-pair coexistence. The abstract state-model instruction did not force agents to enumerate every mutation producer, and the long workflow diluted the key decision.

## Hypothesis 3: compact, producer-aware managed guidance

### Proposed change

Reduce the managed block from eleven workflow bullets to five decision rules. Make retrieval evidence-driven rather than routine. For stateful work, require tracing every mutation/event producer and the state consumer before selecting one state owner, followed by explicit behavior rows and focused quiet validation.

### Expected benefit

The shorter block should recover H1's lower tokens and calls while retaining a concrete design guardrail. Producer tracing directly targets H2's repeated removal/destruction/replacement failures, which came from updating state consumers without covering all relation mutation paths.

### Outcome

Aborted before any coding-agent model calls after the user clarified that regressions must be reverted before continuing. This proposal is not counted as one of the five evaluated hypotheses. H2's explicit generated-`AGENTS.md` read and this untested compact-prompt edit were both rolled back to the H1 winner.

## Hypothesis 3: transition-producer evidence in `change_surface`

### Proposed change

Starting from H1, keep the same three-tool surface and enhance the already-used `change_surface` response with one compact `state_transitions` group. It prioritizes authoritative add/remove/update/destroy/reset/defer/replacement producer code and excludes query-modifier consumers. The final `trace_symbols` schema is unchanged.

### Expected benefit

Every H1/H2 attempt already calls `change_surface`, so this should expose the relation removal, replacement, and destruction paths that repeated failures missed without adding a tool call. The payload increase is bounded to one short citation, avoiding H2's prompt and search overhead.

### Outcome

H3 is retained as the new winner:

| Metric | H1 | H3 | Change |
| --- | ---: | ---: | ---: |
| Full solves | 1/3 | 2/3 | +1 solve |
| Mean partial | 0.990476 | 0.990476 | unchanged |
| Uncached input/trial | 129,476 | 122,029 | -5.8% |
| Cumulative input/trial | 5,746,183 | 5,318,199 | -7.4% |
| Output/trial | 37,573 | 33,751 | -10.2% |
| Exec/apply calls/trial | 61.33 | 61.33 | unchanged |
| Retrieval calls/trial | 3.00 | 3.33 | +11.1% |
| Retrieval chars/trial | 21,697 | 18,742 | -13.6% |
| Edit actions/trial | 23.67 | 24.33 | +2.8% |
| Tool calls/trial | 64.33 | 64.67 | +0.5% |

One full solve received `packages/core/src/trait/trait.ts` as transition evidence and inspected trait/relation producers before editing. The other full solve made no retrieval calls, so its success is run variance rather than a retrieval win. The failed trial received the same producer citation but still missed removal/destruction/coexistence, showing that the extra evidence is helpful for some trajectories but not sufficient. H3 is retained because solve count improved while all token metrics fell materially.

## Hypothesis 4: evidence-gap descriptions and smaller search payloads

### Proposed change

- Describe `change_surface` as a once-per-change evidence bundle that should be inspected before separate searches.
- Describe `search` as a tool for a specific unresolved gap, queried by symbol or observable behavior in the narrowest scope.
- Reduce search's default/maximum results from 5/10 to 4/6.

### Expected benefit

The two H3 retrieval users each made three searches returning about 14k characters after `change_surface`. Better descriptions should reduce redundant searches; the lower bound caps remaining payload while preserving top-ranked evidence. Score should remain unchanged.

### Outcome

H4 regressed and was rolled back before H5:

| Metric | H3 | H4 | Change |
| --- | ---: | ---: | ---: |
| Full solves | 2/3 | 0/3 | -2 solves |
| Mean partial | 0.990476 | 0.977778 | -0.012698 |
| Uncached input/trial | 122,029 | 164,467 | +34.8% |
| Cumulative input/trial | 5,318,199 | 6,622,466 | +24.5% |
| Output/trial | 33,751 | 39,949 | +18.4% |
| Exec/apply calls/trial | 61.33 | 68.67 | +12.0% |
| Retrieval calls/trial | 3.33 | 4.00 | +20.0% |
| Retrieval chars/trial | 18,742 | 22,752 | +21.4% |
| Edit actions/trial | 24.33 | 25.67 | +5.5% |
| Tool calls/trial | 64.67 | 72.67 | +12.4% |

The six-result cap reduced each search response, and one attempt used only one search, but the cohort as a whole made more retrieval and command calls and spent substantially more tokens. Tool descriptions did not reliably prevent redundant search. Both H4 descriptions and limits were reverted to H3 values.

## Hypothesis 5: compact post-edit symbol traces

### Proposed change

Keep H3's pre-edit retrieval unchanged. Make `trace_symbols` return deduplicated path/line citations rather than repeated snippets, and reduce its per-group default/maximum from 4/6 to 2/3.

### Expected benefit

Trace output was the largest single retrieval response at 9-11k characters in H3. It occurs after implementation, and agents need group presence, paths, and missing groups—not duplicate source excerpts. Compaction should cut retrieval and input tokens without affecting solve quality or tool-call count.

### Outcome

H5 reduced trace payload but regressed the primary outcome, so it was rolled back:

| Metric | H3 | H5 | Change |
| --- | ---: | ---: | ---: |
| Full solves | 2/3 | 1/3 | -1 solve |
| Mean partial | 0.990476 | 0.987302 | -0.003175 |
| Uncached input/trial | 122,029 | 119,204 | -2.3% |
| Cumulative input/trial | 5,318,199 | 5,825,158 | +9.5% |
| Output/trial | 33,751 | 33,222 | -1.6% |
| Exec/apply calls/trial | 61.33 | 64.67 | +5.4% |
| Retrieval calls/trial | 3.33 | 3.67 | +10.0% |
| Retrieval chars/trial | 18,742 | 13,226 | -29.4% |
| Edit actions/trial | 24.33 | 25.33 | +4.1% |
| Tool calls/trial | 64.67 | 68.33 | +5.7% |

Per-call trace payload fell from 9-11k to 1.7-2.1k characters, proving the compaction mechanism worked. That local saving did not reduce cumulative context or calls, and solve quality fell. The compact citation type, lower trace limits, and description were reverted. H3 remains the winner.

## Winner selected for the full suite

H3 is the retained configuration: H1's concise eval treatment and three-tool workflow, plus one `state_transitions` producer citation in `change_surface`. H2, H4, and H5 were rolled back; the aborted compact-prompt run is excluded.

### Full five-task, three-attempt result

The winner run completed 15/15 valid trials with no infrastructure or rate-limit failures.

| Cohort | Full solves | Mean partial | Uncached input/trial | Cumulative input/trial | Output/trial | Tool calls/trial | Retrieval calls/trial | Retrieval chars/trial | Edit actions/trial | Agent duration/trial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3/15 | 0.989192 | 100,184 | 4,175,334 | 30,345 | 51.13 | 0.00 | 0 | 23.20 | 471.1s |
| Old OpenWiki | 6/15 | 0.992832 | 136,772 | 5,192,270 | 30,478 | 57.93 | 9.00 | 70,413 | 16.00 | 929.6s |
| Current OpenWiki | 4/15 | 0.984533 | 125,617 | 5,838,432 | 32,721 | 60.73 | 5.73 | 30,650 | 21.00 | 841.0s |
| H3 winner | **7/15** | **0.994350** | 132,469 | 6,198,174 | 34,006 | 61.07 | **3.20** | **18,291** | 19.07 | **599.7s** |

H3 has the best quality: +4 full solves over baseline, +1 over old OpenWiki, and +3 over current OpenWiki. Against current OpenWiki, it holds total tool calls nearly flat (+0.6%), cuts retrieval calls 44%, retrieval payload 40%, edit actions 9%, and agent duration 29%. The tradeoff is +5.5% uncached input, +6.2% cumulative input, and +3.9% output tokens. Against baseline, quality improves substantially but costs 32% more uncached input, 48% more cumulative input, and 19% more tool calls.

Tool-call accounting treats every Codex exec/apply invocation and every MCP retrieval as one call. Edit actions are already included in exec/apply calls and are reported separately as a churn diagnostic; they are not double-counted in total tool calls.

| Task | Full solves | Mean partial | Uncached input | Cumulative input | Output | Tool calls | Retrieval calls | Retrieval chars | Edit actions | Agent duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Composite aspects | 1/3 | 0.995516 | 157,513 | 8,609,858 | 45,190 | 80.67 | 3.67 | 18,540 | 30.33 | 764.7s |
| Deferred mutation | 3/3 | 1.000000 | 116,375 | 4,779,118 | 27,944 | 56.00 | 5.33 | 24,894 | 13.00 | 511.4s |
| Entity snapshots | 2/3 | 0.994911 | 87,182 | 2,307,435 | 24,183 | 35.00 | 1.33 | 11,825 | 8.33 | 374.4s |
| Pair tracking | 1/3 | 0.996825 | 165,004 | 9,510,027 | 39,297 | 80.00 | 3.00 | 20,210 | 25.67 | 720.6s |
| Query predicates | 0/3 | 0.984496 | 136,271 | 5,784,433 | 33,415 | 53.67 | 2.67 | 15,988 | 18.00 | 627.7s |

Compared with old/current OpenWiki task solves, H3 improved composite aspects to 1/3 and deferred mutation to 3/3, retained 1/3 pair solves, and remained 0/3 on query predicates. Entity snapshots fell from 3/3 to 2/3; its one miss was limited to tag-relation omission and roundtrip world-diff identity.

The remaining failures are concentrated and consistent:

- Composite: constructor arity and one removed-constituent transition.
- Pair: trait-plus-pair or static-plus-temporal conjunction semantics.
- Query predicates: `Added`/`Removed`/`Changed(predicate)` observation windows and independent predicate trackers.
- Entity: tag-relation snapshot omission and exact roundtrip diff identity.

The strongest retained product change is transition-producer evidence inside the existing `change_surface` tool. The clearest negative finding is that more or more-forceful prompting did not help: making the long managed block visible increased tokens/calls and worsened score. Search-result caps and compact final tracing both reduced their local payloads but did not improve end-to-end efficiency or quality, so both were reverted.
