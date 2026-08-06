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

/**
 * A single provider-reported token-usage sample parsed from one streamed model
 * message. Emitted best-effort: only providers that surface `usage_metadata` on
 * their streamed chunks produce these, and a run fires zero or more of them.
 */
export interface TokenUsage {
  /** Prompt/input tokens the provider billed for this message. */
  inputTokens: number;

  /** Completion/output tokens the provider billed for this message. */
  outputTokens: number;

  /**
   * Total tokens the provider reported, falling back to `inputTokens +
   * outputTokens` when the provider omits an explicit total.
   */
  totalTokens: number;
}

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

  /**
   * Best-effort token-usage sink invoked as each streamed model message that
   * carries provider `usage_metadata` is parsed. Consumers accumulate across
   * calls for a run total. Unused by production; the source-freshness benchmark
   * taps it to report cost.
   *
   * @default undefined - token usage is not collected.
   */
  onUsage?: (usage: TokenUsage) => void;
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
