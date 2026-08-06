/**
 * Shared, fully-executed building blocks for the source-grounded freshness eval.
 *
 * Everything here runs the real code under test: the real resolver parses real
 * source, the real evaluator classifies freshness, and the git section drives a
 * real git repository through `getUpdateNoopStatus`. Nothing about a strategy's
 * decision is hard-coded; the harness only supplies inputs and reads out the
 * decisions each strategy actually makes.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { Node } from "web-tree-sitter";

import { getUpdateNoopStatus } from "../../src/agent/utils.js";
import {
  FileSystemSourceReader,
  FreshnessEvaluator,
  type SourceReader,
} from "../../src/staleness/freshness.js";
import { createDefaultRegistry } from "../../src/staleness/languages/registry.js";
import { checkWikiFreshness } from "../../src/staleness/preflight.js";
import { SourceResolver } from "../../src/staleness/resolver.js";
import {
  fingerprintFileBytes,
  writeSidecarAtomic,
} from "../../src/staleness/storage.js";
import { recordSourceDependencies } from "../../src/staleness/recorder.js";

const execFileAsync = promisify(execFile);

/**
 * The two decisions an update run can make for a page: rebuild the
 * documentation, or skip it because nothing meaningful changed.
 */
export type Decision = "skip" | "rebuild";

/**
 * How a decision compares to ground truth. `missed-drift` is a skip that should
 * have been a rebuild (stale docs shipped); `wasted-rebuild` is a rebuild that
 * should have been a skip (an LLM run burned for a no-op diff).
 */
export type Verdict = "correct" | "missed-drift" | "wasted-rebuild";

/**
 * Grade one decision against the known-correct answer.
 *
 * @param decision - The decision a strategy made.
 *
 * @param truth - The correct decision for the scenario.
 */
export function grade(decision: Decision, truth: Decision): Verdict {
  if (decision === truth) {
    return "correct";
  }

  return decision === "skip" ? "missed-drift" : "wasted-rebuild";
}

/**
 * An in-memory source tree used as the resolver's and evaluator's
 * {@link SourceReader}, so a scenario can mutate a file without touching disk.
 */
export class MemReader implements SourceReader {
  private readonly files = new Map<string, string>();

  /**
   * Set (or, with `undefined`, delete) the contents of a repository-relative
   * path.
   *
   * @param path - Repository-relative POSIX path.
   *
   * @param contents - New contents, or `undefined` to remove the file.
   */
  set(path: string, contents: string | undefined): void {
    if (contents === undefined) {
      this.files.delete(path);
    } else {
      this.files.set(path, contents);
    }
  }

  readSource(path: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(path));
  }
}

/**
 * A single resolver reused across the whole eval so grammars load only once.
 */
export const sharedResolver = new SourceResolver(createDefaultRegistry());

/**
 * The `content-hash` strategy: rebuild whenever the source file's bytes changed
 * at all. This is what a naive file watcher does.
 *
 * @param before - Source bytes at the time the page was written.
 *
 * @param after - Current source bytes.
 */
export function contentHashDecision(
  before: string,
  after: string | undefined,
): Decision {
  if (after === undefined) {
    return "rebuild";
  }

  return fingerprintFileBytes(before).value === fingerprintFileBytes(after).value
    ? "skip"
    : "rebuild";
}

/**
 * The `source-grounded` strategy (this PR), as a pure mechanism decision: skip
 * only when every definition the page cites is confirmed unchanged.
 *
 * @param sidecar - The page's recorded dependencies.
 *
 * @param reader - Source reader holding the current (possibly mutated) tree.
 */
export async function sourceGroundedDecision(
  sidecar: Parameters<FreshnessEvaluator["evaluatePage"]>[0],
  reader: SourceReader,
): Promise<{ decision: Decision; state: string }> {
  const evaluator = new FreshnessEvaluator(sharedResolver, reader);
  const report = await evaluator.evaluatePage(sidecar);

  return {
    decision: report.state === "fresh" ? "skip" : "rebuild",
    state: report.state,
  };
}

/**
 * Splice a node's byte range out of the source and replace it, but only when
 * the node's reported offsets line up exactly with its text. Returns
 * `undefined` when they do not (a non-ASCII offset mismatch), so a scenario
 * that cannot be built precisely is skipped rather than mislabeled.
 *
 * @param text - The full source the node was parsed from.
 *
 * @param node - The node whose span is being replaced.
 *
 * @param replacement - Text to put in the node's place.
 */
export function verifiedSplice(
  text: string,
  node: Node,
  replacement: string,
): string | undefined {
  if (text.slice(node.startIndex, node.endIndex) !== node.text) {
    return undefined;
  }

  return text.slice(0, node.startIndex) + replacement + text.slice(node.endIndex);
}

const IDENTIFIER_TYPES = [
  "identifier",
  "type_identifier",
  "property_identifier",
  "field_identifier",
];

/**
 * Find the identifier node that names a definition, so a rename can target the
 * declaration alone. Prefers the grammar's `name` field, then the first
 * matching identifier leaf.
 *
 * @param defNode - The definition subtree.
 *
 * @param expectedName - The definition's simple name.
 */
export function findNameNode(defNode: Node, expectedName: string): Node | undefined {
  const byField = defNode.childForFieldName("name");
  if (byField && byField.text === expectedName) {
    return byField;
  }

  for (const candidate of defNode.descendantsOfType(IDENTIFIER_TYPES)) {
    if (candidate && candidate.text === expectedName) {
      return candidate;
    }
  }

  return undefined;
}

const LITERAL_TYPES = [
  "number",
  "integer",
  "float",
  "int_literal",
  "float_literal",
  "string_fragment",
];

/**
 * Find a literal leaf inside a definition whose value can be changed to force a
 * semantic difference, or `undefined` when the definition has none.
 *
 * @param defNode - The definition subtree to search.
 */
export function findLiteralLeaf(defNode: Node): Node | undefined {
  for (const candidate of defNode.descendantsOfType(LITERAL_TYPES)) {
    if (candidate && candidate.childCount === 0) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Produce a replacement value for a literal leaf that is guaranteed to differ
 * from the original while remaining the same syntactic kind.
 *
 * @param leaf - The literal leaf being changed.
 */
export function mutateLiteralText(leaf: Node): string {
  return leaf.type === "string_fragment" ? `${leaf.text}x` : `${leaf.text}1`;
}

/**
 * Two nodes whose byte ranges do not overlap, so mutating one cannot change the
 * other's canonical form.
 *
 * @param a - First node.
 *
 * @param b - Second node.
 */
export function disjoint(a: Node, b: Node): boolean {
  return a.endIndex <= b.startIndex || b.endIndex <= a.startIndex;
}

const COMMENT_TOKEN_BY_EXTENSION = new Map<string, string>([
  [".ts", "//"],
  [".mts", "//"],
  [".cts", "//"],
  [".js", "//"],
  [".jsx", "//"],
  [".mjs", "//"],
  [".cjs", "//"],
  [".go", "//"],
  [".py", "#"],
  [".pyi", "#"],
]);

/**
 * Append a comment and blank lines to a file without touching any existing
 * token, so every definition's canonical form is preserved. This is the
 * cosmetic-churn edit: file bytes change, meaning does not.
 *
 * @param text - The original source.
 *
 * @param extension - The file's extension, used to pick a comment token.
 */
export function cosmeticChurn(text: string, extension: string): string {
  const token = COMMENT_TOKEN_BY_EXTENSION.get(extension) ?? "";
  const trailer = token ? `\n${token} openwiki eval churn\n` : "\n\n";
  return `\n${text}${trailer}`;
}

/**
 * Record a page grounded in a single symbol and return the sidecar, or
 * `undefined` when the symbol could not be resolved at definition granularity.
 *
 * @param path - Repository-relative source path.
 *
 * @param text - Source bytes.
 *
 * @param symbol - Qualified symbol name to ground the page in.
 */
export async function recordSingleSymbol(
  path: string,
  text: string,
  symbol: string,
): Promise<Awaited<ReturnType<typeof recordSourceDependencies>>["sidecar"] | undefined> {
  const reader = new MemReader();
  reader.set(path, text);

  const { sidecar } = await recordSourceDependencies({
    page: "openwiki/page.md",
    pageBytes: "# page\n",
    requests: [{ path, symbol }],
    resolver: sharedResolver,
    reader,
  });

  if (sidecar.sources[0]?.resolution !== "symbol") {
    return undefined;
  }

  return sidecar;
}

/**
 * Run `git` in a directory with a deterministic identity and no ambient config,
 * returning trimmed stdout. Uses `execFile` with an argument array (never a
 * shell), per the project's command-injection guardrails.
 *
 * @param cwd - Working directory (a throwaway temp repo).
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
        GIT_CONFIG_GLOBAL: join(tmpdir(), "openwiki-eval-nonexistent-gitconfig"),
        GIT_CONFIG_SYSTEM: join(tmpdir(), "openwiki-eval-nonexistent-gitconfig"),
      },
    },
  );

  return stdout.trim();
}

/**
 * Create a throwaway git repository, hand it to `build`, and remove it
 * afterwards no matter what. Temp state is contained under `os.tmpdir()`.
 *
 * @param build - Callback that receives the repository's absolute path.
 */
export async function withTempGitRepo<T>(
  build: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "owfresh-git-"));
  try {
    return await build(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * The wiki page and source both git scenarios start from. The page describes
 * `AuthService.authenticate` as it behaves in {@link AUTH_V1}.
 */
export const AUTH_V1 = [
  "export class AuthService {",
  "  authenticate(user: string): string {",
  "    // resolve the caller",
  "    return user.trim();",
  "  }",
  "}",
  "",
].join("\n");

/**
 * A behavior change: the method now lowercases instead of trimming. The page
 * still describes {@link AUTH_V1}, so this is real drift.
 */
export const AUTH_V2 = AUTH_V1.replace(
  "return user.trim();",
  "return user.toLowerCase();",
);

/**
 * A pure reformat of {@link AUTH_V1}: different whitespace and comment, same
 * behavior. The page remains accurate.
 */
export const AUTH_V1_REFORMATTED = [
  "export class AuthService {",
  "  authenticate( user: string ): string {",
  "",
  "    /* look up the caller session */",
  "    return user.trim() ;",
  "  }",
  "}",
  "",
].join("\n");

const AUTH_PAGE = [
  "# Authentication",
  "",
  "`AuthService.authenticate` trims and returns the user handle.",
  "",
].join("\n");

/**
 * Materialize a freshly generated wiki inside a temp git repo: source at
 * {@link AUTH_V1}, a page grounded in it, a real sidecar, and a committed
 * `.last-update.json` whose `gitHead` points at the source commit. This is the
 * honest starting point every git scenario shares.
 *
 * @param cwd - The temp repository's absolute path.
 *
 * @returns The recorded git head (`gitHead` in `.last-update.json`).
 */
export async function seedGeneratedWiki(cwd: string): Promise<string> {
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "openwiki", "architecture"), { recursive: true });
  await writeFile(join(cwd, "src", "auth.ts"), AUTH_V1, "utf8");
  await writeFile(
    join(cwd, "openwiki", "architecture", "auth.md"),
    AUTH_PAGE,
    "utf8",
  );

  const reader = new FileSystemSourceReader(cwd);
  const { sidecar } = await recordSourceDependencies({
    page: "openwiki/architecture/auth.md",
    pageBytes: AUTH_PAGE,
    requests: [{ path: "src/auth.ts", symbol: "AuthService.authenticate" }],
    resolver: sharedResolver,
    reader,
  });
  await writeSidecarAtomic(cwd, sidecar);

  await git(cwd, ["init", "-q", "-b", "main"]);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "generate wiki for AuthService v1"]);

  const gitHead = await git(cwd, ["rev-parse", "HEAD"]);

  await writeFile(
    join(cwd, "openwiki", ".last-update.json"),
    `${JSON.stringify(
      {
        updatedAt: "2026-01-01T00:00:00.000Z",
        command: "update",
        model: "eval",
        gitHead,
        status: "complete",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "record wiki run metadata"]);

  return gitHead;
}

/**
 * The recorded `gitHead` an update run would treat as "the last documented
 * commit", read back from disk.
 *
 * @param cwd - The temp repository's absolute path.
 */
export async function recordedGitHead(cwd: string): Promise<string> {
  const raw = await readFile(
    join(cwd, "openwiki", ".last-update.json"),
    "utf8",
  );
  return (JSON.parse(raw) as { gitHead: string }).gitHead;
}

/**
 * The `git-range` strategy (what OpenWiki ships today, minus the freshness
 * preflight this PR adds): skip when the worktree is clean and nothing outside
 * `openwiki/` changed between the recorded head and HEAD. Executed against the
 * real repository with real git commands.
 *
 * @param cwd - The temp repository's absolute path.
 *
 * @param gitHead - The recorded head to diff from.
 */
export async function gitRangeDecision(
  cwd: string,
  gitHead: string,
): Promise<Decision> {
  const status = await git(cwd, [
    "status",
    "--short",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    return "rebuild";
  }

  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (head === gitHead) {
    return "skip";
  }

  const diff = await git(cwd, ["diff", "--name-only", `${gitHead}..HEAD`]);
  const changed = diff.split("\n").map((line) => line.trim()).filter(Boolean);
  const touchesSource = changed.some(
    (path) => path !== "openwiki" && !path.startsWith("openwiki/"),
  );

  return touchesSource ? "rebuild" : "skip";
}

/**
 * The decision OpenWiki actually ships with this PR merged: the real
 * `getUpdateNoopStatus`, git gate plus source-grounded veto.
 *
 * @param cwd - The temp repository's absolute path.
 */
export async function shippedTodayDecision(cwd: string): Promise<Decision> {
  const status = await getUpdateNoopStatus(cwd);
  return status.shouldSkip ? "skip" : "rebuild";
}

/**
 * The source-grounded mechanism decision against a real working tree: skip only
 * when every grounded page is fresh.
 *
 * @param cwd - The temp repository's absolute path.
 */
export async function sourceGroundedRepoDecision(cwd: string): Promise<Decision> {
  const freshness = await checkWikiFreshness(cwd);
  return freshness.allFresh ? "skip" : "rebuild";
}

/**
 * The four situations a documented page can be in for the detection benchmark.
 *
 * - `fresh`: the code never changed. Truth: fresh.
 * - `behind-cursor-drift`: the code changed, but the change sits at or before
 *   the recorded git cursor (a partial regen or interrupted run bumped the
 *   cursor past it). Truth: stale. This is git's blind spot.
 * - `in-range-change`: the code changed in a commit after the cursor. Truth:
 *   stale. Git can see this in its diff.
 * - `cosmetic-only`: a commit after the cursor reformatted the code without
 *   changing behavior. Truth: fresh. Git sees the file move; the meaning did
 *   not.
 */
export type DetectionCategory =
  | "fresh"
  | "behind-cursor-drift"
  | "in-range-change"
  | "cosmetic-only";

/**
 * Categories whose ground-truth is that the page is genuinely stale.
 */
export const STALE_CATEGORIES: readonly DetectionCategory[] = [
  "behind-cursor-drift",
  "in-range-change",
];

/**
 * One page in the detection benchmark.
 */
export interface DetectionSpec {
  /**
   * Repository-relative POSIX path of the source file inside the temp repo.
   */
  path: string;

  /**
   * Qualified symbol the page is grounded in.
   */
  symbol: string;

  /**
   * Which situation this page is placed in.
   */
  category: DetectionCategory;

  /**
   * Source bytes the sidecar is recorded against (what the page knows).
   */
  groundedText: string;

  /**
   * Source bytes committed at generation time (the cursor commit, C0).
   */
  c0Text: string;

  /**
   * Source bytes committed in a single later commit, after the cursor. Absent
   * when the category makes no post-cursor commit.
   *
   * @default undefined - no post-cursor commit is made for this page.
   */
  laterText?: string;
}

/**
 * A per-detector confusion matrix over the labeled page population.
 */
export interface Confusion {
  /**
   * Stale pages correctly flagged.
   */
  truePositive: number;

  /**
   * Fresh pages wrongly flagged (a false alarm).
   */
  falsePositive: number;

  /**
   * Stale pages left unflagged (silent staleness). The dangerous cell.
   */
  falseNegative: number;

  /**
   * Fresh pages correctly left alone.
   */
  trueNegative: number;
}

/**
 * Per-category tally of how each detector behaved, so the benchmark can show
 * the assumption-free per-situation result, not just aggregate rates.
 */
export interface CategoryBreakdown {
  /**
   * Pages seeded in this category.
   */
  count: number;

  /**
   * How many the file-level git detector flagged.
   */
  gitFlagged: number;

  /**
   * How many the source-grounded detector flagged.
   */
  sourceGroundedFlagged: number;
}

/**
 * The measured outcome of the detection benchmark.
 */
export interface DetectionOutcome {
  /**
   * Pages that were grounded successfully and are participating.
   */
  pages: number;

  /**
   * Per-category behavior of both detectors.
   */
  byCategory: Record<DetectionCategory, CategoryBreakdown>;

  /**
   * Confusion matrix for the file-level git detector (what ships today).
   */
  git: Confusion;

  /**
   * Confusion matrix for the source-grounded detector (this PR).
   */
  sourceGrounded: Confusion;
}

/**
 * True when a category's ground-truth is stale.
 *
 * @param category - The category to classify.
 */
function isStale(category: DetectionCategory): boolean {
  return STALE_CATEGORIES.includes(category);
}

/**
 * Build one real git repository seeded with a labeled population of pages, run
 * both detectors over it, and return their confusion matrices.
 *
 * The framing is detection, not repair: each detector's job is to answer "is
 * this page still backed by its source?" for every page. The git detector is
 * given a *generous* file-level reading of the signal git actually exposes (did
 * any file this page cites appear in `git diff cursor..HEAD`), even though git
 * never names a stale page per se. The source-grounded detector uses the real
 * {@link checkWikiFreshness}. Whether a flagged page ever gets fixed is a
 * separate concern this benchmark deliberately does not touch.
 *
 * @param specs - One entry per page to seed.
 */
export async function measureDetection(
  specs: readonly DetectionSpec[],
): Promise<DetectionOutcome> {
  return withTempGitRepo(async (cwd) => {
    const emptyBreakdown = (): CategoryBreakdown => ({
      count: 0,
      gitFlagged: 0,
      sourceGroundedFlagged: 0,
    });
    const byCategory: Record<DetectionCategory, CategoryBreakdown> = {
      fresh: emptyBreakdown(),
      "behind-cursor-drift": emptyBreakdown(),
      "in-range-change": emptyBreakdown(),
      "cosmetic-only": emptyBreakdown(),
    };

    /**
     * Seeded pages, in the order committed, with everything needed to grade
     * them after the repository is built.
     */
    const seeded: {
      page: string;
      path: string;
      category: DetectionCategory;
    }[] = [];

    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const page = `openwiki/pages/p${index}.md`;
      const pageBytes = `# ${spec.symbol}\n\nGrounded in \`${spec.symbol}\`.\n`;

      const groundedReader = new MemReader();
      groundedReader.set(spec.path, spec.groundedText);
      const { sidecar } = await recordSourceDependencies({
        page,
        pageBytes,
        requests: [{ path: spec.path, symbol: spec.symbol }],
        resolver: sharedResolver,
        reader: groundedReader,
      });
      if (sidecar.sources[0]?.resolution !== "symbol") {
        continue;
      }

      await mkdir(dirname(join(cwd, spec.path)), { recursive: true });
      await writeFile(join(cwd, spec.path), spec.c0Text, "utf8");
      await mkdir(dirname(join(cwd, page)), { recursive: true });
      await writeFile(join(cwd, page), pageBytes, "utf8");
      await writeSidecarAtomic(cwd, sidecar);

      seeded.push({ page, path: spec.path, category: spec.category });
      byCategory[spec.category].count += 1;
    }

    await git(cwd, ["init", "-q", "-b", "main"]);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "generate wiki"]);
    const cursor = await git(cwd, ["rev-parse", "HEAD"]);

    await writeFile(
      join(cwd, "openwiki", ".last-update.json"),
      `${JSON.stringify(
        {
          updatedAt: "2026-01-01T00:00:00.000Z",
          command: "update",
          model: "eval",
          gitHead: cursor,
          status: "complete",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "record wiki run metadata"]);

    // The single post-cursor commit: the in-range and cosmetic changes.
    let madeLaterCommit = false;
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      if (spec.laterText !== undefined) {
        await writeFile(join(cwd, spec.path), spec.laterText, "utf8");
        madeLaterCommit = true;
      }
    }
    if (madeLaterCommit) {
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-q", "-m", "later source changes"]);
    }

    // File-level git signal: non-wiki paths changed between cursor and HEAD.
    const diff = await git(cwd, ["diff", "--name-only", `${cursor}..HEAD`]);
    const changedPaths = new Set(
      diff
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (path) =>
            path.length > 0 &&
            path !== "openwiki" &&
            !path.startsWith("openwiki/"),
        ),
    );

    // Source-grounded signal: the real freshness preflight, per page.
    const freshness = await checkWikiFreshness(cwd);
    const notFreshPages = new Set(freshness.drifted.map((report) => report.page));

    const git0 = (): Confusion => ({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 0,
      trueNegative: 0,
    });
    const gitMatrix = git0();
    const sourceGroundedMatrix = git0();

    for (const entry of seeded) {
      const stale = isStale(entry.category);
      const gitFlag = changedPaths.has(entry.path);
      const sgFlag = notFreshPages.has(entry.page);

      if (gitFlag) {
        byCategory[entry.category].gitFlagged += 1;
      }
      if (sgFlag) {
        byCategory[entry.category].sourceGroundedFlagged += 1;
      }

      const score = (matrix: Confusion, flagged: boolean): void => {
        if (stale && flagged) {
          matrix.truePositive += 1;
        } else if (stale && !flagged) {
          matrix.falseNegative += 1;
        } else if (!stale && flagged) {
          matrix.falsePositive += 1;
        } else {
          matrix.trueNegative += 1;
        }
      };
      score(gitMatrix, gitFlag);
      score(sourceGroundedMatrix, sgFlag);
    }

    return {
      pages: seeded.length,
      byCategory,
      git: gitMatrix,
      sourceGrounded: sourceGroundedMatrix,
    };
  });
}
