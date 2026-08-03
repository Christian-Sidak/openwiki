import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OpenWikiIgnore } from "../openwiki-ignore.js";
import { isOpenWikiPath, runGit } from "../utils.js";

/**
 * Cheap repo overview the planner reasons from. No deep reading, no agent.
 */
export interface RepoSkeleton {
  /**
   * Every tracked file path (ignore-filtered). Ground truth for glob
   * validation.
   */
  trackedFiles: string[];

  /**
   * Directory tree with file counts, capped, for the prompt.
   */
  treeSummary: string;

  /**
   * Contents of the readme-ish and manifest-ish files, truncated per file.
   */
  keyFiles: string;
}

/**
 * Filenames worth showing the planner verbatim: manifests and readmes that
 * describe the repo's shape and purpose.
 */
const KEY_FILE_PATTERN =
  /(^|\/)(readme\.md|package\.json|pyproject\.toml|go\.mod|cargo\.toml|pom\.xml|makefile)$/i;

/**
 * Per-file byte cap when inlining a key file into the prompt.
 */
const KEY_FILE_MAX_BYTES = 4_000;

/**
 * Cap on directory-summary lines fed to the planner.
 */
const TREE_MAX_LINES = 200;

/**
 * Builds the skeleton from git's file list plus a handful of key files.
 */
export async function collectRepoSkeleton(
  cwd: string,
  ignore: OpenWikiIgnore,
): Promise<RepoSkeleton> {
  const trackedFiles = (await runGit(cwd, ["ls-files"]))
    .split("\n")
    .filter(Boolean)
    .filter((file) => !isOpenWikiPath(file) && !ignore.ignores(file));

  return {
    trackedFiles,
    treeSummary: summarizeTree(trackedFiles),
    keyFiles: await readKeyFiles(cwd, trackedFiles),
  };
}

/**
 * "src/api (14 files)" style rollup, two directory levels deep.
 */
export function summarizeTree(files: string[]): string {
  const counts = new Map<string, number>();

  for (const file of files) {
    const parts = file.split("/");
    const dir =
      parts.length > 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? ".");
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, TREE_MAX_LINES)
    .map(([dir, count]) => `${dir} (${count} files)`)
    .join("\n");
}

/**
 * Reads up to eight key files (truncated per file) into labeled blocks for the
 * planner prompt. Unreadable files are skipped, not fatal.
 */
async function readKeyFiles(cwd: string, files: string[]): Promise<string> {
  const keyPaths = files
    .filter((file) => KEY_FILE_PATTERN.test(file))
    .slice(0, 8);
  const blocks: string[] = [];

  for (const keyPath of keyPaths) {
    try {
      const content = await readFile(path.join(cwd, keyPath), "utf8");
      blocks.push(
        `--- ${keyPath} ---\n${content.slice(0, KEY_FILE_MAX_BYTES)}`,
      );
    } catch {
      // unreadable key files are skippable evidence, not errors
    }
  }

  return blocks.join("\n\n");
}
