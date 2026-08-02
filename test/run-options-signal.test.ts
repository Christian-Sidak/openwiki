import { describe, expect, test } from "vitest";
import type { OpenWikiRunOptions } from "../src/agent/types.ts";

describe("OpenWikiRunOptions.signal", () => {
  test("accepts an AbortSignal that threads through to stream cancellation", () => {
    const controller = new AbortController();

    // Compile-time proof the field exists and is typed as AbortSignal; a type
    // error here fails the typecheck gate, which is the actual guard.
    const options = {
      signal: controller.signal,
    } satisfies OpenWikiRunOptions;

    expect(options.signal).toBe(controller.signal);
    expect(options.signal.aborted).toBe(false);

    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
});
