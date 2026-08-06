/**
 * Safe, fail-loud primitives for scenario `applyMutation` functions.
 *
 * Every scenario mutates real OpenWiki source inside a throwaway checkout. These
 * helpers make that surgery robust: string edits throw when their anchor is
 * missing or ambiguous (a silently skipped edit would produce a half-mutated
 * tree that quietly skews grading, spec section 27), and every path is a literal
 * repo-relative constant routed through {@link resolveWithin} so a mutation can
 * never escape the checkout it is handed (Corridor path-containment guardrail).
 * No shell, no dynamic path segments, no scenario/model/user string ever reaches
 * the filesystem here.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveWithin } from "../harness/repo.js";

/** Owner-only mode for files a mutation writes into the throwaway checkout. */
const NEW_FILE_MODE = 0o600;

/** Owner-only mode for directories a mutation creates in the checkout. */
const NEW_DIR_MODE = 0o700;

/**
 * Replace the single occurrence of `needle` in `haystack` with `replacement`,
 * matched as a literal substring (never a regex, so metacharacters are safe).
 * Throws when `needle` is absent or appears more than once, so an edit whose
 * anchor has drifted fails loudly instead of silently doing nothing or hitting
 * the wrong site.
 *
 * @param haystack - The text to edit.
 *
 * @param needle - The exact substring that must appear exactly once.
 *
 * @param replacement - The literal text to substitute in its place.
 */
export function replaceOnce(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const parts = haystack.split(needle);
  if (parts.length === 1) {
    throw new Error(`anchor not found: ${JSON.stringify(needle)}`);
  }
  if (parts.length > 2) {
    throw new Error(
      `anchor is ambiguous (${parts.length - 1} matches): ${JSON.stringify(needle)}`,
    );
  }
  return parts.join(replacement);
}

/**
 * Replace every occurrence of `needle` (literal substring) with `replacement`.
 * Throws when `needle` is absent, and when `expectedCount` is given and the
 * actual match count differs, so an edit that expected N identical sites and
 * found a different number fails loudly.
 *
 * @param haystack - The text to edit.
 *
 * @param needle - The exact substring to replace.
 *
 * @param replacement - The literal text to substitute for each match.
 *
 * @param expectedCount - The exact number of matches required.
 *
 * @default expectedCount undefined - accept any positive number of matches.
 */
export function replaceAll(
  haystack: string,
  needle: string,
  replacement: string,
  expectedCount?: number,
): string {
  const parts = haystack.split(needle);
  const matches = parts.length - 1;
  if (matches === 0) {
    throw new Error(`anchor not found: ${JSON.stringify(needle)}`);
  }
  if (expectedCount !== undefined && matches !== expectedCount) {
    throw new Error(
      `anchor matched ${matches} times, expected ${expectedCount}: ${JSON.stringify(needle)}`,
    );
  }
  return parts.join(replacement);
}

/**
 * Insert `insertion` immediately after the single occurrence of `anchor`. Throws
 * (via {@link replaceOnce}) when the anchor is missing or ambiguous.
 *
 * @param haystack - The text to edit.
 *
 * @param anchor - The exact substring the insertion is placed after.
 *
 * @param insertion - The literal text to insert.
 */
export function insertAfter(
  haystack: string,
  anchor: string,
  insertion: string,
): string {
  return replaceOnce(haystack, anchor, `${anchor}${insertion}`);
}

/**
 * Read the file at repo-relative `relPath` under `cwd`, apply `transform` to its
 * contents, and write the result back. Throws when `transform` returns the input
 * unchanged, so a mutation that matched nothing surfaces as an error rather than
 * a no-op edit.
 *
 * @param cwd - Absolute checkout root the mutation is confined to.
 *
 * @param relPath - Literal repo-relative POSIX path of the file to edit.
 *
 * @param transform - Pure function producing the new file contents.
 */
export async function editFile(
  cwd: string,
  relPath: string,
  transform: (content: string) => string,
): Promise<void> {
  const absolute = resolveWithin(cwd, relPath);
  const before = await readFile(absolute, "utf8");
  const after = transform(before);
  if (after === before) {
    throw new Error(`edit was a no-op: ${relPath}`);
  }
  await writeFile(absolute, after, "utf8");
}

/**
 * Write a new file at repo-relative `relPath` under `cwd`, creating parent
 * directories as needed. Fails when the file already exists, so a scenario that
 * means to add a module cannot silently overwrite an existing one.
 *
 * @param cwd - Absolute checkout root the mutation is confined to.
 *
 * @param relPath - Literal repo-relative POSIX path of the file to create.
 *
 * @param contents - The file body to write.
 */
export async function writeNewFile(
  cwd: string,
  relPath: string,
  contents: string,
): Promise<void> {
  const absolute = resolveWithin(cwd, relPath);
  await mkdir(dirname(absolute), { recursive: true, mode: NEW_DIR_MODE });
  await writeFile(absolute, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: NEW_FILE_MODE,
  });
}

/**
 * Delete the file at repo-relative `relPath` under `cwd`. Throws when the file is
 * missing, so a removal scenario whose target has moved fails loudly.
 *
 * @param cwd - Absolute checkout root the mutation is confined to.
 *
 * @param relPath - Literal repo-relative POSIX path of the file to delete.
 */
export async function deleteFile(cwd: string, relPath: string): Promise<void> {
  await rm(resolveWithin(cwd, relPath), { force: false });
}
