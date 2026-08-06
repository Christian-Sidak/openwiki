/**
 * Deterministic grading layer (spec section 16).
 *
 * A cheap, reproducible floor that runs the scenario's conservative literal
 * probes against the final wiki bytes and flags eligible pages the run edited
 * without being asked to. It never decides a trial on its own: the blinded judge
 * is authoritative, and these booleans exist to give a reproducible baseline and
 * a disagreement check against the judge (plan section 4).
 *
 * Pure and synchronous: it reads only the ground truth and the already-loaded
 * before/after page maps, performs no I/O, and spends no tokens.
 */

import { isSourceGroundedPage } from "../../../src/staleness/storage.js";
import type {
  EvalScenario,
  FactExpectation,
  PageExpectation,
} from "../scenarios/types.js";

/** The deterministic outcome of one expected fact's literal probes. */
export interface FactProbeResult {
  /** The fact's stable identifier, echoed from the expectation. */
  id: string;

  /** The fact's human-readable statement, echoed from the expectation. */
  description: string;

  /**
   * Whether every `requirePresent` substring was found in the page.
   *
   * @default undefined - the fact specified no `requirePresent` probe.
   */
  requirePresentPass?: boolean;

  /**
   * Whether every `requireAbsent` substring was absent from the page.
   *
   * @default undefined - the fact specified no `requireAbsent` probe.
   */
  requireAbsentPass?: boolean;

  /**
   * The combined deterministic verdict: true only when every specified probe
   * passed. Absent when the fact carries no probe, in which case only the judge
   * can decide it.
   *
   * @default undefined - the fact carries no deterministic probe.
   */
  pass?: boolean;
}

/** The deterministic outcome for one expected page. */
export interface PageDeterministicResult {
  /** Repository-relative wiki page path. */
  page: string;

  /** Whether the page exists in the final wiki at all. */
  found: boolean;

  /** Per-fact probe results for the page's required facts. */
  requiredFacts: FactProbeResult[];

  /** Per-fact probe results for the page's forbidden facts. */
  forbiddenFacts: FactProbeResult[];

  /** Count of required facts that carried at least one probe. */
  requiredFactsProbed: number;

  /** Count of probed required facts whose probes all passed. */
  requiredFactsSatisfied: number;

  /** Count of forbidden facts that carried at least one probe. */
  forbiddenFactsProbed: number;

  /** Count of probed forbidden facts whose obsolete text is gone. */
  forbiddenFactsCleared: number;
}

/** The deterministic grade for one scenario trial. */
export interface DeterministicGrade {
  /** The scenario this grade is for. */
  scenarioId: string;

  /** Per-page deterministic results, in `expectedAffectedPages` order. */
  pages: PageDeterministicResult[];

  /**
   * Source-grounded-eligible pages the run changed that the scenario did not
   * list as affected. A conservative floor for the "unnecessary semantic edits"
   * metric (spec section 6); the judge refines whether a change was truly
   * gratuitous. Sorted, repo-relative POSIX paths.
   */
  changedUnaffectedPages: string[];
}

/** Inputs for {@link gradeDeterministic}. */
export interface DeterministicGradeInput {
  /** The scenario whose ground truth is graded against. */
  scenario: EvalScenario;

  /** The frozen baseline wiki pages, keyed by repo-relative POSIX path. */
  before: Record<string, string>;

  /** The run's final wiki pages, keyed by repo-relative POSIX path. */
  after: Record<string, string>;
}

/**
 * Whether every needle is a literal substring of `haystack`. Returns undefined
 * when there is nothing to probe, so an unspecified probe reads as "no signal"
 * rather than a vacuous pass.
 *
 * @param haystack - The page bytes to search.
 *
 * @param needles - The literal substrings that must all be present.
 */
function containsAll(
  haystack: string,
  needles: string[] | undefined,
): boolean | undefined {
  if (needles === undefined || needles.length === 0) {
    return undefined;
  }

  return needles.every((needle) => haystack.includes(needle));
}

/**
 * Whether every needle is absent from `haystack`. Returns undefined when there
 * is nothing to probe.
 *
 * @param haystack - The page bytes to search.
 *
 * @param needles - The literal substrings that must all be absent.
 */
function absentAll(
  haystack: string,
  needles: string[] | undefined,
): boolean | undefined {
  if (needles === undefined || needles.length === 0) {
    return undefined;
  }

  return needles.every((needle) => !haystack.includes(needle));
}

/**
 * Run one fact's literal probes against the page bytes. A missing page yields
 * empty bytes, so required-present probes fail and required-absent probes pass,
 * which correctly reflects a required fact that the run never wrote.
 *
 * @param fact - The expected fact to probe.
 *
 * @param pageBytes - The final page's content, or the empty string when the
 *   page is absent.
 */
function probeFact(fact: FactExpectation, pageBytes: string): FactProbeResult {
  const requirePresentPass = containsAll(pageBytes, fact.requirePresent);
  const requireAbsentPass = absentAll(pageBytes, fact.requireAbsent);

  let pass: boolean | undefined;
  if (requirePresentPass !== undefined || requireAbsentPass !== undefined) {
    pass = (requirePresentPass ?? true) && (requireAbsentPass ?? true);
  }

  return {
    id: fact.id,
    description: fact.description,
    requirePresentPass,
    requireAbsentPass,
    pass,
  };
}

/**
 * Grade one expected page's facts against the final wiki.
 *
 * @param expectation - The page's ground-truth expectation.
 *
 * @param after - The run's final wiki pages.
 */
function gradePage(
  expectation: PageExpectation,
  after: Record<string, string>,
): PageDeterministicResult {
  const found = Object.prototype.hasOwnProperty.call(after, expectation.page);
  const bytes = after[expectation.page] ?? "";

  const requiredFacts = expectation.requiredFacts.map((fact) =>
    probeFact(fact, bytes),
  );
  const forbiddenFacts = expectation.forbiddenFacts.map((fact) =>
    probeFact(fact, bytes),
  );

  const requiredProbed = requiredFacts.filter(
    (fact) => fact.pass !== undefined,
  );
  const forbiddenProbed = forbiddenFacts.filter(
    (fact) => fact.pass !== undefined,
  );

  return {
    page: expectation.page,
    found,
    requiredFacts,
    forbiddenFacts,
    requiredFactsProbed: requiredProbed.length,
    requiredFactsSatisfied: requiredProbed.filter((fact) => fact.pass).length,
    forbiddenFactsProbed: forbiddenProbed.length,
    forbiddenFactsCleared: forbiddenProbed.filter((fact) => fact.pass).length,
  };
}

/**
 * Find source-grounded-eligible pages the run changed that were not expected to
 * change. New, deleted, and content-edited pages all count as changed; only
 * eligible pages are considered, so regenerated navigation and operational files
 * never register (spec section 6).
 *
 * @param scenario - The scenario whose expected pages are excluded.
 *
 * @param before - The frozen baseline wiki pages.
 *
 * @param after - The run's final wiki pages.
 */
function findChangedUnaffectedPages(
  scenario: EvalScenario,
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const expected = new Set(
    scenario.expectedAffectedPages.map((page) => page.page),
  );
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);

  const changed: string[] = [];
  for (const page of allPaths) {
    if (expected.has(page) || !isSourceGroundedPage(page)) {
      continue;
    }
    if (before[page] !== after[page]) {
      changed.push(page);
    }
  }

  return changed.sort();
}

/**
 * Produce the deterministic grade for one scenario trial: per-page literal probe
 * results plus the list of eligible pages the run edited unnecessarily.
 *
 * @param input - The scenario ground truth and the before/after wiki maps.
 */
export function gradeDeterministic(
  input: DeterministicGradeInput,
): DeterministicGrade {
  const { scenario, before, after } = input;

  return {
    scenarioId: scenario.id,
    pages: scenario.expectedAffectedPages.map((expectation) =>
      gradePage(expectation, after),
    ),
    changedUnaffectedPages: findChangedUnaffectedPages(scenario, before, after),
  };
}
