/**
 * Literal head-to-head: OpenWiki's real update gate WITHOUT source freshness vs
 * WITH source freshness, on the same repo, wiki, and mutations. The only
 * variable between the two arms is whether recorded sidecars exist.
 *
 * The claim under test:
 *
 *   Git is sufficient while the relevant change is still visible. Source
 *   freshness makes stale state durable after Git no longer contains the
 *   evidence needed to rediscover it.
 *
 * No model is invoked. The differentiator lives entirely in the production
 * `getUpdateNoopStatus` decision (`src/agent/utils.ts`): today source freshness
 * only ever runs there, as a skip-veto, after Git has already reported nothing
 * meaningful moved. So "revisited / recovered" here means the real update gate
 * decided to run (`shouldSkip === false`). Whether the agent then repairs the
 * page is out of scope: it is the same agent in both arms, so it cannot be the
 * differentiator.
 *
 * The corpus is OpenWiki's own wiki and source: real pages under `openwiki/`
 * are grounded in real symbols from `src/` using the production recorder, so
 * the sidecars are the ones OpenWiki itself would author, not hand-written.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cosmeticChurn,
  findLiteralLeaf,
  findNameNode,
  git,
  mutateLiteralText,
  sharedResolver,
  verifiedSplice,
  withTempGitRepo,
} from "../freshness/harness.js";
import { getUpdateNoopStatus, writeLastUpdateMetadata } from "../../src/agent/utils.js";
import { FileSystemSourceReader } from "../../src/staleness/freshness.js";
import { checkWikiFreshness } from "../../src/staleness/preflight.js";
import { recordSourceDependencies } from "../../src/staleness/recorder.js";
import { writeSidecarAtomic } from "../../src/staleness/storage.js";

/**
 * The kind of source edit a case applies.
 *
 * `literal`, `rename`, and `delete` are positive mutations that should make the
 * grounded page stale. `reformat`, `neighbor`, and `unrelated-file` are
 * negative controls that must leave it fresh.
 */
export type MutationKind =
  | "literal"
  | "rename"
  | "delete"
  | "reformat"
  | "neighbor"
  | "unrelated-file";

/**
 * A real page grounded in a real symbol from this repository.
 */
export interface Grounding {
  /**
   * Repository-relative path of the wiki page (under `openwiki/`).
   */
  page: string;

  /**
   * Repository-relative path of the source file the page is grounded in.
   */
  path: string;

  /**
   * Qualified symbol name the page is grounded in.
   */
  symbol: string;
}

/**
 * One head-to-head case: a grounding plus the edit to apply to it.
 */
export interface HeadToHeadCase {
  /**
   * Short stable identifier for the case.
   */
  name: string;

  /**
   * One-line description of the scenario.
   */
  description: string;

  /**
   * The real page and symbol this case grounds and mutates.
   */
  grounding: Grounding;

  /**
   * The edit to apply.
   */
  kind: MutationKind;

  /**
   * Whether the mutation should make the grounded page stale. `true` for
   * positive mutations, `false` for negative controls.
   */
  expectedStale: boolean;
}

/**
 * The outcome of running one arm through the real update gate.
 */
export interface ArmDecision {
  /**
   * Whether the update gate decided to run (`shouldSkip === false`). This is
   * the signal that the stale page would be revisited.
   */
  ran: boolean;

  /**
   * The gate's own reason string, verbatim, for the report.
   */
  reason: string;
}

/**
 * A situation measured for a single case: both arms under one cursor position.
 */
export interface SituationResult {
  /**
   * The arm with no sidecars recorded (Git-only behavior, i.e. pre-feature).
   */
  without: ArmDecision;

  /**
   * The arm with sidecars recorded by the production recorder.
   */
  with: ArmDecision;
}

/**
 * The full comparison for one case.
 */
export interface CaseComparison {
  /**
   * The case that was run.
   */
  case: HeadToHeadCase;

  /**
   * In-range situation (cursor sits before the change; Git still sees it).
   * Only measured for positive mutations, where it demonstrates parity.
   *
   * @default undefined - Not measured for negative controls.
   */
  inRange?: SituationResult;

  /**
   * After-advance situation: the page was left unrepaired and the cursor moved
   * past the change, so `git diff` is empty. This is the failure state the
   * feature protects against.
   */
  afterAdvance: SituationResult;

  /**
   * Wall-clock milliseconds the freshness preflight added on the with-freshness
   * arm in the after-advance situation.
   */
  freshnessMs: number;
}

/**
 * Aggregate counts across every case, in the shape of the results table.
 */
export interface HeadToHeadAggregate {
  /**
   * Number of positive mutations.
   */
  positives: number;

  /**
   * Number of negative controls.
   */
  controls: number;

  /**
   * Positive in-range changes that triggered a run, per arm.
   */
  inRangeRan: { without: number; with: number };

  /**
   * Positive stale pages recovered (run triggered) after the cursor advanced,
   * per arm.
   */
  recoveredAfterAdvance: { without: number; with: number };

  /**
   * Negative controls that triggered a spurious run after the cursor advanced,
   * per arm. Lower is better; the feature must not add false reruns.
   */
  spuriousReruns: { without: number; with: number };

  /**
   * Median added freshness preflight cost in milliseconds.
   */
  medianFreshnessMs: number;
}

/**
 * The complete head-to-head report.
 */
export interface HeadToHeadReport {
  /**
   * Per-case comparisons.
   */
  cases: CaseComparison[];

  /**
   * Aggregate table counts.
   */
  aggregate: HeadToHeadAggregate;

  /**
   * Whether the core claim held for every case: without freshness never
   * recovers a stale page after the cursor advances, with freshness always
   * does, and no control triggers a spurious rerun on either arm.
   */
  claimHolds: boolean;
}

/**
 * The real groundings used as the corpus: each is a real wiki page in this repo
 * grounded in a real callable it documents. Kept small and hand-labeled so the
 * expected-stale ground truth comes from us, never from the agent or sidecars.
 */
export const HEAD_TO_HEAD_CASES: readonly HeadToHeadCase[] = [
  {
    name: "constant-change",
    description:
      "A cited hash-algorithm literal in createOpenWikiContentSnapshot changes.",
    grounding: {
      page: "openwiki/operations/credentials-and-updates.md",
      path: "src/agent/utils.ts",
      symbol: "createOpenWikiContentSnapshot",
    },
    kind: "literal",
    expectedStale: true,
  },
  {
    name: "rename-http-helper",
    description: "The cited fetchWithResilience helper is renamed.",
    grounding: {
      page: "openwiki/integrations/connectors.md",
      path: "src/connectors/http.ts",
      symbol: "fetchWithResilience",
    },
    kind: "rename",
    expectedStale: true,
  },
  {
    name: "delete-registry-factory",
    description: "The cited createConnectorRegistry factory is removed.",
    grounding: {
      page: "openwiki/integrations/connectors.md",
      path: "src/connectors/registry.ts",
      symbol: "createConnectorRegistry",
    },
    kind: "delete",
    expectedStale: true,
  },
  {
    name: "rename-backend-factory",
    description: "The cited createAgentBackend factory is renamed.",
    grounding: {
      page: "openwiki/architecture/overview.md",
      path: "src/agent/index.ts",
      symbol: "createAgentBackend",
    },
    kind: "rename",
    expectedStale: true,
  },
  {
    name: "delete-crash-guard",
    description: "The cited clearActiveRun crash-guard helper is removed.",
    grounding: {
      page: "openwiki/agent/workflow.md",
      path: "src/agent/crash-guard.ts",
      symbol: "clearActiveRun",
    },
    kind: "delete",
    expectedStale: true,
  },
  {
    name: "reformat-only",
    description:
      "createOpenWikiContentSnapshot is reformatted (comment + whitespace) with no token change.",
    grounding: {
      page: "openwiki/operations/credentials-and-updates.md",
      path: "src/agent/utils.ts",
      symbol: "createOpenWikiContentSnapshot",
    },
    kind: "reformat",
    expectedStale: false,
  },
  {
    name: "neighbor-symbol",
    description:
      "An unrelated symbol in the same file as fetchWithResilience changes.",
    grounding: {
      page: "openwiki/integrations/connectors.md",
      path: "src/connectors/http.ts",
      symbol: "fetchWithResilience",
    },
    kind: "neighbor",
    expectedStale: false,
  },
  {
    name: "unrelated-file",
    description:
      "A completely unrelated file changes; the page's grounded file is untouched.",
    grounding: {
      page: "openwiki/architecture/overview.md",
      path: "src/agent/index.ts",
      symbol: "createAgentBackend",
    },
    kind: "unrelated-file",
    expectedStale: false,
  },
];

/**
 * Absolute path to a repository-relative path.
 *
 * @param repoRoot - Absolute path to the repository root.
 *
 * @param relativePath - Repository-relative path.
 */
function abs(repoRoot: string, relativePath: string): string {
  return join(repoRoot, relativePath);
}

/**
 * Copy one real repository file into the temp repo at the same relative path.
 *
 * @param repoRoot - Source repository root (read-only).
 *
 * @param cwd - Destination temp repo.
 *
 * @param relativePath - Repository-relative path to copy.
 */
async function copyRealFile(
  repoRoot: string,
  cwd: string,
  relativePath: string,
): Promise<string> {
  const bytes = await readFile(abs(repoRoot, relativePath), "utf8");
  const destination = abs(cwd, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, "utf8");
  return bytes;
}

/**
 * Path of the throwaway file the `unrelated-file` control mutates.
 */
const UNRELATED_EVAL_FILE = "src/__openwiki_eval_unrelated__.ts";

/**
 * Seed a temp git repo from OpenWiki's own page and source, optionally
 * recording the sidecar with the production recorder, and set the update cursor
 * to the current HEAD. Leaves a clean worktree.
 *
 * @param cwd - The temp repo.
 *
 * @param testCase - The case being seeded.
 *
 * @param repoRoot - The real repository root (read-only source of files).
 *
 * @param withSidecars - Whether to record the with-freshness arm's sidecar.
 */
async function seed(
  cwd: string,
  testCase: HeadToHeadCase,
  repoRoot: string,
  withSidecars: boolean,
): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main"]);

  await copyRealFile(repoRoot, cwd, testCase.grounding.path);
  const pageBytes = await copyRealFile(repoRoot, cwd, testCase.grounding.page);
  if (testCase.kind === "unrelated-file") {
    const destination = abs(cwd, UNRELATED_EVAL_FILE);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "export const evalMarker = 1;\n", "utf8");
  }

  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "seed"]);

  if (withSidecars) {
    const reader = new FileSystemSourceReader(cwd);
    const { sidecar } = await recordSourceDependencies({
      page: testCase.grounding.page,
      pageBytes,
      requests: [
        { path: testCase.grounding.path, symbol: testCase.grounding.symbol },
      ],
      resolver: sharedResolver,
      reader,
    });

    const resolution = sidecar.sources[0]?.resolution;
    if (resolution !== "symbol") {
      throw new Error(
        `${testCase.name}: expected symbol-level grounding for ` +
          `${testCase.grounding.symbol}, got ${resolution ?? "none"}`,
      );
    }

    await writeSidecarAtomic(cwd, sidecar);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "sidecars"]);
  }

  await writeLastUpdateMetadata("update", cwd, "eval-model");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "metadata"]);
}

/**
 * Apply the case's edit to the on-disk source. Byte-level only: source is
 * parsed and spliced, never evaluated or executed.
 *
 * @param cwd - The temp repo.
 *
 * @param testCase - The case whose mutation to apply.
 */
async function mutateSource(cwd: string, testCase: HeadToHeadCase): Promise<void> {
  if (testCase.kind === "unrelated-file") {
    const destination = abs(cwd, UNRELATED_EVAL_FILE);
    await writeFile(destination, "export const evalMarker = 2;\n", "utf8");
    return;
  }

  const sourcePath = testCase.grounding.path;
  const destination = abs(cwd, sourcePath);
  const original = await readFile(destination, "utf8");

  if (testCase.kind === "reformat") {
    await writeFile(destination, cosmeticChurn(original, extname(sourcePath)), "utf8");
    return;
  }

  const parsed = await sharedResolver.parseFile(sourcePath, original);

  if (testCase.kind === "neighbor") {
    for (const [key, capture] of parsed.definitions) {
      if (key === testCase.grounding.symbol) {
        continue;
      }
      const nameNode = findNameNode(capture.node, capture.name);
      const spliced = nameNode
        ? verifiedSplice(original, nameNode, `${capture.name}Renamed`)
        : undefined;
      if (spliced) {
        await writeFile(destination, spliced, "utf8");
        return;
      }
    }
    throw new Error(`${testCase.name}: no mutable neighbor symbol found`);
  }

  const capture = parsed.definitions.get(testCase.grounding.symbol);
  if (!capture) {
    throw new Error(
      `${testCase.name}: symbol ${testCase.grounding.symbol} not found`,
    );
  }

  let spliced: string | undefined;
  if (testCase.kind === "literal") {
    const leaf = findLiteralLeaf(capture.node);
    spliced = leaf
      ? verifiedSplice(original, leaf, mutateLiteralText(leaf))
      : undefined;
  } else if (testCase.kind === "rename") {
    const nameNode = findNameNode(capture.node, capture.name);
    spliced = nameNode
      ? verifiedSplice(original, nameNode, `${capture.name}Renamed`)
      : undefined;
  } else {
    spliced = verifiedSplice(original, capture.node, "");
  }

  if (spliced === undefined) {
    throw new Error(`${testCase.name}: ${testCase.kind} splice failed`);
  }

  await writeFile(destination, spliced, "utf8");
}

/**
 * The situation a case is measured under.
 *
 * `in-range` leaves the cursor before the change (Git still sees it).
 * `after-advance` advances the cursor past the unrepaired change (empty diff).
 */
type Situation = "in-range" | "after-advance";

/**
 * Build a temp repo for one arm and situation, run the real update gate, and
 * return its decision plus the freshness preflight cost.
 *
 * @param testCase - The case to run.
 *
 * @param repoRoot - The real repository root.
 *
 * @param situation - Cursor position for this measurement.
 *
 * @param withSidecars - Whether this is the with-freshness arm.
 */
async function buildAndDecide(
  testCase: HeadToHeadCase,
  repoRoot: string,
  situation: Situation,
  withSidecars: boolean,
): Promise<{ decision: ArmDecision; freshnessMs: number }> {
  return withTempGitRepo(async (cwd) => {
    await seed(cwd, testCase, repoRoot, withSidecars);

    await mutateSource(cwd, testCase);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "mutation"]);

    if (situation === "after-advance") {
      await writeLastUpdateMetadata("update", cwd, "eval-model");
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-q", "-m", "advance-cursor"]);
    }

    const start = process.hrtime.bigint();
    await checkWikiFreshness(cwd);
    const freshnessMs = Number(process.hrtime.bigint() - start) / 1e6;

    const status = await getUpdateNoopStatus(cwd);
    return {
      decision: {
        ran: !status.shouldSkip,
        reason: status.shouldSkip ? "" : status.reason,
      },
      freshnessMs,
    };
  });
}

/**
 * Run one case end to end and return its comparison.
 *
 * @param testCase - The case to run.
 *
 * @param repoRoot - The real repository root.
 */
export async function runHeadToHeadCase(
  testCase: HeadToHeadCase,
  repoRoot: string,
): Promise<CaseComparison> {
  const afterWithout = await buildAndDecide(
    testCase,
    repoRoot,
    "after-advance",
    false,
  );
  const afterWith = await buildAndDecide(testCase, repoRoot, "after-advance", true);

  const comparison: CaseComparison = {
    case: testCase,
    afterAdvance: { without: afterWithout.decision, with: afterWith.decision },
    freshnessMs: afterWith.freshnessMs,
  };

  if (testCase.expectedStale) {
    const inWithout = await buildAndDecide(testCase, repoRoot, "in-range", false);
    const inWith = await buildAndDecide(testCase, repoRoot, "in-range", true);
    comparison.inRange = {
      without: inWithout.decision,
      with: inWith.decision,
    };
  }

  return comparison;
}

/**
 * The repository root, derived from this file's location.
 */
export function repositoryRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * The median of a list of numbers, or 0 for an empty list.
 *
 * @param values - The numbers to summarize.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Run every case and aggregate into the head-to-head report.
 *
 * @param repoRoot - The real repository root. Defaults to this repo.
 */
export async function runHeadToHead(
  repoRoot: string = repositoryRoot(),
): Promise<HeadToHeadReport> {
  const cases: CaseComparison[] = [];
  for (const testCase of HEAD_TO_HEAD_CASES) {
    cases.push(await runHeadToHeadCase(testCase, repoRoot));
  }

  const positives = cases.filter((c) => c.case.expectedStale);
  const controls = cases.filter((c) => !c.case.expectedStale);

  const aggregate: HeadToHeadAggregate = {
    positives: positives.length,
    controls: controls.length,
    inRangeRan: {
      without: positives.filter((c) => c.inRange?.without.ran).length,
      with: positives.filter((c) => c.inRange?.with.ran).length,
    },
    recoveredAfterAdvance: {
      without: positives.filter((c) => c.afterAdvance.without.ran).length,
      with: positives.filter((c) => c.afterAdvance.with.ran).length,
    },
    spuriousReruns: {
      without: controls.filter((c) => c.afterAdvance.without.ran).length,
      with: controls.filter((c) => c.afterAdvance.with.ran).length,
    },
    medianFreshnessMs: median(cases.map((c) => c.freshnessMs)),
  };

  const claimHolds =
    aggregate.recoveredAfterAdvance.without === 0 &&
    aggregate.recoveredAfterAdvance.with === positives.length &&
    aggregate.spuriousReruns.without === 0 &&
    aggregate.spuriousReruns.with === 0;

  return { cases, aggregate, claimHolds };
}
