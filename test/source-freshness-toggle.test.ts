import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";
import { getUpdateNoopStatus } from "../src/agent/utils.ts";
import { FileSystemSourceReader } from "../src/staleness/freshness.ts";
import { createDefaultRegistry } from "../src/staleness/languages/registry.ts";
import { recordSourceDependencies } from "../src/staleness/recorder.ts";
import { SourceResolver } from "../src/staleness/resolver.ts";
import { writeSidecarAtomic } from "../src/staleness/storage.ts";
import {
  DISABLE_SOURCE_FRESHNESS_ENV_KEY,
  isSourceFreshnessEnabled,
} from "../src/staleness/toggle.ts";

const execFileAsync = promisify(execFile);

/**
 * Forces the control arm for the duration of a test and restores the ambient
 * environment afterwards, so an arm flip never leaks into a later test in this
 * file.
 */
function disableFreshness(): void {
  process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = "1";
}

afterEach(() => {
  delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];
});

describe("isSourceFreshnessEnabled", () => {
  test("is on by default and off only for the exact opt-out value", () => {
    delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];
    expect(isSourceFreshnessEnabled()).toBe(true);

    process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = "1";
    expect(isSourceFreshnessEnabled()).toBe(false);

    // Any other value leaves freshness on, so a stray "0"/"false" never reads as
    // an accidental disable.
    process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = "0";
    expect(isSourceFreshnessEnabled()).toBe(true);
    process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY] = "false";
    expect(isSourceFreshnessEnabled()).toBe(true);
  });
});

describe("createSystemPrompt grounding instructions gate", () => {
  test("includes source-grounding instructions for a repository update by default", () => {
    delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];

    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toContain("Source grounding:");
    expect(prompt).toContain("record_source_dependencies");
  });

  test("drops source-grounding instructions in the disabled control arm", () => {
    disableFreshness();

    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).not.toContain("Source grounding:");
    expect(prompt).not.toContain("record_source_dependencies");
    // The rest of the repository system prompt is unaffected: only the freshness
    // section is withheld.
    expect(prompt).toContain("Link integrity:");
  });
});

const STALE_PAGE = "openwiki/thing.md";
const STALE_PAGE_BYTES = "# Thing\n\n`greet` returns hello.\n";
const STALE_SOURCE = "src/thing.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/**
 * Builds a temp repo whose single grounded page has drifted from its source
 * while git stays quiet, so the only signal that the page is stale is the
 * recorded sidecar. Returns the repo path with HEAD recorded as the last-update
 * cursor.
 */
async function createRepoWithDrift(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "openwiki-toggle-"));
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  await writeFile(path.join(repo, "README.md"), "# Test Repo\n", "utf8");
  await mkdir(path.join(repo, "openwiki"));

  const sourceAbsolute = path.join(repo, STALE_SOURCE);
  await mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await writeFile(
    sourceAbsolute,
    'export function greet(): string {\n  return "hello";\n}\n',
    "utf8",
  );
  await writeFile(path.join(repo, STALE_PAGE), STALE_PAGE_BYTES, "utf8");

  const { sidecar } = await recordSourceDependencies({
    page: STALE_PAGE,
    pageBytes: STALE_PAGE_BYTES,
    requests: [{ path: STALE_SOURCE, symbol: "greet" }],
    resolver: new SourceResolver(createDefaultRegistry()),
    reader: new FileSystemSourceReader(repo),
  });
  await writeSidecarAtomic(repo, sidecar);

  // Drift the cited definition, then commit the drift alongside the sidecar that
  // fingerprinted the original. HEAD now holds a sidecar that mismatches its own
  // committed source, so git is quiet against the cursor and the only stale
  // signal is the recorded dependency.
  await writeFile(
    sourceAbsolute,
    'export function greet(): string {\n  return "goodbye";\n}\n',
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "record grounded page then drift source"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repo, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: new Date().toISOString(),
      command: "update",
      gitHead: head,
      model: "test-model",
    })}\n`,
    "utf8",
  );
  return repo;
}

describe("getUpdateNoopStatus freshness preflight gate", () => {
  test("surfaces the drifted page by default and forces a run", async () => {
    delete process.env[DISABLE_SOURCE_FRESHNESS_ENV_KEY];
    const repo = await createRepoWithDrift();

    const status = await getUpdateNoopStatus(repo);

    expect(status.shouldSkip).toBe(false);
    if (status.shouldSkip) {
      throw new Error("unreachable");
    }
    expect(status.stalePages.map((page) => page.page)).toEqual([STALE_PAGE]);
  });

  test("runs no preflight and skips the quiet run in the control arm", async () => {
    disableFreshness();
    const repo = await createRepoWithDrift();

    const status = await getUpdateNoopStatus(repo);

    // With freshness off, the drifted sidecar is never consulted, so git being
    // quiet collapses to a no-op: the run takes the skip branch, which carries
    // no stale-page list at all. This is the exact inverse of the default arm
    // above, which forced a run and surfaced the drifted page.
    expect(status.shouldSkip).toBe(true);
  });
});
