import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { filterMatching } from "./reconcile/glob.js";
import type { OpenWikiManifest } from "./manifest/types.js";

/**
 * One unit-proposed claim: "this section should also watch this glob".
 */
export interface SectionSuggestion {
  /**
   * Existing section path the claim targets.
   */
  sectionPath: string;

  /**
   * Repo-relative source glob the target section should watch.
   */
  glob: string;

  /**
   * One-line justification, surfaced in run output.
   */
  reason: string;
}

/**
 * Accepted per unit; excess is dropped silently. Abuse is bounded by design.
 */
export const MAX_SUGGESTIONS_PER_UNIT = 2;

/**
 * Per-unit mailbox the tool writes into and the orchestrator drains.
 */
export interface SuggestionCollector {
  /**
   * Appends one suggestion to the mailbox.
   */
  record(suggestion: SectionSuggestion): void;

  /**
   * Returns every recorded suggestion and empties the mailbox.
   */
  drain(): SectionSuggestion[];
}

/**
 * Creates an empty per-unit suggestion mailbox. record() appends; drain()
 * returns everything and empties it, so each unit reads only its own
 * suggestions.
 */
export function createSuggestionCollector(): SuggestionCollector {
  const suggestions: SectionSuggestion[] = [];

  return {
    record: (suggestion) => {
      suggestions.push(suggestion);
    },
    drain: () => suggestions.splice(0),
  };
}

/**
 * The mailbox tool. It changes no state and reveals nothing: a flat ack
 * regardless of content, so the model gets no signal that invites iteration.
 * Validation and application happen in code after the unit finishes. Follows
 * the DynamicStructuredTool style of createOpenWikiConnectorTools.
 */
export function createSuggestRelatedSectionTool(
  collector: SuggestionCollector,
): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: "suggest_related_section",
    description:
      "Propose that another wiki section should also watch a source glob, " +
      "because content you are documenting belongs to its domain too. " +
      "Use at most twice per task, only when the relationship is clear.",
    schema: {
      type: "object",
      properties: {
        sectionPath: {
          type: "string",
          description: 'Existing section path, e.g. "integrations/"',
        },
        glob: {
          type: "string",
          description: 'Repo-relative source glob, e.g. "src/api/webhooks*.ts"',
        },
        reason: {
          type: "string",
          maxLength: 200,
        },
      },
      required: ["sectionPath", "glob", "reason"],
      additionalProperties: false,
    } as const,
    func: (input) => {
      collector.record(input as SectionSuggestion);
      return Promise.resolve("recorded");
    },
  });
}

/**
 * Stable dedupe key for a suggestion. JSON.stringify keeps the two fields
 * unambiguous without a magic separator that a path or glob could contain.
 */
function suggestionKey(suggestion: SectionSuggestion): string {
  return JSON.stringify([suggestion.sectionPath, suggestion.glob]);
}

/**
 * Filters a unit's suggestions to the ones code will act on: target section
 * exists, glob is repo-relative and matches real tracked files, and the
 * target does not already cover those files. Deduped, capped. Rejected
 * suggestions are returned for debug logging; rejection is silent otherwise.
 */
export function validateSuggestions(
  raw: SectionSuggestion[],
  manifest: OpenWikiManifest,
  trackedFiles: string[],
): { accepted: SectionSuggestion[]; rejected: SectionSuggestion[] } {
  const accepted: SectionSuggestion[] = [];
  const rejected: SectionSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of raw) {
    const key = suggestionKey(suggestion);
    const target = manifest.sections.find(
      (section) => section.path === suggestion.sectionPath,
    );
    const matched = filterMatching(trackedFiles, [suggestion.glob]);
    const alreadyCovered =
      target !== undefined &&
      matched.length > 0 &&
      matched.every(
        (file) => filterMatching([file], target.sources).length > 0,
      );
    const valid =
      !seen.has(key) &&
      target !== undefined &&
      !target.abandoned &&
      !suggestion.glob.startsWith("/") &&
      !suggestion.glob.includes("..") &&
      matched.length > 0 &&
      !alreadyCovered &&
      accepted.length < MAX_SUGGESTIONS_PER_UNIT;

    seen.add(key);
    (valid ? accepted : rejected).push(suggestion);
  }

  return { accepted, rejected };
}
