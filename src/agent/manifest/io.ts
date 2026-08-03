import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../../constants.js";
import { isFileNotFoundError } from "../../fs-errors.js";
import type { ManifestSection, OpenWikiManifest } from "./types.js";

/**
 * Filename of the manifest inside the wiki directory.
 */
const MANIFEST_FILENAME = ".manifest.json";

/**
 * Repo-relative manifest path, for git plumbing and status filtering.
 */
export const MANIFEST_REPO_PATH = `${OPEN_WIKI_DIR}/${MANIFEST_FILENAME}`;

/**
 * Absolute manifest path for a repo root.
 */
export function getManifestPath(cwd: string): string {
  return path.join(cwd, OPEN_WIKI_DIR, MANIFEST_FILENAME);
}

/**
 * A structurally invalid manifest fails loudly, listing every problem at
 * once.
 */
export class ManifestValidationError extends Error {
  override name = "ManifestValidationError";

  constructor(public readonly problems: string[]) {
    super(`Invalid OpenWiki manifest:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Reads and validates the manifest. Returns undefined when the file doesn't
 * exist (fresh init or pre-manifest wiki). Throws ManifestValidationError on a
 * bad hand edit rather than silently reconciling against garbage.
 */
export async function readManifest(
  cwd: string,
): Promise<OpenWikiManifest | undefined> {
  let raw: string;

  try {
    raw = await readFile(getManifestPath(cwd), "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  const problems = validateManifest(parsed);

  if (problems.length > 0) {
    throw new ManifestValidationError(problems);
  }

  return parsed as OpenWikiManifest;
}

/**
 * Atomic write (tmp + rename) so a crash mid-write can't leave half a
 * manifest, which would turn every later run into a validation failure.
 */
export async function writeManifest(
  cwd: string,
  manifest: OpenWikiManifest,
): Promise<void> {
  const file = getManifestPath(cwd);
  const tmp = `${file}.tmp-${process.pid}`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

/**
 * Structural validation only: shapes, uniqueness, sane values. Content checks
 * that need the repo (do globs match real files) live in the planner, which
 * is the layer that can fix them by re-asking the model.
 */
export function validateManifest(value: unknown): string[] {
  const problems: string[] = [];

  if (typeof value !== "object" || value === null) {
    return ["manifest is not an object"];
  }

  const manifest = value as Partial<OpenWikiManifest>;

  if (manifest.version !== 1) {
    problems.push(`unknown version: ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.sections)) {
    return [...problems, "sections is not an array"];
  }

  const seen = new Set<string>();

  manifest.sections.forEach((section, index) => {
    problems.push(...validateSection(section, index));

    if (typeof section?.path === "string") {
      if (seen.has(section.path)) {
        problems.push(`sections[${index}]: duplicate path "${section.path}"`);
      }
      seen.add(section.path);
    }
  });

  return problems;
}

/**
 * Validates one section entry's shape and values, prefixing each problem with
 * its array index. Split out so validateManifest reads as top-level shape plus
 * uniqueness, with per-entry rules living here.
 */
function validateSection(section: ManifestSection, index: number): string[] {
  const problems: string[] = [];
  const label = `sections[${index}]`;

  if (
    typeof section?.path !== "string" ||
    !/^[\w.-]+(\/[\w.-]+)*\/$/.test(section.path) ||
    section.path.includes("..")
  ) {
    problems.push(
      `${label}: path must be a relative dir with trailing slash and no ".." segments`,
    );
  }
  if (
    !Array.isArray(section?.sources) ||
    section.sources.length === 0 ||
    section.sources.some(
      (glob) =>
        typeof glob !== "string" ||
        glob.startsWith("/") ||
        glob.includes("..") ||
        glob.startsWith(`${OPEN_WIKI_DIR}/`),
    )
  ) {
    problems.push(
      `${label}: sources must be non-empty repo-relative globs outside ${OPEN_WIKI_DIR}/`,
    );
  }
  if (section?.head !== null && typeof section?.head !== "string") {
    problems.push(`${label}: head must be a commit sha or null`);
  }
  if (typeof section?.attempts !== "number" || section.attempts < 0) {
    problems.push(`${label}: attempts must be a non-negative number`);
  }

  return problems;
}
