import { beforeEach, describe, expect, test, vi } from "vitest";
import { OpenWikiIgnore } from "../src/agent/openwiki-ignore.ts";
import {
  gatherRepoEvidence,
  type RepoEvidence,
} from "../src/agent/manifest/evidence.ts";
import { computeVerdicts } from "../src/agent/manifest/reconcile.ts";
import type {
  ManifestSection,
  OpenWikiManifest,
} from "../src/agent/manifest/types.ts";
import { runGitStrict } from "../src/agent/utils.ts";

// Only the git boundary is mocked; isOpenWikiPath (used by evidence filtering)
// stays real so the openwiki/ drop is exercised against production logic.
vi.mock("../src/agent/utils.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/utils.ts")>();
  return { ...actual, runGitStrict: vi.fn() };
});

const mockGit = vi.mocked(runGitStrict);
const noIgnore = OpenWikiIgnore.parse("");

/**
 * Builds a manifest section, defaulting to a written, non-abandoned entry.
 * Pass `head: null` explicitly for the never-written case.
 */
function section(overrides: Partial<ManifestSection> = {}): ManifestSection {
  return {
    path: overrides.path ?? "a/",
    sources: overrides.sources ?? ["src/a/**"],
    head: overrides.head === undefined ? "HEAD_A" : overrides.head,
    attempts: overrides.attempts ?? 0,
    ...(overrides.abandoned !== undefined
      ? { abandoned: overrides.abandoned }
      : {}),
  };
}

/**
 * Wraps sections in a v1 manifest.
 */
function manifest(sections: ManifestSection[]): OpenWikiManifest {
  return { version: 1, sections };
}

/**
 * A RepoEvidence stub that returns canned per-head change lists and records
 * which heads were queried, so tests can inject evidence without touching git.
 */
function makeEvidence(opts: {
  runHead?: string;
  changedByHead?: Record<string, string[]>;
}): { evidence: RepoEvidence; queried: string[] } {
  const queried: string[] = [];
  const changedByHead = opts.changedByHead ?? {};
  const evidence: RepoEvidence = {
    runHead: opts.runHead ?? "RUNHEAD",
    dirtyPaths: [],
    changedSince: async (head) => {
      queried.push(head);
      return changedByHead[head] ?? [];
    },
  };
  return { evidence, queried };
}

describe("computeVerdicts (injected evidence)", () => {
  test("a null head is missing", async () => {
    const { evidence } = makeEvidence({});

    const result = await computeVerdicts(
      manifest([section({ head: null })]),
      evidence,
    );

    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].kind).toBe("missing");
  });

  test("abandoned wins over a null head and over pending changes", async () => {
    const { evidence } = makeEvidence({
      changedByHead: { HEAD_A: ["src/a/x.ts"] },
    });

    // Abandoned + null head: abandoned, not missing.
    const nullHead = await computeVerdicts(
      manifest([section({ head: null, abandoned: true })]),
      evidence,
    );
    expect(nullHead.verdicts[0].kind).toBe("abandoned");

    // Abandoned + real changes that would otherwise be stale: still abandoned.
    const wouldBeStale = await computeVerdicts(
      manifest([
        section({ head: "HEAD_A", sources: ["src/a/**"], abandoned: true }),
      ]),
      evidence,
    );
    expect(wouldBeStale.verdicts[0].kind).toBe("abandoned");
  });

  test("head === runHead short-circuits to fast-forward without diffing", async () => {
    // changedSince for this head WOULD report a matching change; the
    // short-circuit must fire first, so the verdict is fast-forward, not stale.
    const { evidence, queried } = makeEvidence({
      runHead: "RH",
      changedByHead: { RH: ["src/a/x.ts"] },
    });

    const result = await computeVerdicts(
      manifest([section({ head: "RH", sources: ["src/a/**"] })]),
      evidence,
    );

    expect(result.verdicts[0].kind).toBe("fast-forward");
    // The per-section verdict path never queried; the only RH query, if any,
    // would come from the unclaimed scan. Here writtenHeads = [RH], and unclaimed
    // does query it, so we assert the verdict outcome rather than call counts.
    expect(queried.filter((head) => head === "RH").length).toBeLessThanOrEqual(
      1,
    );
  });

  test("stale carries exactly the changed files intersecting its sources", async () => {
    const { evidence } = makeEvidence({
      changedByHead: {
        HEAD_A: ["src/a/x.ts", "src/b/y.ts", "src/a/z.ts"],
      },
    });

    const result = await computeVerdicts(
      manifest([section({ head: "HEAD_A", sources: ["src/a/**"] })]),
      evidence,
    );

    const verdict = result.verdicts[0];
    expect(verdict.kind).toBe("stale");
    if (verdict.kind === "stale") {
      // Exactly the src/a/ files, in encounter order, excluding src/b/y.ts.
      expect(verdict.changedFiles).toEqual(["src/a/x.ts", "src/a/z.ts"]);
    }
  });

  test("a written head whose sources saw no matching change is fast-forward", async () => {
    const { evidence } = makeEvidence({
      changedByHead: { HEAD_A: ["src/b/y.ts"] },
    });

    const result = await computeVerdicts(
      manifest([section({ head: "HEAD_A", sources: ["src/a/**"] })]),
      evidence,
    );

    expect(result.verdicts[0].kind).toBe("fast-forward");
  });
});

describe("computeUnclaimed (via computeVerdicts)", () => {
  test("fresh init with only null heads yields no unclaimed paths", async () => {
    const { evidence, queried } = makeEvidence({
      changedByHead: { HEAD_A: ["should/not/matter.ts"] },
    });

    const result = await computeVerdicts(
      manifest([
        section({ path: "a/", head: null }),
        section({ path: "b/", head: null }),
      ]),
      evidence,
    );

    expect(result.unclaimed).toEqual([]);
    // Nothing to scan against, so no head was ever queried.
    expect(queried).toEqual([]);
  });

  test("unclaimed is the union of changes across distinct written heads", async () => {
    const { evidence } = makeEvidence({
      changedByHead: {
        H1: ["docs/readme.md"],
        H2: ["scripts/tool.sh"],
      },
    });

    const result = await computeVerdicts(
      manifest([
        section({ path: "a/", head: "H1", sources: ["src/a/**"] }),
        section({ path: "b/", head: "H2", sources: ["src/b/**"] }),
      ]),
      evidence,
    );

    // Neither changed path is claimed by any section, so both surface, unioned
    // across H1 and H2 in head-iteration order.
    expect(result.unclaimed).toEqual(["docs/readme.md", "scripts/tool.sh"]);
  });

  test("a path claimed by any section (even two) is never unclaimed", async () => {
    const { evidence } = makeEvidence({
      changedByHead: {
        H1: ["src/shared/x.ts", "loose/y.ts"],
        H2: ["src/shared/x.ts"],
      },
    });

    const result = await computeVerdicts(
      manifest([
        // Same path claimed by two sections.
        section({ path: "a/", head: "H1", sources: ["src/shared/**"] }),
        section({ path: "b/", head: "H2", sources: ["src/shared/**"] }),
      ]),
      evidence,
    );

    expect(result.unclaimed).not.toContain("src/shared/x.ts");
    // The genuinely unclaimed path still surfaces.
    expect(result.unclaimed).toEqual(["loose/y.ts"]);
  });
});

describe("gatherRepoEvidence parsing (mocked git)", () => {
  beforeEach(() => {
    mockGit.mockReset();
  });

  /**
   * Routes runGitStrict by subcommand: rev-parse -> runHead, status -> the
   * porcelain fixture, diff -> the name-status fixture.
   */
  function stubGit(opts: { porcelain?: string; diff?: string }): void {
    mockGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return "RUNHEAD";
      }
      if (args[0] === "status") {
        return opts.porcelain ?? "";
      }
      if (args[0] === "diff") {
        return opts.diff ?? "";
      }
      return "";
    });
  }

  test("--name-status rename lines contribute both old and new paths", async () => {
    stubGit({
      diff: "R100\tsrc/old.ts\tsrc/new.ts\nM\tsrc/a.ts",
    });

    const evidence = await gatherRepoEvidence("/repo", noIgnore);

    expect(await evidence.changedSince("HEAD1")).toEqual([
      "src/old.ts",
      "src/new.ts",
      "src/a.ts",
    ]);
  });

  test("porcelain rename lines split into both sides; modified and untracked kept", async () => {
    stubGit({
      porcelain: "R  src/old.ts -> src/new.ts\n M src/c.ts\n?? src/d.ts",
    });

    const evidence = await gatherRepoEvidence("/repo", noIgnore);

    expect(evidence.dirtyPaths).toEqual([
      "src/old.ts",
      "src/new.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  test("ignored and openwiki paths are dropped from both committed and dirty evidence", async () => {
    stubGit({
      porcelain: "?? ignored/x.ts\n?? openwiki/notes.md\n?? src/keep.ts",
      diff: "M\tignored/y.ts\nM\topenwiki/pages/z.md\nM\tsrc/also.ts",
    });

    const evidence = await gatherRepoEvidence(
      "/repo",
      OpenWikiIgnore.parse("ignored/\n"),
    );

    expect(evidence.dirtyPaths).toEqual(["src/keep.ts"]);
    // committed src/also.ts (ignored/ and openwiki/ dropped) merged with the
    // surviving dirty path.
    expect(await evidence.changedSince("HEAD1")).toEqual([
      "src/also.ts",
      "src/keep.ts",
    ]);
  });
});

describe("gatherRepoEvidence diff caching (mocked git)", () => {
  beforeEach(() => {
    mockGit.mockReset();
    mockGit.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") {
        return "RUNHEAD";
      }
      if (args[0] === "diff") {
        return "M\tsrc/a.ts";
      }
      return "";
    });
  });

  test("runs one git diff per distinct head and caches repeats", async () => {
    const evidence = await gatherRepoEvidence("/repo", noIgnore);

    await evidence.changedSince("H1");
    await evidence.changedSince("H1");
    await evidence.changedSince("H2");
    await evidence.changedSince("H2");

    const diffCalls = mockGit.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "diff",
    );
    expect(diffCalls).toHaveLength(2);
    // And each distinct head was diffed against the pinned run head.
    expect((diffCalls[0][1] as string[]).slice(-2)).toEqual(["H1", "RUNHEAD"]);
    expect((diffCalls[1][1] as string[]).slice(-2)).toEqual(["H2", "RUNHEAD"]);
  });
});
