/**
 * Throwaway-repo plumbing for the source-freshness eval.
 *
 * Every trial runs the real update agent against a fresh temp git repo seeded
 * from the frozen baseline, so the developer checkout is never mutated. All git
 * and tar invocations use `execFile` with argument arrays (never a shell) and a
 * neutered ambient git config, per the project's command-injection guardrails.
 * Filesystem mutations only ever target paths built from the freshly created
 * temp directory joined with literal constants, never any scenario, model, or
 * user string.
 */

import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SOURCE_DEPS_DIRECTORY } from "../../../src/staleness/storage.js";
import type { EvalScenario } from "../scenarios/types.js";

const execFileAsync = promisify(execFile);

/** Basename of the temporary docs-impact plan file the agent writes and deletes. */
const TEMPORARY_PLAN_FILE = "_plan.md";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the `evals/source-freshness/` directory. */
export const EVAL_ROOT = join(HARNESS_DIR, "..");

/** Absolute path to the frozen baseline the bootstrap produces. */
export const DEFAULT_BASELINE_DIR = join(EVAL_ROOT, "baseline");

/**
 * The frozen baseline wiki directory (pages plus `.source-deps`) inside a
 * baseline directory.
 *
 * @param baselineDir - Baseline root.
 *
 * @default DEFAULT_BASELINE_DIR - the checked-in baseline.
 */
export function baselineWikiDir(baselineDir = DEFAULT_BASELINE_DIR): string {
  return join(baselineDir, "openwiki");
}

/**
 * Normalize an untrusted repo-relative path and reject any that is absolute,
 * empty, or contains a `..` traversal segment. Returns the cleaned POSIX
 * repo-relative form. Every scenario-supplied or otherwise dynamic path is run
 * through this before it is joined onto a real directory, so a path can never
 * escape the tree it is meant to address (Corridor path-containment guardrail).
 *
 * @param candidate - The repo-relative path to validate.
 */
export function normalizeRepoRelativePath(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("repo-relative path must be a non-empty string");
  }
  if (isAbsolute(candidate)) {
    throw new Error(`repo-relative path must not be absolute: ${candidate}`);
  }

  const segments = candidate
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error(`repo-relative path resolves to nothing: ${candidate}`);
  }
  if (segments.some((segment) => segment === "..")) {
    throw new Error(
      `repo-relative path escapes the repository root: ${candidate}`,
    );
  }

  return segments.join("/");
}

/**
 * Resolve `candidate` under `baseDir`, guaranteeing the result stays within
 * `baseDir`. Combines {@link normalizeRepoRelativePath} with a resolved-prefix
 * check so both traversal segments and symlink-style escapes are refused.
 *
 * @param baseDir - The absolute directory the result must remain inside.
 *
 * @param candidate - The repo-relative path to resolve.
 */
export function resolveWithin(baseDir: string, candidate: string): string {
  const safe = normalizeRepoRelativePath(candidate);
  const resolved = join(baseDir, safe);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes ${baseDir}: ${candidate}`);
  }
  return resolved;
}

/**
 * Run `git` in a directory with a deterministic identity and no ambient config,
 * returning trimmed stdout. Uses `execFile` with an argument array (never a
 * shell), per the project's command-injection guardrails.
 *
 * @param cwd - Working directory (a throwaway temp repo, or the read-only dev
 *   root for `git archive`).
 *
 * @param args - Git arguments, passed verbatim as an array.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.email=eval@openwiki.test",
      "-c",
      "user.name=OpenWiki Eval",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(
          tmpdir(),
          "openwiki-eval-nonexistent-gitconfig",
        ),
        GIT_CONFIG_SYSTEM: join(
          tmpdir(),
          "openwiki-eval-nonexistent-gitconfig",
        ),
      },
    },
  );

  return stdout.trim();
}

/**
 * Create a throwaway git repository directory, hand it to `build`, and remove it
 * afterwards no matter what. Temp state is contained under `os.tmpdir()`.
 *
 * @param build - Callback that receives the repository's absolute path.
 */
export async function withTempGitRepo<T>(
  build: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "owsf-git-"));
  try {
    return await build(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * True when `candidate` is the sidecar directory or lives inside it, relative to
 * `root`. Used to keep `.source-deps` out of the frozen-wiki page copy.
 *
 * @param candidate - Absolute path being considered for copy.
 *
 * @param root - Absolute root the relative comparison is anchored at.
 */
function isWithinSourceDeps(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === SOURCE_DEPS_DIRECTORY ||
    rel.startsWith(`${SOURCE_DEPS_DIRECTORY}${sep}`)
  );
}

/**
 * Materialize the committed source tree at `commit` from `devRoot` into the
 * empty `cwd`, without any git history. Archives to a temp tarball and extracts
 * with `tar`; nothing in `devRoot` is mutated and the extracted tree carries no
 * `.git`, so a trial repo can never reach back into the developer checkout.
 *
 * @param devRoot - The developer checkout to archive from (read-only).
 *
 * @param commit - The commit-ish whose tree is extracted.
 *
 * @param cwd - Destination directory (a fresh temp dir).
 */
async function extractSourceTree(
  devRoot: string,
  commit: string,
  cwd: string,
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "owsf-archive-"));
  const tarPath = join(scratch, "source.tar");
  try {
    await git(devRoot, ["archive", "--format=tar", "-o", tarPath, commit]);
    await execFileAsync("tar", ["-xf", tarPath, "-C", cwd]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Replace `cwd/openwiki` with the frozen baseline wiki pages, excluding the
 * dependency sidecars. Sidecars are injected per arm ({@link injectBaselineSidecars}),
 * never through this page copy, so the control arm's tree is sidecar-free from
 * the start.
 *
 * @param cwd - The trial repo root.
 *
 * @param baselineWiki - The frozen baseline wiki directory to copy from.
 */
async function layFrozenWikiPages(
  cwd: string,
  baselineWiki: string,
): Promise<void> {
  const dest = join(cwd, "openwiki");
  await rm(dest, { recursive: true, force: true });
  await cp(baselineWiki, dest, {
    recursive: true,
    filter: (source) => !isWithinSourceDeps(source, baselineWiki),
  });
}

/**
 * Write `openwiki/.last-update.json` pointing the freshness cursor at `gitHead`
 * and marking the previous run complete, so the update agent treats the frozen
 * baseline as the last good wiki and computes git drift as `gitHead..HEAD`.
 *
 * @param cwd - The trial repo root.
 *
 * @param gitHead - The frozen baseline commit the cursor points at.
 */
async function writeBaselineCursor(
  cwd: string,
  gitHead: string,
): Promise<void> {
  const payload = {
    updatedAt: new Date().toISOString(),
    command: "update",
    gitHead,
    model: "baseline",
    status: "complete",
  };
  await writeFile(
    join(cwd, "openwiki", ".last-update.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Copy the frozen baseline dependency sidecars into `cwd/openwiki/.source-deps`
 * as untracked working-tree files. Only the WITH arm calls this; the control arm
 * never receives the dependency graph in the working tree or in git history.
 *
 * @param cwd - The trial repo root.
 *
 * @param baselineWiki - The frozen baseline wiki directory whose sidecars are copied.
 */
export async function injectBaselineSidecars(
  cwd: string,
  baselineWiki: string,
): Promise<void> {
  await cp(
    join(baselineWiki, SOURCE_DEPS_DIRECTORY),
    join(cwd, "openwiki", SOURCE_DEPS_DIRECTORY),
    { recursive: true },
  );
}

/** Inputs for {@link seedTrialRepo}. */
export interface SeedTrialRepoOptions {
  /** The fresh temp repo directory to seed (from {@link withTempGitRepo}). */
  cwd: string;

  /** The developer checkout to archive the corpus from (read-only). */
  devRoot: string;

  /** The commit-ish in `devRoot` the frozen baseline source is taken from. */
  sourceCommit: string;

  /** The frozen baseline wiki directory (pages plus `.source-deps`). */
  baselineWiki: string;

  /** The scenario whose mutation becomes the trial's post-baseline commit. */
  scenario: EvalScenario;

  /**
   * Whether to inject the frozen sidecars after the mutation commit. `true` for
   * the WITH arm, `false` for the control arm.
   */
  includeSidecars: boolean;
}

/** The two commits that bound a seeded trial. */
export interface SeededTrial {
  /** The frozen baseline commit: source at `sourceCommit` plus the frozen wiki. */
  frozenCommit: string;

  /** The mutation commit: `frozenCommit` plus the scenario's source change. */
  mutationCommit: string;
}

/**
 * Seed a throwaway trial repo to the exact state an update run should see:
 *
 * 1. extract the corpus source at `sourceCommit` (no git history);
 * 2. lay the frozen baseline wiki pages over it;
 * 3. commit that as the frozen baseline and point the freshness cursor at it;
 * 4. apply the scenario mutation and commit it on top;
 * 5. for the WITH arm only, inject the frozen sidecars as untracked files.
 *
 * The result is byte-identical across arms on the non-sidecar tree (source plus
 * wiki prose); the presence or absence of `.source-deps` is the single intended
 * difference. Returns the two bounding commits so the run can be checked for
 * `frozenCommit..mutationCommit` drift.
 *
 * @param options - The seed inputs.
 */
export async function seedTrialRepo(
  options: SeedTrialRepoOptions,
): Promise<SeededTrial> {
  const {
    cwd,
    devRoot,
    sourceCommit,
    baselineWiki,
    scenario,
    includeSidecars,
  } = options;

  await extractSourceTree(devRoot, sourceCommit, cwd);
  await layFrozenWikiPages(cwd, baselineWiki);

  await git(cwd, ["init", "-q"]);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "frozen baseline: source + wiki"]);
  const frozenCommit = await git(cwd, ["rev-parse", "HEAD"]);

  await writeBaselineCursor(cwd, frozenCommit);

  await scenario.applyMutation(cwd);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", `scenario: ${scenario.id}`]);
  const mutationCommit = await git(cwd, ["rev-parse", "HEAD"]);

  if (includeSidecars) {
    await injectBaselineSidecars(cwd, baselineWiki);
  }

  return { frozenCommit, mutationCommit };
}

/** Inputs for {@link readMutatedSource}. */
export interface ReadMutatedSourceOptions {
  /** The developer checkout the corpus source is archived from (read-only). */
  devRoot: string;

  /** The commit-ish in `devRoot` the frozen baseline source is taken from. */
  sourceCommit: string;

  /** The scenario whose mutation is applied to the extracted source. */
  scenario: EvalScenario;

  /** Repo-relative POSIX paths whose post-mutation bytes should be read. */
  paths: string[];
}

/** Read the file at `absolutePath`, or return undefined when it does not exist. */
async function readFileOrUndefined(
  absolutePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Materialize the corpus source at `sourceCommit`, apply the scenario mutation
 * to it, and read the requested files' post-mutation bytes. Used to hand the
 * blinded judge ground-truth source evidence without running a full trial or
 * spending any tokens; the temporary tree is removed before returning.
 *
 * The mutation must touch source only (no git, no wiki), since this runs it
 * against a plain extracted tree with no `.git`. Each requested path is
 * contained under the temp root before being read.
 *
 * @param options - The dev root, commit, scenario, and paths to read.
 */
export async function readMutatedSource(
  options: ReadMutatedSourceOptions,
): Promise<Record<string, string | undefined>> {
  const { devRoot, sourceCommit, scenario, paths } = options;

  return withTempGitRepo(async (cwd) => {
    await extractSourceTree(devRoot, sourceCommit, cwd);
    await scenario.applyMutation(cwd);

    const sources: Record<string, string | undefined> = {};
    for (const path of paths) {
      sources[path] = await readFileOrUndefined(resolveWithin(cwd, path));
    }
    return sources;
  });
}

/**
 * Read every wiki page under `repoRoot/openwiki` into a map keyed by
 * repo-relative POSIX path (for example `openwiki/architecture/overview.md`).
 * Skips the temporary plan file and everything under `.source-deps`, so the
 * result is exactly the documentation pages a grader compares.
 *
 * Reused for both the frozen baseline ("before") and a trial's final wiki
 * ("after"), so the two share identical keys.
 *
 * @param repoRoot - A repository root containing an `openwiki/` directory.
 */
export async function readWikiPages(
  repoRoot: string,
): Promise<Record<string, string>> {
  const wikiRoot = join(repoRoot, "openwiki");
  const entries = await readdir(wikiRoot, {
    recursive: true,
    withFileTypes: true,
  });

  const pages: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const absolute = join(entry.parentPath, entry.name);
    const rel = relative(wikiRoot, absolute);
    const segments = rel.split(sep);
    if (
      segments[0] === SOURCE_DEPS_DIRECTORY ||
      entry.name === TEMPORARY_PLAN_FILE
    ) {
      continue;
    }

    pages[`openwiki/${segments.join("/")}`] = await readFile(absolute, "utf8");
  }

  return pages;
}
