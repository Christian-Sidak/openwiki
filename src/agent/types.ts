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

  /**
   * Cancels the agent run. Aborted runs stop streaming, classify as
   * "aborted", and stamp `interrupted` via the normal stream-catch path.
   *
   * @default undefined — the run cannot be cancelled externally
   */
  signal?: AbortSignal;
};

export type UpdateRunStatus = "complete" | "interrupted" | "partial";

export interface UpdateMetadata {
  /**
   * ISO 8601 timestamp of when this stamp was written.
   */
  updatedAt: string;

  /**
   * The command that produced this stamp (init or update).
   */
  command: OpenWikiCommand;

  /**
   * Repository head the wiki is verified against.
   *
   * @default undefined — local-wiki runs record no repository head
   */
  gitHead?: string;

  /**
   * Model identifier that generated the wiki content for this run.
   */
  model: string;

  /**
   * Outcome of the run that wrote this stamp.
   *
   * @default undefined — legacy stamps (pre-#365) omit it and are treated as
   * complete
   */
  status?: UpdateRunStatus;

  /**
   * Effective wiki output language.
   *
   * @default undefined — the wiki uses the default (English) output language
   */
  language?: string;

  /**
   * Section paths given up on after repeated attributable failures. Excluded
   * from the floor.
   *
   * @default undefined — no sections have been abandoned
   */
  abandoned?: string[];
}

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  gitSummary: string;
  language?: string;
  wikiGoal?: string;
};
