import type { OpenWikiIgnore } from "../openwiki-ignore.js";
import { isOpenWikiPath, runGitStrict } from "../utils.js";

/**
 * Everything reconcile needs to know about the repo, gathered once per run.
 * `runHead` is pinned here and used for every pointer advance in the run:
 * advancing to a later "current" HEAD would claim sections cover commits
 * their units never saw.
 *
 * Every call that feeds a verdict uses runGitStrict: an empty diff means
 * "git verified nothing changed", never "git errored and we ate it". A
 * throw here (missing section head after a rebase or shallow clone) aborts
 * the run loudly; 0.8's guard catches the common cause before we get here.
 */
export interface RepoEvidence {
  /**
   * HEAD at run start. The only commit pointers may advance to.
   */
  runHead: string;

  /**
   * Uncommitted changes (staged, unstaged, untracked), repo-relative.
   */
  dirtyPaths: string[];

  /**
   * changedSince(head): committed changes in head..runHead plus dirtyPaths.
   */
  changedSince: (head: string) => Promise<string[]>;
}

/**
 * Builds the evidence bundle. Throws when the repo has no HEAD (empty repo).
 */
export async function gatherRepoEvidence(
  cwd: string,
  ignore: OpenWikiIgnore,
): Promise<RepoEvidence> {
  // runGitStrict, not runGit: a failed rev-parse must throw, not hand back
  // stderr text that would pass a truthiness check and become the "head".
  let runHead: string;

  try {
    runHead = await runGitStrict(cwd, ["rev-parse", "HEAD"]);
  } catch {
    throw new Error("Cannot reconcile: repository has no commits.");
  }

  const dirtyPaths = filterPaths(await getDirtyPaths(cwd), ignore);
  const diffCache = new Map<string, string[]>();

  return {
    runHead,
    dirtyPaths,
    changedSince: async (head) => {
      const cached = diffCache.get(head);
      if (cached) {
        return cached;
      }

      const committed = filterPaths(
        await getCommittedChanges(cwd, head, runHead),
        ignore,
      );
      const merged = [...new Set([...committed, ...dirtyPaths])];
      diffCache.set(head, merged);
      return merged;
    },
  };
}

/**
 * Committed path changes between two commits. --name-status rather than
 * --name-only so renames contribute both sides: the old path can mark a
 * section stale (its file left) and the new path can be unclaimed.
 */
async function getCommittedChanges(
  cwd: string,
  from: string,
  to: string,
): Promise<string[]> {
  const output = await runGitStrict(cwd, [
    "diff",
    "--name-status",
    "-M",
    from,
    to,
  ]);

  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => line.split("\t").slice(1));
}

/**
 * Worktree changes from `git status --porcelain`, both sides of renames.
 */
async function getDirtyPaths(cwd: string): Promise<string[]> {
  const output = await runGitStrict(cwd, ["status", "--porcelain"]);

  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => line.slice(3).split(" -> "));
}

/**
 * Drops wiki-internal paths and ignored paths; neither is documentation
 * evidence.
 */
function filterPaths(paths: string[], ignore: OpenWikiIgnore): string[] {
  return paths.filter((path) => !isOpenWikiPath(path) && !ignore.ignores(path));
}
