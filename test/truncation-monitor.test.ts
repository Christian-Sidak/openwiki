import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "vitest";
import {
  TruncationError,
  TruncationMonitor,
} from "../src/agent/truncation-monitor.ts";

/**
 * Wraps a single fabricated generation object in the nested-array shape an
 * `LLMResult` uses (`generations[promptIndex][candidateIndex]`).
 */
function llmResult(generation: unknown): LLMResult {
  return { generations: [[generation as never]] };
}

describe("TruncationMonitor", () => {
  test("flags a completion-shaped generation capped with finish_reason=length", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult({
        text: "half a",
        generationInfo: { finish_reason: "length" },
      }),
    );

    expect(monitor.truncated).toBe(true);
    expect(monitor.truncationCount).toBe(1);
  });

  test("flags a completion-shaped generation capped with stop_reason=max_tokens", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult({ generationInfo: { stop_reason: "max_tokens" } }),
    );

    expect(monitor.truncated).toBe(true);
    expect(monitor.truncationCount).toBe(1);
  });

  test("flags a chat-shaped generation capped via message.response_metadata", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult({
        message: { response_metadata: { finish_reason: "length" } },
      }),
    );
    monitor.handleLLMEnd(
      llmResult({
        message: { response_metadata: { stop_reason: "max_tokens" } },
      }),
    );

    expect(monitor.truncationCount).toBe(2);
  });

  test("does not flag a generation that stopped naturally", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult({ generationInfo: { finish_reason: "stop" } }),
    );
    monitor.handleLLMEnd(
      llmResult({
        message: { response_metadata: { stop_reason: "end_turn" } },
      }),
    );

    expect(monitor.truncated).toBe(false);
    expect(monitor.truncationCount).toBe(0);
  });

  test("ignores malformed and null generations without throwing", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(llmResult(null));
    monitor.handleLLMEnd(llmResult("just a string"));
    monitor.handleLLMEnd(llmResult({ generationInfo: undefined }));
    monitor.handleLLMEnd(llmResult({ message: {} }));

    expect(monitor.truncationCount).toBe(0);
  });

  test("counts one increment per capped response across a multi-generation result", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd({
      generations: [
        [{ generationInfo: { finish_reason: "length" } } as never],
        [{ generationInfo: { finish_reason: "stop" } } as never],
        [
          {
            message: { response_metadata: { stop_reason: "max_tokens" } },
          } as never,
        ],
      ],
    });

    expect(monitor.truncationCount).toBe(2);
  });
});

describe("TruncationError", () => {
  test("carries a fixed routable name and reports the count", () => {
    const error = new TruncationError(3);

    expect(error.name).toBe("TruncationError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("3 model response(s)");
  });
});
