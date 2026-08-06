/**
 * Phase 7 unit test for the metrics and aggregation module.
 *
 * Pure and token-free: it feeds synthetic deterministic and judge grades through
 * {@link scorePage}, {@link combineTrialArm}, {@link aggregateArm}, and
 * {@link computeDelta} and asserts the micro/macro math, the pessimistic
 * missing-judge fallback, the routing diagnostic, and the deterministic-versus-
 * judge disagreement flag.
 */

import { describe, expect, test } from "vitest";
import type { TokenUsage } from "../../../src/agent/types.js";
import type { RunTelemetry } from "../harness/telemetry.js";
import type { EvalScenario } from "../scenarios/types.js";
import type {
  DeterministicGrade,
  PageDeterministicResult,
} from "./deterministic.js";
import type { PageJudgeResult } from "./judge.js";
import {
  aggregateArm,
  combineTrialArm,
  computeDelta,
  scorePage,
  type TrialArmResult,
} from "./aggregate.js";

/**
 * Build a deterministic page result with the given probe verdicts.
 *
 * @param page - The page path.
 *
 * @param required - Required-fact ids mapped to their deterministic `pass`.
 *
 * @param forbidden - Forbidden-fact ids mapped to their deterministic `pass`
 *   (true means the obsolete text is cleared).
 */
function detPage(
  page: string,
  required: Record<string, boolean | undefined>,
  forbidden: Record<string, boolean | undefined> = {},
): PageDeterministicResult {
  return {
    page,
    found: true,
    requiredFacts: Object.entries(required).map(([id, pass]) => ({
      id,
      description: id,
      pass,
    })),
    forbiddenFacts: Object.entries(forbidden).map(([id, pass]) => ({
      id,
      description: id,
      pass,
    })),
    requiredFactsProbed: 0,
    requiredFactsSatisfied: 0,
    forbiddenFactsProbed: 0,
    forbiddenFactsCleared: 0,
  };
}

describe("scorePage", () => {
  test("a correct verdict is synchronized with no missing or stale facts", () => {
    const det = detPage("openwiki/a.md", { r1: true }, { f1: true });
    const judge: PageJudgeResult = {
      verdict: "correct",
      requiredFacts: [{ id: "r1", satisfied: true, explanation: "" }],
      forbiddenFacts: [{ id: "f1", stillPresent: false, explanation: "" }],
      unsupportedClaims: [],
      summary: "",
    };

    const grade = scorePage(det, judge);

    expect(grade.synchronized).toBe(true);
    expect(grade.requiredFactsMissing).toBe(0);
    expect(grade.staleFactsRemaining).toBe(0);
    expect(grade.deterministicDisagreement).toBe(false);
  });

  test("a stale verdict counts missing required and remaining forbidden facts", () => {
    const det = detPage("openwiki/a.md", { r1: false }, { f1: false });
    const judge: PageJudgeResult = {
      verdict: "stale",
      requiredFacts: [{ id: "r1", satisfied: false, explanation: "" }],
      forbiddenFacts: [{ id: "f1", stillPresent: true, explanation: "" }],
      unsupportedClaims: [],
      summary: "",
    };

    const grade = scorePage(det, judge);

    expect(grade.synchronized).toBe(false);
    expect(grade.requiredFactsMissing).toBe(1);
    expect(grade.staleFactsRemaining).toBe(1);
    // Deterministic (not satisfied / still present) agrees with the judge.
    expect(grade.deterministicDisagreement).toBe(false);
  });

  test("flags a required-fact disagreement (deterministic pass, judge unsatisfied)", () => {
    const det = detPage("openwiki/a.md", { r1: true });
    const judge: PageJudgeResult = {
      verdict: "partially_correct",
      requiredFacts: [{ id: "r1", satisfied: false, explanation: "" }],
      forbiddenFacts: [],
      unsupportedClaims: [],
      summary: "",
    };

    expect(scorePage(det, judge).deterministicDisagreement).toBe(true);
  });

  test("flags a forbidden-fact disagreement (deterministic cleared, judge still present)", () => {
    const det = detPage("openwiki/a.md", {}, { f1: true });
    const judge: PageJudgeResult = {
      verdict: "stale",
      requiredFacts: [],
      forbiddenFacts: [{ id: "f1", stillPresent: true, explanation: "" }],
      unsupportedClaims: [],
      summary: "",
    };

    expect(scorePage(det, judge).deterministicDisagreement).toBe(true);
  });
});

/** A two-page scenario used to exercise {@link combineTrialArm}. */
const combineScenario: EvalScenario = {
  id: "combine",
  title: "two-page scenario",
  complexity: "small",
  description: "a change touching two pages",
  async applyMutation(): Promise<void> {},
  expectedAffectedPages: [
    {
      page: "openwiki/a.md",
      rationale: "page a",
      requiredFacts: [{ id: "ra", description: "ra" }],
      forbiddenFacts: [{ id: "fa", description: "fa" }],
      sourceEvidence: [],
    },
    {
      page: "openwiki/b.md",
      rationale: "page b",
      requiredFacts: [{ id: "rb", description: "rb" }],
      forbiddenFacts: [],
      sourceEvidence: [],
    },
  ],
};

const combineDeterministic: DeterministicGrade = {
  scenarioId: "combine",
  pages: [
    detPage("openwiki/a.md", { ra: true }, { fa: true }),
    detPage("openwiki/b.md", { rb: false }),
  ],
  changedUnaffectedPages: ["openwiki/x.md", "openwiki/y.md"],
};

const combineTelemetry: RunTelemetry = {
  toolCalls: 7,
  toolCallsByName: { read_file: 5, write_file: 2 },
  toolRounds: 3,
  sourceFilesRead: ["src/x.ts"],
  wikiPagesRead: ["openwiki/a.md", "openwiki/b.md"],
  wikiPagesWritten: ["openwiki/a.md"],
  recordSourceDependenciesCalls: 1,
  tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  freshnessMode: "on",
};

describe("combineTrialArm", () => {
  test("grades pages in order and rolls up per-trial metrics", () => {
    const result = combineTrialArm({
      scenario: combineScenario,
      arm: "with",
      trial: 1,
      deterministic: combineDeterministic,
      judgeByPage: {
        "openwiki/a.md": {
          verdict: "correct",
          requiredFacts: [{ id: "ra", satisfied: true, explanation: "" }],
          forbiddenFacts: [{ id: "fa", stillPresent: false, explanation: "" }],
          unsupportedClaims: [],
          summary: "",
        },
        // openwiki/b.md is intentionally omitted to exercise the fallback.
      },
      telemetry: combineTelemetry,
      wallMs: 4242,
      skipped: false,
      model: "test-model",
      surfacedStalePages: ["openwiki/a.md"],
    });

    expect(result.pages.map((page) => page.page)).toEqual([
      "openwiki/a.md",
      "openwiki/b.md",
    ]);
    expect(result.expectedPages).toBe(2);
    expect(result.correctPages).toBe(1);
    expect(result.missedPages).toEqual(["openwiki/b.md"]);
    expect(result.unnecessaryEdits).toBe(2);
    expect(result.routingRecall).toEqual({ surfaced: 1, total: 2 });
    expect(result.toolCalls).toBe(7);
    expect(result.wikiPagesRead).toBe(2);
    expect(result.sourceFilesRead).toBe(1);
    expect(result.tokens?.totalTokens).toBe(120);
  });

  test("an omitted judge result grades the page pessimistically as a miss", () => {
    const result = combineTrialArm({
      scenario: combineScenario,
      arm: "with",
      trial: 1,
      deterministic: combineDeterministic,
      judgeByPage: {},
      telemetry: combineTelemetry,
      wallMs: 1,
      skipped: false,
      model: "test-model",
    });

    const pageB = result.pages.find((page) => page.page === "openwiki/b.md");
    expect(pageB?.synchronized).toBe(false);
    expect(pageB?.requiredFactsMissing).toBe(1);
    // Missing pages fall back to `incorrect`, so nothing is synchronized.
    expect(result.correctPages).toBe(0);
  });

  test("omits routing recall when no stale pages are supplied", () => {
    const result = combineTrialArm({
      scenario: combineScenario,
      arm: "without",
      trial: 1,
      deterministic: combineDeterministic,
      judgeByPage: {},
      telemetry: combineTelemetry,
      wallMs: 1,
      skipped: false,
      model: "test-model",
    });

    expect(result.routingRecall).toBeUndefined();
  });
});

/**
 * Build a {@link TrialArmResult} with defaults, overriding only the fields the
 * aggregate math reads.
 *
 * @param overrides - The fields to override.
 */
function trial(overrides: Partial<TrialArmResult>): TrialArmResult {
  return {
    scenarioId: "s1",
    arm: "with",
    trial: 1,
    skipped: false,
    model: "test-model",
    wallMs: 0,
    pages: [],
    expectedPages: 0,
    correctPages: 0,
    missedPages: [],
    staleFactsRemaining: 0,
    requiredFactsMissing: 0,
    unnecessaryEdits: 0,
    toolCalls: 0,
    wikiPagesRead: 0,
    sourceFilesRead: 0,
    ...overrides,
  };
}

const tokens = (total: number): TokenUsage => ({
  inputTokens: total,
  outputTokens: 0,
  totalTokens: total,
});

describe("aggregateArm", () => {
  const results: TrialArmResult[] = [
    trial({
      scenarioId: "s1",
      expectedPages: 2,
      correctPages: 2,
      staleFactsRemaining: 0,
      requiredFactsMissing: 0,
      unnecessaryEdits: 0,
      wallMs: 50,
      tokens: tokens(100),
    }),
    trial({
      scenarioId: "s1",
      expectedPages: 2,
      correctPages: 1,
      staleFactsRemaining: 1,
      requiredFactsMissing: 1,
      unnecessaryEdits: 0,
      wallMs: 150,
      tokens: tokens(200),
    }),
    trial({
      scenarioId: "s2",
      expectedPages: 4,
      correctPages: 1,
      staleFactsRemaining: 2,
      requiredFactsMissing: 3,
      unnecessaryEdits: 1,
      wallMs: 250,
      tokens: tokens(300),
    }),
    trial({
      scenarioId: "s2",
      expectedPages: 4,
      correctPages: 0,
      staleFactsRemaining: 3,
      requiredFactsMissing: 4,
      unnecessaryEdits: 2,
      wallMs: 350,
      tokens: undefined,
    }),
  ];

  const aggregate = aggregateArm(results);

  test("micro recall is total correct over total expected page outcomes", () => {
    expect(aggregate.correctPages).toBe(4);
    expect(aggregate.expectedPages).toBe(12);
    expect(aggregate.microRecall).toBeCloseTo(4 / 12, 10);
  });

  test("macro recall averages per-scenario mean recall, not per page", () => {
    expect(aggregate.perScenarioRecall.s1).toBeCloseTo(0.75, 10);
    expect(aggregate.perScenarioRecall.s2).toBeCloseTo(0.125, 10);
    expect(aggregate.macroRecall).toBeCloseTo(0.4375, 10);
    // Macro and micro must differ so the report shows both honestly.
    expect(aggregate.macroRecall).not.toBeCloseTo(aggregate.microRecall, 5);
  });

  test("sums the fact and edit floors across all trials", () => {
    expect(aggregate.staleFactsRemaining).toBe(6);
    expect(aggregate.requiredFactsMissing).toBe(8);
    expect(aggregate.unnecessaryEdits).toBe(3);
  });

  test("medians ignore trials without token usage", () => {
    expect(aggregate.medianWallMs).toBe(200);
    expect(aggregate.medianTotalTokens).toBe(200);
    expect(aggregate.trials).toBe(4);
  });
});

describe("computeDelta", () => {
  test("subtracts WITHOUT from WITH for each headline metric", () => {
    const without = aggregateArm([
      trial({
        scenarioId: "s1",
        expectedPages: 2,
        correctPages: 0,
        staleFactsRemaining: 4,
      }),
    ]);
    const withFreshness = aggregateArm([
      trial({
        scenarioId: "s1",
        expectedPages: 2,
        correctPages: 2,
        staleFactsRemaining: 1,
      }),
    ]);

    const delta = computeDelta(without, withFreshness);

    expect(delta.microRecall).toBeCloseTo(1, 10);
    expect(delta.macroRecall).toBeCloseTo(1, 10);
    expect(delta.staleFactsRemaining).toBe(-3);
  });
});
