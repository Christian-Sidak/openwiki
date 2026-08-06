/**
 * CI guard for the deterministic freshness mechanism.
 *
 * The full mutation eval (categories 1 and 2, metrics, JSON) lives in
 * `evals/freshness-mutation/` and is run manually with `tsx`. This test imports
 * only the category-1 case list plus the gitHead durability case, which are
 * deterministic and fast, and asserts they all pass, so a regression in the
 * checker breaks the build. Category 2 (coverage over real source) is a
 * measurement, not a pass/fail gate, and is deliberately left to the eval.
 */

import { describe, expect, test } from "vitest";

import {
  MECHANISM_CASES,
  runDurabilityCase,
  runMutationCase,
} from "../../evals/freshness-mutation/mutation-eval.ts";

describe("mutation eval: deterministic freshness mechanism", () => {
  for (const testCase of MECHANISM_CASES) {
    test(testCase.name, async () => {
      const result = await runMutationCase(testCase);
      expect(
        result.status,
        `${result.detail ?? ""} missed=${result.missed.join(",")} ` +
          `falsePositives=${result.falsePositives.join(",")} ` +
          `mismatches=${JSON.stringify(result.stateMismatches)}`,
      ).toBe("pass");
    });
  }

  test("gitHead durability", async () => {
    const result = await runDurabilityCase();
    expect(result.status, result.detail ?? "").toBe("pass");
  });
});
