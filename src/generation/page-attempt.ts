import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLAIMS_DIRECTORY,
  toClaimsSidecarRelativePath,
  toRepositoryPagePath,
} from "../claims/brains/code/paths.js";
import { OPEN_WIKI_DIR } from "../config/constants.js";
import { isFileNotFoundError } from "../platform/fs-errors.js";

/**
 * Recoverable byte snapshot for one native page-worker attempt.
 */
export interface RepositoryPageAttempt {
  /**
   * Restores the page and sidecar bytes captured before the attempt.
   */
  rollback(): Promise<void>;
}

/**
 * Captures the only publishable files a single page worker may mutate.
 *
 * @param root - Absolute repository root.
 * @param page - Canonical factual page assigned to the worker.
 * @returns Recoverable page and sidecar snapshot.
 */
export async function beginRepositoryPageAttempt(
  root: string,
  page: string,
): Promise<RepositoryPageAttempt> {
  if (!path.isAbsolute(root)) {
    throw new Error("Repository page attempt requires an absolute root.");
  }
  const pageFile = path.join(root, toRepositoryPagePath(page));
  const sidecarFile = path.join(
    root,
    OPEN_WIKI_DIR,
    CLAIMS_DIRECTORY,
    toClaimsSidecarRelativePath(page),
  );
  const [pageContent, sidecarContent] = await Promise.all([
    readOptionalFile(pageFile),
    readOptionalFile(sidecarFile),
  ]);
  let rolledBack = false;
  return {
    rollback: async () => {
      if (rolledBack) return;
      await restoreOptionalFile(pageFile, pageContent);
      await restoreOptionalFile(sidecarFile, sidecarContent);
      rolledBack = true;
    },
  };
}

/**
 * Reads exact file bytes without treating absence as failure.
 *
 * @param file - Absolute file path inside the repository.
 * @returns Existing bytes, or `null` when the file does not exist.
 */
async function readOptionalFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Restores one file to its exact pre-attempt state.
 *
 * @param file - Absolute file path inside the repository.
 * @param content - Original bytes, or `null` when the file was absent.
 */
async function restoreOptionalFile(
  file: string,
  content: Buffer | null,
): Promise<void> {
  if (content === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
