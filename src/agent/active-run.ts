import type { OpenWikiCommand, OpenWikiOutputMode } from "./types.js";
import type { OpenWikiContentSnapshot } from "./utils.js";

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
   * Content snapshot taken before the run; the stamp writes only if content changed.
   */
  snapshotBefore: OpenWikiContentSnapshot | null;

  /**
   * Effective wiki language, preserved in the stamp.
   *
   * @default undefined - the stamp is written without a language field; the wiki's default
   * (English) is assumed.
   */
  language?: string;
}

/**
 * The single in-flight run, or null when the process is idle. One run at a time by design.
 */
let activeRun: ActiveRunRecord | undefined;

/**
 * Registers the run the process is currently executing. One at a time by design.
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
 * The registered run, or null when the process is idle.
 */
export function getActiveRun(): ActiveRunRecord | undefined {
  return activeRun;
}
