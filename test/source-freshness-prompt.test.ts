import { describe, expect, test } from "vitest";
import { createUserPrompt } from "../src/agent/prompt.ts";
import type { RunContext, UpdateRunSignals } from "../src/agent/types.ts";
import type { PageFreshness } from "../src/staleness/freshness.ts";

const CONTEXT: RunContext = {
  lastUpdate: null,
  language: "en",
  wikiGoal: "Document the repository.",
};

function stalePage(page: string, state: PageFreshness["state"]): PageFreshness {
  return { page, state, dependencies: [] };
}

describe("createUserPrompt source-freshness block", () => {
  test("renders both the changed sources and the pages that must be revalidated", () => {
    const signals: UpdateRunSignals = {
      changedPaths: ["src/auth.ts", "src/config.ts"],
      stalePages: [
        stalePage("openwiki/authentication.md", "stale"),
        stalePage("openwiki/architecture.md", "unknown"),
      ],
    };

    const prompt = createUserPrompt(
      "update",
      CONTEXT,
      null,
      "repository",
      "/repo",
      signals,
    );

    expect(prompt).toContain("Repository changes");
    expect(prompt).toContain("- src/auth.ts");
    expect(prompt).toContain("- src/config.ts");
    expect(prompt).toContain("Pages that MUST be revalidated");
    expect(prompt).toContain("- openwiki/authentication.md (stale)");
    expect(prompt).toContain("- openwiki/architecture.md (unknown)");
    // The point of recording dependencies: the agent is told to re-record after
    // revalidating, and told not to skip a listed page just because the git diff
    // looks quiet.
    expect(prompt).toContain("record_source_dependencies");
    expect(prompt).toContain(
      "Do not skip a listed page because the git diff does not obviously touch it",
    );
  });

  test("emits no freshness block when there is nothing pre-computed", () => {
    const prompt = createUserPrompt(
      "update",
      CONTEXT,
      null,
      "repository",
      "/repo",
      undefined,
    );

    expect(prompt).not.toContain("Repository changes");
    expect(prompt).not.toContain("Pages that MUST be revalidated");
    // The unresolved placeholder must never leak into the prompt.
    expect(prompt).not.toContain("{SOURCE_FRESHNESS}");
  });

  test("emits no freshness block when both signal lists are empty", () => {
    const prompt = createUserPrompt(
      "update",
      CONTEXT,
      null,
      "repository",
      "/repo",
      {
        changedPaths: [],
        stalePages: [],
      },
    );

    expect(prompt).not.toContain("Repository changes");
    expect(prompt).not.toContain("Pages that MUST be revalidated");
    expect(prompt).not.toContain("{SOURCE_FRESHNESS}");
  });

  test("lists only the pages when there are stale pages but no git-visible source changes", () => {
    const prompt = createUserPrompt(
      "update",
      CONTEXT,
      null,
      "repository",
      "/repo",
      {
        changedPaths: [],
        stalePages: [stalePage("openwiki/connectors.md", "unverified")],
      },
    );

    expect(prompt).not.toContain("Repository changes");
    expect(prompt).toContain("Pages that MUST be revalidated");
    expect(prompt).toContain("- openwiki/connectors.md (unverified)");
  });
});
