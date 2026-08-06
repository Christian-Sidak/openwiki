/**
 * Unit test for the pure report and assembly layer.
 *
 * Token-free: it checks CLI parsing, blinded judge-input assembly and the
 * arm-leak tripwire, and that the assembled result and rendered summary carry the
 * right micro/macro math and deltas. No model or temp repo is involved.
 */

import { describe, expect, test } from "vitest";
import type { TokenUsage } from "../../src/agent/types.js";
import type { TrialArmResult } from "./grading/aggregate.js";
import type { JudgePrompt } from "./grading/judge.js";
import type { Arm } from "./harness/arms.js";
import type { EvalScenario, PageExpectation } from "./scenarios/types.js";
import {
  assembleBenchmarkResult,
  assertPromptBlinded,
  buildJudgePageInput,
  DEFAULT_TRIALS,
  parseArgs,
  renderSummaryMarkdown,
  type BenchmarkMetadata,
  type ScenarioBenchmarkResult,
} from "./report.js";

describe("parseArgs", () => {
  test("defaults trials and leaves overrides unset", () => {
    const parsed = parseArgs([]);
    expect(parsed.trials).toBe(DEFAULT_TRIALS);
    expect(parsed.scenarioIds).toBeUndefined();
    expect(parsed.judgeModelId).toBeUndefined();
  });

  test("parses trials, repeated scenarios, and path overrides", () => {
    const parsed = parseArgs([
      "--trials",
      "5",
      "--scenario",
      "a",
      "--scenario",
      "b",
      "--judge-model",
      "jm",
      "--baseline",
      "/b",
      "--dev-root",
      "/d",
      "--out",
      "/o",
    ]);
    expect(parsed.trials).toBe(5);
    expect(parsed.scenarioIds).toEqual(["a", "b"]);
    expect(parsed.judgeModelId).toBe("jm");
    expect(parsed.baselineDir).toBe("/b");
    expect(parsed.devRoot).toBe("/d");
    expect(parsed.outDir).toBe("/o");
  });

  test("splits a comma-separated --scenarios list", () => {
    expect(parseArgs(["--scenarios", "a, b ,c"]).scenarioIds).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test.each([
    ["a non-positive --trials", ["--trials", "0"]],
    ["a missing flag value", ["--trials"]],
    ["an unknown flag", ["--nope"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

const page: PageExpectation = {
  page: "openwiki/architecture/overview.md",
  rationale: "documents greet",
  requiredFacts: [{ id: "r1", description: "documents goodbye" }],
  forbiddenFacts: [{ id: "f1", description: "no longer says hello" }],
  sourceEvidence: [
    { path: "src/greet.ts", explanation: "greet returns goodbye" },
  ],
};

const scenario: EvalScenario = {
  id: "greet-change",
  title: "greet returns goodbye",
  complexity: "small",
  description: "greet() now returns goodbye instead of hello",
  async applyMutation(): Promise<void> {},
  expectedAffectedPages: [page],
};

describe("buildJudgePageInput", () => {
  test("resolves declared source evidence from the mutated source", () => {
    const input = buildJudgePageInput({
      scenario,
      page,
      before: "before body",
      after: "after body",
      mutatedSource: { "src/greet.ts": "return 'goodbye'" },
    });
    expect(input.sourceEvidence[0]?.sourceText).toBe("return 'goodbye'");
    expect(input.before).toBe("before body");
    expect(input.after).toBe("after body");
  });

  test("substitutes a sentinel when source or page content is absent", () => {
    const input = buildJudgePageInput({
      scenario,
      page,
      mutatedSource: {},
    });
    expect(input.sourceEvidence[0]?.sourceText).toMatch(/not found/u);
    expect(input.before).toMatch(/absent in the baseline/u);
    expect(input.after).toMatch(/absent in the final/u);
  });

  test("caps an oversized evidence excerpt", () => {
    const input = buildJudgePageInput({
      scenario,
      page,
      mutatedSource: { "src/greet.ts": "abcdefghij" },
      maxSourceChars: 4,
    });
    expect(input.sourceEvidence[0]?.sourceText).toMatch(
      /^abcd\n… \(truncated 6/u,
    );
  });
});

describe("assertPromptBlinded", () => {
  test("passes a prompt with no arm-identifying tokens", () => {
    const prompt: JudgePrompt = {
      system: "You are a documentation-accuracy grader.",
      user: "Baseline page ... Candidate page ...",
    };
    expect(() => assertPromptBlinded(prompt)).not.toThrow();
  });

  test.each([
    "produced by the with arm",
    "OPENWIKI_DISABLE_SOURCE_FRESHNESS",
    "arm=without",
  ])("throws when the prompt leaks %s", (leak) => {
    expect(() =>
      assertPromptBlinded({ system: "grader", user: `context ${leak}` }),
    ).toThrow(/arm-identifying token/u);
  });
});

const tok = (total: number): TokenUsage => ({
  inputTokens: total,
  outputTokens: 0,
  totalTokens: total,
});

/**
 * Build a {@link TrialArmResult} with defaults, overriding only what the report
 * math reads.
 *
 * @param over - The fields to override; `arm` is required.
 */
function armTrial(
  over: Partial<TrialArmResult> & { arm: Arm },
): TrialArmResult {
  return {
    scenarioId: "s1",
    trial: 1,
    skipped: false,
    model: "m",
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
    ...over,
  };
}

const scenarios: ScenarioBenchmarkResult[] = [
  {
    scenarioId: "s1",
    title: "S one",
    complexity: "small",
    trials: [
      {
        trial: 1,
        without: armTrial({
          arm: "without",
          expectedPages: 2,
          correctPages: 1,
          staleFactsRemaining: 2,
          wallMs: 10,
          tokens: tok(100),
        }),
        with: armTrial({
          arm: "with",
          expectedPages: 2,
          correctPages: 2,
          staleFactsRemaining: 1,
          wallMs: 30,
          tokens: tok(300),
        }),
      },
      {
        trial: 2,
        without: armTrial({
          arm: "without",
          expectedPages: 2,
          correctPages: 0,
          staleFactsRemaining: 3,
          wallMs: 20,
          tokens: tok(200),
        }),
        with: armTrial({
          arm: "with",
          expectedPages: 2,
          correctPages: 2,
          staleFactsRemaining: 0,
          wallMs: 40,
          tokens: tok(400),
        }),
      },
    ],
  },
];

const metadata: BenchmarkMetadata = {
  runId: "run-x",
  timestamp: "2026-08-05T00:00:00.000Z",
  sourceCommit: "abc123",
  agentModel: "agent-model",
  judgeProvider: "anthropic",
  judgeModel: "judge-model",
  trials: 2,
  scenarioIds: ["s1"],
  baselineContentHash: "hash-x",
};

describe("assembleBenchmarkResult and renderSummaryMarkdown", () => {
  const result = assembleBenchmarkResult({ metadata, scenarios });

  test("computes both arms' micro recall from the trials", () => {
    expect(result.aggregate.without.microRecall).toBeCloseTo(0.25, 10);
    expect(result.aggregate.with.microRecall).toBeCloseTo(1, 10);
    expect(result.aggregate.delta.microRecall).toBeCloseTo(0.75, 10);
  });

  const summary = renderSummaryMarkdown(result);

  test("renders the aggregate rows with raw numbers and signed deltas", () => {
    expect(summary).toContain("| Affected pages correct | 1/4 | 4/4 | +3 |");
    expect(summary).toContain(
      "| Synchronization recall (micro) | 25.0% | 100.0% | +75.0pp |",
    );
    expect(summary).toContain("| Stale facts remaining | 5 | 1 | -4 |");
    expect(summary).toContain("| Median tokens | 150 | 350 | +200 |");
    expect(summary).toContain(
      "| Median agent wall time (ms) | 15 | 35 | +20 |",
    );
  });

  test("renders a by-scenario recall row and the run metadata", () => {
    expect(summary).toContain("| s1 | small | 25.0% | 100.0% |");
    expect(summary).toContain("run-x");
    expect(summary).toContain("abc123");
    expect(summary).toContain("anthropic/judge-model");
  });
});
