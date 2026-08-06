/**
 * Metrics and aggregation (spec sections 14-15, 25-26).
 *
 * Pure and token-free. It combines the deterministic floor and the blinded
 * judge into a per-page grade, rolls per-page grades up into per-trial-arm
 * results, and aggregates those across trials and scenarios into the micro and
 * macro numbers the summary reports. The judge's verdict is authoritative for
 * synchronization; the deterministic layer contributes only the unnecessary-edit
 * floor and a per-fact disagreement flag for manual review (spec section 21).
 */

import type { TokenUsage } from "../../../src/agent/types.js";
import type { Arm } from "../harness/arms.js";
import type { RunTelemetry } from "../harness/telemetry.js";
import type { EvalScenario } from "../scenarios/types.js";
import type {
  DeterministicGrade,
  PageDeterministicResult,
} from "./deterministic.js";
import type { PageJudgeResult, PageVerdict } from "./judge.js";

/** The combined grade for one expected page in one trial arm. */
export interface PageGrade {
  /** Repository-relative wiki page path. */
  page: string;

  /** The judge's verdict; only `correct` counts as synchronized. */
  verdict: PageVerdict;

  /** Whether the page is fully synchronized (verdict is `correct`). */
  synchronized: boolean;

  /** Required facts the judge found unsatisfied on the final page. */
  requiredFactsMissing: number;

  /** Forbidden (stale) facts the judge found still present on the final page. */
  staleFactsRemaining: number;

  /**
   * Whether the deterministic probes and the judge disagreed on any probed
   * fact, flagging the page for manual review (spec section 21).
   */
  deterministicDisagreement: boolean;
}

/** The rolled-up result for one scenario, one trial, one arm. */
export interface TrialArmResult {
  /** The scenario this trial graded. */
  scenarioId: string;

  /** The arm this trial ran. */
  arm: Arm;

  /** The 1-based trial index. */
  trial: number;

  /** Whether the agent skipped the run as a no-op. */
  skipped: boolean;

  /** The model id the run reported. */
  model: string;

  /** Wall-clock milliseconds the agent run took. */
  wallMs: number;

  /** Per-page grades, in `expectedAffectedPages` order. */
  pages: PageGrade[];

  /** Number of expected affected pages. */
  expectedPages: number;

  /** Number of expected pages that were fully synchronized. */
  correctPages: number;

  /** Expected pages that were not synchronized, by path. */
  missedPages: string[];

  /** Total stale facts remaining across the trial's expected pages. */
  staleFactsRemaining: number;

  /** Total required facts missing across the trial's expected pages. */
  requiredFactsMissing: number;

  /** Eligible pages edited without being expected to change (deterministic floor). */
  unnecessaryEdits: number;

  /**
   * WITH-arm routing diagnostic: of the expected pages, how many the freshness
   * preflight surfaced as stale (spec section 14).
   *
   * @default undefined - not computed for this arm (the control arm has no
   *   stale-page surfacing).
   */
  routingRecall?: { surfaced: number; total: number };

  /**
   * Best-effort token usage for the run.
   *
   * @default undefined - the provider surfaced no usage.
   */
  tokens?: TokenUsage;

  /** Total tool calls observed. */
  toolCalls: number;

  /** Distinct wiki pages read. */
  wikiPagesRead: number;

  /** Distinct source files read. */
  sourceFilesRead: number;
}

/** The aggregate metrics for one arm across all scenarios and trials. */
export interface AggregateMetrics {
  /** The arm these metrics summarize. */
  arm: Arm;

  /** Total synchronized page outcomes across every trial. */
  correctPages: number;

  /** Total expected page outcomes across every trial. */
  expectedPages: number;

  /** Micro synchronization recall: `correctPages / expectedPages`. */
  microRecall: number;

  /** Per-scenario mean synchronization recall, keyed by scenario id. */
  perScenarioRecall: Record<string, number>;

  /** Macro recall: the unweighted mean of `perScenarioRecall`. */
  macroRecall: number;

  /** Total stale facts remaining across every trial. */
  staleFactsRemaining: number;

  /** Total required facts missing across every trial. */
  requiredFactsMissing: number;

  /** Total unnecessary edits across every trial. */
  unnecessaryEdits: number;

  /**
   * Median total tokens per trial.
   *
   * @default undefined - no trial reported token usage.
   */
  medianTotalTokens?: number;

  /** Median agent wall-clock milliseconds per trial. */
  medianWallMs: number;

  /** Number of trial-arm results aggregated. */
  trials: number;
}

/** The WITH-minus-WITHOUT deltas for the headline metrics. */
export interface AggregateDelta {
  /** Micro recall delta (WITH minus WITHOUT). */
  microRecall: number;

  /** Macro recall delta (WITH minus WITHOUT). */
  macroRecall: number;

  /** Stale-facts-remaining delta (WITH minus WITHOUT; negative is better). */
  staleFactsRemaining: number;

  /** Required-facts-missing delta (WITH minus WITHOUT; negative is better). */
  requiredFactsMissing: number;

  /** Unnecessary-edits delta (WITH minus WITHOUT; negative is better). */
  unnecessaryEdits: number;
}

/** The median of a numeric list, or undefined when the list is empty. */
function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether the deterministic probes and the judge disagree on any probed fact for
 * one page. Only facts that carry a deterministic probe are compared.
 *
 * @param deterministic - The page's deterministic probe results.
 *
 * @param judge - The page's judge result.
 */
function hasDeterministicDisagreement(
  deterministic: PageDeterministicResult,
  judge: PageJudgeResult,
): boolean {
  const judgeRequired = new Map(
    judge.requiredFacts.map((fact) => [fact.id, fact.satisfied]),
  );
  for (const fact of deterministic.requiredFacts) {
    if (fact.pass === undefined) {
      continue;
    }
    const judged = judgeRequired.get(fact.id);
    if (judged !== undefined && judged !== fact.pass) {
      return true;
    }
  }

  const judgeForbidden = new Map(
    judge.forbiddenFacts.map((fact) => [fact.id, fact.stillPresent]),
  );
  for (const fact of deterministic.forbiddenFacts) {
    if (fact.pass === undefined) {
      continue;
    }
    // Deterministic `pass` means the obsolete text is cleared (absent), which
    // should agree with the judge reporting it not still present.
    const judged = judgeForbidden.get(fact.id);
    if (judged !== undefined && judged === fact.pass) {
      return true;
    }
  }

  return false;
}

/**
 * A judge result standing in for a page the judge never returned, graded
 * pessimistically so a judge failure counts as a miss rather than a crash.
 *
 * @param deterministic - The page's deterministic result, used to enumerate fact ids.
 */
function missingJudgeResult(
  deterministic: PageDeterministicResult,
): PageJudgeResult {
  return {
    verdict: "incorrect",
    requiredFacts: deterministic.requiredFacts.map((fact) => ({
      id: fact.id,
      satisfied: false,
      explanation: "no judge result for this page",
    })),
    forbiddenFacts: deterministic.forbiddenFacts.map((fact) => ({
      id: fact.id,
      stillPresent: true,
      explanation: "no judge result for this page",
    })),
    unsupportedClaims: [],
    summary: "no judge result for this page",
  };
}

/**
 * Combine one page's deterministic and judge results into a {@link PageGrade}.
 *
 * @param deterministic - The page's deterministic probe results.
 *
 * @param judge - The page's judge result.
 */
export function scorePage(
  deterministic: PageDeterministicResult,
  judge: PageJudgeResult,
): PageGrade {
  return {
    page: deterministic.page,
    verdict: judge.verdict,
    synchronized: judge.verdict === "correct",
    requiredFactsMissing: judge.requiredFacts.filter((fact) => !fact.satisfied)
      .length,
    staleFactsRemaining: judge.forbiddenFacts.filter(
      (fact) => fact.stillPresent,
    ).length,
    deterministicDisagreement: hasDeterministicDisagreement(
      deterministic,
      judge,
    ),
  };
}

/** Inputs for {@link combineTrialArm}. */
export interface CombineTrialArmInput {
  /** The scenario graded. */
  scenario: EvalScenario;

  /** The arm run. */
  arm: Arm;

  /** The 1-based trial index. */
  trial: number;

  /** The deterministic grade for the whole scenario. */
  deterministic: DeterministicGrade;

  /** The judge result per expected page, keyed by repo-relative page path. */
  judgeByPage: Record<string, PageJudgeResult>;

  /** The run's telemetry. */
  telemetry: RunTelemetry;

  /** Wall-clock milliseconds the run took. */
  wallMs: number;

  /** Whether the run skipped. */
  skipped: boolean;

  /** The model id the run reported. */
  model: string;

  /**
   * WITH-arm stale pages the preflight surfaced, for routing recall.
   *
   * @default undefined - routing recall is not computed for this arm.
   */
  surfacedStalePages?: string[];
}

/**
 * Roll one trial arm's per-page grades and telemetry into a
 * {@link TrialArmResult}.
 *
 * @param input - The scenario, grades, and telemetry for one trial arm.
 */
export function combineTrialArm(input: CombineTrialArmInput): TrialArmResult {
  const detByPage = new Map(
    input.deterministic.pages.map((page) => [page.page, page]),
  );

  const pages: PageGrade[] = input.scenario.expectedAffectedPages.map(
    (expectation) => {
      const deterministic = detByPage.get(expectation.page);
      if (!deterministic) {
        // Every expected page is present in the deterministic grade by
        // construction; this guards against a mismatched grade being passed in.
        throw new Error(
          `deterministic grade is missing expected page ${expectation.page}`,
        );
      }
      const judge =
        input.judgeByPage[expectation.page] ??
        missingJudgeResult(deterministic);
      return scorePage(deterministic, judge);
    },
  );

  const missedPages = pages
    .filter((page) => !page.synchronized)
    .map((page) => page.page);

  const routingRecall =
    input.surfacedStalePages === undefined
      ? undefined
      : {
          surfaced: input.scenario.expectedAffectedPages.filter((expectation) =>
            input.surfacedStalePages?.includes(expectation.page),
          ).length,
          total: input.scenario.expectedAffectedPages.length,
        };

  return {
    scenarioId: input.scenario.id,
    arm: input.arm,
    trial: input.trial,
    skipped: input.skipped,
    model: input.model,
    wallMs: input.wallMs,
    pages,
    expectedPages: pages.length,
    correctPages: pages.filter((page) => page.synchronized).length,
    missedPages,
    staleFactsRemaining: pages.reduce(
      (sum, page) => sum + page.staleFactsRemaining,
      0,
    ),
    requiredFactsMissing: pages.reduce(
      (sum, page) => sum + page.requiredFactsMissing,
      0,
    ),
    unnecessaryEdits: input.deterministic.changedUnaffectedPages.length,
    routingRecall,
    tokens: input.telemetry.tokens,
    toolCalls: input.telemetry.toolCalls,
    wikiPagesRead: input.telemetry.wikiPagesRead.length,
    sourceFilesRead: input.telemetry.sourceFilesRead.length,
  };
}

/**
 * Aggregate one arm's trial results into micro and macro metrics.
 *
 * @param results - Every trial-arm result for a single arm.
 */
export function aggregateArm(results: TrialArmResult[]): AggregateMetrics {
  const arm: Arm = results[0]?.arm ?? "with";

  const correctPages = results.reduce((sum, r) => sum + r.correctPages, 0);
  const expectedPages = results.reduce((sum, r) => sum + r.expectedPages, 0);

  const byScenario = new Map<string, TrialArmResult[]>();
  for (const result of results) {
    const bucket = byScenario.get(result.scenarioId) ?? [];
    bucket.push(result);
    byScenario.set(result.scenarioId, bucket);
  }

  const perScenarioRecall: Record<string, number> = {};
  for (const [scenarioId, trials] of byScenario) {
    const rates = trials
      .filter((trial) => trial.expectedPages > 0)
      .map((trial) => trial.correctPages / trial.expectedPages);
    perScenarioRecall[scenarioId] =
      rates.length === 0
        ? 0
        : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  }

  const scenarioRates = Object.values(perScenarioRecall);
  const macroRecall =
    scenarioRates.length === 0
      ? 0
      : scenarioRates.reduce((sum, rate) => sum + rate, 0) /
        scenarioRates.length;

  const tokenTotals = results
    .map((r) => r.tokens?.totalTokens)
    .filter((value): value is number => value !== undefined);

  return {
    arm,
    correctPages,
    expectedPages,
    microRecall: expectedPages === 0 ? 0 : correctPages / expectedPages,
    perScenarioRecall,
    macroRecall,
    staleFactsRemaining: results.reduce(
      (sum, r) => sum + r.staleFactsRemaining,
      0,
    ),
    requiredFactsMissing: results.reduce(
      (sum, r) => sum + r.requiredFactsMissing,
      0,
    ),
    unnecessaryEdits: results.reduce((sum, r) => sum + r.unnecessaryEdits, 0),
    medianTotalTokens: median(tokenTotals),
    medianWallMs: median(results.map((r) => r.wallMs)) ?? 0,
    trials: results.length,
  };
}

/**
 * Compute the WITH-minus-WITHOUT deltas for the headline metrics.
 *
 * @param without - The control arm's aggregate.
 *
 * @param withFreshness - The freshness arm's aggregate.
 */
export function computeDelta(
  without: AggregateMetrics,
  withFreshness: AggregateMetrics,
): AggregateDelta {
  return {
    microRecall: withFreshness.microRecall - without.microRecall,
    macroRecall: withFreshness.macroRecall - without.macroRecall,
    staleFactsRemaining:
      withFreshness.staleFactsRemaining - without.staleFactsRemaining,
    requiredFactsMissing:
      withFreshness.requiredFactsMissing - without.requiredFactsMissing,
    unnecessaryEdits: withFreshness.unnecessaryEdits - without.unnecessaryEdits,
  };
}
