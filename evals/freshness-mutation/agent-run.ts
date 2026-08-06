/**
 * Runner for the real-agent head-to-head (see agent-head-to-head.ts).
 *
 * This invokes the real update agent against the configured provider, so it
 * costs tokens and wall time. By default it runs only the smallest scenario as
 * a cheap smoke. Pass `--all` for the full four-scenario matrix, or
 * `--scenario=<name>` (repeatable) to pick specific ones.
 *
 *   tsx evals/freshness-mutation/agent-run.ts                  # smallest only
 *   tsx evals/freshness-mutation/agent-run.ts --all            # all four
 *   tsx evals/freshness-mutation/agent-run.ts --scenario=cross-cutting
 *   tsx evals/freshness-mutation/agent-run.ts --all --json     # + agent-results.json
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runScenario,
  SCENARIOS,
  type ScenarioResult,
} from "./agent-head-to-head.js";

/**
 * Parse the CLI flags into the set of scenarios to run and whether to write
 * the JSON artifact.
 */
function parseArgs(argv: string[]): {
  names: string[];
  json: boolean;
} {
  const wantAll = argv.includes("--all");
  const json = argv.includes("--json");
  const picked = argv
    .filter((arg) => arg.startsWith("--scenario="))
    .map((arg) => arg.slice("--scenario=".length));

  if (picked.length > 0) {
    return { names: picked, json };
  }
  if (wantAll) {
    return { names: SCENARIOS.map((scenario) => scenario.name), json };
  }
  // Default: the smallest scenario only.
  return { names: [SCENARIOS[0].name], json };
}

/**
 * Format one arm as `updated/expected, missed M, extra U, Ns`.
 */
function formatArm(result: ScenarioResult["without"], expected: number): string {
  const suffix = result.errored ? " (errored)" : "";
  return `${result.correctlyUpdated.length}/${expected} updated, ${result.stillStale.length} still-stale, ${result.unnecessary.length} extra, ${(result.wallMs / 1000).toFixed(1)}s${suffix}`;
}

async function main(): Promise<void> {
  const { names, json } = parseArgs(process.argv.slice(2));
  const scenarios = SCENARIOS.filter((scenario) => names.includes(scenario.name));

  if (scenarios.length === 0) {
    process.stderr.write(
      `no matching scenarios; known: ${SCENARIOS.map((scenario) => scenario.name).join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    "Real-agent head-to-head: OpenWiki update WITHOUT vs WITH source freshness\n",
  );
  process.stdout.write(
    "(both arms run the real agent; the only variable is recorded sidecars)\n\n",
  );

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`# ${scenario.name} (${scenario.kind})\n`);
    process.stdout.write(`  ${scenario.description}\n`);
    const result = await runScenario(scenario);
    results.push(result);
    process.stdout.write(
      `  WITHOUT freshness: ${formatArm(result.without, result.expectedCount)}\n`,
    );
    process.stdout.write(
      `  WITH freshness:    ${formatArm(result.with, result.expectedCount)}\n`,
    );
    if (result.with.stillStale.length > 0) {
      process.stdout.write(
        `    with-arm still stale: ${result.with.stillStale.join(", ")}\n`,
      );
    }
    if (result.without.stillStale.length > 0) {
      process.stdout.write(
        `    without-arm still stale: ${result.without.stillStale.join(", ")}\n`,
      );
    }
    if (result.without.unnecessary.length > 0) {
      process.stdout.write(
        `    without-arm extra edits: ${result.without.unnecessary.join(", ")}\n`,
      );
    }
    if (result.with.unnecessary.length > 0) {
      process.stdout.write(
        `    with-arm extra edits: ${result.with.unnecessary.join(", ")}\n`,
      );
    }
    process.stdout.write("\n");
  }

  // The headline claim: with freshness, the agent misses no fewer expected
  // pages than without, on at least one scenario it misses strictly fewer, and
  // it never introduces more unnecessary edits.
  const anyImprovement = results.some(
    (result) => result.with.stillStale.length < result.without.stillStale.length,
  );
  const neverWorse = results.every(
    (result) =>
      result.with.stillStale.length <= result.without.stillStale.length,
  );
  process.stdout.write(
    `Summary: with-freshness never worse on missed pages: ${neverWorse}; strictly better somewhere: ${anyImprovement}\n`,
  );

  if (json) {
    const outPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "agent-results.json",
    );
    await writeFile(outPath, `${JSON.stringify({ results }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    process.stdout.write(`wrote ${outPath}\n`);
  }
}

await main();
