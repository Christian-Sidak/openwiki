/**
 * Unit test for the frozen-baseline contract.
 *
 * Token-free: it builds a throwaway baseline directory on disk, writes a manifest
 * whose hash it computes from that tree, and asserts {@link verifyBaseline}
 * accepts the untouched baseline and fails loudly when a page is edited or the
 * file counts drift.
 */

import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_MANIFEST_FILE,
  computeBaselineContentHash,
  countBaselineTree,
  verifyBaseline,
} from "./baseline.js";

/**
 * Build a minimal baseline directory: two wiki pages and one sidecar, plus a
 * manifest whose hash and counts match the tree.
 *
 * @param root - The baseline root to populate.
 */
async function seedBaseline(root: string): Promise<void> {
  const wiki = join(root, "openwiki");
  await mkdir(join(wiki, "architecture"), { recursive: true });
  await mkdir(join(wiki, ".source-deps"), { recursive: true });
  await writeFile(join(wiki, "quickstart.md"), "# Quickstart\n", "utf8");
  await writeFile(
    join(wiki, "architecture", "overview.md"),
    "`greet` returns hello.\n",
    "utf8",
  );
  await writeFile(
    join(wiki, ".source-deps", "overview.json"),
    '{"page":"openwiki/architecture/overview.md"}\n',
    "utf8",
  );

  const counts = await countBaselineTree(root);
  const contentHash = await computeBaselineContentHash(root);
  await writeFile(
    join(root, BASELINE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        sourceCommit: "abc123",
        createdAt: "2026-08-05T00:00:00.000Z",
        agentModel: "test-model",
        pageCount: counts.pageCount,
        sidecarCount: counts.sidecarCount,
        contentHash,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** Run `body` with a freshly seeded baseline directory, cleaned up afterward. */
async function withBaseline(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "owsf-baseline-"));
  try {
    await seedBaseline(root);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("verifyBaseline", () => {
  test("counts the pages and sidecars separately", async () => {
    await withBaseline(async (root) => {
      expect(await countBaselineTree(root)).toEqual({
        pageCount: 2,
        sidecarCount: 1,
      });
    });
  });

  test("accepts an untouched baseline and returns the manifest", async () => {
    await withBaseline(async (root) => {
      const manifest = await verifyBaseline(root);
      expect(manifest.sourceCommit).toBe("abc123");
      expect(manifest.pageCount).toBe(2);
      expect(manifest.sidecarCount).toBe(1);
    });
  });

  test("fails when a page is edited after the manifest was written", async () => {
    await withBaseline(async (root) => {
      await writeFile(
        join(root, "openwiki", "architecture", "overview.md"),
        "`greet` returns goodbye.\n",
        "utf8",
      );
      await expect(verifyBaseline(root)).rejects.toThrow(
        /content hash mismatch/u,
      );
    });
  });

  test("fails when a page is added after the manifest was written", async () => {
    await withBaseline(async (root) => {
      await writeFile(join(root, "openwiki", "extra.md"), "new\n", "utf8");
      // A new file changes both the hash and the count; the hash is checked first.
      await expect(verifyBaseline(root)).rejects.toThrow(/integrity/u);
    });
  });
});
