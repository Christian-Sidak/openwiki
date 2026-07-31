import type { LLMResult } from "@langchain/core/outputs";
import { describe, expect, test } from "vitest";

import {
  TruncationError,
  TruncationMonitor,
} from "../src/agent/truncation-monitor.ts";

/**
 * Wraps a flat list of generations into the `generations: Generation[][]` shape
 * LangChain hands to `handleLLMEnd` (one inner array per prompt).
 */
function llmResult(generations: unknown[]): LLMResult {
  return { generations: [generations] } as unknown as LLMResult;
}

/**
 * OpenAI-compatible completion shape: the finish reason lives on
 * `generationInfo` and is spelled `finish_reason`.
 */
function openAiGeneration(finishReason: string): unknown {
  return { generationInfo: { finish_reason: finishReason } };
}

/**
 * Anthropic-compatible chat shape: the stop reason lives on the message's
 * `response_metadata` and is spelled `stop_reason`.
 */
function anthropicGeneration(stopReason: string): unknown {
  return { message: { response_metadata: { stop_reason: stopReason } } };
}

describe("TruncationMonitor", () => {
  test("counts an OpenAI-compatible length finish as truncated", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(llmResult([openAiGeneration("length")]));

    expect(monitor.truncated).toBe(true);
    expect(monitor.truncationCount).toBe(1);
  });

  test("counts an Anthropic-compatible max_tokens stop as truncated", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(llmResult([anthropicGeneration("max_tokens")]));

    expect(monitor.truncated).toBe(true);
    expect(monitor.truncationCount).toBe(1);
  });

  test("ignores normal finish reasons from both shapes", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult([openAiGeneration("stop"), anthropicGeneration("end_turn")]),
    );

    expect(monitor.truncated).toBe(false);
    expect(monitor.truncationCount).toBe(0);
  });

  test("accumulates across generations and calls", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(
      llmResult([
        openAiGeneration("length"),
        anthropicGeneration("max_tokens"),
      ]),
    );
    monitor.handleLLMEnd(llmResult([anthropicGeneration("max_tokens")]));

    expect(monitor.truncationCount).toBe(3);
  });

  test("tolerates malformed generations without counting them", () => {
    const monitor = new TruncationMonitor();

    monitor.handleLLMEnd(llmResult([undefined, null, {}, "text"]));

    expect(monitor.truncated).toBe(false);
  });
});

describe("TruncationError", () => {
  test("carries the name classifyError routes on", () => {
    expect(new TruncationError(2).name).toBe("TruncationError");
  });

  test("names the affected response count in its message", () => {
    expect(new TruncationError(2).message).toContain("2 model response");
  });
});
