/**
 * The two experiment arms.
 *
 * `runArm` seeds a fresh throwaway repo from the frozen baseline, sets the
 * freshness toggle for the arm, runs the real update agent with a telemetry tap,
 * and hard-fails if the run did not actually execute in the intended arm. The
 * only variable between arms is source-grounded freshness; the source and wiki
 * prose the agent starts from are identical.
 *
 * Arms mutate `process.env[OPENWIKI_DISABLE_SOURCE_FRESHNESS]` around the run and
 * restore it in a `finally`, so runs MUST be executed sequentially, never
 * concurrently, or the shared environment would race.
 */

import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { runOpenWikiAgent } from "../../../src/agent/index.js";
import { getUpdateNoopStatus } from "../../../src/agent/utils.js";
import { DISABLE_SOURCE_FRESHNESS_ENV_KEY } from "../../../src/staleness/toggle.js";
import { SOURCE_DEPS_DIRECTORY } from "../../../src/staleness/storage.js";
import type { EvalScenario } from "../scenarios/types.js";
import { readWikiPages, seedTrialRepo, withTempGitRepo } from "./repo.js";
import { createTelemetryTap, type RunTelemetry } from "./telemetry.js";

/** Which experiment arm a run belongs to. */
export type Arm = "with" | "without";

/** Inputs for {@link runArm}. */
export interface RunArmOptions {
  /** The scenario whose mutation the agent reacts to. */
  scenario: EvalScenario;

  /** The arm to run: `with` freshness (production default) or `without` (control). */
  arm: Arm;

  /** The developer checkout the corpus source is archived from (read-only). */
  devRoot: string;

  /** The commit-ish in `devRoot` the frozen baseline source is taken from. */
  sourceCommit: string;

  /** The frozen baseline wiki directory (pages plus `.source-deps`). */
  baselineWiki: string;
}

/** The outcome of running one arm against one scenario. */
export interface ArmRunResult {
  /** The arm this result is for. */
  arm: Arm;

  /** True when the agent skipped the run as a no-op (should not happen for a real mutation). */
  skipped: boolean;

  /** The model id the run reported. */
  model: string;

  /** Wall-clock milliseconds spent inside `runOpenWikiAgent`. */
  wallMs: number;

  /** The frozen baseline commit the run started from. */
  frozenCommit: string;

  /** The mutation commit the run reacted to. */
  mutationCommit: string;

  /** Diagnostic telemetry accumulated from the run's event stream. */
  telemetry: RunTelemetry;

  /** The final wiki pages, keyed by repo-relative POSIX path. */
  finalWiki: Record<string, string>;

  /**
   * The wiki pages the freshness preflight surfaced as stale before the agent
   * ran, as repo-relative POSIX paths. Used only for the WITH-arm routing
   * diagnostic (spec section 14).
   *
   * @default undefined - the control arm, where freshness is disabled and no
   *   stale-page list is produced.
   */
  surfacedStalePages?: string[];
}

/**
 * Set the freshness toggle for `arm` and return a restore function that puts the
 * environment back exactly as it was, whether the variable was previously set or
 * unset.
 *
 * @param arm - The arm being run.
 */
function applyArmEnv(arm: Arm): () => void {
  const previous = process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];

  if (arm === "without") {
    process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = "1";
  } else {
    delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];
  }

  return () => {
    if (previous === undefined) {
      delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];
    } else {
      process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = previous;
    }
  };
}

/** True when `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert the physical dependency-graph state matches the arm before the run: the
 * WITH arm must have a populated `.source-deps` directory, and the control arm
 * must have none at all. This is the physical half of the "control arm cannot
 * see the dependency graph" guarantee (the toggle is the logical half).
 *
 * @param cwd - The seeded trial repo root.
 *
 * @param arm - The arm being run.
 */
async function assertSidecarState(cwd: string, arm: Arm): Promise<void> {
  const sidecarDir = join(cwd, "openwiki", SOURCE_DEPS_DIRECTORY);
  const present = await exists(sidecarDir);

  if (arm === "with") {
    if (!present) {
      throw new Error(
        "integrity: WITH arm is missing openwiki/.source-deps; the baseline sidecars were not injected",
      );
    }
    const entries = await stat(sidecarDir);
    if (!entries.isDirectory()) {
      throw new Error(
        "integrity: WITH arm openwiki/.source-deps is not a directory",
      );
    }
    return;
  }

  if (present) {
    throw new Error(
      "integrity: control arm has openwiki/.source-deps present; the dependency graph must be physically absent",
    );
  }
}

/**
 * Assert the run actually executed in the intended arm, using the freshness mode
 * the agent reported and the freshness-only telemetry. Catches "WITH did not run
 * freshness" and "control accidentally ran it" (spec section 27).
 *
 * @param arm - The arm that was intended.
 *
 * @param telemetry - The captured run telemetry.
 */
function assertArmIntegrity(arm: Arm, telemetry: RunTelemetry): void {
  const expectedMode = arm === "with" ? "on" : "off";
  if (telemetry.freshnessMode !== expectedMode) {
    throw new Error(
      `integrity: ${arm} arm reported freshness.mode=${
        telemetry.freshnessMode ?? "absent"
      }, expected ${expectedMode}`,
    );
  }

  if (arm === "without" && telemetry.recordSourceDependenciesCalls > 0) {
    throw new Error(
      `integrity: control arm made ${telemetry.recordSourceDependenciesCalls} record_source_dependencies call(s); the tool must be withheld`,
    );
  }
}

/**
 * Run one arm against one scenario in an isolated throwaway repo and return the
 * final wiki plus telemetry. Never mutates the developer checkout.
 *
 * @param options - The arm run inputs.
 */
export async function runArm(options: RunArmOptions): Promise<ArmRunResult> {
  const { scenario, arm, devRoot, sourceCommit, baselineWiki } = options;

  return withTempGitRepo(async (cwd) => {
    const restoreEnv = applyArmEnv(arm);
    try {
      const { frozenCommit, mutationCommit } = await seedTrialRepo({
        cwd,
        devRoot,
        sourceCommit,
        baselineWiki,
        scenario,
        includeSidecars: arm === "with",
      });

      await assertSidecarState(cwd, arm);

      // WITH-arm routing diagnostic: capture the stale-page list the freshness
      // preflight produces from the seeded repo before the agent runs. Freshness
      // is disabled in the control arm, so this is only meaningful for WITH.
      let surfacedStalePages: string[] | undefined;
      if (arm === "with") {
        const preflight = await getUpdateNoopStatus(cwd);
        surfacedStalePages = preflight.shouldSkip
          ? []
          : preflight.stalePages.map((page) => page.page);
      }

      const tap = createTelemetryTap();
      const start = Date.now();
      const result = await runOpenWikiAgent("update", cwd, {
        outputMode: "repository",
        debug: true,
        onEvent: tap.onEvent,
        onUsage: tap.onUsage,
      });
      const wallMs = Date.now() - start;

      const telemetry = tap.snapshot();
      assertArmIntegrity(arm, telemetry);

      const finalWiki = await readWikiPages(cwd);

      return {
        arm,
        skipped: result.skipped ?? false,
        model: result.model,
        wallMs,
        frozenCommit,
        mutationCommit,
        telemetry,
        finalWiki,
        surfacedStalePages,
      };
    } finally {
      restoreEnv();
    }
  });
}
