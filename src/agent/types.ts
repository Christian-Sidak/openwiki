/**
 * The three ways the agent runs: an interactive `chat` turn, a first-time
 * `init` that builds the wiki, or an `update` that refreshes an existing one.
 */
export type OpenWikiCommand = "chat" | "init" | "update";

/**
 * Where a run writes its output: a dedicated `local-wiki` directory, or inline
 * into the `repository` alongside the code it documents.
 */
export type OpenWikiOutputMode = "local-wiki" | "repository";

/**
 * The result of a completed agent run, returned to the caller.
 */
export interface OpenWikiRunResult {
  /**
   * Command that ran.
   */
  command: OpenWikiCommand;

  /**
   * Resolved model id the run used.
   */
  model: string;

  /**
   * Whether the run was a no-op (an `update` that found nothing to regenerate).
   *
   * @default undefined - the run did real work; it was not skipped.
   */
  skipped?: boolean;
}

/**
 * A single streamed event delivered to `OpenWikiRunOptions.onEvent`. A
 * discriminated union keyed on `type`: streamed model text, the start or end of
 * a tool call, or a debug diagnostic line.
 */
export type OpenWikiRunEvent =
  | {
      /**
       * Which graph produced the text.
       *
       * @default undefined - the text came from the main graph, not a subgraph.
       */
      source?: "main" | "subgraph";

      /**
       * Discriminant: streamed model text.
       */
      type: "text";

      /**
       * The streamed text fragment.
       */
      text: string;
    }
  | {
      /**
       * Discriminant: a tool call started.
       */
      type: "tool_start";

      /**
       * Human-readable rendering of the call, `name(args)`.
       */
      call: string;

      /**
       * Id correlating this start with its matching `tool_end`.
       */
      id: string;

      /**
       * Raw tool arguments.
       */
      input: unknown;

      /**
       * Tool name.
       */
      name: string;
    }
  | {
      /**
       * Discriminant: a tool call finished.
       */
      type: "tool_end";

      /**
       * Id correlating this end with its matching `tool_start`.
       */
      id: string;

      /**
       * Tool name.
       */
      name: string;

      /**
       * Whether the tool finished cleanly or errored.
       */
      status: "error" | "finished";
    }
  | {
      /**
       * Discriminant: a debug diagnostic line.
       */
      type: "debug";

      /**
       * The debug message.
       */
      message: string;
    };

/**
 * Options controlling a single agent run. Every field is optional; the run
 * applies the documented default for any left unset.
 */
export interface OpenWikiRunOptions {
  /**
   * Emit `debug` events and extra diagnostics during the run.
   *
   * @default undefined - debug output is off.
   */
  debug?: boolean;

  /**
   * Whether this chat turn continues an existing thread rather than opening one.
   *
   * @default undefined - treated as a fresh, non-followup run.
   */
  isFollowup?: boolean;

  /**
   * Target wiki language.
   *
   * @default undefined - the wiki's default language (English) is used.
   */
  language?: string | null;

  /**
   * Model id override for this run.
   *
   * @default undefined - the configured or default model is used.
   */
  modelId?: string | null;

  /**
   * Callback invoked for each streamed run event.
   *
   * @default undefined - events are dropped; the caller receives no stream.
   */
  onEvent?: (event: OpenWikiRunEvent) => void;

  /**
   * Where the run writes its output.
   *
   * @default undefined - defaults to "local-wiki".
   */
  outputMode?: OpenWikiOutputMode;

  /**
   * Conversation thread id, for chat memory continuity.
   *
   * @default undefined - a thread id is derived from the working directory.
   */
  threadId?: string;

  /**
   * The user's message, for `chat` runs.
   *
   * @default undefined - no user message; `init` and `update` do not take one.
   */
  userMessage?: string | null;

  /**
   * Path to tee the exact telemetry payload to, for inspection.
   *
   * @default undefined - telemetry is not written to a file.
   */
  telemetryFile?: string;

  /**
   * Signal that aborts the run when triggered.
   *
   * @default undefined - the run cannot be cancelled via a signal.
   */
  signal?: AbortSignal;
}

/**
 * Terminal state recorded in the run stamp: `complete` when the run finished,
 * `interrupted` when it was aborted, crashed, or truncated mid-generation.
 */
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

/**
 * The `.last-update.json` stamp describing the most recent run against a wiki.
 * Read at the start of the next run to decide whether an update can be skipped.
 */
export interface UpdateMetadata {
  /**
   * ISO timestamp the stamp was written.
   */
  updatedAt: string;

  /**
   * Command that produced this stamp.
   */
  command: OpenWikiCommand;

  /**
   * Repo HEAD commit at stamp time.
   *
   * @default undefined - not recorded (for example, the target is not a git repo).
   */
  gitHead?: string;

  /**
   * Resolved model id that produced the run.
   */
  model: string;

  /**
   * How the run ended.
   *
   * @default undefined - a legacy stamp predating the status field; readers treat it as "complete".
   */
  status?: UpdateRunStatus;

  /**
   * Wiki language recorded for the run.
   *
   * @default undefined - no language field; the wiki default (English) is assumed.
   */
  language?: string;
}

/**
 * Everything the agent needs about prior state and intent at the start of a
 * run: the previous stamp, a git summary, and optional language and goal.
 */
export interface RunContext {
  /**
   * The previous run's stamp, or null when the wiki has never been generated.
   */
  lastUpdate: UpdateMetadata | null;

  /**
   * Human-readable summary of the repository's git state, fed into the prompt.
   */
  gitSummary: string;

  /**
   * Effective wiki language for this run.
   *
   * @default undefined - the wiki default (English) is used.
   */
  language?: string;

  /**
   * User-provided statement of the wiki's purpose or focus.
   *
   * @default undefined - no explicit goal; the agent infers scope from the repo.
   */
  wikiGoal?: string;
}
