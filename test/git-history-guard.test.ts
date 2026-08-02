import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { UpdateMetadata } from "../src/agent/types.ts";
import {
  assertUsableHistory,
  readLastUpdate,
  runGit,
  runGitCheck,
  runGitStrict,
  writeLastUpdateMetadata,
} from "../src/agent/utils.ts";

const execFileAsync = promisify(execFile);

/**
 * Runs a git command in the given repo with a fixed, code-constructed argument
 * array (no shell), returning trimmed stdout.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Creates an isolated temp repo with a single commit and returns its path.
 */
async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-githist-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

/**
 * Reads the repository-mode last-update stamp back off disk.
 */
async function readStamp(repo: string): Promise<UpdateMetadata> {
  const raw = await readFile(
    path.join(repo, "openwiki", ".last-update.json"),
    "utf8",
  );
  return JSON.parse(raw) as UpdateMetadata;
}

describe("runGitStrict vs runGit", () => {
  test("runGitStrict throws on a git error where runGit swallows it", async () => {
    const repo = await createRepo();
    const bogusRange = ["log", "does-not-exist..HEAD"];

    // runGit returns git's stderr as if it were ordinary output.
    const swallowed = await runGit(repo, bogusRange);
    expect(swallowed).not.toBe("");

    // runGitStrict refuses to let that masquerade as an empty result.
    await expect(runGitStrict(repo, bogusRange)).rejects.toThrow();
  });

  test("runGitStrict returns real stdout for a valid command", async () => {
    const repo = await createRepo();
    const head = await git(repo, ["rev-parse", "HEAD"]);

    expect(await runGitStrict(repo, ["rev-parse", "HEAD"])).toBe(head);
  });
});

describe("runGitCheck", () => {
  test("returns true for a commit that exists and false for one that does not", async () => {
    const repo = await createRepo();
    const head = await git(repo, ["rev-parse", "HEAD"]);

    expect(
      await runGitCheck(repo, ["cat-file", "-e", `${head}^{commit}`]),
    ).toBe(true);
    expect(
      await runGitCheck(repo, ["cat-file", "-e", `${"0".repeat(40)}^{commit}`]),
    ).toBe(false);
  });
});

describe("assertUsableHistory", () => {
  test("returns silently when there is no prior stamp or no recorded head", async () => {
    const repo = await createRepo();

    await expect(assertUsableHistory(repo, null)).resolves.toBeUndefined();
    await expect(
      assertUsableHistory(repo, {
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "update",
        model: "test-model",
      }),
    ).resolves.toBeUndefined();
  });

  test("returns silently when the recorded head is present locally", async () => {
    const repo = await createRepo();
    const head = await git(repo, ["rev-parse", "HEAD"]);

    await expect(
      assertUsableHistory(repo, {
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "update",
        gitHead: head,
        model: "test-model",
      }),
    ).resolves.toBeUndefined();
  });

  test("throws the rebased-away message when the head is missing in a full repo", async () => {
    const repo = await createRepo();
    const missing = "0".repeat(40);

    await expect(
      assertUsableHistory(repo, {
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "update",
        gitHead: missing,
        model: "test-model",
      }),
    ).rejects.toThrow(/no longer exists|rebased away/i);
  });

  test("throws the shallow-checkout message when the head is missing in a shallow clone", async () => {
    // Build an origin with two commits, then shallow-clone depth 1 so the first
    // commit (our recorded head) is absent and the clone reports shallow.
    const origin = await createRepo();
    await writeFile(path.join(origin, "second.md"), "# Second\n", "utf8");
    await git(origin, ["add", "."]);
    await git(origin, ["commit", "-m", "second"]);
    const firstCommit = await git(origin, ["rev-parse", "HEAD~1"]);

    const shallow = await mkdtemp(path.join(tmpdir(), "openwiki-shallow-"));
    await execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      `file://${origin}`,
      shallow,
    ]);

    expect(
      await runGit(shallow, ["rev-parse", "--is-shallow-repository"]),
    ).toBe("true");

    await expect(
      assertUsableHistory(shallow, {
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "update",
        gitHead: firstCommit,
        model: "test-model",
      }),
    ).rejects.toThrow(/shallow.*fetch-depth: 0/is);
  });
});

describe("writeLastUpdateMetadata", () => {
  test("preserves the prior verified head on an interrupted run", async () => {
    const repo = await createRepo();
    const originalHead = await git(repo, ["rev-parse", "HEAD"]);

    // A prior complete run recorded the head it verified.
    await writeLastUpdateMetadata("update", repo, "model-a", "repository");
    expect((await readStamp(repo)).gitHead).toBe(originalHead);

    // The repo advances after that stamp.
    await writeFile(path.join(repo, "next.md"), "# Next\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "advance"]);
    const advancedHead = await git(repo, ["rev-parse", "HEAD"]);
    expect(advancedHead).not.toBe(originalHead);

    // An interrupted run must keep the OLD head so the retry re-sweeps the
    // window the dead run was processing.
    await writeLastUpdateMetadata(
      "update",
      repo,
      "model-a",
      "repository",
      "interrupted",
    );

    const stamp = await readStamp(repo);
    expect(stamp.status).toBe("interrupted");
    expect(stamp.gitHead).toBe(originalHead);
    expect(stamp.gitHead).not.toBe(advancedHead);
  });

  test("falls back to current HEAD on an interrupted run with no prior stamp", async () => {
    const repo = await createRepo();
    const head = await git(repo, ["rev-parse", "HEAD"]);

    await writeLastUpdateMetadata(
      "update",
      repo,
      "model-a",
      "repository",
      "interrupted",
    );

    const stamp = await readStamp(repo);
    expect(stamp.status).toBe("interrupted");
    expect(stamp.gitHead).toBe(head);
  });

  test("round-trips through readLastUpdate", async () => {
    const repo = await createRepo();

    await writeLastUpdateMetadata("update", repo, "model-a", "repository");

    const loaded = await readLastUpdate(repo, "repository");
    expect(loaded?.model).toBe("model-a");
    expect(loaded?.command).toBe("update");
  });
});
