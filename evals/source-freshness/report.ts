/**
 * Pure output and assembly layer for the runner (spec sections 24-26).
 *
 * Everything here is deterministic and token-free so it can be unit-tested
 * without a model or a temp repo: CLI parsing, building the blinded judge input
 * from a scenario and resolved source, the arm-leak tripwire, assembling the
 * {@link BenchmarkResult}, and rendering the summary table. The impure
 * orchestration and filesystem writes live in `run.ts`.
 */

import type { Arm } from "./harness/arms.js";
import type {
  AggregateDelta,
  AggregateMetrics,
  TrialArmResult,
} from "./grading/aggregate.js";
import { aggregateArm, computeDelta } from "./grading/aggregate.js";
import type {
  JudgePageInput,
  JudgePrompt,
  JudgeSourceEvidence,
} from "./grading/judge.js";
import type {
  EvalScenario,
  PageExpectation,
  ScenarioComplexity,
} from "./scenarios/types.js";

/** Default number of trials per arm when the CLI does not override it. */
export const DEFAULT_TRIALS = 3;

/** Default cap on resolved source evidence handed to the judge, in characters. */
export const DEFAULT_MAX_SOURCE_CHARS = 8000;

/**
 * Lowercased substrings that would reveal which arm produced a candidate page.
 * The blinded judge prompt must contain none of them (spec section 27). Only
 * arm-identifying tokens are listed: words like "freshness" appear legitimately
 * in the OpenWiki corpus this eval documents, so they are deliberately excluded.
 */
const ARM_LEAK_TOKENS = [
  "openwiki_disable_source_freshness",
  "with arm",
  "without arm",
  "control arm",
  "freshness arm",
  "arm=with",
  "arm=without",
];

/** The arguments parsed from the runner CLI. */
export interface ParsedArgs {
  /** Number of trials per arm. */
  trials: number;

  /**
   * Scenario ids to include; when absent, every registered scenario runs.
   *
   * @default undefined - run all registered scenarios.
   */
  scenarioIds?: string[];

  /**
   * Judge model id override.
   *
   * @default undefined - resolve the judge model the same way the agent's model
   *   is resolved.
   */
  judgeModelId?: string;

  /**
   * Baseline directory override.
   *
   * @default undefined - use the checked-in baseline directory.
   */
  baselineDir?: string;

  /**
   * Developer-checkout root override the corpus source is archived from.
   *
   * @default undefined - use the current working directory.
   */
  devRoot?: string;

  /**
   * Results output root override.
   *
   * @default undefined - use `evals/source-freshness/results`.
   */
  outDir?: string;
}

/** Metadata recorded for a whole benchmark run (spec section 28). */
export interface BenchmarkMetadata {
  /** The unique id for this run, used as the results subdirectory name. */
  runId: string;

  /** ISO-8601 timestamp the run started. */
  timestamp: string;

  /** The corpus commit the frozen baseline source was taken from. */
  sourceCommit: string;

  /** The agent model id the trials ran with. */
  agentModel: string;

  /** The provider the judge model ran under. */
  judgeProvider: string;

  /** The judge model id. */
  judgeModel: string;

  /** Number of trials per arm. */
  trials: number;

  /** The scenario ids that ran, in order. */
  scenarioIds: string[];

  /** The verified baseline content hash the trials seeded from. */
  baselineContentHash: string;
}

/** One trial's paired arm results. */
export interface TrialPairResult {
  /** The 1-based trial index. */
  trial: number;

  /** The control-arm result. */
  without: TrialArmResult;

  /** The freshness-arm result. */
  with: TrialArmResult;
}

/** All trial results for one scenario. */
export interface ScenarioBenchmarkResult {
  /** The scenario id. */
  scenarioId: string;

  /** The scenario title. */
  title: string;

  /** The scenario complexity band. */
  complexity: ScenarioComplexity;

  /** Per-trial paired arm results, retained individually (spec section 25). */
  trials: TrialPairResult[];
}

/** The per-arm aggregates and their delta. */
export interface BenchmarkAggregate {
  /** The control-arm aggregate. */
  without: AggregateMetrics;

  /** The freshness-arm aggregate. */
  with: AggregateMetrics;

  /** The WITH-minus-WITHOUT deltas. */
  delta: AggregateDelta;
}

/** The complete benchmark result written to `results.json` (spec section 25). */
export interface BenchmarkResult {
  /** Run metadata. */
  metadata: BenchmarkMetadata;

  /** Per-scenario results, retaining every trial. */
  scenarios: ScenarioBenchmarkResult[];

  /** The aggregate metrics for both arms and their delta. */
  aggregate: BenchmarkAggregate;
}

/**
 * Read the value that must follow a flag, failing loudly when it is missing.
 *
 * @param argv - The full argument list.
 *
 * @param index - The index of the flag itself.
 *
 * @param flag - The flag name, for the error message.
 */
function flagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

/**
 * Parse the runner CLI arguments. Recognizes `--trials`, `--scenario` (repeatable)
 * or `--scenarios a,b`, `--judge-model`, `--baseline`, `--dev-root`, and `--out`.
 * Unknown flags and malformed values throw rather than being silently ignored.
 *
 * @param argv - The argument list, excluding the node and script entries.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let trials = DEFAULT_TRIALS;
  const scenarioIds: string[] = [];
  let judgeModelId: string | undefined;
  let baselineDir: string | undefined;
  let devRoot: string | undefined;
  let outDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--trials": {
        const value = Number(flagValue(argv, index, flag));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--trials must be a positive integer");
        }
        trials = value;
        index += 1;
        break;
      }
      case "--scenario": {
        scenarioIds.push(flagValue(argv, index, flag));
        index += 1;
        break;
      }
      case "--scenarios": {
        for (const id of flagValue(argv, index, flag).split(",")) {
          const trimmed = id.trim();
          if (trimmed.length > 0) {
            scenarioIds.push(trimmed);
          }
        }
        index += 1;
        break;
      }
      case "--judge-model": {
        judgeModelId = flagValue(argv, index, flag);
        index += 1;
        break;
      }
      case "--baseline": {
        baselineDir = flagValue(argv, index, flag);
        index += 1;
        break;
      }
      case "--dev-root": {
        devRoot = flagValue(argv, index, flag);
        index += 1;
        break;
      }
      case "--out": {
        outDir = flagValue(argv, index, flag);
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  return {
    trials,
    scenarioIds: scenarioIds.length > 0 ? scenarioIds : undefined,
    judgeModelId,
    baselineDir,
    devRoot,
    outDir,
  };
}

/** Truncate `text` to `maxChars`, appending a marker when it was shortened. */
function capSourceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n… (truncated ${text.length - maxChars} characters)`;
}

/** Inputs for {@link buildJudgePageInput}. */
export interface BuildJudgePageInputArgs {
  /** The scenario the page belongs to. */
  scenario: EvalScenario;

  /** The page expectation being judged. */
  page: PageExpectation;

  /**
   * The page's frozen baseline content.
   *
   * @default undefined - the page did not exist in the baseline.
   */
  before?: string;

  /**
   * The page's final content in the graded arm.
   *
   * @default undefined - the run did not write the page.
   */
  after?: string;

  /** Resolved post-mutation source bytes keyed by repo-relative path. */
  mutatedSource: Record<string, string | undefined>;

  /**
   * Cap on each evidence excerpt handed to the judge, in characters.
   *
   * @default DEFAULT_MAX_SOURCE_CHARS
   */
  maxSourceChars?: number;
}

/**
 * Build the blinded {@link JudgePageInput} for one expected page. Resolves each
 * declared source-evidence path to its post-mutation bytes (capped), and
 * substitutes explicit sentinels when the page is absent before or after, so the
 * judge always receives a well-formed, arm-independent payload.
 *
 * @param args - The scenario, page, before/after content, and resolved source.
 */
export function buildJudgePageInput(
  args: BuildJudgePageInputArgs,
): JudgePageInput {
  const maxChars = args.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS;

  const sourceEvidence: JudgeSourceEvidence[] = args.page.sourceEvidence.map(
    (evidence) => {
      const resolved = args.mutatedSource[evidence.path];
      return {
        path: evidence.path,
        symbol: evidence.symbol,
        explanation: evidence.explanation,
        sourceText:
          resolved === undefined
            ? "(source file not found at the mutated commit)"
            : capSourceText(resolved, maxChars),
      };
    },
  );

  return {
    scenarioDescription: args.scenario.description,
    page: args.page.page,
    rationale: args.page.rationale,
    requiredFacts: args.page.requiredFacts,
    forbiddenFacts: args.page.forbiddenFacts,
    sourceEvidence,
    before: args.before ?? "(page absent in the baseline wiki)",
    after: args.after ?? "(page absent in the final wiki)",
  };
}

/**
 * Assert a built judge prompt reveals nothing about which arm produced the
 * candidate page. A leak here would let the judge score arms differently for a
 * reason other than page correctness, so this fails the run loudly (spec section
 * 27).
 *
 * @param prompt - The prompt about to be sent to the judge.
 */
export function assertPromptBlinded(prompt: JudgePrompt): void {
  const haystack = `${prompt.system}\n${prompt.user}`.toLowerCase();
  for (const token of ARM_LEAK_TOKENS) {
    if (haystack.includes(token)) {
      throw new Error(
        `integrity: judge prompt leaked an arm-identifying token ("${token}")`,
      );
    }
  }
}

/** Flatten every trial's results for one arm across all scenarios. */
function armResults(
  scenarios: ScenarioBenchmarkResult[],
  arm: Arm,
): TrialArmResult[] {
  return scenarios.flatMap((scenario) =>
    scenario.trials.map((trial) =>
      arm === "with" ? trial.with : trial.without,
    ),
  );
}

/** Inputs for {@link assembleBenchmarkResult}. */
export interface AssembleBenchmarkResultArgs {
  /** The run metadata. */
  metadata: BenchmarkMetadata;

  /** The per-scenario trial results. */
  scenarios: ScenarioBenchmarkResult[];
}

/**
 * Assemble the final {@link BenchmarkResult} from per-scenario trial results,
 * computing both arms' aggregates and their delta.
 *
 * @param args - The metadata and per-scenario results.
 */
export function assembleBenchmarkResult(
  args: AssembleBenchmarkResultArgs,
): BenchmarkResult {
  const without = aggregateArm(armResults(args.scenarios, "without"));
  const withFreshness = aggregateArm(armResults(args.scenarios, "with"));

  return {
    metadata: args.metadata,
    scenarios: args.scenarios,
    aggregate: {
      without,
      with: withFreshness,
      delta: computeDelta(without, withFreshness),
    },
  };
}

/** Format a fraction in [0,1] as a one-decimal percentage. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Format a fraction delta as signed percentage points. */
function signedPp(fraction: number): string {
  const points = fraction * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)}pp`;
}

/** Format an integer delta with an explicit sign. */
function signedInt(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

/** Format a possibly-absent token count. */
function tokenCell(value: number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

/** Format the delta of two possibly-absent token counts. */
function tokenDeltaCell(
  without: number | undefined,
  withFreshness: number | undefined,
): string {
  if (without === undefined || withFreshness === undefined) {
    return "n/a";
  }
  return signedInt(withFreshness - without);
}

/**
 * Render the human-readable `summary.md` (spec section 26): the aggregate table,
 * then a per-scenario recall table. It reports actual numbers only, with a Δ
 * column defined as WITH minus WITHOUT, and draws no celebratory conclusion.
 *
 * @param result - The assembled benchmark result.
 */
export function renderSummaryMarkdown(result: BenchmarkResult): string {
  const { metadata, aggregate } = result;
  const { without, with: withFreshness, delta } = aggregate;

  const lines: string[] = [];
  lines.push("# Source-freshness benchmark");
  lines.push("");
  lines.push(`Run \`${metadata.runId}\` · ${metadata.timestamp}`);
  lines.push(
    `Source commit \`${metadata.sourceCommit}\` · agent \`${metadata.agentModel}\` · judge \`${metadata.judgeProvider}/${metadata.judgeModel}\``,
  );
  lines.push(
    `Scenarios: ${metadata.scenarioIds.length} · Trials per arm: ${metadata.trials}`,
  );
  lines.push("");
  lines.push("Columns are the raw per-arm numbers; Δ is WITH minus WITHOUT.");
  lines.push("");

  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Without freshness | With freshness | Δ |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| Affected pages correct | ${without.correctPages}/${without.expectedPages} | ${withFreshness.correctPages}/${withFreshness.expectedPages} | ${signedInt(withFreshness.correctPages - without.correctPages)} |`,
  );
  lines.push(
    `| Synchronization recall (micro) | ${pct(without.microRecall)} | ${pct(withFreshness.microRecall)} | ${signedPp(delta.microRecall)} |`,
  );
  lines.push(
    `| Synchronization recall (macro) | ${pct(without.macroRecall)} | ${pct(withFreshness.macroRecall)} | ${signedPp(delta.macroRecall)} |`,
  );
  lines.push(
    `| Stale facts remaining | ${without.staleFactsRemaining} | ${withFreshness.staleFactsRemaining} | ${signedInt(delta.staleFactsRemaining)} |`,
  );
  lines.push(
    `| Required facts missing | ${without.requiredFactsMissing} | ${withFreshness.requiredFactsMissing} | ${signedInt(delta.requiredFactsMissing)} |`,
  );
  lines.push(
    `| Unnecessary doc edits | ${without.unnecessaryEdits} | ${withFreshness.unnecessaryEdits} | ${signedInt(delta.unnecessaryEdits)} |`,
  );
  lines.push(
    `| Median tokens | ${tokenCell(without.medianTotalTokens)} | ${tokenCell(withFreshness.medianTotalTokens)} | ${tokenDeltaCell(without.medianTotalTokens, withFreshness.medianTotalTokens)} |`,
  );
  lines.push(
    `| Median agent wall time (ms) | ${without.medianWallMs} | ${withFreshness.medianWallMs} | ${signedInt(withFreshness.medianWallMs - without.medianWallMs)} |`,
  );
  lines.push("");

  lines.push("## By scenario");
  lines.push("");
  lines.push(
    "| Scenario | Change | Complexity | Recall without | Recall with |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  for (const scenario of result.scenarios) {
    const recallWithout = without.perScenarioRecall[scenario.scenarioId] ?? 0;
    const recallWith =
      withFreshness.perScenarioRecall[scenario.scenarioId] ?? 0;
    lines.push(
      `| ${scenario.scenarioId} | ${scenario.title} | ${scenario.complexity} | ${pct(recallWithout)} | ${pct(recallWith)} |`,
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
