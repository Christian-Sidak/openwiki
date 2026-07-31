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
  signal?: AbortSignal;
};

export type UpdateRunStatus = "complete" | "interrupted";

/**
 * An abort/interrupt error, augmented by the agent run with whether it managed
 * to persist an interrupted stamp before unwinding.
 *
 * The CLI reads this to decide whether to tell the user progress was saved: a
 * run aborted before any wiki page changed writes no stamp, so there is nothing
 * to resume and no message worth printing.
 */
export interface InterruptedRunError extends Error {
  /**
   * Whether `persistRunMetadataIfChanged` wrote an interrupted stamp for this run.
   *
   * @default undefined - the abort escaped before any stamp attempt (e.g. during
   * setup or connector ingestion) or the stamp write itself failed; treated as
   * not stamped, so the CLI prints nothing.
   */
  openWikiInterruptStamped?: boolean;
}

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
  gitSummary: string;
  language?: string;
  wikiGoal?: string;
};
