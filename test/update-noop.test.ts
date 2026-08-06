import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../src/agent/openwiki-ignore.ts";
import {
  getUpdateNoopStatus,
  shouldCheckUpdateNoop,
} from "../src/agent/utils.ts";
import { FileSystemSourceReader } from "../src/staleness/freshness.ts";
import { createDefaultRegistry } from "../src/staleness/languages/registry.ts";
import { recordSourceDependencies } from "../src/staleness/recorder.ts";
import { SourceResolver } from "../src/staleness/resolver.ts";
import { writeSidecarAtomic } from "../src/staleness/storage.ts";

const execFileAsync = promisify(execFile);

const THING_PAGE = "openwiki/thing.md";
const THING_PAGE_BYTES = "# Thing\n\n`greet` returns hello.\n";
const THING_SOURCE = "src/thing.ts";

/**
 * Grounds a wiki page in a real source symbol via the production recorder, then
 * drifts that symbol so the page is genuinely stale while git stays quiet. The
 * sidecar is left committed-ready so the caller can commit and point `gitHead`
 * at HEAD, isolating source-grounded freshness from any git-visible change.
 */
async function seedStalePage(repo: string): Promise<void> {
  const sourceAbsolute = path.join(repo, THING_SOURCE);
  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await writeFile(
    sourceAbsolute,
    'export function greet(): string {\n  return "hello";\n}\n',
    "utf8",
  );
  await writeFile(path.join(repo, THING_PAGE), THING_PAGE_BYTES, "utf8");

  const { sidecar } = await recordSourceDependencies({
    page: THING_PAGE,
    pageBytes: THING_PAGE_BYTES,
    requests: [{ path: THING_SOURCE, symbol: "greet" }],
    resolver: new SourceResolver(createDefaultRegistry()),
    reader: new FileSystemSourceReader(repo),
  });
  if (sidecar.sources[0]?.resolution !== "symbol") {
    throw new Error("expected symbol-level grounding for the test fixture");
  }
  await writeSidecarAtomic(repo, sidecar);

  // Drift the cited definition; the page now claims something the source no
  // longer says, so freshness reports it stale even with git quiet.
  await writeFile(
    sourceAbsolute,
    'export function greet(): string {\n  return "goodbye";\n}\n',
    "utf8",
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepoWithOpenWiki(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-noop-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, "openwiki"));
  await writeFile(
    path.join(repo, "openwiki", "quickstart.md"),
    "# Quickstart\n",
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function writeLastUpdate(
  repo: string,
  gitHead: string,
  extraFields: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead,
      model: "test-model",
      ...extraFields,
    })}\n`,
    "utf8",
  );
}

describe("getUpdateNoopStatus", () => {
  test("detects a clean update with unchanged HEAD as a no-op", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("detects a no-op when only the committed run metadata is dirty", async () => {
    // A committed wiki leaves openwiki/.last-update.json tracked, so the next
    // run sees it as an unstaged modification: " M openwiki/.last-update.json".
    const repo = await createRepoWithOpenWiki();
    await writeLastUpdate(repo, "0".repeat(40));
    await git(repo, ["add", "openwiki/.last-update.json"]);
    await git(repo, ["commit", "-m", "record update"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when the worktree has uncommitted changes", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
  });

  test("skips update when worktree changes only touch ignored paths", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await mkdir(path.join(repo, "private"));
    await writeFile(
      path.join(repo, "private", "notes.md"),
      "Ignored\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(
      repo,
      OpenWikiIgnore.parse("private/\n"),
    );

    expect(status.shouldSkip).toBe(true);
  });

  test("skips update when commits since the last run only touch OpenWiki files", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "# Quickstart\nUpdated\n",
      "utf8",
    );
    await git(repo, ["add", "openwiki/quickstart.md"]);
    await git(repo, ["commit", "-m", "update openwiki docs"]);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when the previous run was interrupted", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head, { status: "interrupted" });

    const status = await getUpdateNoopStatus(repo);

    expect(status).toEqual({
      shouldSkip: false,
      reason: "previous update was interrupted",
      changedPaths: [],
      stalePages: [],
    });
  });

  test("skips update when the previous complete run predates the status field", async () => {
    // Metadata written by versions without the status field must keep
    // behaving as a completed run and not force a spurious re-run.
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(true);
  });

  test("does not skip update when commits since the last run touch source files", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "update readme"]);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    if (status.shouldSkip) {
      throw new Error("unreachable");
    }
    expect(status.changedPaths).toEqual(["README.md"]);
    expect(status.stalePages).toEqual([]);
  });

  test("lists worktree source changes in changedPaths without listing wiki output", async () => {
    const repo = await createRepoWithOpenWiki();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );
    // A concurrent edit to the wiki itself must not appear as a source change.
    await writeFile(
      path.join(repo, "openwiki", "quickstart.md"),
      "# Quickstart\nEdited\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    if (status.shouldSkip) {
      throw new Error("unreachable");
    }
    expect(status.changedPaths).toEqual(["README.md"]);
  });

  test("forces a run and surfaces stale pages when git is quiet", async () => {
    const repo = await createRepoWithOpenWiki();
    await seedStalePage(repo);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "record grounded page then drift source"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    if (status.shouldSkip) {
      throw new Error("unreachable");
    }
    // Git sees nothing since the cursor, so this drift is only visible through
    // the recorded sidecar. The stale page must still reach the caller.
    expect(status.changedPaths).toEqual([]);
    expect(status.stalePages.map((page) => page.page)).toEqual([THING_PAGE]);
    expect(status.stalePages[0]?.state).toBe("stale");
  });

  test("combines git source changes and stale pages into one run signal", async () => {
    const repo = await createRepoWithOpenWiki();
    await seedStalePage(repo);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "record grounded page then drift source"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await writeLastUpdate(repo, head);
    // An unrelated, git-visible source change lands alongside the sidecar drift.
    await writeFile(
      path.join(repo, "README.md"),
      "# Test Repo\nChanged\n",
      "utf8",
    );

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    if (status.shouldSkip) {
      throw new Error("unreachable");
    }
    expect(status.changedPaths).toEqual(["README.md"]);
    expect(status.stalePages.map((page) => page.page)).toEqual([THING_PAGE]);
  });
});

describe("shouldCheckUpdateNoop", () => {
  test("does not check for update no-op when an update message is provided", () => {
    expect(shouldCheckUpdateNoop({ userMessage: "document the API" })).toBe(
      false,
    );
  });

  test("checks for update no-op when no update message is provided", () => {
    expect(shouldCheckUpdateNoop({ userMessage: null })).toBe(true);
    expect(shouldCheckUpdateNoop({ userMessage: "   " })).toBe(true);
  });
});
