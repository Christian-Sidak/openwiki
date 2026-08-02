import { getErrorMessage, sanitizeDiagnosticText } from "../diagnostics.js";
import { describeErrorForTelemetry } from "../telemetry/errors.js";
import { recordRunSafe } from "../telemetry/record-run-safe.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";
import {
  persistRunMetadataIfChanged,
  removeTemporaryPlanFile,
  type OpenWikiContentSnapshot,
} from "./utils.js";

/**
 * Everything the crash guard needs to stamp an interrupted run post-mortem.
 */
export interface ActiveRunRecord {
  /**
   * Command of the in-flight run.
   */
  command: OpenWikiCommand;

  /**
   * Repo (or local-wiki) root the run is writing into.
   */
  cwd: string;

  /**
   * Resolved model id, for the stamp.
   */
  modelId: string;

  /**
   * Output mode, decides where the stamp lives.
   */
  outputMode: OpenWikiOutputMode;

  /**
   * Content snapshot taken before the run; the stamp writes only if content
   * changed.
   *
   * @default undefined - no snapshot was captured before the run
   */
  snapshotBefore?: OpenWikiContentSnapshot;

  /**
   * Effective wiki language, preserved in the stamp.
   *
   * @default undefined — the run has no explicit wiki language
   */
  language?: string;
}

/**
 * The single in-flight run the process is executing, or undefined when idle.
 * One at a time by design, so a bare module-level slot suffices.
 */
let activeRun: ActiveRunRecord | undefined;

/**
 * Latches when the first fatal signal begins shutdown. A crash commonly
 * cascades into several rejections in the same tick; only the first drives
 * cleanup and the single process exit, so a later one cannot schedule an exit
 * that preempts the in-flight cleanup writes.
 */
let shutdownStarted = false;

/**
 * Registers the run the process is currently executing. One at a time by
 * design.
 */
export function registerActiveRun(record: ActiveRunRecord): void {
  activeRun = record;
}

/**
 * Clears the registration; call in the run's finally block.
 */
export function clearActiveRun(): void {
  activeRun = undefined;
}

/**
 * The registered run, or undefined when the process is idle.
 */
export function getActiveRun(): ActiveRunRecord | undefined {
  return activeRun;
}

/**
 * Last-resort handler for rejections and exceptions that bypass every catch.
 * Today those kill the process with a raw stack, no stamp, and no telemetry
 * (#494). The guard stamps the active run `interrupted` so the next scheduled
 * update retries instead of no-opping against a broken wiki, prints one
 * readable line, and exits non-zero.
 *
 * Install exactly once, before any run starts.
 */
export function installCrashGuard(): void {
  // Installing (re)initializes shutdown state. Production installs exactly once
  // at startup, so this is a no-op there; it only matters to tests that
  // reinstall the guard and need a clean latch each time.
  shutdownStarted = false;

  process.on("unhandledRejection", (reason) => {
    void handleFatal("unhandledRejection", reason);
  });
  process.on("uncaughtException", (error) => {
    void handleFatal("uncaughtException", error);
  });
}

/**
 * Shared post-mortem for both fatal signals. Prints one readable, redacted line
 * for every signal, then — for the first signal only — cleans up the run the
 * same way the graceful catch does (drops the temporary plan file, stamps the
 * run `interrupted` so the next scheduled update retries instead of no-opping
 * against a partial wiki), records the crash to the telemetry boundary
 * (fire-and-forget), and exits non-zero.
 *
 * A crash commonly cascades into several rejections in the same tick (a
 * subagent's aborted connection plus its "Subagent ... failed" projection).
 * The `shutdownStarted` latch makes only the first drive cleanup and the single
 * exit; a later one prints and returns, so its exit cannot fire before the
 * awaited cleanup finishes writing. `source` names which handler fired.
 */
async function handleFatal(source: string, error: unknown): Promise<void> {
  // Print every fatal in a cascade so all of its causes stay visible, even the
  // ones that do not drive shutdown below. getErrorMessage redacts secrets.
  process.stderr.write(
    `OpenWiki run failed (${source}): ${getErrorMessage(error)}\n`,
  );

  if (error instanceof Error && error.stack && process.env.OPENWIKI_DEBUG) {
    process.stderr.write(`${sanitizeDiagnosticText(error.stack)}\n`);
  }

  // Only the first fatal owns shutdown. Returning here for later rejections in
  // the same cascade is what keeps their setImmediate exit from preempting the
  // cleanup writes below and losing the interrupted stamp.
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  const active = getActiveRun();

  if (active) {
    clearActiveRun();

    // Mirror the graceful catch so a crash-path interrupt leaves the same state
    // as a thrown one: no orphaned _plan.md, and an `interrupted` stamp. Both
    // are awaited before the exit; both swallow their own failures so the
    // original crash is still the story the process exits with.
    try {
      await removeTemporaryPlanFile(active.cwd, active.outputMode);
    } catch {
      // ignored
    }

    try {
      await persistRunMetadataIfChanged(
        active.command,
        active.cwd,
        active.modelId,
        active.outputMode,
        // persistRunMetadataIfChanged still takes | null; coerce at this
        // existing-code boundary.
        active.snapshotBefore ?? null,
        "interrupted",
        active.language,
      );
    } catch {
      // ignored
    }

    // Hand the crash to the single telemetry boundary so runs that die outside
    // every catch finally appear in the data (#494). Strictly fire-and-forget:
    // recordRunSafe never throws and the exit below must not wait on the network.
    void recordRunSafe(
      active.command,
      { outputMode: active.outputMode },
      { outcome: "failure", ...describeErrorForTelemetry(error) },
    );
  }

  // Give stderr a tick to flush, then exit non-zero. Without the explicit exit
  // Node would continue with undefined state after an uncaught exception.
  setImmediate(() => process.exit(1));
}
