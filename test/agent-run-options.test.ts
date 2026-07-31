import { describe, expect, expectTypeOf, test } from "vitest";

import type { OpenWikiRunOptions } from "../src/agent/types.ts";

// NOTE: test/ is outside tsconfig's `include` and no vitest typecheck config is
// present, so the expectTypeOf assertion below is documentary rather than
// CI-enforced today. The runtime assertion is what `vitest run` actually checks.
describe("OpenWikiRunOptions.signal", () => {
  test("is typed as an optional AbortSignal", () => {
    expectTypeOf<OpenWikiRunOptions["signal"]>().toEqualTypeOf<
      AbortSignal | undefined
    >();
  });

  test("accepts a real AbortSignal at runtime", () => {
    const controller = new AbortController();
    const options: OpenWikiRunOptions = { signal: controller.signal };

    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});
