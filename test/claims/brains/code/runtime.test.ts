import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../../../src/agent/openwiki-ignore.ts";
import { prepareClaimsRuntime } from "../../../../src/claims/brains/code/runtime.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";

describe("prepareClaimsRuntime", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-runtime-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Writes one generated Markdown page.
   *
   * @param page - Virtual generated-page path.
   * @param content - Complete Markdown contents.
   */
  async function writePage(page: string, content: string): Promise<void> {
    const absolute = path.join(rootDir, page.replace(/^\/+/u, ""));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  test("disables Claims for chat and personal-brain runs", async () => {
    const ignore = new OpenWikiIgnore([]);

    await expect(
      prepareClaimsRuntime("chat", "repository", rootDir, ignore),
    ).resolves.toBeUndefined();
    await expect(
      prepareClaimsRuntime("init", "local-wiki", rootDir, ignore),
    ).resolves.toBeUndefined();
    await expect(
      prepareClaimsRuntime("update", "local-wiki", rootDir, ignore),
    ).resolves.toBeUndefined();
  });

  test("starts init with empty working state and inventories old sidecars", async () => {
    const orphanPage = "/openwiki/old.md";
    const store = new ClaimsStore(rootDir);
    await store.writePage(orphanPage, {
      schemaVersion: 1,
      pageVersion: `sha256:${"a".repeat(64)}`,
      claims: [],
    });

    const runtime = await prepareClaimsRuntime(
      "init",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
    await runtime?.finalize();
    await expect(store.loadPage(orphanPage)).resolves.toBeNull();
  });

  test("does not seed mandatory work for pages without sidecars", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
    expect(runtime?.session.inspectClaims(page)).toEqual([]);
  });

  test("loads synchronized persisted claims into update working state", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    const pageClaims = {
      schemaVersion: 1 as const,
      pageVersion: await store.hashPage(page),
      claims: [
        {
          id: "claim_existing",
          statement: "The page exists.",
          evidence: [
            {
              resource: "repo://package.json",
              version: "repo-file-v1:sha256:old",
            },
          ],
        },
      ],
    };
    await store.writePage(page, pageClaims);

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(1);
    expect(runtime?.session.inspectClaims(page)).toEqual([
      {
        id: "claim_existing",
        statement: "The page exists.",
        evidence: ["repo://package.json"],
        issue: {
          kind: "unresolved",
          resources: ["repo://package.json"],
        },
      },
    ]);
  });

  test("reports zero lazy issues for fresh persisted Claims", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(page, {
      schemaVersion: 1,
      pageVersion: await store.hashPage(page),
      claims: [],
    });

    const runtime = await prepareClaimsRuntime(
      "update",
      "repository",
      rootDir,
      new OpenWikiIgnore([]),
    );

    expect(runtime?.issueCount).toBe(0);
  });
});
