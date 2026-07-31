import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

/**
 * Thrown after a stream completes when any model response in the run ended by
 * hitting its output-token cap. Without this, a truncated run is
 * indistinguishable from a finished one: the stream just ends, the run stamps
 * `complete`, and the CLI exits 0 over a half-written page.
 */
export class TruncationError extends Error {
  /**
   * Error name that routes this through classifyError to the "truncation" class.
   */
  override name = "TruncationError";

  constructor(count: number) {
    super(
      `${count} model response(s) hit the output-token cap mid-generation. ` +
        `The run is recorded as interrupted; re-run to retry the affected pages.`,
    );
  }
}

/**
 * LangChain callback handler that watches every model completion in a run and
 * records the ones that ended with a length/max-tokens finish reason. Attach
 * via the `callbacks` entry of the stream config.
 */
export class TruncationMonitor extends BaseCallbackHandler {
  /**
   * LangChain handler name; identifies this handler in callback traces.
   */
  name = "openwiki-truncation-monitor";

  /**
   * Running tally of model responses that ended on the output-token cap.
   */
  #truncations = 0;

  /**
   * Number of model responses that ended on the output cap.
   */
  get truncationCount(): number {
    return this.#truncations;
  }

  /**
   * True when at least one response was cut off.
   */
  get truncated(): boolean {
    return this.#truncations > 0;
  }

  /**
   * LangChain hook: inspects every completion in the result and counts truncated ones.
   */
  override handleLLMEnd(output: LLMResult): void {
    for (const generations of output.generations) {
      for (const generation of generations) {
        if (isTruncatedGeneration(generation)) {
          this.#truncations += 1;
        }
      }
    }
  }
}

/**
 * Providers disagree on where the finish reason lives (generationInfo for
 * completion-shaped results, response_metadata for chat messages) and what
 * they call it (`length` for OpenAI-compatible APIs, `max_tokens` for
 * Anthropic-compatible ones). Check all of it.
 */
function isTruncatedGeneration(generation: unknown): boolean {
  if (typeof generation !== "object" || generation === null) {
    return false;
  }

  const candidate = generation as {
    generationInfo?: Record<string, unknown>;
    message?: { response_metadata?: Record<string, unknown> };
  };
  const reasons = [
    candidate.generationInfo?.finish_reason,
    candidate.generationInfo?.stop_reason,
    candidate.message?.response_metadata?.finish_reason,
    candidate.message?.response_metadata?.stop_reason,
  ];

  return reasons.some(
    (reason) => reason === "length" || reason === "max_tokens",
  );
}
