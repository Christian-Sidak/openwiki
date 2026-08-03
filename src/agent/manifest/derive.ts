import type { UpdateRunStatus } from "../types.js";
import { runGitCheck } from "../utils.js";
import type { OpenWikiManifest } from "./types.js";

/**
 * The floor: the section head that is an ancestor of every other head,
 * meaning "every non-abandoned section is documented at least as of this
 * commit". Returns undefined when there is no floor (a null head, an unknown
 * commit after a rebase, or diverged heads), which callers treat as
 * "re-verify everything". A too-old or missing floor only ever causes extra
 * checking, never missed work.
 */
export async function computeFloor(
  cwd: string,
  manifest: OpenWikiManifest,
): Promise<string | undefined> {
  const heads = manifest.sections
    .filter((section) => !section.abandoned)
    .map((section) => section.head);

  if (heads.length === 0 || heads.some((head) => head === null)) {
    return undefined;
  }

  const unique = [...new Set(heads as string[])];

  for (const head of unique) {
    const exists = await runGitCheck(cwd, [
      "cat-file",
      "-e",
      `${head}^{commit}`,
    ]);
    if (!exists) {
      return undefined;
    }
  }

  let floor = unique[0];

  for (const head of unique.slice(1)) {
    if (await runGitCheck(cwd, ["merge-base", "--is-ancestor", head, floor])) {
      floor = head;
    } else if (
      !(await runGitCheck(cwd, ["merge-base", "--is-ancestor", floor, head]))
    ) {
      // Diverged: neither is an ancestor of the other. V1 punts.
      return undefined;
    }
  }

  return floor;
}

/**
 * The stamp fields the manifest determines. The receipt, never authored.
 */
export interface DerivedStamp {
  status: Extract<UpdateRunStatus, "complete" | "partial">;

  /**
   * The floor.
   *
   * @default undefined — some section is missing: no floor, nothing may treat
   * the wiki as current
   */
  gitHead?: string;

  /**
   * Abandoned section paths, surfaced for the CLI and the PR body.
   *
   * @default undefined — no sections are abandoned
   */
  abandoned?: string[];
}

/**
 * Derives stamp fields from the manifest. `partial` when any non-abandoned
 * section has never been written; abandoned sections are excluded from both
 * the floor and the partial test so one hopeless section can't pin the wiki.
 */
export async function deriveStamp(
  cwd: string,
  manifest: OpenWikiManifest,
): Promise<DerivedStamp> {
  const active = manifest.sections.filter((section) => !section.abandoned);
  const abandoned = manifest.sections
    .filter((section) => section.abandoned)
    .map((section) => section.path);
  const partial = active.some((section) => section.head === null);
  const floor = partial ? undefined : await computeFloor(cwd, manifest);

  return {
    status: partial ? "partial" : "complete",
    ...(floor ? { gitHead: floor } : {}),
    ...(abandoned.length > 0 ? { abandoned } : {}),
  };
}
