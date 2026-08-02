import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OPEN_WIKI_DIR, UPDATE_METADATA_PATH } from "../constants.js";
import {
  isExpectedSnapshotRaceError,
  isFileNotFoundError,
} from "../fs-errors.js";
import { resolveLanguage } from "../language.js";
import {
  readOpenWikiOnboardingConfig,
  readRepositoryWikiInstructions,
} from "../onboarding.js";
import { OpenWikiIgnore } from "./openwiki-ignore.js";
import type {
  OpenWikiCommand,
  OpenWikiOutputMode,
  OpenWikiRunOptions,
  RunContext,
  UpdateMetadata,
  UpdateRunStatus,
} from "./types.js";
import type { Dirent } from "node:fs";

const execFileAsync = promisify(execFile);
const LOCAL_WIKI_METADATA_PATH = ".last-update.json";
const TEMPORARY_PLAN_FILE = "_plan.md";

export type OpenWikiContentSnapshot = string;

export type UpdateNoopStatus =
  | {
      shouldSkip: true;
      gitHead: string;
      model: string;
    }
  | {
      shouldSkip: false;
      reason: string;
    };

/**
 * Builds the per-run context the prompt uses to reason about prior docs and git changes.
 *
 * Paths excluded by `openWikiIgnore` are stripped from the git evidence so the
 * agent never sees changes under an ignored path.
 */
export async function createRunContext(
  command: OpenWikiCommand,
  cwd: string,
  outputMode: OpenWikiOutputMode = "repository",
  language?: string | null,
  openWikiIgnore = new OpenWikiIgnore([]),
): Promise<RunContext> {
  const lastUpdate = await readLastUpdate(cwd, outputMode);
  // A validated flag wins; otherwise inherit the wiki's persisted language so an
  // update without --language keeps the existing wiki consistent instead of
  // producing a mix of the old and new language.
  const requestedLanguage = resolveLanguage(language).language;
  // English is materialized as "en" rather than encoded by an absent key, so the
  // wiki's language is always explicit in metadata and every run inherits a
  // concrete value.
  const effectiveLanguage = requestedLanguage ?? lastUpdate?.language ?? "en";
  const languageContext = { language: effectiveLanguage };
  const wikiGoal = await readRunWikiGoal(cwd, outputMode);

  if (command === "chat") {
    return {
      lastUpdate,
      gitSummary: "Not applicable for chat.",
      ...languageContext,
      wikiGoal,
    };
  }

  if (outputMode === "local-wiki") {
    return {
      lastUpdate,
      gitSummary:
        "Local wiki mode: connector source evidence is provided through raw data paths and OpenWiki connector tools. Git repository diff context is not used for this run.",
      ...languageContext,
      wikiGoal,
    };
  }

  return {
    lastUpdate,
    gitSummary: await createGitSummary(
      command,
      cwd,
      lastUpdate,
      openWikiIgnore,
    ),
    ...languageContext,
    wikiGoal,
  };
}

async function readRunWikiGoal(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<string | undefined> {
  if (outputMode === "repository") {
    return readRepositoryWikiInstructions(cwd);
  }

  return (await readOpenWikiOnboardingConfig()).wikiGoal;
}

/**
 * Decides whether an `update` run can be skipped because nothing meaningful changed.
 *
 * Working-tree and committed changes that only touch `openwiki/` or paths
 * excluded by `openWikiIgnore` do not count as meaningful, so an ignored path
 * changing on its own never forces a rebuild.
 */
export async function getUpdateNoopStatus(
  cwd: string,
  openWikiIgnore = new OpenWikiIgnore([]),
): Promise<UpdateNoopStatus> {
  const lastUpdate = await readLastUpdate(cwd, "repository");

  if (!lastUpdate?.gitHead) {
    return { shouldSkip: false, reason: "missing previous update git head" };
  }

  if (lastUpdate.status === "interrupted") {
    return { shouldSkip: false, reason: "previous update was interrupted" };
  }

  const head = await getGitHead(cwd);

  if (!head) {
    return { shouldSkip: false, reason: "missing current git head" };
  }

  const status = await runGit(cwd, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  const meaningfulStatus = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isUpdateMetadataStatusLine(line))
    .filter((line) => !lineReferencesIgnoredPath(line, openWikiIgnore));

  if (meaningfulStatus.length > 0) {
    return { shouldSkip: false, reason: "worktree has changes" };
  }

  if (head !== lastUpdate.gitHead) {
    const committedPaths = await getChangedPathsSinceLastUpdate(
      cwd,
      lastUpdate.gitHead,
    );

    if (
      committedPaths.length === 0 ||
      committedPaths.some(
        (changedPath) =>
          !isOpenWikiPath(changedPath) && !openWikiIgnore.ignores(changedPath),
      )
    ) {
      return { shouldSkip: false, reason: "git head changed" };
    }
  }

  return {
    shouldSkip: true,
    gitHead: head,
    model: lastUpdate.model,
  };
}

export function shouldCheckUpdateNoop(options: OpenWikiRunOptions): boolean {
  return !options.userMessage?.trim();
}

/**
 * Records an init/update run so future updates can diff from this git head.
 * Interrupted runs are recorded with status "interrupted" so the update
 * no-op check knows the wiki may be partial and does not skip the retry.
 */
export async function writeLastUpdateMetadata(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode = "repository",
  status: UpdateRunStatus = "complete",
  language?: string,
): Promise<void> {
  const metadataFile = getMetadataFilePath(cwd, outputMode);
  // An interrupted run must not advance the verified head. It reads back the
  // prior stamp and keeps that head so the retry re-sweeps the full window the
  // dead run was processing; advancing here would drop the unprocessed commits
  // out of the next diff forever.
  const previous =
    status === "interrupted" ? await readLastUpdate(cwd, outputMode) : null;
  const metadata: UpdateMetadata = {
    updatedAt: new Date().toISOString(),
    command,
    // Falls back to the current head when there is no prior stamp (a first init
    // that died before ever recording one).
    gitHead:
      outputMode === "repository"
        ? (previous?.gitHead ?? (await getGitHead(cwd)))
        : undefined,
    model: modelId,
    status,
    ...(language ? { language } : {}),
  };

  await mkdir(path.dirname(metadataFile), { recursive: true });
  await writeFile(
    metadataFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Persists run metadata after a run ends. Returns whether metadata was written.
 *
 * An interrupted run always writes its stamp so the next update sees status
 * "interrupted" and retries. A completed run writes only when content changed
 * since the given snapshot (or to clear a prior interrupted status), which keeps
 * repeating no-op runs from churning the stamp. Chat runs never write.
 */
export async function persistRunMetadataIfChanged(
  command: OpenWikiCommand,
  cwd: string,
  modelId: string,
  outputMode: OpenWikiOutputMode,
  snapshotBefore: OpenWikiContentSnapshot | null,
  status: UpdateRunStatus = "complete",
  language?: string,
): Promise<boolean> {
  if (command === "chat") {
    return false;
  }

  // An interrupted run is always recorded, even when it produced no new content
  // yet (the earliest, most dangerous interrupt: an empty or partial wiki). The
  // stamp is the record that the last attempt did not finish, so the next
  // update sees status "interrupted" and retries instead of trusting the wiki.
  // Only a completed run takes the unchanged-content skip, which exists to avoid
  // spurious .last-update.json churn on repeating no-op runs.
  if (status === "complete") {
    if (snapshotBefore === null) {
      return false;
    }

    if (
      snapshotBefore === (await createOpenWikiContentSnapshot(cwd, outputMode))
    ) {
      // A completed run still rewrites when it clears a previous interrupted
      // status, so the update no-op check can skip again.
      const lastUpdate = await readLastUpdate(cwd, outputMode);
      if (lastUpdate?.status !== "interrupted") {
        return false;
      }
    }
  }

  await writeLastUpdateMetadata(
    command,
    cwd,
    modelId,
    outputMode,
    status,
    language,
  );

  return true;
}

/**
 * Removes the temporary planning file the agent creates during init/update runs.
 */
export async function removeTemporaryPlanFile(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<boolean> {
  const planFile = getTemporaryPlanFilePath(cwd, outputMode);

  try {
    await rm(planFile);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Hashes OpenWiki content, excluding run metadata, to detect real documentation changes.
 */
export async function createOpenWikiContentSnapshot(
  cwd: string,
  outputMode: OpenWikiOutputMode = "repository",
): Promise<OpenWikiContentSnapshot> {
  const openWikiDir = getWikiContentRoot(cwd, outputMode);
  const hash = createHash("sha256");

  await addDirectoryToSnapshot(hash, openWikiDir, "");

  return hash.digest("hex");
}

/**
 * Reads prior run metadata if it exists and is structurally valid.
 */
export async function readLastUpdate(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): Promise<UpdateMetadata | null> {
  const metadataFile = getMetadataFilePath(cwd, outputMode);

  try {
    const rawMetadata = await readFile(metadataFile, "utf8");
    const parsedMetadata = JSON.parse(rawMetadata) as Partial<UpdateMetadata>;

    if (
      typeof parsedMetadata.updatedAt === "string" &&
      typeof parsedMetadata.command === "string" &&
      typeof parsedMetadata.model === "string"
    ) {
      return {
        updatedAt: parsedMetadata.updatedAt,
        command: parsedMetadata.command === "init" ? "init" : "update",
        gitHead:
          typeof parsedMetadata.gitHead === "string"
            ? parsedMetadata.gitHead
            : undefined,
        model: parsedMetadata.model,
        // Metadata written before the status field existed is treated as
        // complete so upgrades do not force a spurious re-run.
        status:
          parsedMetadata.status === "interrupted" ? "interrupted" : "complete",
        language:
          typeof parsedMetadata.language === "string"
            ? parsedMetadata.language
            : undefined,
      };
    }

    return null;
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

/**
 * Recursively adds stable file paths and bytes to the OpenWiki content snapshot.
 */
async function addDirectoryToSnapshot(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory: string,
): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      hash.update("missing");
      return;
    }

    throw error;
  }

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.join(relativeDirectory, entry.name);

    if (isIgnoredSnapshotPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\0`);
      await addDirectoryToSnapshot(hash, entryPath, relativePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileContent = await readSnapshotFile(entryPath);

    if (fileContent === null) {
      continue;
    }

    hash.update(`file:${relativePath}\0`);
    hash.update(fileContent);
    hash.update("\0");
  }
}

function getWikiContentRoot(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki" ? cwd : path.join(cwd, OPEN_WIKI_DIR);
}

function getTemporaryPlanFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return path.join(getWikiContentRoot(cwd, outputMode), TEMPORARY_PLAN_FILE);
}

function getMetadataFilePath(
  cwd: string,
  outputMode: OpenWikiOutputMode,
): string {
  return outputMode === "local-wiki"
    ? path.join(cwd, LOCAL_WIKI_METADATA_PATH)
    : path.join(cwd, UPDATE_METADATA_PATH);
}

function isIgnoredSnapshotPath(relativePath: string): boolean {
  return (
    relativePath === path.basename(UPDATE_METADATA_PATH) ||
    relativePath === LOCAL_WIKI_METADATA_PATH ||
    relativePath === TEMPORARY_PLAN_FILE
  );
}

/**
 * Reads snapshot bytes while tolerating files that move mid-scan.
 */
async function readSnapshotFile(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isExpectedSnapshotRaceError(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Produces the git evidence block passed to init/update prompts.
 *
 * Lines that reference a path excluded by `openWikiIgnore` are filtered out of
 * every git section (status, log, diff) before the block is assembled.
 */
async function createGitSummary(
  command: OpenWikiCommand,
  cwd: string,
  lastUpdate: UpdateMetadata | null,
  openWikiIgnore: OpenWikiIgnore,
): Promise<string> {
  const sections: string[] = [];
  const status = filterGitOutputForIgnore(
    await runGit(cwd, ["status", "--short"]),
    openWikiIgnore,
  );
  const head = await getGitHead(cwd);

  sections.push(formatGitSection("git status --short", status));
  sections.push(formatGitSection("git rev-parse HEAD", head ?? "(unknown)"));

  if (command === "update" && lastUpdate?.gitHead) {
    const logSinceLastHead = filterGitOutputForIgnore(
      // Evidence path: a range against a missing commit must throw, not return
      // git's error text as if it were an empty log.
      await runGitStrict(cwd, [
        "log",
        `${lastUpdate.gitHead}..HEAD`,
        "--name-status",
        "--oneline",
      ]),
      openWikiIgnore,
    );

    sections.push(
      formatGitSection(
        `git log ${lastUpdate.gitHead}..HEAD --name-status --oneline`,
        logSinceLastHead,
      ),
    );
  } else if (command === "update" && lastUpdate?.updatedAt) {
    const logSinceLastUpdate = filterGitOutputForIgnore(
      // Evidence path: this log feeds the update's change reasoning, so a git
      // failure must surface rather than pass as no commits since last update.
      await runGitStrict(cwd, [
        "log",
        "--since",
        lastUpdate.updatedAt,
        "--name-status",
        "--oneline",
      ]),
      openWikiIgnore,
    );

    sections.push(
      formatGitSection(
        `git log --since ${lastUpdate.updatedAt} --name-status --oneline`,
        logSinceLastUpdate,
      ),
    );
  } else {
    const recentLog = filterGitOutputForIgnore(
      await runGit(cwd, [
        "log",
        "--max-count=20",
        "--name-status",
        "--oneline",
      ]),
      openWikiIgnore,
    );

    if (command === "update") {
      sections.push("No prior OpenWiki update timestamp was found.");
    }

    sections.push(
      formatGitSection(
        "git log --max-count=20 --name-status --oneline",
        recentLog,
      ),
    );
  }

  const diff = filterGitOutputForIgnore(
    await runGit(cwd, ["diff", "--name-status", "HEAD"]),
    openWikiIgnore,
  );
  sections.push(formatGitSection("git diff --name-status HEAD", diff));

  return sections.join("\n\n");
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);

  return head.length > 0 ? head : undefined;
}

/**
 * Runs git commands without failing the whole run for normal git command errors.
 *
 * Swallows exec failures and returns whatever git wrote (including stderr), so a
 * failed command reads as ordinary output. Correct for display-ish calls whose
 * worst case is a noisy prompt section, but NOT for evidence the run reasons
 * over: use {@link runGitStrict} there so a git error cannot masquerade as an
 * empty diff.
 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        maxBuffer: 1024 * 1024,
      },
    );

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isExecError(error)) {
      return [error.stdout?.trim(), error.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    throw error;
  }
}

/**
 * Runs git and reports only whether it succeeded. For plumbing whose answer is
 * the exit code (`merge-base --is-ancestor`, `cat-file -e`).
 *
 * @param cwd - Repository root to run git in.
 * @param args - Git arguments, a fixed code-constructed array (no shell).
 * @returns True when git exited zero, false on any failure.
 */
export async function runGitCheck(
  cwd: string,
  args: string[],
): Promise<boolean> {
  try {
    await execFileAsync("git", ["--no-pager", ...args], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs git and throws on failure instead of returning stderr as output.
 * Evidence-path calls (diffs, logs that feed prompts or verdicts) MUST use this:
 * a fast-forward or "no changes" conclusion is only sound over a diff git
 * actually produced (the CreditGenie shallow-clone bug, where a missing commit's
 * error text flowed in as an empty diff and silently froze the wiki).
 *
 * @param cwd - Repository root to run git in.
 * @param args - Git arguments, a fixed code-constructed array (no shell).
 * @returns The trimmed stdout git produced.
 */
export async function runGitStrict(
  cwd: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
    cwd,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Fails loudly when the last-update commit is not present locally, instead of
 * letting evidence collection run against a commit git has never heard of. The
 * usual cause is a CI checkout with the default fetch-depth of 1; the other is a
 * rebase that erased the commit. Doing nothing when there is no prior stamp (a
 * first init) or no recorded head is correct: there is nothing to diff against.
 *
 * @param cwd - Repository root to check.
 * @param lastUpdate - The prior run's metadata, or null when none exists.
 * @throws When the recorded gitHead is missing locally, with the exact fix.
 */
export async function assertUsableHistory(
  cwd: string,
  lastUpdate: UpdateMetadata | null,
): Promise<void> {
  if (!lastUpdate?.gitHead) {
    return;
  }

  const exists = await runGitCheck(cwd, [
    "cat-file",
    "-e",
    `${lastUpdate.gitHead}^{commit}`,
  ]);

  if (exists) {
    return;
  }

  const shallow =
    (await runGit(cwd, ["rev-parse", "--is-shallow-repository"])) === "true";

  throw new Error(
    shallow
      ? `This checkout is shallow and does not contain the last-update commit ` +
          `(${lastUpdate.gitHead}). Set "fetch-depth: 0" on actions/checkout in ` +
          `your OpenWiki workflow so updates can diff against it.`
      : `The last-update commit (${lastUpdate.gitHead}) no longer exists in ` +
          `this repository (rebased away?). Delete openwiki/.last-update.json ` +
          `and re-run to rebuild from current state.`,
  );
}

function formatGitSection(command: string, output: string): string {
  return [`$ ${command}`, output.length > 0 ? output : "(no output)"].join(
    "\n",
  );
}

/**
 * Matches the two-character status field `git status --short` puts in front of
 * each path. The field is only one character wide on the first line of a
 * trimmed run, because `runGit` strips the leading space of an unstaged-only
 * status such as " M openwiki/.last-update.json".
 */
const GIT_STATUS_LINE_PATTERN = /^[ !?ACDMRTU]{1,2} (.+)$/u;

function isUpdateMetadataStatusLine(line: string): boolean {
  const statusPath = (GIT_STATUS_LINE_PATTERN.exec(line)?.[1] ?? line).trim();
  const normalizedPath = statusPath.replace(/\\/gu, "/");

  return (
    normalizedPath === UPDATE_METADATA_PATH ||
    normalizedPath.endsWith(` -> ${UPDATE_METADATA_PATH}`)
  );
}

async function getChangedPathsSinceLastUpdate(
  cwd: string,
  gitHead: string,
): Promise<string[]> {
  // Evidence path: this diff decides whether the wiki is stale, so a git error
  // must throw rather than read back as an empty (unchanged) result.
  const diff = await runGitStrict(cwd, [
    "diff",
    "--name-only",
    `${gitHead}..HEAD`,
  ]);

  return diff
    .split("\n")
    .map((line) => normalizeGitPath(line))
    .filter(Boolean);
}

function isOpenWikiPath(changedPath: string): boolean {
  return (
    changedPath === OPEN_WIKI_DIR || changedPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

function normalizeGitPath(value: string): string {
  return value.trim().replace(/\\/gu, "/");
}

/**
 * Strips lines that reference an ignored path from a block of git output.
 *
 * Returns the input unchanged when no rules are active. When filtering removes
 * every line, returns a placeholder so the prompt records that matching paths
 * existed but were excluded, rather than showing a misleadingly empty section.
 */
function filterGitOutputForIgnore(
  output: string,
  openWikiIgnore: OpenWikiIgnore,
): string {
  if (!openWikiIgnore.isActive || output.length === 0) {
    return output;
  }

  const filteredOutput = output
    .split("\n")
    .filter((line) => !lineReferencesIgnoredPath(line, openWikiIgnore))
    .join("\n")
    .trim();

  return filteredOutput.length > 0
    ? filteredOutput
    : "(all matching paths are excluded by .openwikiignore)";
}

/**
 * Whether a single line of git output names at least one ignored path.
 */
function lineReferencesIgnoredPath(
  line: string,
  openWikiIgnore: OpenWikiIgnore,
): boolean {
  return extractGitPaths(line).some((changedPath) =>
    openWikiIgnore.ignores(changedPath),
  );
}

/**
 * Pulls the file path(s) out of one line of `git status --short` or
 * `--name-status` output.
 *
 * Handles both the two-column short-status format and the letter-prefixed
 * name-status format, and returns an empty array for lines that carry no path
 * (such as `--oneline` commit headers). Rename lines yield both the old and new
 * paths so that either side matching a rule excludes the line.
 */
function extractGitPaths(line: string): string[] {
  const shortStatusMatch = /^(?:[ MARCUD?!]{2})\s+(.+)$/u.exec(line);
  const nameStatusMatch = /^(?:[ACDMRTUXB]\d*)\s+(.+)$/u.exec(line.trim());
  const pathsText = shortStatusMatch?.[1] ?? nameStatusMatch?.[1];

  if (!pathsText) {
    return [];
  }

  return splitGitPaths(pathsText).map(normalizeGitPath).filter(Boolean);
}

/**
 * Splits the path portion of a git line into individual paths.
 *
 * `--name-status` separates a rename's source and target with a tab, while
 * `git status --short` uses ` -> `; a plain single path is returned as-is.
 */
function splitGitPaths(pathsText: string): string[] {
  if (pathsText.includes("\t")) {
    return pathsText.split("\t");
  }

  if (pathsText.includes(" -> ")) {
    return pathsText.split(" -> ");
  }

  return [pathsText];
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
