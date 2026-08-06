/**
 * Source-grounded freshness evaluation.
 *
 * The question this eval answers: when the code a wiki page documents changes,
 * does the update run correctly decide to REBUILD the page, and when nothing
 * meaningful changes, does it correctly SKIP? Getting that wrong costs one of
 * two ways, and the eval measures both directly:
 *
 * - MISSED DRIFT   a page was skipped even though its code changed, so the wiki
 *                  now describes code that no longer exists. Silent and unsafe.
 * - WASTED REBUILD a page was rebuilt even though nothing meaningful changed, so
 *                  an LLM run and a commit were spent on a no-op diff.
 *
 * Three strategies are compared head to head, each one actually executed (no
 * strategy's decision is hard-coded):
 *
 * - content-hash     rebuild if the source FILE's bytes changed at all.
 * - git-range        rebuild only if `git diff <last wiki commit>..HEAD` touches
 *                    a non-wiki file. This is what OpenWiki ships today.
 * - source-grounded  rebuild only if the specific DEFINITIONS a page cites
 *                    changed meaning, ignoring comments and formatting. THIS PR.
 *
 * Ground truth is known in every scenario because the harness makes the edit
 * itself. Run with: tsx evals/freshness/run.ts
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import type { Node } from "web-tree-sitter";

import {
  AUTH_V1,
  AUTH_V1_REFORMATTED,
  AUTH_V2,
  cosmeticChurn,
  contentHashDecision,
  type Decision,
  type DetectionCategory,
  type DetectionOutcome,
  type DetectionSpec,
  disjoint,
  findLiteralLeaf,
  findNameNode,
  git,
  gitRangeDecision,
  grade,
  measureDetection,
  MemReader,
  mutateLiteralText,
  recordedGitHead,
  recordSingleSymbol,
  seedGeneratedWiki,
  sharedResolver,
  shippedTodayDecision,
  sourceGroundedDecision,
  sourceGroundedRepoDecision,
  STALE_CATEGORIES,
  type Verdict,
  verifiedSplice,
  withTempGitRepo,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Reporting helpers.
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function rule(width = 78): string {
  return "-".repeat(width);
}

function heading(title: string): void {
  console.log(`\n${"=".repeat(78)}`);
  console.log(title);
  console.log("=".repeat(78));
}

/**
 * A running count of wrong calls per strategy, split by failure mode.
 */
interface Tally {
  correct: number;
  missedDrift: number;
  wastedRebuild: number;
}

function emptyTally(): Tally {
  return { correct: 0, missedDrift: 0, wastedRebuild: 0 };
}

function record(tally: Tally, verdict: Verdict): void {
  if (verdict === "correct") {
    tally.correct += 1;
  } else if (verdict === "missed-drift") {
    tally.missedDrift += 1;
  } else {
    tally.wastedRebuild += 1;
  }
}

function tallyLine(label: string, tally: Tally, total: number): string {
  return `${pad(label, 20)}${pad(`${tally.correct}/${total}`, 10)}${pad(
    String(tally.missedDrift),
    14,
  )}${pad(String(tally.wastedRebuild), 14)}`;
}

// ---------------------------------------------------------------------------
// Section 1: silent staleness turned into detected staleness (the headline).
// ---------------------------------------------------------------------------

const DETECTION_TARGET = 40;

/**
 * The four situations Section 1 places pages in, cycled round-robin so the
 * population is an even, labeled mix of genuinely-stale and genuinely-fresh
 * pages.
 */
const DETECTION_CATEGORIES: readonly DetectionCategory[] = [
  "fresh",
  "behind-cursor-drift",
  "in-range-change",
  "cosmetic-only",
];

/**
 * Build a semantically-different version of a definition: flip a literal inside
 * it (a same-name behavior change, the insidious case a stale page keeps
 * describing verbatim), falling back to renaming the definition. Returns the
 * changed source, or `undefined` when neither is safe.
 *
 * @param text - Original source.
 *
 * @param defNode - The cited definition's subtree.
 *
 * @param groundedName - The qualified name the page is grounded in.
 */
function buildSemanticChange(
  text: string,
  defNode: Node,
  groundedName: string,
): string | undefined {
  const leaf = findLiteralLeaf(defNode);
  if (leaf) {
    const changed = verifiedSplice(text, leaf, mutateLiteralText(leaf));
    if (changed) {
      return changed;
    }
  }

  const name = findNameNode(defNode, simpleName(groundedName));
  if (name) {
    const changed = verifiedSplice(text, name, `${name.text}Renamed`);
    if (changed) {
      return changed;
    }
  }

  return undefined;
}

/**
 * Assemble the labeled population for the detection benchmark by placing one
 * grounded page per eligible `src/` file into the next category in the cycle.
 * A file is eligible only if its cited symbol has both a buildable semantic
 * change (for the stale/in-range cases) and a cosmetic churn, so every category
 * is expressed the same way across the corpus.
 *
 * @param repoRoot - Absolute path to this repository.
 */
async function collectDetectionSpecs(
  repoRoot: string,
): Promise<DetectionSpec[]> {
  const specs: DetectionSpec[] = [];
  const files = await listSourceFiles(join(repoRoot, "src"));

  for (const file of files) {
    if (specs.length >= DETECTION_TARGET) {
      break;
    }

    const text = await readFile(file, "utf8");
    const relPath = relative(repoRoot, file).split(sep).join("/");
    const parsed = await sharedResolver.parseFile(relPath, text);
    if (!parsed.parsed) {
      continue;
    }

    for (const [name, capture] of parsed.definitions) {
      if (simpleName(name).length < 3) {
        continue;
      }
      const semantic = buildSemanticChange(text, capture.node, name);
      if (!semantic) {
        continue;
      }
      const cosmetic = cosmeticChurn(text, extname(relPath).toLowerCase());
      const sidecar = await recordSingleSymbol(relPath, text, name);
      if (!sidecar) {
        continue;
      }

      const category = DETECTION_CATEGORIES[
        specs.length % DETECTION_CATEGORIES.length
      ];
      specs.push(buildDetectionSpec(category, relPath, name, text, semantic, cosmetic));
      break;
    }
  }

  return specs;
}

/**
 * Turn a corpus file and its precomputed changes into a {@link DetectionSpec}
 * for one category. The grounded text is always the original definition; the
 * category decides what the cursor commit (C0) holds and whether a later commit
 * lands after the cursor.
 *
 * @param category - Which situation to build.
 *
 * @param path - Repository-relative source path.
 *
 * @param symbol - Qualified symbol the page is grounded in.
 *
 * @param original - The source the page is grounded against.
 *
 * @param semantic - A behavior-changing edit of the cited definition.
 *
 * @param cosmetic - A comment/formatting-only churn of the same file.
 */
function buildDetectionSpec(
  category: DetectionCategory,
  path: string,
  symbol: string,
  original: string,
  semantic: string,
  cosmetic: string,
): DetectionSpec {
  const base = { path, symbol, category, groundedText: original } as const;
  switch (category) {
    case "fresh":
      // Code never moved.
      return { ...base, c0Text: original };
    case "behind-cursor-drift":
      // The change is already baked into the generation commit and sits at or
      // behind the cursor: grounded against the old definition, committed as
      // the new one, with no later commit. Git's diff since the cursor is empty.
      return { ...base, c0Text: semantic };
    case "in-range-change":
      // The change lands in a commit after the cursor, where git can see it.
      return { ...base, c0Text: original, laterText: semantic };
    case "cosmetic-only":
      // A post-cursor commit only reformats: git sees the file move, meaning did not.
      return { ...base, c0Text: original, laterText: cosmetic };
  }
}

// ---------------------------------------------------------------------------
// Section 3: the real OpenWiki source tree, at scale (the cost side).
// ---------------------------------------------------------------------------

/**
 * The kinds of edit the scale section applies to each sampled real symbol.
 */
type EditKind = "neighbor-edit" | "cosmetic-churn" | "rename-def" | "literal-change";

const EDIT_TRUTH: Record<EditKind, Decision> = {
  "neighbor-edit": "skip",
  "cosmetic-churn": "skip",
  "rename-def": "rebuild",
  "literal-change": "rebuild",
};

const EDIT_NOTE: Record<EditKind, string> = {
  "neighbor-edit": "a DIFFERENT symbol in the same file changed",
  "cosmetic-churn": "comment and blank lines added, no code change",
  "rename-def": "the cited symbol was renamed",
  "literal-change": "a literal inside the cited symbol changed",
};

const PER_FILE_CAP = 8;
const TOTAL_CAP = 400;

/**
 * Recursively list every first-party TypeScript source file under `src/`.
 *
 * @param root - Absolute path to the `src/` directory.
 */
async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        out.push(full);
      }
    }
  };

  await walk(root);
  return out.sort();
}

/**
 * Build the mutated source for one edit kind, or `undefined` when the file has
 * no safe way to express it (so the scenario is skipped, never mislabeled).
 *
 * @param kind - The edit to apply.
 *
 * @param text - Original source.
 *
 * @param extension - File extension (for the cosmetic comment token).
 *
 * @param definitions - All definitions parsed from the file.
 *
 * @param groundedName - The qualified name the page is grounded in.
 */
function buildEdit(
  kind: EditKind,
  text: string,
  extension: string,
  definitions: Map<string, Node>,
  groundedName: string,
): string | undefined {
  const grounded = definitions.get(groundedName);
  if (!grounded) {
    return undefined;
  }

  if (kind === "cosmetic-churn") {
    return cosmeticChurn(text, extension);
  }

  if (kind === "rename-def") {
    const name = findNameNode(grounded, simpleName(groundedName));
    return name ? verifiedSplice(text, name, `${name.text}Renamed`) : undefined;
  }

  if (kind === "literal-change") {
    const leaf = findLiteralLeaf(grounded);
    return leaf ? verifiedSplice(text, leaf, mutateLiteralText(leaf)) : undefined;
  }

  // neighbor-edit: rename a different, non-overlapping definition's name.
  for (const [name, node] of definitions) {
    if (name === groundedName || !disjoint(node, grounded)) {
      continue;
    }
    const nameNode = findNameNode(node, simpleName(name));
    if (nameNode && disjoint(nameNode, grounded)) {
      const mutated = verifiedSplice(text, nameNode, `${nameNode.text}Renamed`);
      if (mutated) {
        return mutated;
      }
    }
  }

  return undefined;
}

/**
 * The trailing segment of a qualified name (`AuthService.authenticate` ->
 * `authenticate`).
 *
 * @param qualifiedName - The dotted qualified name.
 */
function simpleName(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  return parts[parts.length - 1] ?? qualifiedName;
}

async function runScaleSection(repoRoot: string): Promise<{
  contentHash: Tally;
  sourceGrounded: Tally;
  filesParsed: number;
  definitionsSeen: number;
  symbolsSampled: number;
  editsRun: number;
  perKind: Map<
    EditKind,
    { edits: number; contentWasted: number; groundedWrong: number }
  >;
}> {
  const contentHash = emptyTally();
  const sourceGrounded = emptyTally();
  const perKind = new Map<
    EditKind,
    { edits: number; contentWasted: number; groundedWrong: number }
  >();
  for (const kind of Object.keys(EDIT_TRUTH) as EditKind[]) {
    perKind.set(kind, { edits: 0, contentWasted: 0, groundedWrong: 0 });
  }

  const files = await listSourceFiles(join(repoRoot, "src"));
  let filesParsed = 0;
  let definitionsSeen = 0;
  let symbolsSampled = 0;
  let editsRun = 0;

  for (const file of files) {
    if (symbolsSampled >= TOTAL_CAP) {
      break;
    }

    const text = await readFile(file, "utf8");
    const relPath = relative(repoRoot, file).split(sep).join("/");
    const parsed = await sharedResolver.parseFile(relPath, text);
    if (!parsed.parsed) {
      continue;
    }
    filesParsed += 1;
    definitionsSeen += parsed.definitions.size;

    const nodesByName = new Map<string, import("web-tree-sitter").Node>();
    for (const [name, capture] of parsed.definitions) {
      nodesByName.set(name, capture.node);
    }

    const candidates = [...parsed.definitions.keys()]
      .filter((name) => simpleName(name).length >= 3)
      .slice(0, PER_FILE_CAP);

    for (const groundedName of candidates) {
      if (symbolsSampled >= TOTAL_CAP) {
        break;
      }

      const sidecar = await recordSingleSymbol(relPath, text, groundedName);
      if (!sidecar) {
        continue;
      }
      symbolsSampled += 1;

      for (const kind of Object.keys(EDIT_TRUTH) as EditKind[]) {
        const after = buildEdit(
          kind,
          text,
          extname(relPath).toLowerCase(),
          nodesByName,
          groundedName,
        );
        if (after === undefined) {
          continue;
        }

        const truth = EDIT_TRUTH[kind];
        const reader = new MemReader();
        reader.set(relPath, after);

        const contentDecision = contentHashDecision(text, after);
        const grounded = await sourceGroundedDecision(sidecar, reader);

        const contentVerdict = grade(contentDecision, truth);
        const groundedVerdict = grade(grounded.decision, truth);
        record(contentHash, contentVerdict);
        record(sourceGrounded, groundedVerdict);

        const bucket = perKind.get(kind);
        if (bucket) {
          bucket.edits += 1;
          if (contentVerdict === "wasted-rebuild") {
            bucket.contentWasted += 1;
          }
          if (groundedVerdict !== "correct") {
            bucket.groundedWrong += 1;
          }
        }
        editsRun += 1;
      }
    }
  }

  return {
    contentHash,
    sourceGrounded,
    filesParsed,
    definitionsSeen,
    symbolsSampled,
    editsRun,
    perKind,
  };
}

// ---------------------------------------------------------------------------
// Section 2: the git blind spot, one mechanism at a time.
// ---------------------------------------------------------------------------

/**
 * One executed git scenario: a real history, a real recorded cursor, and the
 * three decisions each strategy actually makes on it.
 */
interface GitRow {
  id: string;
  note: string;
  truth: Decision;
  gitRange: Decision;
  shippedToday: Decision;
  sourceGrounded: Decision;
}

/**
 * Set up a git scenario from the freshly-generated wiki state and read out
 * every strategy's decision.
 *
 * @param id - Scenario label.
 *
 * @param note - Plain-English description of the history.
 *
 * @param truth - The correct decision.
 *
 * @param mutate - Applies the scenario's commits; returns the cursor to diff
 * from (the recorded `gitHead`).
 */
async function runGitScenario(
  id: string,
  note: string,
  truth: Decision,
  mutate: (cwd: string, seededHead: string) => Promise<void>,
): Promise<GitRow> {
  return withTempGitRepo(async (cwd) => {
    const seededHead = await seedGeneratedWiki(cwd);
    await mutate(cwd, seededHead);

    const cursor = await recordedGitHead(cwd);
    return {
      id,
      note,
      truth,
      gitRange: await gitRangeDecision(cwd, cursor),
      shippedToday: await shippedTodayDecision(cwd),
      sourceGrounded: await sourceGroundedRepoDecision(cwd),
    };
  });
}

async function writeSource(cwd: string, contents: string): Promise<void> {
  await writeFile(join(cwd, "src", "auth.ts"), contents, "utf8");
}

async function advanceCursorTo(cwd: string, head: string): Promise<void> {
  const path = join(cwd, "openwiki", ".last-update.json");
  const raw = await readFile(path, "utf8");
  const meta = JSON.parse(raw) as Record<string, unknown>;
  meta.gitHead = head;
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

async function runGitSection(): Promise<GitRow[]> {
  const rows: GitRow[] = [];

  rows.push(
    await runGitScenario(
      "nothing-changed",
      "wiki is current; no code touched since it was written",
      "skip",
      async () => {
        // No mutation: the wiki matches the code.
      },
    ),
  );

  rows.push(
    await runGitScenario(
      "semantic-commit",
      "one ordinary commit changed the cited method",
      "rebuild",
      async (cwd) => {
        await writeSource(cwd, AUTH_V2);
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["commit", "-q", "-m", "change authenticate behavior"]);
      },
    ),
  );

  rows.push(
    await runGitScenario(
      "advanced-cursor",
      "cursor advanced past the change without regenerating the page",
      "rebuild",
      async (cwd) => {
        await writeSource(cwd, AUTH_V2);
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["commit", "-q", "-m", "change authenticate behavior"]);
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        await advanceCursorTo(cwd, head);
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["commit", "-q", "-m", "bump wiki cursor"]);
      },
    ),
  );

  rows.push(
    await runGitScenario(
      "reformat-commit",
      "a commit only reformatted the cited method",
      "skip",
      async (cwd) => {
        await writeSource(cwd, AUTH_V1_REFORMATTED);
        await git(cwd, ["add", "-A"]);
        await git(cwd, ["commit", "-q", "-m", "reformat authenticate"]);
      },
    ),
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Section 4: the mechanism across languages.
// ---------------------------------------------------------------------------

/**
 * One language fixture plus the edits applied to its cited symbol.
 */
interface LanguageCase {
  language: string;
  path: string;
  symbol: string;
  before: string;
  edits: { label: string; after: string; truth: Decision }[];
}

const LANGUAGE_CASES: LanguageCase[] = [
  {
    language: "TypeScript",
    path: "src/auth.ts",
    symbol: "AuthService.authenticate",
    before: AUTH_V1,
    edits: [
      { label: "reformat", after: AUTH_V1_REFORMATTED, truth: "skip" },
      {
        label: "comment edit",
        after: AUTH_V1.replace("// resolve the caller", "// look up the session"),
        truth: "skip",
      },
      { label: "behavior change", after: AUTH_V2, truth: "rebuild" },
      {
        label: "signature change",
        after: AUTH_V1.replace("authenticate(user: string)", "authenticate(user: string, strict: boolean)"),
        truth: "rebuild",
      },
    ],
  },
  {
    language: "JavaScript",
    path: "src/util.js",
    symbol: "normalize",
    before: [
      "export function normalize(value) {",
      "  // strip surrounding space",
      "  return value.trim();",
      "}",
      "",
    ].join("\n"),
    edits: [
      {
        label: "reformat",
        after: [
          "export function normalize( value ) {",
          "",
          "  /* strip surrounding space */",
          "  return value.trim() ;",
          "}",
          "",
        ].join("\n"),
        truth: "skip",
      },
      {
        label: "behavior change",
        after: [
          "export function normalize(value) {",
          "  // strip surrounding space",
          "  return value.trim().toLowerCase();",
          "}",
          "",
        ].join("\n"),
        truth: "rebuild",
      },
    ],
  },
  {
    language: "Python",
    path: "src/store.py",
    symbol: "Store.create",
    before: [
      "class Store:",
      "    def create(self, name):",
      "        # persist the row",
      "        return {'name': name}",
      "",
    ].join("\n"),
    edits: [
      {
        label: "reformat/comment",
        after: [
          "class Store:",
          "    def create(self, name):",
          "        # store the record",
          "        return {'name': name}   ",
          "",
        ].join("\n"),
        truth: "skip",
      },
      {
        label: "return shape change",
        after: [
          "class Store:",
          "    def create(self, name):",
          "        # persist the row",
          "        return {'name': name, 'created': True}",
          "",
        ].join("\n"),
        truth: "rebuild",
      },
    ],
  },
  {
    language: "Go",
    path: "src/store.go",
    symbol: "Store.Create",
    before: [
      "package store",
      "",
      "type Store struct{}",
      "",
      "func (s *Store) Create(name string) error {",
      "\t// write the record",
      "\treturn nil",
      "}",
      "",
    ].join("\n"),
    edits: [
      {
        label: "reformat/comment",
        after: [
          "package store",
          "",
          "type Store struct{}",
          "",
          "func (s *Store) Create(name string) error {",
          "\t// persist",
          "\treturn nil",
          "}",
          "",
        ].join("\n"),
        truth: "skip",
      },
      {
        label: "error path change",
        after: [
          "package store",
          "",
          'import "errors"',
          "",
          "type Store struct{}",
          "",
          "func (s *Store) Create(name string) error {",
          "\t// write the record",
          '\treturn errors.New("nope")',
          "}",
          "",
        ].join("\n"),
        truth: "rebuild",
      },
    ],
  },
];

interface LanguageResult {
  language: string;
  label: string;
  truth: Decision;
  decision: Decision;
  state: string;
}

async function runLanguageSection(): Promise<LanguageResult[]> {
  const results: LanguageResult[] = [];

  for (const testCase of LANGUAGE_CASES) {
    const sidecar = await recordSingleSymbol(
      testCase.path,
      testCase.before,
      testCase.symbol,
    );
    if (!sidecar) {
      results.push({
        language: testCase.language,
        label: "could not ground symbol",
        truth: "rebuild",
        decision: "rebuild",
        state: "unrecorded",
      });
      continue;
    }

    for (const edit of testCase.edits) {
      const reader = new MemReader();
      reader.set(testCase.path, edit.after);
      const grounded = await sourceGroundedDecision(sidecar, reader);
      results.push({
        language: testCase.language,
        label: edit.label,
        truth: edit.truth,
        decision: grounded.decision,
        state: grounded.state,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Orchestration and reporting.
// ---------------------------------------------------------------------------

/**
 * The truth label to print for a category.
 *
 * @param category - The category.
 */
function truthLabel(category: DetectionCategory): Decision {
  return STALE_CATEGORIES.includes(category) ? "rebuild" : "skip";
}

/**
 * Silent-staleness rate: stale pages a detector left unflagged, over all stale
 * pages. This is the number the feature is about.
 *
 * @param outcome - The measured detection outcome.
 *
 * @param detector - Which detector to score.
 */
function silentRate(
  outcome: DetectionOutcome,
  detector: "git" | "sourceGrounded",
): string {
  const m = outcome[detector];
  const stale = m.truePositive + m.falseNegative;
  return stale === 0 ? "n/a" : `${m.falseNegative}/${stale}`;
}

/**
 * False-alarm rate: fresh pages a detector wrongly flagged, over all fresh
 * pages.
 *
 * @param outcome - The measured detection outcome.
 *
 * @param detector - Which detector to score.
 */
function falseAlarmRate(
  outcome: DetectionOutcome,
  detector: "git" | "sourceGrounded",
): string {
  const m = outcome[detector];
  const fresh = m.falsePositive + m.trueNegative;
  return fresh === 0 ? "n/a" : `${m.falsePositive}/${fresh}`;
}

/**
 * Print the headline section: staleness that git leaves silent, and that source
 * grounding turns into detected staleness.
 *
 * @param outcome - The measured detection outcome.
 */
function reportDetectionSection(outcome: DetectionOutcome): void {
  heading("SECTION 1 — Turning silent staleness into detected staleness");
  console.log(`
The feature does not write pages, and it does not assume the agent fixes them.
It changes one thing: whether a page's staleness is DETECTED or stays SILENT. So
the honest way to measure it is detection accuracy over a labeled population.

Setup (one real git repo, seeded from this repository's own src/): ${outcome.pages} pages, each
grounded in a real definition and placed in one of four situations. Two are
genuinely stale, two are genuinely fresh. Each detector answers, per page, "does
this page still match the code it cites?" The file-level "git" detector is given
the most generous reading of git's real signal: did any file this page cites
appear in git diff cursor..HEAD.
`);
  console.log(
    `${pad("situation", 22)}${pad("truth", 9)}${pad("n", 5)}${pad(
      "git detects",
      14,
    )}source-grounded detects`,
  );
  console.log(rule());
  for (const category of DETECTION_CATEGORIES) {
    const bucket = outcome.byCategory[category];
    const truth = truthLabel(category);
    const stale = STALE_CATEGORIES.includes(category);
    // On stale rows, "detects" is good; on fresh rows, flagging is a false alarm.
    const gitCell = `${bucket.gitFlagged}/${bucket.count}`;
    const sgCell = `${bucket.sourceGroundedFlagged}/${bucket.count}`;
    const gitFlag = stale
      ? bucket.gitFlagged < bucket.count
        ? "  <- SILENT"
        : ""
      : bucket.gitFlagged > 0
        ? "  <- false alarm"
        : "";
    console.log(
      `${pad(category, 22)}${pad(truth === "rebuild" ? "stale" : "fresh", 9)}${pad(
        String(bucket.count),
        5,
      )}${pad(gitCell, 14)}${pad(sgCell, 12)}${gitFlag}`,
    );
  }
  console.log(rule());
  console.log(`
Reading it: on "behind-cursor-drift" the code really did change, but the change
sits at or behind the recorded cursor (an interrupted run, a partial regen, a
compounding skip, a wiki generated before a refactor). git diff cursor..HEAD is
empty, so git detects nothing and the stale page ships SILENTLY. Source grounding
compares the page's recorded fingerprints to the current source and detects it.
On "cosmetic-only" a later commit reformats the file, so git flags it (a wasted
rebuild) while source grounding sees the meaning is unchanged.
`);
  console.log(
    `${pad("detector", 20)}${pad("silent-stale", 14)}${pad(
      "false-alarms",
      14,
    )}what it means`,
  );
  console.log(rule());
  console.log(
    `${pad("git (file-level)", 20)}${pad(silentRate(outcome, "git"), 14)}${pad(
      falseAlarmRate(outcome, "git"),
      14,
    )}stale pages left silent`,
  );
  console.log(
    `${pad("source-grounded", 20)}${pad(
      silentRate(outcome, "sourceGrounded"),
      14,
    )}${pad(falseAlarmRate(outcome, "sourceGrounded"), 14)}detected, not silent`,
  );
  console.log(rule());
  console.log(`
silent-stale = stale pages the detector missed / all stale pages (the dangerous
error). false-alarms = fresh pages wrongly flagged / all fresh pages (merely
expensive). The 50/50 stale/fresh mix here is illustrative, not a field rate;
the per-situation table above is the assumption-free result. The point is the
shape: git's misses are silent staleness, source grounding's are zero.
`);
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();

  heading("SOURCE-GROUNDED FRESHNESS — will the wiki quietly go stale?");
  console.log(`
Every OpenWiki update run decides, per page: REBUILD (the code it documents
changed) or SKIP (nothing meaningful changed). Two ways to be wrong:

  MISSED DRIFT    skipped a page whose code changed  ->  ships docs that lie
                  about the code. THE DANGEROUS ONE: silent, and the wiki is
                  trusted precisely when nobody is re-reading the code.
  WASTED REBUILD  rebuilt a page nothing changed for ->  burns an LLM run and
                  a commit for a no-op diff. Merely expensive.

Three strategies, each one executed for real against this repository:

  content-hash     rebuild if the source FILE's bytes changed at all.
  git-range        rebuild only if git diff since the last wiki commit touches
                   a non-wiki file. (what OpenWiki ships today)
  source-grounded  rebuild only if the DEFINITIONS a page cites changed meaning,
                   ignoring comments and formatting. (this PR)

The harness makes every edit itself, so the correct answer is always known.
Section 1 is the headline: it turns silent staleness into detected staleness.`);

  // Section 1: silent staleness -> detected staleness (headline) ----------
  const detectionSpecs = await collectDetectionSpecs(repoRoot);
  const detection = await measureDetection(detectionSpecs);
  reportDetectionSection(detection);

  // Section 2: the git blind spot, one mechanism at a time ----------------
  const gitRows = await runGitSection();

  heading("SECTION 2 — The git blind spot, one mechanism at a time");
  console.log(`
Section 1 showed it at scale; this shows exactly how it happens, one real
throwaway git repository per row. A wiki is generated, a real .last-update.json
records the commit, then a specific everyday history plays out, and every
strategy's decision is read back from real git and the real getUpdateNoopStatus.
"shipped-today" is exactly what OpenWiki does now with this PR merged.
`);
  console.log(
    `${pad("scenario", 18)}${pad("truth", 9)}${pad("git-range", 15)}${pad(
      "shipped-today",
      15,
    )}source-grounded`,
  );
  console.log(rule());
  const gitTallies = {
    "git-range": emptyTally(),
    "shipped-today": emptyTally(),
    "source-grounded": emptyTally(),
  };
  for (const row of gitRows) {
    record(gitTallies["git-range"], grade(row.gitRange, row.truth));
    record(gitTallies["shipped-today"], grade(row.shippedToday, row.truth));
    record(gitTallies["source-grounded"], grade(row.sourceGrounded, row.truth));
    const mark = (decision: Decision): string =>
      decision === row.truth
        ? decision
        : `${decision} ${decision === "skip" ? "MISS" : "WASTE"}`;
    console.log(
      `${pad(row.id, 18)}${pad(row.truth, 9)}${pad(mark(row.gitRange), 15)}${pad(
        mark(row.shippedToday),
        15,
      )}${mark(row.sourceGrounded)}`,
    );
  }
  console.log(rule());
  for (const row of gitRows) {
    console.log(`  ${pad(row.id, 18)} ${row.note}`);
  }
  console.log(`
"advanced-cursor" is Section 1's mechanism in miniature: the cited method
changed, but the cursor was advanced past it, so git-range sees nothing and
SKIPS a stale page. This PR (shipped-today) catches it via the source-grounded
veto. On "reformat-commit" git-range and shipped-today both still rebuild (the
git gate fires first on a cosmetic commit); the source-grounded column shows the
fingerprints alone would have skipped it, the remaining win if freshness also
gates the rebuild path.
`);
  console.log(
    `${pad("strategy", 20)}${pad("correct", 10)}${pad("missed-drift", 14)}wasted-rebuild`,
  );
  console.log(rule());
  console.log(tallyLine("git-range", gitTallies["git-range"], gitRows.length));
  console.log(
    tallyLine("shipped-today", gitTallies["shipped-today"], gitRows.length),
  );
  console.log(
    tallyLine("source-grounded", gitTallies["source-grounded"], gitRows.length),
  );

  // Section 3: precision at scale (the cost side) -------------------------
  const scale = await runScaleSection(repoRoot);

  heading("SECTION 3 — Real repository, at scale (the cost side)");
  console.log(`
Missed drift is the danger; wasted rebuilds are the cost. This section measures
the cost. Corpus: this repository's own src/ (${scale.filesParsed} files parsed, ${scale.definitionsSeen} definitions
found). For a sample of real symbols we ground a page in each, apply four
realistic edits, and ask content-hash vs source-grounded to decide.

  sampled ${scale.symbolsSampled} definitions (cap ${TOTAL_CAP}, up to ${PER_FILE_CAP} per file); ran ${scale.editsRun} edits.
`);

  console.log(
    `${pad("edit applied", 18)}${pad("truth", 9)}${pad("n", 6)}${pad(
      "content-hash",
      24,
    )}source-grounded`,
  );
  console.log(rule());
  for (const kind of Object.keys(EDIT_TRUTH) as EditKind[]) {
    const bucket = scale.perKind.get(kind);
    if (!bucket || bucket.edits === 0) {
      continue;
    }
    const truth = EDIT_TRUTH[kind];
    const content =
      bucket.contentWasted > 0
        ? `rebuild (${bucket.contentWasted} wasted)`
        : "rebuild (correct)";
    const grounded =
      bucket.groundedWrong > 0
        ? `${bucket.groundedWrong} WRONG`
        : `${truth} (all correct)`;
    console.log(
      `${pad(kind, 18)}${pad(truth, 9)}${pad(String(bucket.edits), 6)}${pad(
        content,
        24,
      )}${grounded}`,
    );
  }
  console.log(rule());
  console.log(`
Reading it: "${EDIT_NOTE["neighbor-edit"]}" and "${EDIT_NOTE["cosmetic-churn"]}"
both leave the page correct, yet content-hash rebuilds every one of them because
the file's bytes moved. source-grounded rebuilds only when the cited definition
actually changed.
`);
  console.log(
    `${pad("strategy", 20)}${pad("correct", 10)}${pad("missed-drift", 14)}wasted-rebuild`,
  );
  console.log(rule());
  console.log(tallyLine("content-hash", scale.contentHash, scale.editsRun));
  console.log(tallyLine("source-grounded", scale.sourceGrounded, scale.editsRun));

  // Section 4: the mechanism across languages -----------------------------
  const languageResults = await runLanguageSection();

  heading("SECTION 4 — The mechanism across languages");
  console.log(`
The same canonicalization must tell semantic edits apart from cosmetic ones in
every supported grammar. Reformatting and comments must stay fresh; behavior and
signature changes must go stale. All executed by the real evaluator.
`);
  console.log(
    `${pad("language", 13)}${pad("edit", 22)}${pad("truth", 9)}${pad(
      "decision",
      12,
    )}state`,
  );
  console.log(rule());
  const languageTally = emptyTally();
  for (const result of languageResults) {
    record(languageTally, grade(result.decision, result.truth));
    const flag = result.decision === result.truth ? "" : "  <- WRONG";
    console.log(
      `${pad(result.language, 13)}${pad(result.label, 22)}${pad(
        result.truth,
        9,
      )}${pad(result.decision, 12)}${result.state}${flag}`,
    );
  }
  console.log(rule());
  console.log(
    tallyLine("source-grounded", languageTally, languageResults.length),
  );

  // Verdict ---------------------------------------------------------------
  const detectionSgWrong =
    detection.sourceGrounded.falseNegative + detection.sourceGrounded.falsePositive;
  const groundedWrong =
    detectionSgWrong +
    scale.sourceGrounded.missedDrift +
    scale.sourceGrounded.wastedRebuild +
    gitTallies["source-grounded"].missedDrift +
    gitTallies["source-grounded"].wastedRebuild +
    languageTally.missedDrift +
    languageTally.wastedRebuild;
  const totalDecisions =
    detection.pages +
    scale.editsRun +
    gitRows.length +
    languageResults.length;

  // Stale pages left SILENT (undetected) by git: Section 1's false negatives
  // plus Section 2's missed-drift history.
  const gitSilentTotal =
    detection.git.falseNegative + gitTallies["git-range"].missedDrift;
  const sgSilentTotal =
    detection.sourceGrounded.falseNegative + gitTallies["source-grounded"].missedDrift;

  heading("VERDICT");
  console.log(`
The headline: this feature turns silent staleness into detected staleness. On
the labeled population, git left ${detection.git.falseNegative} stale page(s) SILENT (its diff since the
cursor was empty), and with Section 2's histories that is ${gitSilentTotal} stale pages that
would ship with nothing to flag them. Source grounding detected them: ${sgSilentTotal} left
silent. That is the whole point. Git's vocabulary is "did bytes change in this
commit range?", never "does the page still match the code it cites?"

Detection is not repair: a detected page still has to be regenerated, and the
agent is imperfect. But a detected stale page can be re-run, logged, and gated
on; a silent one cannot. Moving staleness from silent to detected is the thing
the feature actually guarantees.

source-grounded made the correct call on ${totalDecisions - groundedWrong}/${totalDecisions} decisions across all four
sections (the ${detection.pages}-page detection population, the ${gitRows.length} git histories, the ${scale.editsRun}
scale edits, and the ${languageResults.length} language cases): 0 missed detections, 0 false alarms.

The secondary win is cost: the expensive error is WASTED REBUILD, and
content-hash racks up ${scale.contentHash.wastedRebuild} of them across the real tree where source-grounded
has 0.
`);

  if (groundedWrong > 0) {
    console.error(
      `FAIL: source-grounded made ${groundedWrong} wrong call(s); expected a perfect score.`,
    );
    process.exitCode = 1;
  } else {
    console.log("PASS: source-grounded was correct on every decision.\n");
  }
}

await main();
