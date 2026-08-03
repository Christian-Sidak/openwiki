import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  invokeWithRetry,
  PlanningError,
  validateDecision,
  validatePlanAgainstRepo,
} from "../src/agent/plan/planner.ts";
import { summarizeTree } from "../src/agent/plan/skeleton.ts";
import type { RepoSkeleton } from "../src/agent/plan/skeleton.ts";
import {
  adoptExistingWiki,
  deadLinkSections,
  enumerateSectionDirs,
} from "../src/agent/plan/adopt.ts";
import type {
  SectionPlan,
  UnclaimedDecision,
} from "../src/agent/plan/schema.ts";
import { PlanSchema } from "../src/agent/plan/schema.ts";
import type { OpenWikiManifest } from "../src/agent/manifest/types.ts";

/**
 * Builds a RepoSkeleton with the given tracked files; the prompt-only fields
 * are irrelevant to validation, so they stay empty.
 */
function skeleton(trackedFiles: string[]): RepoSkeleton {
  return { trackedFiles, treeSummary: "", keyFiles: "" };
}

/**
 * A fake chat model whose withStructuredOutput().invoke() replays a queued
 * response per call (the last is repeated once exhausted). The invoke spy lets
 * tests assert call counts without a live model.
 */
function fakeModel(responses: unknown[]): {
  model: BaseChatModel;
  invoke: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const invoke = vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  });
  const model = {
    withStructuredOutput: () => ({ invoke }),
  } as unknown as BaseChatModel;

  return { model, invoke };
}

const tmpDirs: string[] = [];

/**
 * Makes a throwaway directory tree under the OS tmpdir and registers it for
 * cleanup. `files` maps repo-relative paths to contents; a trailing slash marks
 * an empty directory.
 */
async function fixture(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "ow-plan-"));
  tmpDirs.push(cwd);

  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(cwd, relative);

    if (relative.endsWith("/")) {
      await mkdir(full, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  return cwd;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("validatePlanAgainstRepo", () => {
  const repo = skeleton(["src/api/server.ts", "src/core/thing.ts"]);

  test("a plan whose globs all hit tracked files has no problems", () => {
    const sections: SectionPlan[] = [
      { path: "api/", brief: "x", sources: ["src/api/**"] },
      { path: "core/", brief: "y", sources: ["src/core/*.ts"] },
    ];

    expect(validatePlanAgainstRepo(sections, repo)).toEqual([]);
  });

  test("a glob matching no tracked file is reported", () => {
    const problems = validatePlanAgainstRepo(
      [{ path: "api/", brief: "x", sources: ["src/nope/**"] }],
      repo,
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("matches no tracked file");
  });

  test("absolute and parent-escape globs are rejected as not repo-relative", () => {
    const problems = validatePlanAgainstRepo(
      [
        { path: "a/", brief: "x", sources: ["/etc/passwd"] },
        { path: "b/", brief: "y", sources: ["../secret/**"] },
      ],
      repo,
    );

    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("must be repo-relative"))).toBe(
      true,
    );
  });
});

describe("validateDecision", () => {
  const manifest: OpenWikiManifest = {
    version: 1,
    sections: [
      { path: "api/", sources: ["src/api/**"], head: null, attempts: 0 },
    ],
  };
  const repo = skeleton(["src/api/a.ts", "docs/readme.md"]);

  test("extending an unknown section is reported", () => {
    const decision: UnclaimedDecision = {
      extend: [{ path: "ghost/", addSources: ["src/api/**"] }],
      add: [],
    };

    const problems = validateDecision(
      decision,
      manifest,
      ["src/api/a.ts"],
      repo,
    );

    expect(problems).toContain('extend targets unknown section "ghost/"');
  });

  test("an unclaimed path left uncovered by every decision is reported", () => {
    const decision: UnclaimedDecision = {
      extend: [{ path: "api/", addSources: ["src/api/**"] }],
      add: [],
    };

    const problems = validateDecision(
      decision,
      manifest,
      ["src/api/a.ts", "docs/readme.md"],
      repo,
    );

    expect(problems).toEqual(["paths left uncovered: docs/readme.md"]);
  });
});

describe("invokeWithRetry", () => {
  interface Candidate {
    ok: boolean;
  }
  const accept = (candidate: Candidate): string[] =>
    candidate.ok ? [] : ["not ok"];

  test("returns the first result and does not retry when it validates", async () => {
    const { model, invoke } = fakeModel([{ ok: true }]);

    const result = await invokeWithRetry<Candidate>(
      model,
      PlanSchema,
      "prompt",
      accept,
    );

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("retries once with feedback and returns the second result", async () => {
    const { model, invoke } = fakeModel([{ ok: false }, { ok: true }]);

    const result = await invokeWithRetry<Candidate>(
      model,
      PlanSchema,
      "prompt",
      accept,
    );

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    // The retry prompt carries the prior problems forward.
    expect(String(invoke.mock.calls[1][0])).toContain("not ok");
  });

  test("throws PlanningError after two failing attempts", async () => {
    const { model, invoke } = fakeModel([{ ok: false }, { ok: false }]);

    await expect(
      invokeWithRetry<Candidate>(model, PlanSchema, "prompt", accept),
    ).rejects.toBeInstanceOf(PlanningError);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("summarizeTree", () => {
  test("rolls files up to two directory levels and sorts by count desc", () => {
    const summary = summarizeTree([
      "src/api/a.ts",
      "src/api/b.ts",
      "src/api/sub/deep.ts",
      "src/core/c.ts",
    ]);

    // src/api collects its own files plus the deeper one (collapsed to 2 levels).
    expect(summary.split("\n")).toEqual([
      "src/api (3 files)",
      "src/core (1 files)",
    ]);
  });

  test("caps the summary at 200 lines", () => {
    const files = Array.from({ length: 201 }, (_, i) => `d${i}/f.ts`);

    expect(summarizeTree(files).split("\n")).toHaveLength(200);
  });
});

describe("enumerateSectionDirs", () => {
  test("returns directories with trailing slashes, sorted, skipping loose files", async () => {
    const cwd = await fixture({
      "openwiki/workflows/": "",
      "openwiki/architecture/": "",
      "openwiki/quickstart.md": "# hi",
      "openwiki/.last-update.json": "{}",
    });

    expect(await enumerateSectionDirs(cwd)).toEqual([
      "architecture/",
      "workflows/",
    ]);
  });
});

describe("deadLinkSections", () => {
  test("flags relative links whose top dir is missing, ignoring the rest", async () => {
    const cwd = await fixture({
      "openwiki/quickstart.md": [
        "[Arch](architecture/overview.md)",
        "[Ops](operations/run.md)",
        "[Flow](./workflows/w.md)",
        "[Ext](https://example.com/x)",
        "[Anchor](#section)",
        "[Loose](quickstart.md)",
        "[Parent](../secret/s.md)",
      ].join("\n"),
    });

    // architecture/ exists; external, anchor, loose (no slash) and parent-escape
    // links are all skipped, leaving the two missing section dirs.
    expect(await deadLinkSections(cwd, ["architecture/"])).toEqual([
      "operations/",
      "workflows/",
    ]);
  });

  test("returns nothing when there is no quickstart file", async () => {
    const cwd = await fixture({ "openwiki/architecture/": "" });

    expect(await deadLinkSections(cwd, [])).toEqual([]);
  });
});

describe("adoptExistingWiki degrade rule", () => {
  test("a section whose extracted globs fail validation degrades to empty sources", async () => {
    const cwd = await fixture({
      "openwiki/architecture/overview.md": "Documents src/real.ts",
    });
    const { model } = fakeModel([
      {
        sections: [
          { path: "architecture/", brief: "b", sources: ["nonexistent/**"] },
        ],
      },
    ]);

    const manifest = await adoptExistingWiki(
      cwd,
      model,
      skeleton(["src/real.ts"]),
    );

    expect(manifest.sections).toHaveLength(1);
    // Invalid glob => sources emptied, null head so the planner re-derives it.
    expect(manifest.sections[0]).toMatchObject({
      path: "architecture/",
      sources: [],
      head: null,
    });
  });

  test("a section whose extracted globs are valid keeps its sources", async () => {
    const cwd = await fixture({
      "openwiki/architecture/overview.md": "Documents src/real.ts",
    });
    const { model } = fakeModel([
      {
        sections: [{ path: "architecture/", brief: "b", sources: ["src/**"] }],
      },
    ]);

    const manifest = await adoptExistingWiki(
      cwd,
      model,
      skeleton(["src/real.ts"]),
    );

    expect(manifest.sections[0].sources).toEqual(["src/**"]);
  });
});
