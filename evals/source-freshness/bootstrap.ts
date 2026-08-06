/**
 * Baseline bootstrap for the source-freshness end-to-end eval (spec section 5).
 *
 * Produces the one frozen state every trial seeds from:
 *
 * ```text
 * source at commit A  +  wiki valid for A  +  agent-recorded sidecars for A
 * ```
 *
 * The wiki that ships in the corpus has no dependency sidecars yet, so a plain
 * `update` would no-op (git is clean) and `checkWikiFreshness` would report
 * `allFresh` trivially (a page with no sidecar does not participate). This script
 * therefore drives the REAL agent grounding path: it forces a full update pass
 * and hands the agent a fixed instruction to call its own
 * `record_source_dependencies` tool for every source-grounded page. Every sidecar
 * is authored by the product's tool, never hand-written or enriched here (spec
 * section 5). It repeats forced passes until every eligible page has a sidecar
 * AND the whole wiki evaluates fresh, capped at `--max-passes`.
 *
 * On convergence it asserts the agent touched only `openwiki/` (never source),
 * freezes the whole `openwiki/` tree (pages plus `.source-deps`) into the
 * baseline directory, and writes `manifest.json` with a content hash the runner
 * re-verifies before spending any tokens.
 *
 * This makes live LLM API calls. Run it once to (re)generate the baseline:
 *
 * ```sh
 * npx tsx evals/source-freshness/bootstrap.ts            # freeze HEAD
 * npx tsx evals/source-freshness/bootstrap.ts --commit <ref> --max-passes 5
 * ```
 */

import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOpenWikiAgent } from "../../src/agent/index.js";
import type { OpenWikiRunEvent } from "../../src/agent/types.js";
import { loadOpenWikiEnv } from "../../src/env.js";
import { checkWikiFreshness } from "../../src/staleness/preflight.js";
import {
  listSourceGroundedPages,
  readSidecar,
} from "../../src/staleness/storage.js";
import { DISABLE_SOURCE_FRESHNESS_ENV_KEY } from "../../src/staleness/toggle.js";
import {
  BASELINE_MANIFEST_FILE,
  computeBaselineContentHash,
  countBaselineTree,
  verifyBaseline,
  type BaselineManifest,
} from "./baseline.js";
import {
  baselineWikiDir,
  DEFAULT_BASELINE_DIR,
  EVAL_ROOT,
  extractSourceTree,
  git,
  withTempGitRepo,
} from "./harness/repo.js";

/** Default cap on forced grounding passes before giving up (spec section 5). */
const DEFAULT_MAX_PASSES = 4;

/** File mode for eval artifacts: owner-only read/write. */
const FILE_MODE = 0o600;

/** Directory mode for eval artifacts: owner-only. */
const DIR_MODE = 0o700;

/**
 * Fixed instruction handed to the agent on every bootstrap pass. It drives the
 * product's own `record_source_dependencies` tool across the wiki; it is a
 * constant, never derived from any untrusted input, and it never asks the agent
 * to rewrite accurate prose (spec section 5: do not enrich state to make
 * scenarios pass).
 */
const GROUNDING_INSTRUCTION = [
  "This repository has source-grounded freshness enabled, but its wiki pages do not yet have recorded source dependencies.",
  "For every wiki page that documents specific code, call record_source_dependencies with the page path and the exact source definitions (prefer qualified symbols such as ClassName.method) whose behavior the page's claims depend on, so a later update can detect when the page has drifted from the code.",
  "Do not rewrite prose that is already accurate; only correct a page if it is genuinely wrong about the current code. Ground every eligible page before you finish.",
].join(" ");

/** Parsed bootstrap CLI options. */
interface BootstrapArgs {
  /**
   * The corpus commit-ish to freeze.
   *
   * @default undefined - freeze the developer checkout's current HEAD.
   */
  commit?: string;

  /** Maximum forced grounding passes before failing as non-convergent. */
  maxPasses: number;

  /** Baseline root directory to write the frozen tree and manifest into. */
  baselineDir: string;
}

/**
 * Parse bootstrap arguments with a hand-written allowlist parser (no shelling,
 * no dynamic evaluation). Unknown flags fail loudly.
 *
 * @param argv - Raw arguments after the node/script prefix.
 */
function parseArgs(argv: string[]): BootstrapArgs {
  const result: BootstrapArgs = {
    maxPasses: DEFAULT_MAX_PASSES,
    baselineDir: DEFAULT_BASELINE_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    switch (flag) {
      case "--commit": {
        if (!value) {
          throw new Error("--commit requires a value");
        }
        result.commit = value;
        index += 1;
        break;
      }
      case "--max-passes": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--max-passes requires a positive integer");
        }
        result.maxPasses = parsed;
        index += 1;
        break;
      }
      case "--baseline-dir": {
        if (!value) {
          throw new Error("--baseline-dir requires a value");
        }
        result.baselineDir = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }

  return result;
}

/** A read of the wiki's current grounding state, used for convergence. */
interface GroundingStatus {
  /** Eligible pages that still have no sidecar. */
  ungrounded: string[];

  /** Eligible pages whose sidecar evaluates to a non-fresh state. */
  notFresh: string[];

  /** True when every eligible page has a sidecar and the whole wiki is fresh. */
  converged: boolean;
}

/**
 * Read the wiki's grounding state: which eligible pages lack a sidecar, and
 * which recorded pages no longer evaluate fresh against the current source.
 *
 * @param cwd - The bootstrap trial repo root.
 */
async function readGroundingStatus(cwd: string): Promise<GroundingStatus> {
  const eligible = await listSourceGroundedPages(cwd);

  const ungrounded: string[] = [];
  for (const page of eligible) {
    if ((await readSidecar(cwd, page)) === undefined) {
      ungrounded.push(page);
    }
  }

  const freshness = await checkWikiFreshness(cwd);
  const notFresh = freshness.drifted.map((entry) => entry.page);

  return {
    ungrounded,
    notFresh,
    converged: ungrounded.length === 0 && freshness.allFresh,
  };
}

/**
 * An `onEvent` tap that prints one compact progress line per tool start, so a
 * background monitor can watch grounding advance. Tool names are product-fixed
 * strings; nothing from the tool input is printed.
 *
 * @param pass - The 1-based pass number, for the log prefix.
 */
function progressOnEvent(pass: number): (event: OpenWikiRunEvent) => void {
  return (event) => {
    if (event.type === "tool_start") {
      process.stdout.write(`[pass ${pass}] tool ${event.name}\n`);
    }
  };
}

/**
 * Recursively restrict a directory tree to owner-only permissions (dirs 0o700,
 * files 0o600), honoring the eval's artifact-permission guardrail.
 *
 * @param dir - Absolute directory to restrict, in place.
 */
async function restrictTree(dir: string): Promise<void> {
  await chmod(dir, DIR_MODE);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      await restrictTree(child);
    } else if (entry.isFile()) {
      await chmod(child, FILE_MODE);
    }
  }
}

/**
 * Freeze the converged wiki tree into the baseline directory: wipe any prior
 * baseline, copy `openwiki/` (pages plus `.source-deps`) out of the temp repo,
 * strip operational artifacts so the content hash is deterministic, restrict
 * permissions, then write and self-verify the manifest.
 *
 * @param cwd - The converged bootstrap trial repo root.
 *
 * @param baselineDir - The baseline root to write into.
 *
 * @param sourceCommit - The corpus commit the wiki was grounded against.
 *
 * @param agentModel - The model id the agent ran with.
 */
async function freezeBaseline(
  cwd: string,
  baselineDir: string,
  sourceCommit: string,
  agentModel: string,
): Promise<BaselineManifest> {
  const frozenWiki = baselineWikiDir(baselineDir);

  await rm(baselineDir, { recursive: true, force: true });
  await mkdir(baselineDir, { recursive: true, mode: DIR_MODE });
  await cp(join(cwd, "openwiki"), frozenWiki, { recursive: true });

  // Operational artifacts are not wiki content; trials write their own cursor,
  // and hashing a timestamped file would make the manifest non-deterministic.
  await rm(join(frozenWiki, ".last-update.json"), { force: true });
  await rm(join(frozenWiki, "_plan.md"), { force: true });

  await restrictTree(baselineDir);

  const counts = await countBaselineTree(baselineDir);
  const contentHash = await computeBaselineContentHash(baselineDir);
  const manifest: BaselineManifest = {
    sourceCommit,
    createdAt: new Date().toISOString(),
    agentModel,
    pageCount: counts.pageCount,
    sidecarCount: counts.sidecarCount,
    contentHash,
  };

  await writeFile(
    join(baselineDir, BASELINE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: FILE_MODE },
  );

  // Prove the freeze is self-consistent before any trial trusts it.
  await verifyBaseline(baselineDir);

  return manifest;
}

/**
 * Bootstrap entry point: build a throwaway repo at the corpus commit, ground the
 * wiki through the real agent path until convergence, then freeze the baseline.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Hydrate ~/.openwiki/.env (provider, model, credentials) and force the WITH
  // arm: the agent must run with freshness ON so it has the record tool and the
  // grounding instructions.
  await loadOpenWikiEnv();
  delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];

  const devRoot = await git(EVAL_ROOT, ["rev-parse", "--show-toplevel"]);
  const sourceCommit =
    args.commit ?? (await git(devRoot, ["rev-parse", "HEAD"]));

  console.log(
    `[bootstrap] devRoot=${devRoot} sourceCommit=${sourceCommit} maxPasses=${args.maxPasses}`,
  );

  const manifest = await withTempGitRepo(async (cwd) => {
    // Materialize source@commit (which carries the tracked openwiki/ wiki but no
    // sidecars) and commit it as the base the agent starts from.
    await extractSourceTree(devRoot, sourceCommit, cwd);
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "bootstrap base: source + wiki"]);
    const baseCommit = await git(cwd, ["rev-parse", "HEAD"]);

    let agentModel = "";

    for (let pass = 1; pass <= args.maxPasses; pass += 1) {
      // Force a full update: with no cursor, getUpdateNoopStatus cannot skip, so
      // the agent revisits the wiki and can ground every page.
      await rm(join(cwd, "openwiki", ".last-update.json"), { force: true });

      console.log(`[bootstrap] pass ${pass}/${args.maxPasses} starting`);
      const result = await runOpenWikiAgent("update", cwd, {
        outputMode: "repository",
        debug: true,
        userMessage: GROUNDING_INSTRUCTION,
        onEvent: progressOnEvent(pass),
      });
      if (result.model) {
        agentModel = result.model;
      }
      if (result.skipped) {
        throw new Error(
          `bootstrap: pass ${pass} was skipped despite a forced update; cannot ground the wiki`,
        );
      }

      // Persist the pass so the source-unchanged assertion can diff base..HEAD
      // and so the next pass starts from a clean tree.
      const dirty = await git(cwd, ["status", "--porcelain"]);
      if (dirty) {
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["commit", "-q", "-m", `bootstrap pass ${pass}`]);
      }

      const status = await readGroundingStatus(cwd);
      console.log(
        `[bootstrap] pass ${pass} result: ungrounded=${status.ungrounded.length} notFresh=${status.notFresh.length} converged=${status.converged}`,
      );

      if (status.converged) {
        break;
      }

      if (!dirty) {
        throw new Error(
          `bootstrap: pass ${pass} produced no changes but the wiki is not converged ` +
            `(ungrounded: ${status.ungrounded.join(", ") || "none"}; ` +
            `not fresh: ${status.notFresh.join(", ") || "none"}); the agent is not grounding pages`,
        );
      }

      if (pass === args.maxPasses) {
        throw new Error(
          `bootstrap: did not converge in ${args.maxPasses} passes ` +
            `(ungrounded: ${status.ungrounded.join(", ") || "none"}; ` +
            `not fresh: ${status.notFresh.join(", ") || "none"})`,
        );
      }
    }

    if (!agentModel) {
      throw new Error(
        "bootstrap: could not determine the agent model id from the run result",
      );
    }

    // The agent must have edited only the wiki; a source change means the
    // baseline no longer represents commit A.
    const changed = (await git(cwd, ["diff", "--name-only", baseCommit, "HEAD"]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const nonWiki = changed.filter((path) => !path.startsWith("openwiki/"));
    if (nonWiki.length > 0) {
      throw new Error(
        `bootstrap: agent modified non-wiki paths, baseline source is not commit A: ${nonWiki.join(", ")}`,
      );
    }

    return freezeBaseline(cwd, args.baselineDir, sourceCommit, agentModel);
  });

  console.log(
    `[bootstrap] froze baseline: ${manifest.pageCount} pages, ${manifest.sidecarCount} sidecars, ` +
      `model=${manifest.agentModel}, hash=${manifest.contentHash.slice(0, 12)}…`,
  );
  console.log(`[bootstrap] baseline written to ${args.baselineDir}`);
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[bootstrap] failed: ${message}`);
  process.exitCode = 1;
});
