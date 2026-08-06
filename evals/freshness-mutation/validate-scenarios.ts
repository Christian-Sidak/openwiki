/**
 * Deterministic validation of the real-agent head-to-head scenarios, with no
 * agent and no token cost. For every scenario it:
 *
 * 1. Checks the ground-truth markers are well-formed against the baseline pages
 *    (each `staleMarker` present, each `requiredMarker` absent).
 * 2. Records the WITH-arm sidecars with the production recorder and confirms
 *    every grounding resolves (no warnings, one dependency per request).
 * 3. Applies the change and runs the real `checkWikiFreshness`, then reports
 *    recall (are all expected pages flagged?) and precision (which non-expected
 *    pages are also flagged — the over-approximation cost of definition-level
 *    tracking).
 *
 * Recall failures are hard errors: if the mechanism cannot even flag a page a
 * human labeled stale, the head-to-head is not measuring what it claims. Over-
 * flagging is reported, not failed, because imperfect precision is an expected
 * and measured property, not a bug.
 *
 * Run: `tsx evals/freshness-mutation/validate-scenarios.ts`
 */

import { recordSourceDependencies } from "../../src/staleness/recorder.js";
import { writeSidecarAtomic } from "../../src/staleness/storage.js";
import { FileSystemSourceReader } from "../../src/staleness/freshness.js";
import { checkWikiFreshness } from "../../src/staleness/preflight.js";
import { git, sharedResolver, withTempGitRepo } from "../freshness/harness.js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SCENARIOS, type Scenario } from "./agent-head-to-head.js";

/**
 * The outcome of validating one scenario.
 */
interface Validation {
  scenario: string;
  failures: string[];
  recall: string;
  overFlagged: string[];
}

/**
 * Write a baseline file under the throwaway repo, creating parent directories.
 */
async function writeSource(
  cwd: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolute = path.join(cwd, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

/**
 * Validate one scenario deterministically and return its outcome.
 */
async function validate(scenario: Scenario): Promise<Validation> {
  const failures: string[] = [];

  for (const expected of scenario.expected) {
    const baseline = scenario.pages[expected.page] ?? "";
    if (baseline.length === 0) {
      failures.push(`baseline page missing: ${expected.page}`);
    }
    if (
      expected.staleMarker !== undefined &&
      !baseline.includes(expected.staleMarker)
    ) {
      failures.push(
        `staleMarker absent from baseline ${expected.page}: ${JSON.stringify(expected.staleMarker)}`,
      );
    }
    if (
      expected.requiredMarker !== undefined &&
      baseline.toLowerCase().includes(expected.requiredMarker.toLowerCase())
    ) {
      failures.push(
        `requiredMarker already in baseline ${expected.page}: ${JSON.stringify(expected.requiredMarker)}`,
      );
    }
    if (expected.staleMarker === undefined && expected.requiredMarker === undefined) {
      failures.push(`no marker set for ${expected.page}`);
    }
  }

  return withTempGitRepo(async (cwd) => {
    for (const [relativePath, contents] of Object.entries(scenario.sources)) {
      await writeSource(cwd, relativePath, contents);
    }
    for (const [relativePath, contents] of Object.entries(scenario.pages)) {
      await writeSource(cwd, relativePath, contents);
    }
    await git(cwd, ["init"]);
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "baseline"]);

    const reader = new FileSystemSourceReader(cwd);
    const byPage = new Map<string, { path: string; symbol?: string }[]>();
    for (const grounding of scenario.grounding) {
      const list = byPage.get(grounding.page) ?? [];
      list.push({ path: grounding.path, symbol: grounding.symbol });
      byPage.set(grounding.page, list);
    }
    for (const [page, requests] of byPage) {
      const { sidecar, warnings } = await recordSourceDependencies({
        page,
        pageBytes: scenario.pages[page],
        requests,
        resolver: sharedResolver,
        reader,
      });
      if (warnings.length > 0) {
        failures.push(`recorder warnings for ${page}: ${JSON.stringify(warnings)}`);
      }
      if (sidecar.sources.length !== requests.length) {
        failures.push(
          `expected ${requests.length} deps for ${page}, recorded ${sidecar.sources.length}`,
        );
      }
      await writeSidecarAtomic(cwd, sidecar);
    }

    await scenario.applyChange(cwd);
    const freshness = await checkWikiFreshness(cwd);
    const drifted = new Set(freshness.drifted.map((entry) => entry.page));
    const expectedSet = new Set(scenario.expected.map((entry) => entry.page));

    let flagged = 0;
    for (const expected of scenario.expected) {
      if (drifted.has(expected.page)) {
        flagged += 1;
      } else {
        failures.push(
          `recall miss: expected page not flagged ${expected.page} (states: ${freshness.drifted
            .map((entry) => `${entry.page}=${entry.state}`)
            .join(", ")})`,
        );
      }
    }

    const overFlagged = [...drifted]
      .filter((page) => !expectedSet.has(page))
      .sort();

    return {
      scenario: scenario.name,
      failures,
      recall: `${flagged}/${scenario.expected.length}`,
      overFlagged,
    };
  });
}

async function main(): Promise<void> {
  const results: Validation[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await validate(scenario));
  }

  let hardFailures = 0;
  for (const result of results) {
    process.stdout.write(`# ${result.scenario}\n`);
    process.stdout.write(
      `  recall: ${result.recall}; over-flagged (precision cost): ${result.overFlagged.length === 0 ? "none" : result.overFlagged.join(", ")}\n`,
    );
    for (const failure of result.failures) {
      hardFailures += 1;
      process.stdout.write(`  FAIL: ${failure}\n`);
    }
  }

  process.stdout.write(
    `\n${hardFailures === 0 ? "ALL CHECKS PASSED" : `${hardFailures} CHECK(S) FAILED`}\n`,
  );
  process.exitCode = hardFailures === 0 ? 0 : 1;
}

await main();
