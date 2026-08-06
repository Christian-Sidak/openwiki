/**
 * Phase 3 harness unit test.
 *
 * Exercises the throwaway-repo seeding ({@link seedTrialRepo}, {@link readWikiPages})
 * and the passive telemetry tap ({@link createTelemetryTap}) against a synthetic
 * baseline built entirely under `os.tmpdir()`. No real agent runs and no tokens
 * are spent: the point is to prove the fair-A/B invariants the costed benchmark
 * relies on (identical source and wiki prose across arms, the dependency graph
 * present only in the WITH arm, the mutation isolated in the git range) and that
 * the telemetry tap classifies a synthetic event stream correctly.
 */

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EvalScenario } from "../scenarios/types.js";
import { git, readWikiPages, seedTrialRepo, withTempGitRepo } from "./repo.js";
import { createTelemetryTap } from "./telemetry.js";

const GREET_HELLO = 'export function greet(): string {\n  return "hello";\n}\n';
const GREET_GOODBYE =
  'export function greet(): string {\n  return "goodbye";\n}\n';

/** Temp roots created by the fixtures, removed after each test. */
const scratchDirs: string[] = [];

/** Make a tracked temp directory that {@link afterEach} will clean up. */
async function makeScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    scratchDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** True when `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a read-only synthetic corpus checkout with one committed source file the
 * scenario later mutates, and return its root plus the commit `git archive` reads.
 */
async function makeDevRepo(): Promise<{
  devRoot: string;
  sourceCommit: string;
}> {
  const devRoot = await makeScratch("owsf-dev-");
  await git(devRoot, ["init", "-q"]);
  await mkdir(join(devRoot, "src"), { recursive: true });
  await writeFile(join(devRoot, "src", "thing.ts"), GREET_HELLO, "utf8");
  await writeFile(
    join(devRoot, "src", "other.ts"),
    "export const OTHER = 1;\n",
    "utf8",
  );
  await writeFile(join(devRoot, "README.md"), "# Synthetic corpus\n", "utf8");
  await git(devRoot, ["add", "-A"]);
  await git(devRoot, ["commit", "-q", "-m", "synthetic corpus"]);
  const sourceCommit = await git(devRoot, ["rev-parse", "HEAD"]);
  return { devRoot, sourceCommit };
}

/**
 * Build a synthetic frozen baseline wiki directory: two real pages, a stray
 * `_plan.md` (which {@link readWikiPages} must skip), and a `.source-deps` sidecar
 * (copied verbatim into the WITH arm only). Returns the `openwiki/` directory.
 */
async function makeBaselineWiki(): Promise<string> {
  const baseline = await makeScratch("owsf-baseline-");
  const wiki = join(baseline, "openwiki");
  await mkdir(join(wiki, "architecture"), { recursive: true });
  await mkdir(join(wiki, ".source-deps"), { recursive: true });
  await writeFile(
    join(wiki, "quickstart.md"),
    "# Quickstart\n\nStart here.\n",
    "utf8",
  );
  await writeFile(
    join(wiki, "architecture", "overview.md"),
    "# Overview\n\n`greet` returns hello.\n",
    "utf8",
  );
  await writeFile(join(wiki, "_plan.md"), "scratch plan\n", "utf8");
  await writeFile(
    join(wiki, ".source-deps", "overview.json"),
    '{"page":"openwiki/architecture/overview.md"}\n',
    "utf8",
  );
  return wiki;
}

/**
 * A synthetic scenario whose mutation flips `greet`'s return value. Only
 * `applyMutation` matters to the harness; the ground-truth fields are minimal
 * because grading is not under test here.
 */
const scenario: EvalScenario = {
  id: "synthetic-greet",
  title: "greet returns goodbye",
  complexity: "small",
  description: "greet() flips its return value from hello to goodbye.",
  async applyMutation(cwd: string): Promise<void> {
    await writeFile(join(cwd, "src", "thing.ts"), GREET_GOODBYE, "utf8");
  },
  expectedAffectedPages: [
    {
      page: "openwiki/architecture/overview.md",
      rationale: "the overview cites greet's return value",
      requiredFacts: [],
      forbiddenFacts: [],
      sourceEvidence: [],
    },
  ],
};

/** What one seeded arm looks like from the outside. */
interface Inspected {
  frozenCommit: string;
  mutationCommit: string;
  sidecarPresent: boolean;
  changedMeaningful: string[];
  cursor: { gitHead?: string; status?: string };
  pages: Record<string, string>;
  mutatedSource: string;
}

/** Seed one arm in a throwaway repo and read back its observable state. */
async function seedAndInspect(
  arm: "with" | "without",
  ctx: { devRoot: string; sourceCommit: string; baselineWiki: string },
): Promise<Inspected> {
  return withTempGitRepo(async (cwd) => {
    const { frozenCommit, mutationCommit } = await seedTrialRepo({
      cwd,
      devRoot: ctx.devRoot,
      sourceCommit: ctx.sourceCommit,
      baselineWiki: ctx.baselineWiki,
      scenario,
      includeSidecars: arm === "with",
    });

    const changed = (
      await git(cwd, [
        "diff",
        "--name-only",
        `${frozenCommit}..${mutationCommit}`,
      ])
    )
      .split("\n")
      .filter(Boolean);
    const cursor = JSON.parse(
      await readFile(join(cwd, "openwiki", ".last-update.json"), "utf8"),
    ) as { gitHead?: string; status?: string };

    return {
      frozenCommit,
      mutationCommit,
      sidecarPresent: await exists(join(cwd, "openwiki", ".source-deps")),
      // The freshness cursor is written after the frozen commit, so `git add -A`
      // sweeps it into the mutation commit; it is filtered from the meaningful
      // diff exactly as the runtime `changedPaths` signal filters the metadata file.
      changedMeaningful: changed.filter(
        (p) => p !== "openwiki/.last-update.json",
      ),
      cursor,
      pages: await readWikiPages(cwd),
      mutatedSource: await readFile(join(cwd, "src", "thing.ts"), "utf8"),
    };
  });
}

describe("seedTrialRepo", () => {
  test("seeds a fair A/B trial: mutation isolated, sidecars only in the WITH arm", async () => {
    const { devRoot, sourceCommit } = await makeDevRepo();
    const baselineWiki = await makeBaselineWiki();
    const ctx = { devRoot, sourceCommit, baselineWiki };

    const withArm = await seedAndInspect("with", ctx);
    const withoutArm = await seedAndInspect("without", ctx);

    // Each trial is bounded by two distinct commits.
    expect(withArm.frozenCommit).not.toBe(withArm.mutationCommit);

    // The only meaningful change across the range is the scenario's source edit,
    // in both arms.
    expect(withArm.changedMeaningful).toEqual(["src/thing.ts"]);
    expect(withoutArm.changedMeaningful).toEqual(["src/thing.ts"]);

    // The freshness cursor points at the frozen baseline and marks it complete, so
    // the update run computes drift as frozenCommit..HEAD.
    expect(withArm.cursor.gitHead).toBe(withArm.frozenCommit);
    expect(withArm.cursor.status).toBe("complete");

    // The mutation is live in the working tree; the frozen wiki prose is untouched
    // (no agent has run yet).
    expect(withArm.mutatedSource).toContain('"goodbye"');
    expect(withArm.pages["openwiki/architecture/overview.md"]).toContain(
      "returns hello",
    );

    // The dependency graph is physically present only for the WITH arm.
    expect(withArm.sidecarPresent).toBe(true);
    expect(withoutArm.sidecarPresent).toBe(false);

    // readWikiPages returns only real documentation pages: no sidecar entries and
    // no temporary plan file.
    const keys = Object.keys(withArm.pages).sort();
    expect(keys).toEqual([
      "openwiki/architecture/overview.md",
      "openwiki/quickstart.md",
    ]);
    expect(keys.some((key) => key.includes(".source-deps"))).toBe(false);
    expect(keys.some((key) => key.endsWith("_plan.md"))).toBe(false);

    // The arms are byte-identical on the documentation pages: source-grounded
    // freshness is the only variable, never the prose the agent starts from.
    expect(withArm.pages).toEqual(withoutArm.pages);
  });
});

describe("createTelemetryTap", () => {
  test("classifies reads and writes, captures the plan, and sums usage", () => {
    const tap = createTelemetryTap();

    tap.onEvent({ type: "debug", message: "freshness.mode=on" });
    tap.onEvent({
      type: "tool_start",
      call: "read_file",
      id: "1",
      name: "read_file",
      input: { file_path: "src/thing.ts" },
    });
    tap.onEvent({
      type: "tool_start",
      call: "read_file",
      id: "2",
      name: "read_file",
      // `path` alias plus a leading virtual-root slash, both normalized away.
      input: { path: "/openwiki/architecture/overview.md" },
    });
    // A subgraph-sourced text event must NOT close the tool-call round.
    tap.onEvent({
      type: "text",
      source: "subgraph",
      text: "planning (subgraph)",
    });
    tap.onEvent({
      type: "tool_start",
      call: "read_file",
      id: "3",
      name: "read_file",
      // A sidecar read is neither a documentation page nor a source file.
      input: { file_path: "openwiki/.source-deps/overview.json" },
    });
    // A main-channel text event closes round 1.
    tap.onEvent({ type: "text", source: "main", text: "now editing" });
    tap.onEvent({
      type: "tool_start",
      call: "write_file",
      id: "4",
      name: "write_file",
      input: { file_path: "openwiki/_plan.md", content: "PLAN BODY" },
    });
    tap.onEvent({
      type: "tool_start",
      call: "write_file",
      id: "5",
      name: "write_file",
      input: {
        file_path: "openwiki/architecture/overview.md",
        content: "# Overview\n\n`greet` returns goodbye.\n",
      },
    });
    tap.onEvent({
      type: "tool_start",
      call: "record",
      id: "6",
      name: "record_source_dependencies",
      input: { page: "openwiki/architecture/overview.md" },
    });
    tap.onUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    tap.onUsage({ inputTokens: 50, outputTokens: 10, totalTokens: 60 });

    const snap = tap.snapshot();

    expect(snap.freshnessMode).toBe("on");
    expect(snap.toolCalls).toBe(6);
    expect(snap.toolCallsByName).toEqual({
      read_file: 3,
      write_file: 2,
      record_source_dependencies: 1,
    });
    // Round 1 = the three reads (a subgraph text does not break it); the
    // main-channel text closes it; round 2 = the two writes plus the record call.
    expect(snap.toolRounds).toBe(2);
    expect(snap.sourceFilesRead).toEqual(["src/thing.ts"]);
    expect(snap.wikiPagesRead).toEqual(["openwiki/architecture/overview.md"]);
    // The sidecar read is classified as neither a page nor a source file.
    expect(snap.sourceFilesRead).not.toContain(
      "openwiki/.source-deps/overview.json",
    );
    // The _plan.md write is captured as the plan, not counted as a page write.
    expect(snap.wikiPagesWritten).toEqual([
      "openwiki/architecture/overview.md",
    ]);
    expect(snap.docsImpactPlan).toBe("PLAN BODY");
    expect(snap.recordSourceDependenciesCalls).toBe(1);
    expect(snap.tokens).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
    });
  });

  test("reports the control-arm mode and omits tokens when the provider is silent", () => {
    const tap = createTelemetryTap();

    tap.onEvent({ type: "debug", message: "freshness.mode=off" });
    tap.onEvent({ type: "debug", message: "some unrelated debug line" });
    tap.onEvent({
      type: "tool_start",
      call: "ls",
      id: "1",
      name: "ls",
      input: {},
    });

    const snap = tap.snapshot();

    expect(snap.freshnessMode).toBe("off");
    expect(snap.tokens).toBeUndefined();
    expect(snap.recordSourceDependenciesCalls).toBe(0);
    expect(snap.docsImpactPlan).toBeUndefined();
    expect(snap.toolCalls).toBe(1);
  });
});
