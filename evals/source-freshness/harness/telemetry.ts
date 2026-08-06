/**
 * Passive telemetry tap for a single agent run.
 *
 * {@link createTelemetryTap} returns `onEvent`/`onUsage` callbacks to hand to
 * `runOpenWikiAgent`, plus `snapshot()` to read the accumulated per-run metrics.
 * Everything here is diagnostic (spec section 13: routing metrics are
 * diagnostic; final wiki correctness is primary), derived only from the event
 * stream, and never influences the run. Tool inputs are untrusted values and are
 * narrowed defensively before use.
 */

import type { OpenWikiRunEvent, TokenUsage } from "../../../src/agent/types.js";

const TEMPORARY_PLAN_SUFFIX = "_plan.md";
const WIKI_PREFIX = "openwiki/";
const SOURCE_DEPS_SEGMENT = "/.source-deps/";

/** Names of the filesystem tools that read repository or wiki content. */
const READ_TOOL_NAMES = new Set(["read_file"]);

/** Names of the filesystem tools that create or modify wiki content. */
const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file"]);

/** The production tool that records a page's source dependencies. */
const RECORD_TOOL_NAME = "record_source_dependencies";

/** Per-run diagnostic metrics accumulated from one agent run's event stream. */
export interface RunTelemetry {
  /** Total tool invocations observed (`tool_start` events). */
  toolCalls: number;

  /** Tool invocation counts keyed by tool name. */
  toolCallsByName: Record<string, number>;

  /**
   * Number of maximal tool-call groups separated by main-channel assistant
   * text. A conservative proxy for model turns that issued tools; reported as
   * an approximation, not an exact turn count.
   */
  toolRounds: number;

  /** Distinct non-wiki files the agent read, as normalized repo-relative paths. */
  sourceFilesRead: string[];

  /** Distinct wiki pages the agent read, as normalized repo-relative paths. */
  wikiPagesRead: string[];

  /** Distinct wiki pages the agent wrote or edited, as normalized repo-relative paths. */
  wikiPagesWritten: string[];

  /** Number of `record_source_dependencies` calls (always 0 in the control arm). */
  recordSourceDependenciesCalls: number;

  /**
   * The docs-impact plan the agent wrote to `_plan.md`, captured from the write
   * because production deletes the file after the run.
   *
   * @default undefined - the agent wrote no `_plan.md`.
   */
  docsImpactPlan?: string;

  /**
   * Summed best-effort token usage across the run, or `undefined` when the
   * provider surfaced no `usage_metadata`.
   *
   * @default undefined - no usage was reported by the provider.
   */
  tokens?: TokenUsage;

  /**
   * The freshness arm the run reported via its `freshness.mode` debug line, used
   * for the integrity assertion that each arm actually ran as intended.
   *
   * @default undefined - no `freshness.mode` line was observed (for example a
   *   run with debug output disabled).
   */
  freshnessMode?: "on" | "off";
}

/** The callbacks and reader a telemetry tap exposes. */
export interface TelemetryTap {
  /** Pass as `OpenWikiRunOptions.onEvent`. */
  onEvent: (event: OpenWikiRunEvent) => void;

  /** Pass as `OpenWikiRunOptions.onUsage`. */
  onUsage: (usage: TokenUsage) => void;

  /** Read the accumulated metrics. Safe to call after the run completes. */
  snapshot: () => RunTelemetry;
}

/** Narrows an unknown value to a plain record for defensive field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts the target path from a filesystem tool's input, tolerating both the
 * `file_path` field and the `path` alias deepagents normalizes, and strips a
 * leading virtual-root slash so paths are comparable repo-relative.
 *
 * @param input - The untrusted `tool_start` input value.
 */
function toolPath(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const raw = input.file_path ?? input.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }

  return raw.replace(/^\/+/, "");
}

/**
 * True when a normalized path denotes a real wiki page: under `openwiki/`, a
 * Markdown file, not the temporary plan file, and not inside `.source-deps`.
 *
 * @param normalizedPath - A leading-slash-stripped repo-relative path.
 */
function isWikiPage(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith(WIKI_PREFIX) &&
    normalizedPath.endsWith(".md") &&
    !normalizedPath.endsWith(TEMPORARY_PLAN_SUFFIX) &&
    !`/${normalizedPath}`.includes(SOURCE_DEPS_SEGMENT)
  );
}

/** Reads a string content field from a write tool's input, if present. */
function writeContent(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  for (const key of ["content", "text", "file_text"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

/**
 * Create a passive telemetry tap for one agent run.
 *
 * The returned callbacks accumulate into private state; `snapshot()` returns a
 * fresh, sorted, immutable-enough copy each call.
 */
export function createTelemetryTap(): TelemetryTap {
  let toolCalls = 0;
  let toolRounds = 0;
  let inToolRound = false;
  let recordSourceDependenciesCalls = 0;
  let docsImpactPlan: string | undefined;
  let freshnessMode: "on" | "off" | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let sawAnyUsage = false;

  const toolCallsByName: Record<string, number> = {};
  const sourceFilesRead = new Set<string>();
  const wikiPagesRead = new Set<string>();
  const wikiPagesWritten = new Set<string>();

  function onEvent(event: OpenWikiRunEvent): void {
    if (event.type === "text") {
      // Main-channel assistant text closes any open tool-call round.
      if (event.source !== "subgraph") {
        inToolRound = false;
      }
      return;
    }

    if (event.type === "debug") {
      if (event.message === "freshness.mode=on") {
        freshnessMode = "on";
      } else if (event.message === "freshness.mode=off") {
        freshnessMode = "off";
      }
      return;
    }

    if (event.type === "tool_start") {
      toolCalls += 1;
      toolCallsByName[event.name] = (toolCallsByName[event.name] ?? 0) + 1;
      if (!inToolRound) {
        toolRounds += 1;
        inToolRound = true;
      }

      if (event.name === RECORD_TOOL_NAME) {
        recordSourceDependenciesCalls += 1;
        return;
      }

      const path = toolPath(event.input);
      if (!path) {
        return;
      }

      if (READ_TOOL_NAMES.has(event.name)) {
        if (isWikiPage(path)) {
          wikiPagesRead.add(path);
        } else if (!path.startsWith(WIKI_PREFIX)) {
          sourceFilesRead.add(path);
        }
        return;
      }

      if (WRITE_TOOL_NAMES.has(event.name)) {
        if (path.endsWith(TEMPORARY_PLAN_SUFFIX)) {
          const content = writeContent(event.input);
          if (content !== undefined) {
            docsImpactPlan = content;
          }
        } else if (isWikiPage(path)) {
          wikiPagesWritten.add(path);
        }
      }
    }
  }

  function onUsage(usage: TokenUsage): void {
    sawAnyUsage = true;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    totalTokens += usage.totalTokens;
  }

  function snapshot(): RunTelemetry {
    return {
      toolCalls,
      toolCallsByName: { ...toolCallsByName },
      toolRounds,
      sourceFilesRead: [...sourceFilesRead].sort(),
      wikiPagesRead: [...wikiPagesRead].sort(),
      wikiPagesWritten: [...wikiPagesWritten].sort(),
      recordSourceDependenciesCalls,
      docsImpactPlan,
      tokens: sawAnyUsage
        ? { inputTokens, outputTokens, totalTokens }
        : undefined,
      freshnessMode,
    };
  }

  return { onEvent, onUsage, snapshot };
}
