/**
 * Unit test for the repo path-containment guards.
 *
 * Pure and token-free: it exercises {@link normalizeRepoRelativePath} and
 * {@link resolveWithin}, the guardrails that keep a scenario- or key-supplied
 * path from escaping the tree it is meant to address.
 */

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { normalizeRepoRelativePath, resolveWithin } from "./repo.js";

describe("normalizeRepoRelativePath", () => {
  test("returns a clean POSIX path for a valid repo-relative input", () => {
    expect(normalizeRepoRelativePath("src/agent/index.ts")).toBe(
      "src/agent/index.ts",
    );
  });

  test("collapses backslashes and duplicate separators", () => {
    expect(normalizeRepoRelativePath("src\\\\agent//index.ts")).toBe(
      "src/agent/index.ts",
    );
  });

  test.each([
    ["an empty string", ""],
    ["an absolute path", "/etc/passwd"],
    ["a bare traversal", ".."],
    ["a leading traversal", "../secrets"],
    ["an embedded traversal", "src/../../secrets"],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeRepoRelativePath(input)).toThrow();
  });
});

describe("resolveWithin", () => {
  test("resolves a contained path under the base directory", () => {
    const base = join("/tmp", "owsf-base");
    expect(resolveWithin(base, "final-wiki/architecture/overview.md")).toBe(
      join(base, "final-wiki/architecture/overview.md"),
    );
  });

  test("refuses a traversal that would escape the base directory", () => {
    expect(() =>
      resolveWithin(join("/tmp", "owsf-base"), "../escape.md"),
    ).toThrow();
  });
});
