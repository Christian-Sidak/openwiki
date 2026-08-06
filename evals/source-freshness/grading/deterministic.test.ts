/**
 * Phase 4 unit test for the deterministic grading layer.
 *
 * Pure and token-free: it feeds a hand-built scenario and before/after page maps
 * through {@link gradeDeterministic} and asserts the literal-probe outcomes and
 * the unnecessary-edit floor.
 */

import { describe, expect, test } from "vitest";
import type { EvalScenario } from "../scenarios/types.js";
import { gradeDeterministic } from "./deterministic.js";

/**
 * A fixture scenario with two expected pages: one that the run synchronizes
 * correctly, and one the run never writes. The mutation is a no-op because only
 * the ground truth is under test here.
 */
const scenario: EvalScenario = {
  id: "grade-fixture",
  title: "authenticate goes async",
  complexity: "medium",
  description: "authenticate() becomes async and stops returning a boolean.",
  async applyMutation(): Promise<void> {},
  expectedAffectedPages: [
    {
      page: "openwiki/architecture/auth.md",
      rationale: "the auth page documents authenticate's name and return type",
      requiredFacts: [
        {
          id: "new-name",
          description: "documents the async name authenticateAsync",
          requirePresent: ["authenticateAsync"],
          requireAbsent: ["authenticateSync"],
        },
        {
          id: "judge-only",
          description: "explains the awaited call flow (no literal probe)",
        },
      ],
      forbiddenFacts: [
        {
          id: "old-return",
          description: "no longer claims the call returns a boolean",
          requireAbsent: ["returns a boolean"],
        },
      ],
      sourceEvidence: [],
    },
    {
      page: "openwiki/missing.md",
      rationale: "a page the run should have written but did not",
      requiredFacts: [
        {
          id: "req-present",
          description: "mentions the X marker",
          requirePresent: ["X marker"],
        },
        {
          id: "req-absent-only",
          description: "drops the Y marker",
          requireAbsent: ["Y marker"],
        },
      ],
      forbiddenFacts: [],
      sourceEvidence: [],
    },
  ],
};

const before: Record<string, string> = {
  "openwiki/architecture/auth.md": "authenticateSync returns a boolean.\n",
  "openwiki/index.md": "- old nav\n",
  "openwiki/architecture/unrelated.md": "Unrelated prose, version one.\n",
};

const after: Record<string, string> = {
  // Synchronized: new name present, old name gone, stale return claim dropped.
  "openwiki/architecture/auth.md":
    "authenticateAsync is awaited; it resolves.\n",
  // Excluded navigation file changed: must not count as an unnecessary edit.
  "openwiki/index.md": "- new nav\n",
  // Eligible page changed without being expected: an unnecessary edit.
  "openwiki/architecture/unrelated.md": "Unrelated prose, version two.\n",
  // Note: openwiki/missing.md is absent, exercising the missing-page path.
};

describe("gradeDeterministic", () => {
  const grade = gradeDeterministic({ scenario, before, after });

  test("scores a synchronized page: required present, obsolete text cleared", () => {
    const auth = grade.pages.find(
      (page) => page.page === "openwiki/architecture/auth.md",
    );
    expect(auth).toBeDefined();
    if (!auth) {
      throw new Error("unreachable");
    }

    expect(auth.found).toBe(true);

    const newName = auth.requiredFacts.find((fact) => fact.id === "new-name");
    expect(newName?.requirePresentPass).toBe(true);
    expect(newName?.requireAbsentPass).toBe(true);
    expect(newName?.pass).toBe(true);

    // A probe-less fact yields no deterministic signal and is excluded from the
    // probed totals; only the judge can decide it.
    const judgeOnly = auth.requiredFacts.find(
      (fact) => fact.id === "judge-only",
    );
    expect(judgeOnly?.pass).toBeUndefined();
    expect(auth.requiredFactsProbed).toBe(1);
    expect(auth.requiredFactsSatisfied).toBe(1);

    const oldReturn = auth.forbiddenFacts.find(
      (fact) => fact.id === "old-return",
    );
    expect(oldReturn?.requireAbsentPass).toBe(true);
    expect(oldReturn?.pass).toBe(true);
    expect(auth.forbiddenFactsProbed).toBe(1);
    expect(auth.forbiddenFactsCleared).toBe(1);
  });

  test("scores a missing page: required-present fails, required-absent passes vacuously", () => {
    const missing = grade.pages.find(
      (page) => page.page === "openwiki/missing.md",
    );
    expect(missing).toBeDefined();
    if (!missing) {
      throw new Error("unreachable");
    }

    expect(missing.found).toBe(false);

    const reqPresent = missing.requiredFacts.find(
      (fact) => fact.id === "req-present",
    );
    expect(reqPresent?.requirePresentPass).toBe(false);
    expect(reqPresent?.pass).toBe(false);

    const reqAbsentOnly = missing.requiredFacts.find(
      (fact) => fact.id === "req-absent-only",
    );
    expect(reqAbsentOnly?.requireAbsentPass).toBe(true);
    expect(reqAbsentOnly?.pass).toBe(true);

    expect(missing.requiredFactsProbed).toBe(2);
    expect(missing.requiredFactsSatisfied).toBe(1);
  });

  test("flags only eligible, unexpected page edits as unnecessary", () => {
    // The eligible unrelated page changed and is flagged; the excluded index.md
    // changed but is not; the expected auth.md changed but is not.
    expect(grade.changedUnaffectedPages).toEqual([
      "openwiki/architecture/unrelated.md",
    ]);
  });
});
