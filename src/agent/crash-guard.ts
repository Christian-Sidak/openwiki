import { describeErrorForTelemetry } from "../telemetry/errors.js";
import { recordRunSafe } from "../telemetry/record-run-safe.js";
import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";
import {
  persistRunMetadataIfChanged,
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
  process.on("unhandledRejection", (reason) => {
    void handleFatal("unhandledRejection", reason);
  });
  process.on("uncaughtException", (error) => {
    void handleFatal("uncaughtException", error);
  });
}

/**
 * Shared post-mortem for both fatal signals: stamps the active run
 * `interrupted` (best-effort), records the crash to the telemetry boundary
 * (fire-and-forget, so the exit never waits on it), prints one readable line,
 * and exits non-zero. `source` names which handler fired, for the stderr line.
 */
async function handleFatal(source: string, error: unknown): Promise<void> {
  const active = getActiveRun();

  if (active) {
    // Swallow stamp failures: the original crash is the story worth exiting with.
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
    // recordRunSafe never throws and the exit below must not wait on it.
    void recordRunSafe(
      active.command,
      { outputMode: active.outputMode },
      { outcome: "failure", ...describeErrorForTelemetry(error) },
    );

    clearActiveRun();
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OpenWiki run failed (${source}): ${message}\n`);

  if (error instanceof Error && error.stack && process.env.OPENWIKI_DEBUG) {
    process.stderr.write(`${error.stack}\n`);
  }

  // Give stderr a tick to flush, then exit non-zero. Without the explicit exit
  // Node would continue with undefined state after an uncaught exception.
  setImmediate(() => process.exit(1));
}
