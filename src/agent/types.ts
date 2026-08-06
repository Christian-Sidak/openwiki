import type { PageFreshness } from "../staleness/freshness.js";

export type OpenWikiCommand = "chat" | "init" | "update";
export type OpenWikiOutputMode = "local-wiki" | "repository";

export type OpenWikiRunResult = {
  command: OpenWikiCommand;
  model: string;
  skipped?: boolean;
};

export type OpenWikiRunEvent =
  | {
      source?: "main" | "subgraph";
      type: "text";
      text: string;
    }
  | {
      type: "tool_start";
      call: string;
      id: string;
      input: unknown;
      name: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      status: "error" | "finished";
    }
  | {
      type: "debug";
      message: string;
    };

export type OpenWikiRunOptions = {
  debug?: boolean;
  isFollowup?: boolean;
  language?: string | null;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  outputMode?: OpenWikiOutputMode;
  threadId?: string;
  userMessage?: string | null;
  telemetryFile?: string;
};

export type UpdateRunStatus = "complete" | "interrupted";

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  gitHead?: string;
  model: string;
  status?: UpdateRunStatus;
  language?: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  language?: string;
  wikiGoal?: string;
};

/**
 * The combined "what work does this update have" signal, computed before the
 * agent runs and threaded into its prompt so page routing never depends on the
 * agent rediscovering drift from the git diff.
 *
 * Both lists are derived entirely from local git output and recorded source
 * sidecars. They are untrusted data printed verbatim into the prompt, never
 * interpreted as instructions or shell commands.
 */
export interface UpdateRunSignals {
  /**
   * Meaningful repository source paths that moved since the wiki was last
   * updated (worktree plus committed), as sorted, de-duplicated, repo-relative
   * POSIX paths. Excludes `openwiki/` output, the run-metadata file, and
   * `.openwikiignore`-matched paths. Empty when git cannot compute a diff (the
   * first update after init) or nothing outside the wiki moved.
   */
  changedPaths: string[];

  /**
   * Pages whose recorded source dependencies no longer match current source
   * (`stale`, `unknown`, or `unverified`), in sidecar-discovery order. These
   * must be revalidated by the agent even when git is quiet, because that is
   * exactly the drift a commit range cannot see.
   */
  stalePages: PageFreshness[];
}
