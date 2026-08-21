/**
 * The plan as evidence, and the briefs generated from it.
 *
 * The ledger stored a directory, a disposition, and page paths. Nothing else -
 * so when the critic asked for a page's source paths, symbols, focused tests,
 * and boundary edges, and the coordinator worked them out, that work was
 * discarded at submission. Author briefs then said "inspect the relevant source
 * directory implied by this page path" and listed every page in the wiki as a
 * possible link target.
 *
 * Two kinds of fact an author cannot derive from its own subtree, however well
 * it reads: how the component relates to its neighbours, and how a change to it
 * is validated. A relationship is a fact about two components, and the only
 * participant that saw both is the planner. The validation answer lives in
 * Makefiles and CI workflows, not beside the code under test.
 *
 * So the plan carries them, and the brief is rendered here rather than composed
 * by the coordinator: a page with no implementation anchor, no entrypoint, and
 * no focused test cannot be dispatched, because an author sent without them can
 * only write what it can see.
 */

/**
 * The one canonical form of a wiki page path.
 *
 * A model spells the same page several ways - `architecture/overview`,
 * `architecture/overview.md`, `openwiki/architecture/overview.md`,
 * `/openwiki/architecture/overview.md` - and each boundary that normalizes
 * differently, or not at all, turns one page into several. A path that reaches
 * the claim store in one form and a page count in another loses the work done
 * under the first.
 *
 * So every boundary calls this: planning, authoring, Claims and finalization. An
 * extensionless path is an alias rather than an error, since the intent is
 * unambiguous and rejecting it only costs another turn.
 *
 * @param page - Page path in any of the spellings a model produces.
 * @returns Absolute path of the form /openwiki/<path>.md.
 */
export function canonicalWikiPage(page: string, wikiRoot = "openwiki"): string {
  const bare = page
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  const rooted = bare.startsWith(`${wikiRoot}/`)
    ? bare.slice(wikiRoot.length + 1)
    : bare;
  const withExtension = /\.md$/iu.test(rooted) ? rooted : `${rooted}.md`;
  return `/${wikiRoot}/${withExtension}`;
}

/** One page the plan commits to, with the evidence its author needs. */
export interface PlannedPage {
  path: string;
  responsibility: string;
  entrypoint: string;
  sources: string[];
  tests: string[];
  edges: { page: string; relationship: string }[];
}

/** One area of the repository and what the plan does about it. */
export type PlanEntry =
  | { disposition: "document"; directory: string; pages: PlannedPage[] }
  | {
      disposition: "covered_by";
      directory: string;
      page: string;
      reason: string;
    }
  | { disposition: "exclude"; directory: string; reason: string };

/** The accepted plan. */
export interface PlanLedger {
  entries: PlanEntry[];
  pages: Map<string, PlannedPage>;
}

/** Shared between the tool that accepts a plan and the tools that consume it. */
export interface PlanStore {
  get(): PlanLedger | null;
  set(ledger: PlanLedger): void;
}

/**
 * Creates an empty plan store.
 *
 * @returns A store the plan and authoring tools share.
 */
export function createPlanStore(): PlanStore {
  let ledger: PlanLedger | null = null;
  return {
    get: () => ledger,
    set: (next) => {
      ledger = next;
    },
  };
}

/**
 * Reports what a planned page is missing before it can be authored.
 *
 * @param page - The planned page.
 * @returns Missing field names, empty when the page is dispatchable.
 */
export function missingEvidence(page: PlannedPage): string[] {
  const missing: string[] = [];
  if (page.sources.length === 0) {
    missing.push("sources");
  }
  if (!page.entrypoint.trim()) {
    missing.push("entrypoint");
  }
  if (page.tests.length === 0) {
    missing.push("tests");
  }
  if (!page.responsibility.trim()) {
    missing.push("responsibility");
  }
  // A relationship is a fact about two components, and an author sees only one
  // of them: its own subtree. The planner saw both, so if the plan names no
  // relationship for a page, nothing downstream can recover it and the page will
  // describe a component as though it stood alone.
  if (page.edges.length === 0) {
    missing.push(
      "at least one edge - what this depends on, or what depends on it",
    );
  }
  return missing;
}

/**
 * Renders one author's brief from the plan.
 *
 * Only the pages this one has an edge to are named, rather than the whole wiki.
 * A brief listing every page invites links the author cannot justify, and a
 * relationship it was not given is one it cannot state.
 *
 * @param page - The planned page to author.
 * @param defect - What to fix, when this is a repair rather than a first draft.
 * @returns The complete brief.
 */
export function renderBrief(page: PlannedPage, defect?: string): string {
  const edges =
    page.edges.length > 0
      ? page.edges
          .map((edge) => `  - ${edge.page}: ${edge.relationship}`)
          .join("\n")
      : "  - none recorded";
  return [
    `Write the OpenWiki page ${page.path}.`,
    "",
    `Responsibility: ${page.responsibility}`,
    `Entrypoint: ${page.entrypoint}`,
    `Implementation evidence, where to start reading:`,
    ...page.sources.map((source) => `  - ${source}`),
    `Focused tests, and what a reader would run to check a change:`,
    ...page.tests.map((test) => `  - ${test}`),
    `Relationships. State each one in the prose that explains it, and link only these pages:`,
    edges,
    "",
    "Read the evidence above before drafting, and follow it into whatever it references - the Makefile target or CI job that runs those tests, and the module on the other side of each relationship. Both are things a reader changing this component needs and neither is inside your own directory.",
    ...(defect
      ? [
          "",
          `This page already exists and is being repaired. Preserve what is correct and fix this: ${defect}`,
        ]
      : []),
  ].join("\n");
}
