/**
 * The frozen baseline contract (spec sections 8, 27).
 *
 * The bootstrap (Phase 2) freezes an entire wiki state, its dependency
 * sidecars, and the source commit they were grounded in, then records a
 * manifest with a content hash over the frozen tree. Every trial seeds from this
 * exact state, so the runner verifies the checked-in baseline still hashes to the
 * manifest before spending any tokens: a hand-edited page or a stale sidecar is a
 * hard failure, not a silent skew between arms.
 *
 * The manifest is read defensively through hand-written narrowing rather than a
 * trusting cast, so a malformed or truncated file fails loudly here.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { SOURCE_DEPS_DIRECTORY } from "../../src/staleness/storage.js";
import { baselineWikiDir } from "./harness/repo.js";

/** Basename of the manifest inside a baseline directory. */
export const BASELINE_MANIFEST_FILE = "manifest.json";

/** Metadata the bootstrap records alongside the frozen baseline tree. */
export interface BaselineManifest {
  /** The corpus commit in the developer checkout the source was frozen at. */
  sourceCommit: string;

  /** ISO-8601 timestamp the baseline was frozen. */
  createdAt: string;

  /** The model id the bootstrap agent ran with while freezing the wiki. */
  agentModel: string;

  /** Number of Markdown wiki pages in the frozen tree. */
  pageCount: number;

  /** Number of dependency sidecar files under `.source-deps`. */
  sidecarCount: number;

  /**
   * Lowercase hex SHA-256 over the canonical serialization of every file under
   * the frozen `openwiki/` tree (pages and sidecars), computed by
   * {@link computeBaselineContentHash}.
   */
  contentHash: string;
}

/** A single file discovered under the frozen wiki tree. */
interface WikiTreeFile {
  /** Repo-relative POSIX path, for example `openwiki/architecture/overview.md`. */
  relativePath: string;

  /** Whether the file lives under `.source-deps`. */
  isSidecar: boolean;

  /** Absolute path on disk. */
  absolutePath: string;
}

/**
 * Enumerate every file under a baseline's `openwiki/` tree (pages and sidecars),
 * as sorted, repo-relative POSIX paths.
 *
 * @param baselineDir - The baseline root directory.
 */
async function listWikiTreeFiles(baselineDir: string): Promise<WikiTreeFile[]> {
  const wikiRoot = baselineWikiDir(baselineDir);
  const entries = await readdir(wikiRoot, {
    recursive: true,
    withFileTypes: true,
  });

  const files: WikiTreeFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const absolutePath = join(entry.parentPath, entry.name);
    const segments = relative(wikiRoot, absolutePath).split(sep);
    files.push({
      relativePath: `openwiki/${segments.join("/")}`,
      isSidecar: segments[0] === SOURCE_DEPS_DIRECTORY,
      absolutePath,
    });
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Compute the canonical content hash over a baseline's frozen wiki tree. The
 * digest binds each file's path, byte length, and bytes in sorted path order, so
 * any edit, addition, removal, or rename changes the hash.
 *
 * @param baselineDir - The baseline root directory.
 */
export async function computeBaselineContentHash(
  baselineDir: string,
): Promise<string> {
  const files = await listWikiTreeFiles(baselineDir);
  const hash = createHash("sha256");

  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }

  return hash.digest("hex");
}

/** Count the pages and sidecars in a baseline's frozen wiki tree. */
export async function countBaselineTree(
  baselineDir: string,
): Promise<{ pageCount: number; sidecarCount: number }> {
  const files = await listWikiTreeFiles(baselineDir);
  return {
    pageCount: files.filter(
      (file) => !file.isSidecar && file.relativePath.endsWith(".md"),
    ).length,
    sidecarCount: files.filter((file) => file.isSidecar).length,
  };
}

/** Narrows an unknown value to a plain record for defensive field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read a required string field from a parsed manifest, failing loudly when it is
 * missing or the wrong type.
 *
 * @param record - The parsed manifest record.
 *
 * @param key - The field name.
 */
function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `baseline manifest field ${key} must be a non-empty string`,
    );
  }
  return value;
}

/**
 * Read a required non-negative integer field from a parsed manifest.
 *
 * @param record - The parsed manifest record.
 *
 * @param key - The field name.
 */
function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `baseline manifest field ${key} must be a non-negative integer`,
    );
  }
  return value;
}

/**
 * Load and narrow the baseline manifest from `baselineDir`, throwing on any
 * malformed or missing field.
 *
 * @param baselineDir - The baseline root directory.
 */
export async function loadBaselineManifest(
  baselineDir: string,
): Promise<BaselineManifest> {
  const raw = await readFile(join(baselineDir, BASELINE_MANIFEST_FILE), "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `baseline manifest is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("baseline manifest must be a JSON object");
  }

  return {
    sourceCommit: requireString(parsed, "sourceCommit"),
    createdAt: requireString(parsed, "createdAt"),
    agentModel: requireString(parsed, "agentModel"),
    pageCount: requireCount(parsed, "pageCount"),
    sidecarCount: requireCount(parsed, "sidecarCount"),
    contentHash: requireString(parsed, "contentHash"),
  };
}

/**
 * Load the manifest and verify the frozen tree still matches it, returning the
 * manifest on success. Fails loudly on a content-hash or file-count mismatch,
 * which means the checked-in baseline was modified after it was frozen (spec
 * section 27: the eval must not run against a drifted baseline).
 *
 * @param baselineDir - The baseline root directory.
 */
export async function verifyBaseline(
  baselineDir: string,
): Promise<BaselineManifest> {
  const manifest = await loadBaselineManifest(baselineDir);

  const actualHash = await computeBaselineContentHash(baselineDir);
  if (actualHash !== manifest.contentHash) {
    throw new Error(
      `integrity: baseline content hash mismatch (manifest ${manifest.contentHash}, on disk ${actualHash}); the frozen baseline was modified after bootstrap`,
    );
  }

  const counts = await countBaselineTree(baselineDir);
  if (
    counts.pageCount !== manifest.pageCount ||
    counts.sidecarCount !== manifest.sidecarCount
  ) {
    throw new Error(
      `integrity: baseline tree counts drifted from the manifest (manifest ${manifest.pageCount} pages / ${manifest.sidecarCount} sidecars, on disk ${counts.pageCount} / ${counts.sidecarCount})`,
    );
  }

  return manifest;
}
