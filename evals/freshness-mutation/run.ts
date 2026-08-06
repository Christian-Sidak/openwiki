/**
 * CLI for the mutation-based freshness eval.
 *
 * Runs the deterministic-mechanism cases (category 1, the CI regression core),
 * the gitHead durability case, and the end-to-end coverage pass over this
 * repo's own source (category 2). Prints a human-readable summary and, with
 * `--json` or `OPENWIKI_FRESHNESS_JSON=1`, writes a structured artifact for
 * run-to-run comparison.
 *
 * Exit code is non-zero when any deterministic-mechanism case fails, the
 * durability case fails, or the coverage pass produces a false positive (a
 * cosmetic change wrongly flagged). Coverage misses are reported but do not
 * fail the run: they are dependency-coverage gaps, not checker bugs.
 *
 * Run it: `tsx evals/freshness-mutation/run.ts [--json]`
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MECHANISM_CASES,
  runCoveragePipeline,
  runDurabilityCase,
  runMutationCase,
  type CaseResult,
  type CoverageOutcome,
  type SweepMetrics,
} from "./mutation-eval.js";
import { runHeadToHead, type HeadToHeadReport } from "./head-to-head.js";

const COVERAGE_SAMPLE_SIZE = 40;

/**
 * Sum sweep metrics across a set of case results, ignoring skipped cases.
 *
 * @param results - The case results to total.
 */
function totalMetrics(results: readonly CaseResult[]): SweepMetrics {
  const total: SweepMetrics = {
    durationMs: 0,
    pagesSwept: 0,
    filesHashed: 0,
    filesParsed: 0,
    definitionsResolved: 0,
  };
  for (const result of results) {
    if (result.metrics) {
      total.durationMs += result.metrics.durationMs;
      total.pagesSwept += result.metrics.pagesSwept;
      total.filesHashed += result.metrics.filesHashed;
      total.filesParsed += result.metrics.filesParsed;
      total.definitionsResolved += result.metrics.definitionsResolved;
    }
  }
  return total;
}

/**
 * A fixed-width status tag for the per-case table.
 *
 * @param status - The case status.
 */
function tag(status: CaseResult["status"]): string {
  if (status === "pass") {
    return "PASS";
  }
  return status === "fail" ? "FAIL" : "SKIP";
}

/**
 * Render the summary of one page's expected outcome for the table.
 *
 * @param result - The graded case.
 */
function expectation(result: CaseResult): string {
  const entries = Object.entries(result.expectedNotFresh);
  if (entries.length === 0) {
    return "all fresh";
  }
  return entries.map(([page, state]) => `${page.split("/").pop()}:${state}`).join(", ");
}

/**
 * Print the category-1 mechanism section and return whether it fully passed.
 *
 * @param results - The mechanism case results (including durability).
 */
function reportMechanism(results: readonly CaseResult[]): boolean {
  console.log("=== Category 1: deterministic freshness mechanism ===\n");
  console.log(
    "Hands the checker a known-correct sidecar, then mutates the cited symbol.",
  );
  console.log("This isolates the machinery from the agent and should be 100%.\n");

  const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
  console.log(
    `${"case".padEnd(nameWidth)}  result  expected`,
  );
  console.log("-".repeat(nameWidth + 8 + 24));
  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${tag(result.status).padEnd(6)}  ${expectation(result)}`,
    );
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  const skippedCount = results.filter((r) => r.status === "skipped").length;

  console.log(
    `\npass rate: ${passed}/${results.length}` +
      (skippedCount > 0 ? ` (${skippedCount} skipped)` : ""),
  );

  const staleCases = results.filter(
    (r) => Object.keys(r.expectedNotFresh).length > 0,
  );
  const expectedStale = staleCases.length;
  const detectedStale = staleCases.filter(
    (r) => r.status === "pass" || (r.missed.length === 0 && r.status !== "skipped"),
  ).length;
  const totalFalsePositives = results.reduce(
    (sum, r) => sum + r.falsePositives.length,
    0,
  );
  console.log(
    `stale-page recall: ${detectedStale}/${expectedStale}  unnecessary invalidations: ${totalFalsePositives}`,
  );

  for (const result of failed) {
    console.log(`\nFAIL ${result.name}: ${result.detail ?? "state mismatch"}`);
    if (result.missed.length > 0) {
      console.log(`  missed (expected not-fresh, got fresh): ${result.missed.join(", ")}`);
    }
    if (result.falsePositives.length > 0) {
      console.log(`  false positives (expected fresh, got not-fresh): ${result.falsePositives.join(", ")}`);
    }
    for (const mismatch of result.stateMismatches) {
      console.log(
        `  wrong state on ${mismatch.page}: expected ${mismatch.expected}, got ${mismatch.actual}`,
      );
    }
    const deps = Object.entries(result.recordedDeps);
    if (deps.length > 0) {
      console.log("  recorded dependencies:");
      for (const [page, symbols] of deps) {
        console.log(`    ${page} -> ${symbols.join(", ")}`);
      }
    }
  }

  const metrics = totalMetrics(results);
  console.log(
    `\npreflight cost (all cases): ${metrics.durationMs.toFixed(1)}ms, ` +
      `${metrics.pagesSwept} pages swept, ${metrics.filesHashed} files hashed, ` +
      `${metrics.filesParsed} parsed, ${metrics.definitionsResolved} definitions resolved`,
  );

  return failed.length === 0 && skippedCount === 0;
}

/**
 * Print the durability case result.
 *
 * @param result - The durability case result.
 */
function reportDurability(result: CaseResult): void {
  console.log("\n=== gitHead durability ===\n");
  console.log(
    "Change a cited def, advance gitHead past it without repairing the page,",
  );
  console.log("then confirm the page is STILL not-fresh with an empty git diff.\n");
  console.log(`${tag(result.status)}  ${result.detail ?? ""}`);
}

/**
 * Print the category-2 coverage section and return whether it is free of false
 * positives (a false positive is a checker bug; a miss is a coverage gap).
 *
 * @param outcome - The coverage pass outcome.
 */
function reportCoverage(outcome: CoverageOutcome): boolean {
  console.log("\n=== Category 2: end-to-end coverage (real source) ===\n");
  console.log(
    "The real recorder grounds pages in real symbols; then a semantic change",
  );
  console.log(
    "must be detected and a cosmetic change must stay fresh. This exercises the",
  );
  console.log(
    "recorder + preflight pipeline; judging the agent's symbol choice needs a",
  );
  console.log("real generated wiki (Tier B, see README).\n");

  console.log(
    `sampled ${outcome.symbolsSampled} symbols from ${outcome.filesScanned} files ` +
      `(${outcome.symbolsSkipped} skipped as unresolved)`,
  );
  console.log(
    `positive probes: ${outcome.detected}/${outcome.positiveProbes} detected  ` +
      `cosmetic probes: ${outcome.cosmeticProbes}, false positives: ${outcome.falsePositives.length}`,
  );

  if (outcome.missed.length > 0) {
    console.log("\ncoverage gaps (semantic change not detected):");
    for (const miss of outcome.missed) {
      console.log(`  ${miss.path} :: ${miss.symbol}`);
    }
  }
  if (outcome.falsePositives.length > 0) {
    console.log("\nFALSE POSITIVES (cosmetic change wrongly flagged):");
    for (const fp of outcome.falsePositives) {
      console.log(`  ${fp.path} :: ${fp.symbol}`);
    }
  }

  const m = outcome.metrics;
  console.log(
    `\npreflight cost (coverage): ${m.durationMs.toFixed(1)}ms, ` +
      `${m.pagesSwept} pages swept, ${m.filesHashed} files hashed, ` +
      `${m.filesParsed} parsed, ${m.definitionsResolved} definitions resolved`,
  );

  return outcome.falsePositives.length === 0;
}

/**
 * Print the head-to-head section (the headline result) and return whether the
 * core durability claim held.
 *
 * @param report - The head-to-head report.
 */
function reportHeadToHead(report: HeadToHeadReport): boolean {
  const { aggregate: a } = report;

  console.log(
    "=== Head-to-head: OpenWiki update gate, without vs with source freshness ===\n",
  );
  console.log(
    "Same repo, wiki, and mutations over OpenWiki's own pages and source. The",
  );
  console.log(
    "only variable is whether recorded sidecars exist. No model is invoked: the",
  );
  console.log(
    'difference lives entirely in the real getUpdateNoopStatus gate. "Recovered"',
  );
  console.log('and "run triggered" mean the gate decided to run (shouldSkip=false).\n');

  const col = (value: string): string => value.padEnd(20);
  console.log(`${"Situation".padEnd(44)}${col("Without freshness")}With freshness`);
  console.log("-".repeat(44 + 20 + 14));
  console.log(
    `${"Normal in-range change (run triggered)".padEnd(44)}` +
      `${col(`${a.inRangeRan.without}/${a.positives}`)}${a.inRangeRan.with}/${a.positives}`,
  );
  console.log(
    `${"Stale page after Git cursor advanced".padEnd(44)}` +
      `${col(`${a.recoveredAfterAdvance.without}/${a.positives} recovered`)}` +
      `${a.recoveredAfterAdvance.with}/${a.positives} recovered`,
  );
  console.log(
    `${"Cosmetic/unrelated edit, cursor advanced".padEnd(44)}` +
      `${col(`${a.spuriousReruns.without}/${a.controls} spurious`)}` +
      `${a.spuriousReruns.with}/${a.controls} spurious`,
  );
  console.log(
    `${"Median added preflight cost".padEnd(44)}${col("-")}` +
      `${a.medianFreshnessMs.toFixed(1)} ms`,
  );

  console.log(
    `\nHeadline: without source freshness, ${a.recoveredAfterAdvance.without}/${a.positives} ` +
      `stale pages were recovered once the Git cursor advanced past the change ` +
      `(empty Git diff); with source freshness, ${a.recoveredAfterAdvance.with}/${a.positives} ` +
      `were, because the sidecar still disagreed with the source and forced the run again.`,
  );
  console.log(
    "In-range changes are byte-identical across arms: Git still sees the change, " +
      "so freshness is never consulted and does not alter the normal path.",
  );

  if (!report.claimHolds) {
    console.log("\nCLAIM DID NOT HOLD:");
    for (const c of report.cases) {
      const expectedRecover = c.case.expectedStale;
      const withRan = c.afterAdvance.with.ran;
      const withoutRan = c.afterAdvance.without.ran;
      if (
        (expectedRecover && (!withRan || withoutRan)) ||
        (!expectedRecover && (withRan || withoutRan))
      ) {
        console.log(
          `  ${c.case.name}: after-advance without=${withoutRan} with=${withRan} ` +
            `(expected ${expectedRecover ? "recover" : "skip"})`,
        );
      }
    }
  }

  return report.claimHolds;
}

/**
 * Run every section, print the summary, optionally write the JSON artifact, and
 * set the process exit code.
 */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = join(here, "..", "..", "src");

  const headToHead = await runHeadToHead();

  const mechanism: CaseResult[] = [];
  for (const testCase of MECHANISM_CASES) {
    mechanism.push(await runMutationCase(testCase));
  }
  const durability = await runDurabilityCase();
  const mechanismAll = [...mechanism, durability];

  const coverage = await runCoveragePipeline(srcRoot, COVERAGE_SAMPLE_SIZE);

  const headToHeadOk = reportHeadToHead(headToHead);
  console.log("\n");
  const mechanismOk = reportMechanism(mechanismAll);
  reportDurability(durability);
  const coverageOk = reportCoverage(coverage);

  const wantJson =
    process.argv.includes("--json") || process.env.OPENWIKI_FRESHNESS_JSON === "1";
  if (wantJson) {
    const artifact = {
      generatedAt: new Date().toISOString(),
      measures: "source-grounded staleness detection only",
      headToHead,
      mechanism: mechanismAll,
      coverage,
    };
    const outPath = join(here, "results.json");
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    console.log(`\nwrote ${outPath}`);
  }

  const ok =
    headToHeadOk && mechanismOk && durability.status === "pass" && coverageOk;
  console.log(`\n${ok ? "PASS" : "FAIL"}: mutation freshness eval`);
  if (!ok) {
    process.exitCode = 1;
  }
}

await main();
