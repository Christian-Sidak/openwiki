/**
 * Mutation-based eval for source-grounded staleness detection.
 *
 * The question this answers: when source changes in a way that should make a
 * wiki page stale, does OpenWiki's freshness check flag the right pages, and
 * does it leave the pages it should not touch alone? It measures nothing else.
 * It does not measure hallucination or overall wiki factual accuracy.
 *
 * Results are kept in two deliberately separate categories so a missing
 * dependency is never confused with a broken checker:
 *
 * 1. Deterministic mechanism. We write a known-correct sidecar, change the
 *    cited symbol, and assert the page goes not-fresh (and that unrelated
 *    changes leave it fresh). This isolates the checker from the agent and
 *    should be ~100% reliable; a failure here means the machinery is broken.
 *
 * 2. End-to-end coverage. The real production recorder grounds pages in real
 *    symbols from a real source tree, then realistic mutations are applied and
 *    the real preflight is run. Because category 1 already proves the checker
 *    sound, a miss here is a coverage gap in what was grounded, not a checker
 *    bug. Testing the agent's own symbol-selection judgment needs a real
 *    generated wiki with committed sidecars, which is the optional Tier B
 *    config layered on top.
 *
 * Everything runs the real code under test: the real resolver, the real
 * {@link FreshnessEvaluator}, the real {@link checkWikiFreshness}, and the real
 * {@link getUpdateNoopStatus}. Mutations are byte-level only (a verified splice
 * or a whole-file overwrite with a known variant); mutated source is never
 * evaluated or executed.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  FileSystemSourceReader,
  FreshnessEvaluator,
  type FreshnessState,
  type PageFreshness,
  type SourceReader,
} from "../../src/staleness/freshness.js";
import { checkWikiFreshness } from "../../src/staleness/preflight.js";
import { recordSourceDependencies } from "../../src/staleness/recorder.js";
import {
  listSourceGroundedPages,
  readSidecar,
  writeSidecarAtomic,
} from "../../src/staleness/storage.js";
import { getUpdateNoopStatus } from "../../src/agent/utils.js";
import {
  AUTH_V1,
  AUTH_V1_REFORMATTED,
  AUTH_V2,
  cosmeticChurn,
  findLiteralLeaf,
  findNameNode,
  git,
  mutateLiteralText,
  seedGeneratedWiki,
  sharedResolver,
  verifiedSplice,
  withTempGitRepo,
} from "../freshness/harness.js";

/**
 * A page that is not fresh is always in one of these states. `stale` means the
 * cited definition (or file, for a file-level dependency) changed meaning;
 * `unknown` means the anchor moved out from under us (a rename or deletion);
 * `unverified` means freshness could not be computed at all.
 */
export type NotFreshState = "stale" | "unknown" | "unverified";

/**
 * A single byte-level source mutation. None of these evaluate or execute the
 * mutated source.
 *
 * - `literal`: change a literal leaf inside the cited definition (a constant or
 *   default value), so the definition fingerprint differs.
 * - `rename`: rename the cited definition's own identifier, so the symbol can no
 *   longer be resolved (production classifies this `unknown`).
 * - `delete`: splice the whole cited definition out of the file, so the symbol
 *   is gone (production classifies this `unknown`).
 * - `replace-file`: overwrite a whole file with a known variant, used for
 *   signature and body changes and for cosmetic reformats.
 */
export type Mutation =
  | { kind: "literal"; path: string; symbol: string }
  | { kind: "rename"; path: string; symbol: string; to: string }
  | { kind: "delete"; path: string; symbol: string }
  | { kind: "replace-file"; path: string; text: string };

/**
 * A source file present in a case's starting world.
 */
export interface SourceFile {
  /**
   * Repository-relative POSIX path.
   */
  path: string;

  /**
   * The file's starting bytes.
   */
  text: string;
}

/**
 * A page and the single symbol it is grounded in.
 */
export interface PageGrounding {
  /**
   * Repository-relative POSIX path of the page markdown.
   */
  page: string;

  /**
   * Repository-relative POSIX path of the source file the page cites.
   */
  path: string;

  /**
   * Qualified symbol the page is grounded in, for example
   * `AuthService.authenticate`.
   */
  symbol: string;
}

/**
 * One deterministic-mechanism case: a starting world, one mutation, and the
 * pages expected to be not-fresh afterwards. Any page not listed in
 * {@link expectedNotFresh} is expected to stay fresh.
 */
export interface MutationCase {
  /**
   * Stable, human-readable case name.
   */
  name: string;

  /**
   * One-line description of what the case proves.
   */
  description: string;

  /**
   * Source files present when the sidecars are recorded.
   */
  sources: SourceFile[];

  /**
   * Pages to ground and their cited symbols.
   */
  pages: PageGrounding[];

  /**
   * The single mutation applied after the world is in a known-fresh state.
   */
  mutation: Mutation;

  /**
   * Pages expected to be not-fresh after the mutation, each pinned to the exact
   * expected state. Every page absent from this map is expected to stay fresh.
   */
  expectedNotFresh: Record<string, NotFreshState>;
}

/**
 * Performance counters for one freshness sweep. These describe the preflight
 * only, never any agent generation work.
 */
export interface SweepMetrics {
  /**
   * Wall-clock duration of the sweep in milliseconds.
   */
  durationMs: number;

  /**
   * Pages swept (every page carrying a sidecar).
   */
  pagesSwept: number;

  /**
   * Distinct source files whose bytes were read and hashed.
   */
  filesHashed: number;

  /**
   * Distinct source files that fell through the fast path and were parsed.
   */
  filesParsed: number;

  /**
   * Definitions re-resolved and re-fingerprinted (symbol lookups performed).
   */
  definitionsResolved: number;
}

/**
 * The graded outcome of one case.
 */
export interface CaseResult {
  /**
   * The case name.
   */
  name: string;

  /**
   * The case description.
   */
  description: string;

  /**
   * `pass` when the actual states matched the expectation exactly; `fail`
   * otherwise; `skipped` when the case could not be built (for example a symbol
   * that would not resolve, or a mutation that could not be spliced precisely).
   */
  status: "pass" | "fail" | "skipped";

  /**
   * Why the case was skipped or failed, when applicable.
   *
   * @default undefined - the case passed with nothing to explain.
   */
  detail?: string;

  /**
   * The expected not-fresh pages and their pinned states.
   */
  expectedNotFresh: Record<string, NotFreshState>;

  /**
   * The actual state of every page after the mutation.
   */
  actual: Record<string, FreshnessState>;

  /**
   * Expected-not-fresh pages that came back fresh (a detection miss).
   */
  missed: string[];

  /**
   * Expected-fresh pages that came back not-fresh (an unnecessary
   * invalidation).
   */
  falsePositives: string[];

  /**
   * Detected pages whose state did not match the pinned expectation.
   */
  stateMismatches: { page: string; expected: NotFreshState; actual: FreshnessState }[];

  /**
   * Recorded symbols per page, for debugging failures.
   */
  recordedDeps: Record<string, string[]>;

  /**
   * Sweep metrics for this case, or `undefined` when the case was skipped.
   *
   * @default undefined - no sweep ran because the case was skipped.
   */
  metrics?: SweepMetrics;
}

/**
 * A {@link SourceReader} that counts the distinct files it reads successfully,
 * so a sweep can report how many files it hashed without changing production
 * code. Wraps a real reader and forwards every call.
 */
class CountingReader implements SourceReader {
  private readonly seen = new Set<string>();

  /**
   * @param inner - The real reader to delegate to.
   */
  constructor(private readonly inner: SourceReader) {}

  async readSource(path: string): Promise<string | undefined> {
    const bytes = await this.inner.readSource(path);
    if (bytes !== undefined) {
      this.seen.add(path);
    }
    return bytes;
  }

  /**
   * Distinct files that were read and therefore hashed.
   */
  get filesHashed(): number {
    return this.seen.size;
  }
}

/**
 * Dependency reasons that imply the file was parsed (the fast path missed and a
 * grammar ran, whether or not the symbol was ultimately found).
 */
const PARSE_REASONS = new Set([
  "language-unsupported",
  "parse-failed",
  "symbol-not-found",
  "definition-changed",
  "definition-unchanged",
]);

/**
 * Dependency reasons that imply a symbol lookup and definition fingerprint were
 * computed.
 */
const RESOLVE_REASONS = new Set([
  "symbol-not-found",
  "definition-changed",
  "definition-unchanged",
]);

/**
 * Sweep every source-grounded page with the real evaluator, returning every
 * page's report (fresh and not) plus performance counters.
 *
 * This mirrors {@link checkWikiFreshness} but keeps the fresh pages too (the
 * production function returns only drifted pages) and wraps the reader for
 * counting. The classification itself is the real {@link FreshnessEvaluator};
 * only the enumeration loop is duplicated so the eval can instrument it without
 * complicating the production API. Counters are derived from the public
 * per-dependency `reason`, not from any private internals.
 *
 * @param cwd - Repository root to sweep.
 */
async function instrumentedSweep(
  cwd: string,
): Promise<{ reports: PageFreshness[]; metrics: SweepMetrics }> {
  const reader = new CountingReader(new FileSystemSourceReader(cwd));
  const evaluator = new FreshnessEvaluator(sharedResolver, reader);
  const pages = await listSourceGroundedPages(cwd);

  const start = process.hrtime.bigint();
  const reports: PageFreshness[] = [];
  for (const page of pages) {
    const sidecar = await readSidecar(cwd, page);
    if (!sidecar) {
      continue;
    }
    reports.push(await evaluator.evaluatePage(sidecar));
  }
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

  const parsedPaths = new Set<string>();
  let definitionsResolved = 0;
  for (const report of reports) {
    for (const dependency of report.dependencies) {
      if (PARSE_REASONS.has(dependency.reason)) {
        parsedPaths.add(dependency.dependency.path);
      }
      if (RESOLVE_REASONS.has(dependency.reason)) {
        definitionsResolved += 1;
      }
    }
  }

  return {
    reports,
    metrics: {
      durationMs,
      pagesSwept: reports.length,
      filesHashed: reader.filesHashed,
      filesParsed: parsedPaths.size,
      definitionsResolved,
    },
  };
}

/**
 * Seed a temp repo with a case's source files and grounded pages, writing a
 * known-correct sidecar for each page via the real recorder. Returns the
 * recorded symbols per page, or `undefined` when any symbol failed to resolve
 * at definition granularity (so the case is reported skipped rather than run
 * against a degraded sidecar).
 *
 * @param cwd - The temp repository root.
 *
 * @param sources - Source files to write.
 *
 * @param pages - Pages to ground.
 */
async function seedCaseWorld(
  cwd: string,
  sources: readonly SourceFile[],
  pages: readonly PageGrounding[],
): Promise<Record<string, string[]> | undefined> {
  for (const source of sources) {
    await mkdir(dirname(join(cwd, source.path)), { recursive: true });
    await writeFile(join(cwd, source.path), source.text, "utf8");
  }

  const reader = new FileSystemSourceReader(cwd);
  const recordedDeps: Record<string, string[]> = {};

  for (const grounding of pages) {
    const pageBytes = `# ${grounding.symbol}\n\nGrounded in \`${grounding.symbol}\` from \`${grounding.path}\`.\n`;
    await mkdir(dirname(join(cwd, grounding.page)), { recursive: true });
    await writeFile(join(cwd, grounding.page), pageBytes, "utf8");

    const { sidecar } = await recordSourceDependencies({
      page: grounding.page,
      pageBytes,
      requests: [{ path: grounding.path, symbol: grounding.symbol }],
      resolver: sharedResolver,
      reader,
    });

    if (sidecar.sources[0]?.resolution !== "symbol") {
      return undefined;
    }

    await writeSidecarAtomic(cwd, sidecar);
    recordedDeps[grounding.page] = sidecar.sources.map(
      (source) => source.symbol ?? source.path,
    );
  }

  return recordedDeps;
}

/**
 * Apply a mutation to the working tree, returning `undefined` on success or a
 * reason string when the mutation could not be built precisely (so the case is
 * skipped rather than mislabeled).
 *
 * @param cwd - The repository root the file lives under.
 *
 * @param mutation - The mutation to apply.
 */
async function applyMutation(
  cwd: string,
  mutation: Mutation,
): Promise<string | undefined> {
  if (mutation.kind === "replace-file") {
    await writeFile(join(cwd, mutation.path), mutation.text, "utf8");
    return undefined;
  }

  const original = await readFile(join(cwd, mutation.path), "utf8");
  const parsed = await sharedResolver.parseFile(mutation.path, original);
  if (!parsed.parsed) {
    return `could not parse ${mutation.path}`;
  }

  const capture = parsed.definitions.get(mutation.symbol);
  if (!capture) {
    return `symbol ${mutation.symbol} not found in ${mutation.path}`;
  }

  let mutated: string | undefined;
  if (mutation.kind === "literal") {
    const leaf = findLiteralLeaf(capture.node);
    if (!leaf) {
      return `no literal to change inside ${mutation.symbol}`;
    }
    mutated = verifiedSplice(original, leaf, mutateLiteralText(leaf));
  } else if (mutation.kind === "rename") {
    const nameNode = findNameNode(capture.node, capture.name);
    if (!nameNode) {
      return `could not locate the name of ${mutation.symbol}`;
    }
    mutated = verifiedSplice(original, nameNode, mutation.to);
  } else {
    mutated = verifiedSplice(original, capture.node, "");
  }

  if (mutated === undefined) {
    return `offset mismatch splicing ${mutation.symbol} (non-ASCII span)`;
  }

  await writeFile(join(cwd, mutation.path), mutated, "utf8");
  return undefined;
}

/**
 * Build a skipped-case result with a reason.
 *
 * @param testCase - The case that was skipped.
 *
 * @param detail - Why it was skipped.
 */
function skipped(testCase: MutationCase, detail: string): CaseResult {
  return {
    name: testCase.name,
    description: testCase.description,
    status: "skipped",
    detail,
    expectedNotFresh: testCase.expectedNotFresh,
    actual: {},
    missed: [],
    falsePositives: [],
    stateMismatches: [],
    recordedDeps: {},
  };
}

/**
 * Run one deterministic-mechanism case end to end: seed a known-fresh world,
 * apply the mutation, sweep with the real evaluator, and grade the actual page
 * states against the pinned expectation.
 *
 * @param testCase - The case to run.
 */
export async function runMutationCase(
  testCase: MutationCase,
): Promise<CaseResult> {
  return withTempGitRepo(async (cwd) => {
    const recordedDeps = await seedCaseWorld(
      cwd,
      testCase.sources,
      testCase.pages,
    );
    if (!recordedDeps) {
      return skipped(testCase, "a page's symbol did not resolve to a definition");
    }

    // A dirty baseline must fail loudly, never silently pass.
    const baseline = await checkWikiFreshness(cwd);
    if (!baseline.allFresh) {
      return {
        ...skipped(testCase, "baseline was not all-fresh before mutation"),
        status: "fail",
        recordedDeps,
      };
    }

    const mutationError = await applyMutation(cwd, testCase.mutation);
    if (mutationError) {
      return { ...skipped(testCase, mutationError), recordedDeps };
    }

    const { reports, metrics } = await instrumentedSweep(cwd);
    const actual: Record<string, FreshnessState> = {};
    for (const report of reports) {
      actual[report.page] = report.state;
    }

    const missed: string[] = [];
    const stateMismatches: CaseResult["stateMismatches"] = [];
    for (const [page, expectedState] of Object.entries(
      testCase.expectedNotFresh,
    )) {
      const actualState = actual[page] ?? "fresh";
      if (actualState === "fresh") {
        missed.push(page);
      } else if (actualState !== expectedState) {
        stateMismatches.push({ page, expected: expectedState, actual: actualState });
      }
    }

    const falsePositives: string[] = [];
    for (const [page, state] of Object.entries(actual)) {
      if (state !== "fresh" && !(page in testCase.expectedNotFresh)) {
        falsePositives.push(page);
      }
    }

    const pass =
      missed.length === 0 &&
      falsePositives.length === 0 &&
      stateMismatches.length === 0;

    return {
      name: testCase.name,
      description: testCase.description,
      status: pass ? "pass" : "fail",
      expectedNotFresh: testCase.expectedNotFresh,
      actual,
      missed,
      falsePositives,
      stateMismatches,
      recordedDeps,
      metrics,
    };
  });
}

/**
 * The gitHead durability case: prove freshness is independent of the git
 * cursor. A cited definition changes and the page goes stale; the cursor is
 * then advanced past the change (an interrupted or partial run) so the git diff
 * is empty; the page must still be not-fresh, and the real
 * {@link getUpdateNoopStatus} must refuse to skip.
 */
export async function runDurabilityCase(): Promise<CaseResult> {
  const name = "githead-durability";
  const description =
    "advancing gitHead past an unrepaired change does not launder the page fresh";

  return withTempGitRepo(async (cwd) => {
    await seedGeneratedWiki(cwd);
    const page = "openwiki/architecture/auth.md";

    const base = await checkWikiFreshness(cwd);
    if (!base.allFresh) {
      return {
        name,
        description,
        status: "fail",
        detail: "seeded wiki was not all-fresh",
        expectedNotFresh: { [page]: "stale" },
        actual: {},
        missed: [],
        falsePositives: [],
        stateMismatches: [],
        recordedDeps: {},
      };
    }

    // Change the cited definition and commit it, so HEAD advances past it.
    await writeFile(join(cwd, "src", "auth.ts"), AUTH_V2, "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "change AuthService.authenticate"]);

    const afterChange = await instrumentedSweep(cwd);
    const staleNow = afterChange.reports.find((report) => report.page === page);

    // Advance the recorded cursor to the current HEAD without repairing the
    // page, then commit that metadata bump so the worktree is clean.
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const metadataPath = join(cwd, "openwiki", ".last-update.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    metadata.gitHead = head;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "advance cursor without regrounding"]);

    // git diff cursor..HEAD is now empty and the worktree is clean.
    const noop = await getUpdateNoopStatus(cwd);
    const { reports, metrics } = await instrumentedSweep(cwd);
    const durable = reports.find((report) => report.page === page);

    const actual: Record<string, FreshnessState> = {};
    for (const report of reports) {
      actual[report.page] = report.state;
    }

    const problems: string[] = [];
    if (staleNow?.state !== "stale") {
      problems.push(
        `page was ${staleNow?.state ?? "missing"} right after the change, expected stale`,
      );
    }
    if (durable?.state !== "stale") {
      problems.push(
        `page was ${durable?.state ?? "missing"} after the cursor advanced, expected stale`,
      );
    }
    if (noop.shouldSkip) {
      problems.push("getUpdateNoopStatus would still skip despite the drift");
    }

    const missed = durable?.state === "stale" ? [] : [page];
    return {
      name,
      description,
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0
          ? `preflight refused to skip (${noop.shouldSkip ? "skip" : "reason: " + (noop as { reason: string }).reason})`
          : problems.join("; "),
      expectedNotFresh: { [page]: "stale" },
      actual,
      missed,
      falsePositives: [],
      stateMismatches: [],
      recordedDeps: {},
      metrics,
    };
  });
}

// --- Category 1: deterministic mechanism cases ------------------------------

// Constants are carried inside functions because the grammar tag queries only
// capture callable and type definitions, not bare `const`/assignment bindings,
// so a top-level `const` is not a groundable symbol.
const CONFIG_TS = [
  "export function tokenTtlHours(): number {",
  "  return 24;",
  "}",
  "export function maxRetries(): number {",
  "  return 3;",
  "}",
  "",
].join("\n");

const AUTH_SIGNATURE_CHANGED = [
  "export class AuthService {",
  "  authenticate(account: string, strict: boolean): string {",
  "    return account.trim();",
  "  }",
  "}",
  "",
].join("\n");

const UNRELATED_TS = [
  "export function helper(): number {",
  "  return 42;",
  "}",
  "",
].join("\n");

const CONFIG_PY = [
  "def token_ttl_hours():",
  "    return 24",
  "",
  "def max_retries():",
  "    return 3",
  "",
].join("\n");

/**
 * The deterministic-mechanism cases. Small on purpose: a positive mutation of
 * each kind and the negative controls that prove selectivity. These are the
 * CI-suitable regression core and should all pass.
 */
export const MECHANISM_CASES: readonly MutationCase[] = [
  {
    name: "constant-change",
    description:
      "changing a cited constant flags its page; the neighbor symbol in the same file stays fresh",
    sources: [{ path: "src/config.ts", text: CONFIG_TS }],
    pages: [
      { page: "openwiki/pages/token.md", path: "src/config.ts", symbol: "tokenTtlHours" },
      { page: "openwiki/pages/retries.md", path: "src/config.ts", symbol: "maxRetries" },
    ],
    mutation: { kind: "literal", path: "src/config.ts", symbol: "tokenTtlHours" },
    expectedNotFresh: { "openwiki/pages/token.md": "stale" },
  },
  {
    name: "neighbor-symbol-same-file",
    description:
      "changing an unrelated symbol in the same file leaves the cited page fresh (definition-level, not file-level)",
    sources: [{ path: "src/config.ts", text: CONFIG_TS }],
    pages: [
      { page: "openwiki/pages/token.md", path: "src/config.ts", symbol: "tokenTtlHours" },
    ],
    mutation: { kind: "literal", path: "src/config.ts", symbol: "maxRetries" },
    expectedNotFresh: {},
  },
  {
    name: "signature-change",
    description: "changing a cited method's signature flags its page",
    sources: [{ path: "src/auth.ts", text: AUTH_V1 }],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: {
      kind: "replace-file",
      path: "src/auth.ts",
      text: AUTH_SIGNATURE_CHANGED,
    },
    expectedNotFresh: { "openwiki/pages/auth.md": "stale" },
  },
  {
    name: "body-change",
    description: "a semantic body change to a cited method flags its page",
    sources: [{ path: "src/auth.ts", text: AUTH_V1 }],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: { kind: "replace-file", path: "src/auth.ts", text: AUTH_V2 },
    expectedNotFresh: { "openwiki/pages/auth.md": "stale" },
  },
  {
    name: "rename",
    description: "renaming a cited symbol marks its page unknown (the anchor moved)",
    sources: [{ path: "src/auth.ts", text: AUTH_V1 }],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: {
      kind: "rename",
      path: "src/auth.ts",
      symbol: "AuthService.authenticate",
      to: "authenticateUser",
    },
    expectedNotFresh: { "openwiki/pages/auth.md": "unknown" },
  },
  {
    name: "delete",
    description: "deleting a cited symbol marks its page unknown",
    sources: [{ path: "src/auth.ts", text: AUTH_V1 }],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: { kind: "delete", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    expectedNotFresh: { "openwiki/pages/auth.md": "unknown" },
  },
  {
    name: "reformat-only",
    description: "reformatting a cited definition leaves its page fresh (canonicalization)",
    sources: [{ path: "src/auth.ts", text: AUTH_V1 }],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: {
      kind: "replace-file",
      path: "src/auth.ts",
      text: AUTH_V1_REFORMATTED,
    },
    expectedNotFresh: {},
  },
  {
    name: "unrelated-file",
    description: "changing a completely unrelated file leaves every page fresh",
    sources: [
      { path: "src/auth.ts", text: AUTH_V1 },
      { path: "src/unrelated.ts", text: UNRELATED_TS },
    ],
    pages: [
      { page: "openwiki/pages/auth.md", path: "src/auth.ts", symbol: "AuthService.authenticate" },
    ],
    mutation: {
      kind: "replace-file",
      path: "src/unrelated.ts",
      text: UNRELATED_TS.replace("42", "7"),
    },
    expectedNotFresh: {},
  },
  {
    name: "python-constant-change",
    description: "the mechanism holds across grammars: a changed Python constant flags its page",
    sources: [{ path: "src/config.py", text: CONFIG_PY }],
    pages: [
      { page: "openwiki/pages/py-token.md", path: "src/config.py", symbol: "token_ttl_hours" },
    ],
    mutation: { kind: "literal", path: "src/config.py", symbol: "token_ttl_hours" },
    expectedNotFresh: { "openwiki/pages/py-token.md": "stale" },
  },
];

// --- Category 2: end-to-end coverage over real source -----------------------

/**
 * Maximum symbols probed per source file, so a coverage sample spans many files
 * rather than exhausting itself on the first few large ones.
 */
const PER_FILE_CAP = 6;

/**
 * The aggregate outcome of the real-source coverage pass.
 */
export interface CoverageOutcome {
  /**
   * Source files scanned for groundable symbols.
   */
  filesScanned: number;

  /**
   * Symbols that grounded successfully and were probed.
   */
  symbolsSampled: number;

  /**
   * Symbols skipped because they would not ground at definition granularity.
   */
  symbolsSkipped: number;

  /**
   * Positive probes run (a semantic change was applied and detection expected).
   */
  positiveProbes: number;

  /**
   * Positive probes the preflight correctly flagged.
   */
  detected: number;

  /**
   * Positive probes the preflight missed, with their symbols.
   */
  missed: { path: string; symbol: string }[];

  /**
   * Negative (cosmetic-churn) probes run, where the page must stay fresh.
   */
  cosmeticProbes: number;

  /**
   * Cosmetic probes that were wrongly flagged, with their symbols.
   */
  falsePositives: { path: string; symbol: string }[];

  /**
   * Summed sweep metrics across every probe.
   */
  metrics: SweepMetrics;
}

/**
 * Recursively list `.ts` source files under a directory, excluding declaration
 * files, in sorted order for determinism.
 *
 * @param root - Absolute directory to walk.
 */
async function listSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(full);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * Add one sweep's metrics into a running total.
 *
 * @param total - The accumulator to add into.
 *
 * @param next - The sweep metrics to add.
 */
function addMetrics(total: SweepMetrics, next: SweepMetrics): void {
  total.durationMs += next.durationMs;
  total.pagesSwept += next.pagesSwept;
  total.filesHashed += next.filesHashed;
  total.filesParsed += next.filesParsed;
  total.definitionsResolved += next.definitionsResolved;
}

/**
 * Run the end-to-end coverage pass over a real source tree. For a deterministic
 * sample of real symbols the production recorder grounds a page, then a
 * semantic literal change is applied (must be detected) and, separately, a
 * cosmetic churn is applied (must stay fresh). This exercises the real
 * recorder plus the real preflight over real definitions; it does not judge the
 * agent's symbol-selection, which needs a real generated wiki (Tier B).
 *
 * @param srcRoot - Absolute path to the source tree to sample.
 *
 * @param sampleSize - Maximum number of symbols to probe.
 */
export async function runCoveragePipeline(
  srcRoot: string,
  sampleSize: number,
): Promise<CoverageOutcome> {
  const files = await listSourceFiles(srcRoot);
  const metrics: SweepMetrics = {
    durationMs: 0,
    pagesSwept: 0,
    filesHashed: 0,
    filesParsed: 0,
    definitionsResolved: 0,
  };
  const outcome: CoverageOutcome = {
    filesScanned: 0,
    symbolsSampled: 0,
    symbolsSkipped: 0,
    positiveProbes: 0,
    detected: 0,
    missed: [],
    cosmeticProbes: 0,
    falsePositives: [],
    metrics,
  };

  for (const file of files) {
    if (outcome.symbolsSampled >= sampleSize) {
      break;
    }
    outcome.filesScanned += 1;

    const repoPath = relative(dirname(srcRoot), file).split("\\").join("/");
    const text = await readFile(file, "utf8");
    const parsed = await sharedResolver.parseFile(repoPath, text);
    if (!parsed.parsed) {
      continue;
    }

    // Cap symbols per file so the sample spans the tree instead of exhausting
    // itself on the first few large files.
    let takenFromFile = 0;
    for (const [symbol, capture] of parsed.definitions) {
      if (outcome.symbolsSampled >= sampleSize || takenFromFile >= PER_FILE_CAP) {
        break;
      }

      const testCase: MutationCase = {
        name: `coverage:${symbol}`,
        description: "real-source coverage probe",
        sources: [{ path: repoPath, text }],
        pages: [{ page: "openwiki/pages/probe.md", path: repoPath, symbol }],
        mutation: { kind: "literal", path: repoPath, symbol },
        expectedNotFresh: { "openwiki/pages/probe.md": "stale" },
      };

      const hasLiteral = findLiteralLeaf(capture.node) !== undefined;

      const result = await withTempGitRepo(async (cwd) => {
        const recorded = await seedCaseWorld(
          cwd,
          testCase.sources,
          testCase.pages,
        );
        if (!recorded) {
          return "unresolved" as const;
        }

        const baseline = await checkWikiFreshness(cwd);
        if (!baseline.allFresh) {
          return "unresolved" as const;
        }

        // Positive probe: a semantic literal change must be detected.
        let positiveDetected: boolean | undefined;
        if (hasLiteral) {
          const err = await applyMutation(cwd, testCase.mutation);
          if (!err) {
            const swept = await instrumentedSweep(cwd);
            addMetrics(metrics, swept.metrics);
            const report = swept.reports.find(
              (entry) => entry.page === "openwiki/pages/probe.md",
            );
            positiveDetected = report?.state !== undefined && report.state !== "fresh";
          }
          // Restore before the cosmetic probe.
          await writeFile(join(cwd, repoPath), text, "utf8");
        }

        // Negative probe: cosmetic churn must stay fresh.
        const churned = cosmeticChurn(text, ".ts");
        await writeFile(join(cwd, repoPath), churned, "utf8");
        const cosmeticSweep = await instrumentedSweep(cwd);
        addMetrics(metrics, cosmeticSweep.metrics);
        const cosmeticReport = cosmeticSweep.reports.find(
          (entry) => entry.page === "openwiki/pages/probe.md",
        );
        const cosmeticFlagged =
          cosmeticReport?.state !== undefined && cosmeticReport.state !== "fresh";

        return { positiveDetected, cosmeticFlagged };
      });

      if (result === "unresolved") {
        outcome.symbolsSkipped += 1;
        continue;
      }

      outcome.symbolsSampled += 1;
      takenFromFile += 1;

      if (result.positiveDetected !== undefined) {
        outcome.positiveProbes += 1;
        if (result.positiveDetected) {
          outcome.detected += 1;
        } else {
          outcome.missed.push({ path: repoPath, symbol });
        }
      }

      outcome.cosmeticProbes += 1;
      if (result.cosmeticFlagged) {
        outcome.falsePositives.push({ path: repoPath, symbol });
      }
    }
  }

  return outcome;
}
