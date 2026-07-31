import { clearActiveRun, getActiveRun } from "./agent/active-run.js";
import { persistRunMetadataIfChanged } from "./agent/utils.js";

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
 * Stamps the active run interrupted (best-effort), prints one readable line,
 * and exits non-zero. Shared by both the rejection and exception handlers.
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
        active.snapshotBefore,
        "interrupted",
        active.language,
      );
    } catch {
      // ignored
    }
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
