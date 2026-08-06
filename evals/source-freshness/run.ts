/**
 * The source-freshness benchmark runner (spec sections 7, 24-28).
 *
 * Orchestration and filesystem I/O only; every decision it makes lives in a pure,
 * unit-tested module (`report.ts`, `grading/*`, `baseline.ts`). For each scenario
 * it verifies the frozen baseline, resolves the post-mutation source once, then
 * runs both arms of every trial through the real update agent, grades each final
 * wiki with the deterministic floor and the blinded judge, and writes the result
 * tree. Arms run strictly sequentially because the freshness toggle is a
 * process-global environment variable.
 *
 * This spends tokens: it runs the real agent and calls a judge model. It is never
 * imported by a unit test; the pure logic it depends on is tested directly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModel, resolveModelId } from "../../src/agent/index.js";
import {
  resolveConfiguredProvider,
  resolveProviderRetryAttempts,
} from "../../src/constants.js";
import { verifyBaseline } from "./baseline.js";
import type { DeterministicGrade } from "./grading/deterministic.js";
import { gradeDeterministic } from "./grading/deterministic.js";
import type { PageJudgeResult } from "./grading/judge.js";
import {
  buildJudgePrompt,
  createChatModelJudge,
  parseJudgeResponse,
  type JudgeModel,
} from "./grading/judge.js";
import type { TrialArmResult } from "./grading/aggregate.js";
import { combineTrialArm } from "./grading/aggregate.js";
import type { Arm, ArmRunResult } from "./harness/arms.js";
import { runArm } from "./harness/arms.js";
import {
  baselineWikiDir,
  DEFAULT_BASELINE_DIR,
  EVAL_ROOT,
  normalizeRepoRelativePath,
  readMutatedSource,
  readWikiPages,
  resolveWithin,
} from "./harness/repo.js";
import {
  assembleBenchmarkResult,
  assertPromptBlinded,
  buildJudgePageInput,
  parseArgs,
  renderSummaryMarkdown,
  type BenchmarkMetadata,
  type ScenarioBenchmarkResult,
  type TrialPairResult,
} from "./report.js";
import type { EvalScenario } from "./scenarios/types.js";
import { selectScenarios, validateScenarios } from "./scenarios/index.js";

/** The per-arm grading artifacts persisted for one trial. */
interface ArmGradingArtifact {
  /** The deterministic grade for the trial. */
  deterministic: DeterministicGrade;

  /** The judge result per expected page, keyed by page path. */
  judge: Record<string, PageJudgeResult>;

  /** The combined per-trial metrics. */
  metrics: TrialArmResult;
}

/** Turn an ISO-8601 timestamp into a filesystem-safe run id. */
export function makeRunId(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

/** Collect the unique source-evidence paths a scenario references. */
export function uniqueEvidencePaths(scenario: EvalScenario): string[] {
  const paths = new Set<string>();
  for (const page of scenario.expectedAffectedPages) {
    for (const evidence of page.sourceEvidence) {
      paths.add(evidence.path);
    }
  }
  return [...paths];
}

/** Write a JSON file, creating parents, with contained permissions. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Write a UTF-8 text file, creating parents, with contained permissions. */
async function writeTextFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}

/**
 * Write a final wiki tree under `finalWikiDir`, one file per page. Page keys are
 * `openwiki/...` paths; the `openwiki/` prefix is stripped and the remainder is
 * contained under `finalWikiDir` so a malformed key cannot escape the run tree.
 *
 * @param finalWikiDir - The destination directory for this arm's final wiki.
 *
 * @param finalWiki - The page map keyed by repo-relative POSIX path.
 */
async function writeFinalWiki(
  finalWikiDir: string,
  finalWiki: Record<string, string>,
): Promise<void> {
  const prefix = "openwiki/";
  for (const [pageKey, content] of Object.entries(finalWiki)) {
    const relative = pageKey.startsWith(prefix)
      ? pageKey.slice(prefix.length)
      : pageKey;
    await writeTextFile(resolveWithin(finalWikiDir, relative), content);
  }
}

/**
 * Persist one arm's per-trial artifacts (spec section 24): the final wiki tree,
 * the distilled agent-run record, and the grading detail.
 *
 * @param armDir - The `.../trial-N/<arm>` directory.
 *
 * @param armResult - The arm's run result.
 *
 * @param grading - The arm's grading artifacts.
 */
async function writeTrialArmArtifacts(
  armDir: string,
  armResult: ArmRunResult,
  grading: ArmGradingArtifact,
): Promise<void> {
  await writeFinalWiki(join(armDir, "final-wiki"), armResult.finalWiki);
  await writeJsonFile(join(armDir, "agent-run.json"), {
    arm: armResult.arm,
    skipped: armResult.skipped,
    model: armResult.model,
    wallMs: armResult.wallMs,
    frozenCommit: armResult.frozenCommit,
    mutationCommit: armResult.mutationCommit,
    surfacedStalePages: armResult.surfacedStalePages,
    telemetry: armResult.telemetry,
  });
  await writeJsonFile(join(armDir, "grading.json"), {
    deterministic: grading.deterministic,
    judge: grading.judge,
    metrics: grading.metrics,
  });
}

/**
 * Fail loudly when a scenario's mutation produced no commit (spec section 27:
 * "mutation produced no diff"). A no-op mutation would make both arms trivially
 * identical and the comparison meaningless.
 *
 * @param scenario - The scenario, for the error message.
 *
 * @param armResult - The arm result whose bounding commits are checked.
 */
function assertMutationProducedDiff(
  scenario: EvalScenario,
  armResult: ArmRunResult,
): void {
  if (armResult.frozenCommit === armResult.mutationCommit) {
    throw new Error(
      `integrity: scenario ${scenario.id} produced no source diff (frozen and mutation commits are identical)`,
    );
  }
}

/** Inputs for {@link gradeArm}. */
interface GradeArmArgs {
  /** The scenario being graded. */
  scenario: EvalScenario;

  /** The arm that ran. */
  arm: Arm;

  /** The 1-based trial index. */
  trial: number;

  /** The arm's run result. */
  armResult: ArmRunResult;

  /** The frozen baseline wiki pages ("before"). */
  before: Record<string, string>;

  /** The resolved post-mutation source bytes keyed by path. */
  mutatedSource: Record<string, string | undefined>;

  /** The judge model. */
  judgeModel: JudgeModel;
}

/**
 * Grade one arm's final wiki: run the deterministic floor, judge every expected
 * page through a blinded prompt (asserting no arm leak first), and combine into
 * per-trial metrics.
 *
 * @param args - The scenario, arm result, baseline, source, and judge model.
 */
async function gradeArm(
  args: GradeArmArgs,
): Promise<{ metrics: TrialArmResult; grading: ArmGradingArtifact }> {
  const deterministic = gradeDeterministic({
    scenario: args.scenario,
    before: args.before,
    after: args.armResult.finalWiki,
  });

  const judge: Record<string, PageJudgeResult> = {};
  for (const page of args.scenario.expectedAffectedPages) {
    const input = buildJudgePageInput({
      scenario: args.scenario,
      page,
      before: args.before[page.page],
      after: args.armResult.finalWiki[page.page],
      mutatedSource: args.mutatedSource,
    });
    const prompt = buildJudgePrompt(input);
    assertPromptBlinded(prompt);
    const raw = await args.judgeModel.judge(prompt);
    judge[page.page] = parseJudgeResponse(raw, {
      requiredFactIds: page.requiredFacts.map((fact) => fact.id),
      forbiddenFactIds: page.forbiddenFacts.map((fact) => fact.id),
    });
  }

  const metrics = combineTrialArm({
    scenario: args.scenario,
    arm: args.arm,
    trial: args.trial,
    deterministic,
    judgeByPage: judge,
    telemetry: args.armResult.telemetry,
    wallMs: args.armResult.wallMs,
    skipped: args.armResult.skipped,
    model: args.armResult.model,
    surfacedStalePages:
      args.arm === "with" ? args.armResult.surfacedStalePages : undefined,
  });

  return { metrics, grading: { deterministic, judge, metrics } };
}

/** The runner entry point. */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const devRoot = parsed.devRoot ?? process.cwd();
  const baselineDir = parsed.baselineDir ?? DEFAULT_BASELINE_DIR;
  const outRoot = parsed.outDir ?? join(EVAL_ROOT, "results");

  // Integrity: the checked-in baseline must still match its manifest before any
  // tokens are spent (spec section 27).
  const manifest = await verifyBaseline(baselineDir);
  const baselineWiki = baselineWikiDir(baselineDir);

  const scenarios = selectScenarios(parsed.scenarioIds);
  validateScenarios(scenarios);

  // Build the judge model exactly the way the agent's model is resolved, with an
  // optional model-id override, so the eval works wherever OpenWiki is configured.
  const judgeProvider = resolveConfiguredProvider();
  const judgeModelId = resolveModelId(
    { modelId: parsed.judgeModelId },
    judgeProvider,
  );
  const judgeModel = createChatModelJudge(
    createModel(judgeProvider, judgeModelId, resolveProviderRetryAttempts()),
  );

  const timestamp = new Date().toISOString();
  const runId = makeRunId(timestamp);
  const runDir = resolveWithin(outRoot, runId);

  const before = await readWikiPages(baselineDir);

  const scenarioResults: ScenarioBenchmarkResult[] = [];
  let agentModel = manifest.agentModel;

  for (const scenario of scenarios) {
    const mutatedSource = await readMutatedSource({
      devRoot,
      sourceCommit: manifest.sourceCommit,
      scenario,
      paths: uniqueEvidencePaths(scenario),
    });

    const scenarioDir = join(
      runDir,
      "scenarios",
      normalizeRepoRelativePath(scenario.id),
    );

    const trials: TrialPairResult[] = [];
    for (let trial = 1; trial <= parsed.trials; trial += 1) {
      const pair: Partial<Record<Arm, TrialArmResult>> = {};

      // Arms run sequentially: the freshness toggle is process-global.
      for (const arm of ["without", "with"] as const) {
        const armResult = await runArm({
          scenario,
          arm,
          devRoot,
          sourceCommit: manifest.sourceCommit,
          baselineWiki,
        });
        assertMutationProducedDiff(scenario, armResult);
        agentModel = armResult.model;

        const { metrics, grading } = await gradeArm({
          scenario,
          arm,
          trial,
          armResult,
          before,
          mutatedSource,
          judgeModel,
        });

        await writeTrialArmArtifacts(
          join(scenarioDir, `trial-${trial}`, arm),
          armResult,
          grading,
        );
        pair[arm] = metrics;
      }

      if (!pair.without || !pair.with) {
        throw new Error(
          `internal: trial ${trial} of ${scenario.id} is missing an arm result`,
        );
      }
      trials.push({ trial, without: pair.without, with: pair.with });
    }

    scenarioResults.push({
      scenarioId: scenario.id,
      title: scenario.title,
      complexity: scenario.complexity,
      trials,
    });
  }

  const metadata: BenchmarkMetadata = {
    runId,
    timestamp,
    sourceCommit: manifest.sourceCommit,
    agentModel,
    judgeProvider,
    judgeModel: judgeModelId,
    trials: parsed.trials,
    scenarioIds: scenarios.map((scenario) => scenario.id),
    baselineContentHash: manifest.contentHash,
  };

  const result = assembleBenchmarkResult({
    metadata,
    scenarios: scenarioResults,
  });

  await writeJsonFile(join(runDir, "metadata.json"), metadata);
  await writeJsonFile(join(runDir, "results.json"), result);
  await writeTextFile(
    join(runDir, "summary.md"),
    renderSummaryMarkdown(result),
  );

  process.stdout.write(`Wrote benchmark results to ${runDir}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
