# DeepSWE OpenWiki evaluation

This harness runs a paired DeepSWE experiment with the same tasks, seed, model,
reasoning effort, attempts, and Harbor environment in both conditions:

- `baseline`: Codex receives only the DeepSWE task and repository.
- `openwiki`: OpenWiki first documents an isolated clone of the agent-visible
  repository, then the same Codex adapter is instructed to read the generated
  quickstart and use OpenWiki's read-only OKF-aware retrieval MCP server before
  solving the task.

The harness pins:

- DeepSWE commit `6db64a40f3318d8659238ff34a8cc4b491c49205`
- `harbor[langsmith]==0.20.0`
- `litellm==1.83.14` (Harbor's supported lower bound, pinned to avoid a newer
  release's local Rust build requirement)
- Codex CLI `0.118.0`
- the current OpenWiki checkout, packed locally for each treatment run

## Safety and isolation

DeepSWE uses a separate verifier environment. Its held-out `tests/` and
`solution/` directories are not present in the agent container. The treatment
adapter additionally runs OpenWiki against `/tmp/openwiki-source`, a local clone
of `/app`; OpenWiki never runs from the benchmark task directory and cannot see
the verifier or reference solution.

Generated wiki files remain outside `/app`, so DeepSWE's patch extraction cannot
include them. Codex is explicitly told that `/app` is the source of truth and
that all code changes belong there.

DeepSWE v1.1 normally requires Pier 0.3's `pre_artifacts.sh` lifecycle to copy
committed work into its separate verifier. This harness retains Harbor 0.20 for
the official LangSmith integration, so the shared Codex adapter performs the
same validated base-to-final-HEAD diff capture into
`/logs/artifacts/model.patch`. It also configures a fixed repository-local eval
author so task-required commits succeed. Both baseline and OpenWiki conditions
use this identical compatibility path.

The treatment installs the packed OpenWiki artifact with dependency lifecycle
scripts disabled, then explicitly rebuilds and verifies only the existing pinned
`better-sqlite3` native dependency required by OpenWiki's checkpointer.

Credentials are injected at runtime by Harbor. They are never written into an
image, command argument, generated wiki, or result summary. Do not enable Harbor's
debug mode for credentialed runs.

DeepSWE disables general container internet access. The harness narrowly allows
the Debian, NodeSource, npm, GitHub release-asset, and OpenAI API hosts needed to
install and run Codex and OpenWiki's pinned SQLite binding, plus the LangSmith
API and trace-ingest hosts required by every traced run. The adapter uses the
task image's existing Node runtime and installs the pinned Codex CLI directly,
avoiding Harbor's NVM bootstrap.

For Docker runs, the harness removes inactive per-trial networks after each job
and checks completed prior jobs for stale networks before launching. Cleanup is
restricted to networks derived from Harbor result directories, verifies exact
Docker Compose ownership labels, and skips every network with an attached
container; it never performs a global Docker network prune.
If `OPENAI_BASE_URL` uses another gateway, pass its hostname (not a URL) with
`--allow-host gateway.example.com`. The separate verifier environment remains
offline.

## Requirements

- Python 3.12 (Harbor's supported runtime; selected explicitly through `uvx`)
- `uv`/`uvx`
- `pnpm`
- Docker for local runs, or a configured Modal account
- `OPENAI_API_KEY` available in the process environment or an env file passed
  by path with `--env-file`
- `LANGSMITH_API_KEY` available the same way

The project does not add Harbor as a package dependency. `uvx` downloads the
pinned Apache-2.0 runner and its official LangSmith extra into its tool cache
when a run starts.

## LangSmith datasets, experiments, and traces

Every evaluation command enables Harbor's official `langsmith` plugin. The
plugin creates or updates one stable dataset named
`deepswe-openwiki-6db64a40f331` by default. Baseline and OpenWiki jobs use that
same dataset and create separate, uniquely named experiments whose names begin
with the corresponding Harbor job name (for example,
`pilot-01-baseline-seed-0` and `pilot-01-openwiki-seed-0`).
Ambient Harbor experiment-name/ID overrides are cleared to prevent the two
conditions from being merged accidentally. See the official
[LangSmith Harbor integration](https://docs.langchain.com/langsmith/harbor-integrations)
for the resulting run and feedback schema.

The harness subclasses the official plugin only to omit DeepSWE's count metrics
(such as `f2p_total`) from LangSmith feedback. Harbor 0.20 otherwise sends all
numeric rewards as bounded scores, which LangSmith rejects when a count is
greater than one. Normalized metrics are rounded to LangSmith's supported four
decimal places, and the primary reward remains a feedback score. All counts
remain available in trial outputs and local results.

Each experiment contains one root run per trial, environment/agent/verifier
phase runs, verifier reward feedback, Harbor error feedback, and reported token
and cost usage. The OpenWiki condition also enables OpenWiki's LangChain v2
tracing and routes those generation traces to the OpenWiki experiment. Codex
CLI itself does not emit native LangSmith LLM/tool spans; Harbor still records
its agent phase, ATIF trajectory-derived totals, tokens, cost, result, and
feedback.

Use `--langsmith-dataset NAME` to override the shared dataset. Self-hosted or
multi-workspace LangSmith installations can also use `--langsmith-endpoint URL`
and `--langsmith-workspace-id ID`. Dataset sync and fail-fast behavior are
always enabled so a run cannot silently omit its LangSmith evaluation record.

## Commands

Inspect both commands without downloading tasks, building images, or calling a
model:

```bash
python3 evals/deepswe/run.py paired --n-tasks 2 --dry-run
```

Prepare the pinned DeepSWE checkout and pack the current OpenWiki source:

```bash
python3 evals/deepswe/run.py prepare
```

Run only the baseline:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py baseline \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --reasoning-effort high
```

Run only the OpenWiki condition:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py openwiki \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --openwiki-model gpt-5.6-terra \
  --reasoning-effort high
```

Run both paired conditions and summarize them:

```bash
source ~/.zshrc && python3 evals/deepswe/run.py paired \
  --run-name pilot-01 \
  --n-tasks 10 \
  --seed 0 \
  --model openai/gpt-5.6-terra \
  --openwiki-model gpt-5.6-terra \
  --reasoning-effort high
```

Use `--task '<glob>'` one or more times to select named tasks. The harness uses
`--seed` to sample one exact task list and passes that same list to both arms.
Use `--attempts 3` for repeated trials and `--environment modal` for Harbor's
hosted parallel environment.

### Named OpenWiki task suites

Use `--task-suite` for the two exact, reproducible OpenWiki cohorts. A suite
selects all of its members regardless of `--n-tasks` and cannot be combined
with `--task`:

```bash
# Existing fast iteration set: the five Koota tasks
python3 evals/deepswe/run.py paired --task-suite koota-5

# Broader set: the five Koota tasks plus 15 independent repositories
python3 evals/deepswe/run.py paired --task-suite openwiki-20
```

The 15 tasks added to `openwiki-20` are not exposed as a separate runnable
suite. They were selected from the user-provided `gpt-5.6-terra [medium]`
leaderboard export. Across their 42 listed trials they had an 81% failure rate,
40.8 mean steps, and $0.88 mean reported cost. The local harness uses high
reasoning, so these figures are selection signals rather than expected results.
The export did not include token counts; reported cost and steps are only
proxies for token intensity.

| Task                                       | Repository / language         | Terra-medium signal    | What it stresses                                                   |
| ------------------------------------------ | ----------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `adaptix-name-mapping-aliases`             | Adaptix / Python              | 1/4 failed, 47.0 steps | High-cost positive control; mapping and serialization seams        |
| `dynamodb-toolbox-lazy-recursive-schemas`  | DynamoDB Toolbox / TypeScript | 4/4 failed, 40.8 steps | Recursive types, DTO round trips, JSON Schema, update expressions  |
| `pebble-durability-wait-apis`              | Pebble / Go                   | 2/2 failed, 45.5 steps | Concurrency, durability callbacks, waits, metrics, reset behavior  |
| `scriggo-method-declarations`              | Scriggo / Go                  | 2/2 failed, 44.0 steps | Compiler/runtime method sets and interface dispatch                |
| `helm-unified-manifest-stream`             | Helm / Go                     | 1/4 failed, 42.8 steps | Large-repo positive control across multiple command paths          |
| `fastapi-implicit-head-options`            | FastAPI / Python              | 2/3 failed, 38.7 steps | Routing inheritance, configuration, HEAD/OPTIONS semantics         |
| `boa-hierarchical-evaluation-cancellation` | Boa / Rust                    | 3/3 failed, 38.0 steps | Nested cancellation and async lifecycle propagation                |
| `bandit-structured-nosec-directives`       | Bandit / Python               | 2/2 failed, 39.0 steps | Parser state, scoped directives, selector semantics                |
| `effect-sse-httpapi-streaming`             | Effect / TypeScript           | 3/3 failed, 42.3 steps | Large monorepo; server/client streaming and public API propagation |
| `katex-multicolumn-array-spans`            | KaTeX / JavaScript            | 2/2 failed, 40.5 steps | Parser-to-layout invariants and error handling                     |
| `prometheus-transactional-reload-status`   | Prometheus / Go               | 1/2 failed, 36.5 steps | Large repo; transactions, rollback, persistence, HTTP status       |
| `opa-template-string-reconstruction`       | OPA / Go                      | 3/3 failed, 39.7 steps | Compiler AST reconstruction and syntax preservation                |
| `oxvg-structural-selector-preservation`    | OXVG / Rust                   | 3/3 failed, 39.7 steps | Optimizer correctness under structural CSS selectors               |
| `kgateway-consistent-hash-policy`          | kgateway / Go                 | 2/2 failed, 38.5 steps | Kubernetes API-to-runtime translation and merge behavior           |
| `python-statemachine-state-data-scoping`   | python-statemachine / Python  | 3/3 failed, 36.3 steps | Hierarchical state ownership, history, isolation, lifecycle resets |

Treatment runs register `openwiki-retrieval-mcp` inside Codex's isolated home.
It exposes three read-only workflows over `/app` and the generated wiki:
`search` with `all`, `wiki`, `source_code`, and `tests` scopes;
`change_surface` for pre-edit cross-boundary mapping; and batched
`trace_symbols` for post-edit public-surface verification. Search automatically
combines exact, BM25, semantic-vector, and OKF graph ranking. Local deterministic
vectors are the default. Pass `--retrieval-embedding-provider openai` to opt into
bounded `text-embedding-3-small` reranking; provider failures fall back to local
vectors.

If runs already exist, summarize them without invoking Harbor:

```bash
python3 evals/deepswe/run.py summarize --run-name pilot-01 --seed 0
```

## Outputs and interpretation

Harbor writes raw jobs to `evals/deepswe/results/`. The harness writes aggregate
JSON and trial-level CSV files to `evals/deepswe/summaries/`, including:

- binary reward and exception type
- input, cached, and output tokens used by Codex
- Codex cost and agent steps
- agent and total wall-clock time
- OpenWiki generation wall-clock time

Efficiency should be compared among successful trials as well as across all
trials. A faster failure is not an efficiency improvement.

OpenWiki's current CLI does not expose generation token usage to Harbor's local
summary, so treatment summaries include its wall-clock time but not its tokens
or provider cost. Its LangSmith generation traces in the same experiment provide
generation-token details.
