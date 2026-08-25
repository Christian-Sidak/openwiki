import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CLAIMS_DIRECTORY,
  toClaimsSidecarRelativePath,
  toRepositoryPagePath,
} from "../../src/claims/brains/code/paths.ts";
import { beginRepositoryPageAttempt } from "../../src/generation/page-attempt.ts";

const PAGE = "/openwiki/guides/page.md";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwiki-page-attempt-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Resolves the test page and Claims sidecar below the temporary repository.
 *
 * @returns Absolute page and sidecar paths.
 */
function attemptFiles(): { page: string; sidecar: string } {
  return {
    page: path.join(root, toRepositoryPagePath(PAGE)),
    sidecar: path.join(
      root,
      "openwiki",
      CLAIMS_DIRECTORY,
      toClaimsSidecarRelativePath(PAGE),
    ),
  };
}

describe("repository page attempts", () => {
  test("restores existing Markdown and sidecar bytes exactly", async () => {
    const files = attemptFiles();
    const originalPage = Buffer.from([
      0x23, 0x20, 0x50, 0x61, 0x67, 0x65, 0x0a,
    ]);
    const originalSidecar = Buffer.from([0x7b, 0x7d, 0x0a, 0x00]);
    await mkdir(path.dirname(files.page), { recursive: true });
    await mkdir(path.dirname(files.sidecar), { recursive: true });
    await writeFile(files.page, originalPage);
    await writeFile(files.sidecar, originalSidecar);
    const attempt = await beginRepositoryPageAttempt(root, PAGE);

    await writeFile(files.page, "changed page\n");
    await writeFile(files.sidecar, "changed sidecar\n");
    await attempt.rollback();
    await attempt.rollback();

    await expect(readFile(files.page)).resolves.toEqual(originalPage);
    await expect(readFile(files.sidecar)).resolves.toEqual(originalSidecar);
  });

  test("removes files created by a failed new-page worker", async () => {
    const files = attemptFiles();
    const attempt = await beginRepositoryPageAttempt(root, PAGE);
    await mkdir(path.dirname(files.page), { recursive: true });
    await mkdir(path.dirname(files.sidecar), { recursive: true });
    await writeFile(files.page, "new page\n");
    await writeFile(files.sidecar, "new sidecar\n");

    await attempt.rollback();

    await expect(readFile(files.page)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(files.sidecar)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects unsafe roots and non-factual page paths", async () => {
    await expect(beginRepositoryPageAttempt("relative", PAGE)).rejects.toThrow(
      "requires an absolute root",
    );
    await expect(
      beginRepositoryPageAttempt(root, "/openwiki/index.md"),
    ).rejects.toThrow("reserved or structural");
    await expect(
      beginRepositoryPageAttempt(root, "/openwiki/../outside.md"),
    ).rejects.toThrow("traversal segments");
  });
});
