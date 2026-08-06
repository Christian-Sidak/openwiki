/**
 * Persisted types, path mapping, and atomic sidecar storage for source-grounded
 * freshness.
 *
 * Each source-grounded wiki page has a JSON "sidecar" under
 * `openwiki/.source-deps/` that records the source definitions the page depends
 * on, together with the fingerprints used to decide whether those definitions
 * have changed. This module owns the persisted shape, the safe page/sidecar
 * path mapping, deterministic serialization, and atomic reads/writes. It never
 * parses source code; that is the resolver's job.
 */

import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { OPEN_WIKI_DIR } from "../constants.js";
import {
  isFileNotFoundError,
  isExpectedSnapshotRaceError,
} from "../fs-errors.js";

/**
 * Directory, relative to the OpenWiki content root, that holds dependency
 * sidecars.
 */
export const SOURCE_DEPS_DIRECTORY = ".source-deps";

/**
 * Current sidecar schema version. Bump when the persisted shape changes.
 */
export const SOURCE_DEPS_SCHEMA_VERSION = 1;

/**
 * The kind of definition a dependency points at. `file` is used for whole-file
 * dependencies where no symbol was resolved.
 */
export type SourceDependencyKind =
  | "class"
  | "function"
  | "interface"
  | "method"
  | "module"
  | "type"
  | "variable"
  | "file";

/**
 * Whether a dependency is tracked at symbol granularity or as the whole file.
 */
export type SourceResolution = "symbol" | "file";

/**
 * Hashing scheme that produced a {@link PersistedFingerprint}.
 *
 * - `page-bytes-v1`: hash of the whole wiki page bytes.
 * - `file-bytes-v1`: hash of the whole source file bytes.
 * - `tree-sitter-v1`: hash of a canonicalized definition subtree.
 */
export type FingerprintAlgorithm =
  "page-bytes-v1" | "file-bytes-v1" | "tree-sitter-v1";

/**
 * A single content fingerprint, tagged with the algorithm that produced it so
 * stored hashes stay comparable across schema and algorithm changes.
 */
export interface PersistedFingerprint {
  /**
   * Identifier of the hashing scheme that produced {@link value}.
   */
  algorithm: FingerprintAlgorithm;

  /**
   * The hash itself, formatted as `sha256:<hex>`.
   */
  value: string;
}

/**
 * One recorded source definition that a wiki page depends on, together with the
 * fingerprints used to decide whether it is still current.
 */
export interface PersistedSourceDependency {
  /**
   * Normalized repository-relative POSIX path to the source file.
   */
  path: string;

  /**
   * Whether this dependency is tracked at symbol granularity or as a whole file.
   */
  resolution: SourceResolution;

  /**
   * The kind of definition this dependency points at.
   */
  kind: SourceDependencyKind;

  /**
   * Qualified symbol name, for example `AuthService.authenticate`.
   *
   * @default undefined - the dependency is tracked at file level, so no symbol is recorded.
   */
  symbol?: string;

  /**
   * Cheap whole-file fingerprint, used as the first freshness check.
   */
  fileFingerprint: PersistedFingerprint;

  /**
   * Precise fingerprint of the canonicalized definition subtree.
   *
   * @default undefined - file-level tracking, so no symbol-level fingerprint exists.
   */
  definitionFingerprint?: PersistedFingerprint;
}

/**
 * The complete persisted sidecar for a single wiki page: the page fingerprint
 * plus every source dependency that supports it.
 */
export interface SourceDependencySidecar {
  /**
   * Schema version of this sidecar.
   */
  version: typeof SOURCE_DEPS_SCHEMA_VERSION;

  /**
   * Repository-relative POSIX path of the wiki page this sidecar describes.
   */
  page: string;

  /**
   * Fingerprint of the page bytes at the time dependencies were recorded.
   */
  pageFingerprint: PersistedFingerprint;

  /**
   * Recorded source dependencies, sorted by `path`, then `symbol ?? ""`, then
   * `kind`.
   */
  sources: PersistedSourceDependency[];
}

/**
 * Wiki file names that are generated navigation or operational artifacts rather
 * than source-grounded claims, and so never carry a sidecar.
 */
const EXCLUDED_PAGE_FILES = new Set([
  "index.md",
  "log.md",
  "_plan.md",
  "INSTRUCTIONS.md",
]);

/**
 * Computes a `sha256:<hex>` digest over UTF-8 text or raw bytes.
 *
 * @param data - The content to hash.
 *
 * @returns The digest string, prefixed with the algorithm name.
 */
function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * Fingerprints the raw bytes of a wiki page.
 *
 * @param bytes - The page's on-disk bytes.
 *
 * @returns A `page-bytes-v1` fingerprint.
 */
export function fingerprintPage(
  bytes: string | Uint8Array,
): PersistedFingerprint {
  return { algorithm: "page-bytes-v1", value: sha256(bytes) };
}

/**
 * Fingerprints the raw bytes of a source file.
 *
 * @param bytes - The source file's on-disk bytes.
 *
 * @returns A `file-bytes-v1` fingerprint.
 */
export function fingerprintFileBytes(
  bytes: string | Uint8Array,
): PersistedFingerprint {
  return { algorithm: "file-bytes-v1", value: sha256(bytes) };
}

/**
 * Fingerprints a canonicalized definition string.
 *
 * @param canonical - The canonical serialization of a definition subtree.
 *
 * @returns A `tree-sitter-v1` fingerprint.
 */
export function fingerprintDefinition(canonical: string): PersistedFingerprint {
  return { algorithm: "tree-sitter-v1", value: sha256(canonical) };
}

/**
 * Normalizes an untrusted path to a repository-relative POSIX path and rejects
 * anything that could escape the repository boundary.
 *
 * Rejects absolute paths, embedded NUL bytes, and any path that normalizes to a
 * location outside the repository (via `..`). This is the single choke point
 * for path safety on persisted source and page paths.
 *
 * @param rawPath - The untrusted path, in POSIX or Windows form.
 *
 * @returns The normalized repository-relative POSIX path.
 *
 * @throws If the path is absolute, contains a NUL byte, or escapes the repository.
 */
export function normalizeRepoRelativePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new Error("path contains a NUL byte");
  }

  const posix = rawPath.replace(/\\/gu, "/");

  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:/u.test(posix)) {
    throw new Error(`path must be repository-relative: ${rawPath}`);
  }

  const normalized = path.posix.normalize(posix).replace(/^\.\//u, "");

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "." ||
    normalized.length === 0
  ) {
    throw new Error(`path escapes the repository: ${rawPath}`);
  }

  return normalized;
}

/**
 * Returns whether a wiki page participates in source-grounded freshness
 * tracking. Generated navigation and operational files are excluded.
 *
 * @param page - Repository-relative POSIX path to the wiki page.
 *
 * @returns True when the page should carry a dependency sidecar.
 */
export function isSourceGroundedPage(page: string): boolean {
  const normalized = page.replace(/\\/gu, "/");

  if (!normalized.endsWith(".md")) {
    return false;
  }

  const relativeToWiki = normalized.startsWith(`${OPEN_WIKI_DIR}/`)
    ? normalized.slice(OPEN_WIKI_DIR.length + 1)
    : normalized;

  if (relativeToWiki.split("/").some((segment) => segment.startsWith("."))) {
    // Excludes everything under .source-deps/ and any other dot-directory.
    return false;
  }

  return !EXCLUDED_PAGE_FILES.has(path.posix.basename(normalized));
}

/**
 * Maps a wiki page path to its sidecar path on disk.
 *
 * `openwiki/architecture/authentication.md` maps to
 * `openwiki/.source-deps/architecture/authentication.json`.
 *
 * @param cwd - Absolute path to the repository root.
 * @param page - Repository-relative POSIX path to the wiki page.
 *
 * @returns The absolute path to the page's sidecar.
 *
 * @throws If the page is not inside the OpenWiki content root.
 */
export function sidecarPathForPage(cwd: string, page: string): string {
  const normalized = normalizeRepoRelativePath(page);

  if (
    normalized !== OPEN_WIKI_DIR &&
    !normalized.startsWith(`${OPEN_WIKI_DIR}/`)
  ) {
    throw new Error(`page is outside the OpenWiki directory: ${page}`);
  }

  const relativeToWiki = normalized.slice(OPEN_WIKI_DIR.length + 1);
  const sidecarRelative = relativeToWiki.replace(/\.md$/u, ".json");

  return path.join(
    cwd,
    OPEN_WIKI_DIR,
    SOURCE_DEPS_DIRECTORY,
    ...sidecarRelative.split("/"),
  );
}

/**
 * Serializes a sidecar to deterministic two-space JSON with a trailing newline.
 *
 * Dependencies are sorted by `path`, then `symbol ?? ""`, then `kind`, so that
 * identical inputs always produce byte-identical output. No timestamps are
 * stored.
 *
 * @param sidecar - The sidecar to serialize.
 *
 * @returns The canonical JSON text.
 */
export function serializeSidecar(sidecar: SourceDependencySidecar): string {
  const sortedSources = [...sidecar.sources].sort((left, right) => {
    return (
      left.path.localeCompare(right.path) ||
      (left.symbol ?? "").localeCompare(right.symbol ?? "") ||
      left.kind.localeCompare(right.kind)
    );
  });

  const ordered: SourceDependencySidecar = {
    version: sidecar.version,
    page: sidecar.page,
    pageFingerprint: sidecar.pageFingerprint,
    sources: sortedSources,
  };

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Validates a parsed JSON value as a {@link SourceDependencySidecar}.
 *
 * Mirrors the repository's hand-written narrowing convention (see
 * `readLastUpdate`): structural checks over `unknown`, returning `undefined`
 * rather than throwing on malformed input.
 *
 * @param value - The parsed JSON value.
 * @param expectedPage - The page the sidecar is expected to describe.
 *
 * @returns The validated sidecar, or `undefined` if malformed or mismatched.
 */
function parseSidecar(
  value: unknown,
  expectedPage: string,
): SourceDependencySidecar | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Partial<SourceDependencySidecar>;

  if (
    candidate.version !== SOURCE_DEPS_SCHEMA_VERSION ||
    candidate.page !== expectedPage ||
    !isFingerprint(candidate.pageFingerprint) ||
    !Array.isArray(candidate.sources)
  ) {
    return undefined;
  }

  const sources: PersistedSourceDependency[] = [];

  for (const raw of candidate.sources) {
    const dependency = parseDependency(raw);

    if (!dependency) {
      return undefined;
    }

    sources.push(dependency);
  }

  return {
    version: SOURCE_DEPS_SCHEMA_VERSION,
    page: candidate.page,
    pageFingerprint: candidate.pageFingerprint,
    sources,
  };
}

/**
 * Narrows an unknown value to a {@link PersistedFingerprint}.
 *
 * @param value - The value to check.
 *
 * @returns True when the value is a well-formed fingerprint.
 */
function isFingerprint(value: unknown): value is PersistedFingerprint {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PersistedFingerprint>;

  return (
    (candidate.algorithm === "page-bytes-v1" ||
      candidate.algorithm === "file-bytes-v1" ||
      candidate.algorithm === "tree-sitter-v1") &&
    typeof candidate.value === "string"
  );
}

/**
 * Narrows an unknown value to a {@link PersistedSourceDependency}.
 *
 * @param value - The value to check.
 *
 * @returns The validated dependency, or `undefined` if malformed.
 */
function parseDependency(
  value: unknown,
): PersistedSourceDependency | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Partial<PersistedSourceDependency>;

  if (
    typeof candidate.path !== "string" ||
    (candidate.resolution !== "symbol" && candidate.resolution !== "file") ||
    typeof candidate.kind !== "string" ||
    !isFingerprint(candidate.fileFingerprint)
  ) {
    return undefined;
  }

  if (candidate.symbol !== undefined && typeof candidate.symbol !== "string") {
    return undefined;
  }

  if (
    candidate.definitionFingerprint !== undefined &&
    !isFingerprint(candidate.definitionFingerprint)
  ) {
    return undefined;
  }

  return {
    path: candidate.path,
    resolution: candidate.resolution,
    kind: candidate.kind,
    symbol: candidate.symbol,
    fileFingerprint: candidate.fileFingerprint,
    definitionFingerprint: candidate.definitionFingerprint,
  };
}

/**
 * Reads and validates a page's sidecar from disk.
 *
 * A missing or malformed sidecar, or one that describes a different page,
 * returns `undefined` (the page will be treated as unverified). Unexpected
 * permission and filesystem errors are allowed to escape.
 *
 * @param cwd - Absolute path to the repository root.
 * @param page - Repository-relative POSIX path to the wiki page.
 *
 * @returns The validated sidecar, or `undefined`.
 */
export async function readSidecar(
  cwd: string,
  page: string,
): Promise<SourceDependencySidecar | undefined> {
  const sidecarPath = sidecarPathForPage(cwd, page);

  let raw: string;

  try {
    raw = await readFile(sidecarPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }

  try {
    return parseSidecar(JSON.parse(raw), page);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }
}

/**
 * Writes a sidecar atomically: serialize, write to a unique sibling temp file,
 * then `rename()` into place so a reader never observes a partial file.
 *
 * @param cwd - Absolute path to the repository root.
 * @param sidecar - The sidecar to persist.
 *
 * @returns The absolute path the sidecar was written to.
 */
export async function writeSidecarAtomic(
  cwd: string,
  sidecar: SourceDependencySidecar,
): Promise<string> {
  const sidecarPath = sidecarPathForPage(cwd, sidecar.page);

  await mkdir(path.dirname(sidecarPath), { recursive: true });

  const tmpPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(tmpPath, serializeSidecar(sidecar), "utf8");
  await rename(tmpPath, sidecarPath);

  return sidecarPath;
}

/**
 * Recursively lists every source-grounded wiki page under the OpenWiki content
 * root, as repository-relative POSIX paths.
 *
 * Symlinked entries are skipped (a symlink dirent is neither a file nor a
 * directory), so the walk cannot follow a link outside the wiki.
 *
 * @param cwd - Absolute path to the repository root.
 *
 * @returns Sorted repository-relative page paths.
 */
export async function listSourceGroundedPages(cwd: string): Promise<string[]> {
  const wikiRoot = path.join(cwd, OPEN_WIKI_DIR);
  const pages: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isExpectedSnapshotRaceError(error)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) {
          await walk(absolute);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const page = path.relative(cwd, absolute).split(path.sep).join("/");

      if (isSourceGroundedPage(page)) {
        pages.push(page);
      }
    }
  };

  await walk(wikiRoot);

  return pages.sort((left, right) => left.localeCompare(right));
}

/**
 * Removes sidecars whose corresponding wiki page no longer exists.
 *
 * @param cwd - Absolute path to the repository root.
 * @param livePages - Repository-relative paths of pages that currently exist.
 *
 * @returns Repository-relative paths of the sidecars that were removed.
 */
export async function removeOrphanSidecars(
  cwd: string,
  livePages: readonly string[],
): Promise<string[]> {
  const sidecarRoot = path.join(cwd, OPEN_WIKI_DIR, SOURCE_DEPS_DIRECTORY);
  const livePageSet = new Set(livePages);
  const removed: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isExpectedSnapshotRaceError(error)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(absolute);

        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const page = sidecarPathToPage(cwd, absolute);

      if (!livePageSet.has(page)) {
        await rm(absolute, { force: true });
        removed.push(page);
      }
    }
  };

  await walk(sidecarRoot);

  return removed.sort((left, right) => left.localeCompare(right));
}

/**
 * Inverts {@link sidecarPathForPage}: maps an absolute sidecar path back to the
 * wiki page it describes.
 *
 * @param cwd - Absolute path to the repository root.
 * @param sidecarPath - Absolute path to the sidecar file.
 *
 * @returns The repository-relative POSIX path of the wiki page.
 */
function sidecarPathToPage(cwd: string, sidecarPath: string): string {
  const sidecarRoot = path.join(cwd, OPEN_WIKI_DIR, SOURCE_DEPS_DIRECTORY);
  const relative = path
    .relative(sidecarRoot, sidecarPath)
    .split(path.sep)
    .join("/");
  const pageRelative = relative.replace(/\.json$/u, ".md");

  return `${OPEN_WIKI_DIR}/${pageRelative}`;
}
