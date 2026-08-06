/**
 * Scenario format for the source-freshness end-to-end eval.
 *
 * A scenario is a reproducible source-code change plus the hand-authored ground
 * truth for grading the wiki that results from re-running the update agent. The
 * ground truth is authored independently of the agent-generated dependency
 * sidecars and is never shown to the arms, so it cannot leak the dependency
 * graph into the runs (spec: no oracle leakage).
 */

/**
 * Rough scope of a scenario's source change. Reporting and selection only; it
 * never influences grading.
 */
export type ScenarioComplexity = "small" | "medium" | "large" | "cross-cutting";

/**
 * A single hand-authored fact about the post-mutation source that a
 * synchronized wiki page must reflect (when listed under `requiredFacts`) or
 * must no longer assert (when listed under `forbiddenFacts`).
 *
 * The deterministic grader runs the conservative literal probes; the blinded
 * judge reads `description`. Probes are matched as case-sensitive literal
 * substrings, never regexes, so a code identifier or file path with regex
 * metacharacters is safe to write verbatim (spec section 16: keep deterministic
 * checks conservative, no brittle regexes).
 */
export interface FactExpectation {
  /** Stable identifier, unique within its page, used in grading output. */
  id: string;

  /** Human-readable statement of the fact, handed verbatim to the judge. */
  description: string;

  /**
   * Literal substrings that a correct page is expected to contain (for a
   * required fact, the new name or statement).
   *
   * @default undefined - no positive deterministic probe; the judge alone
   *   decides this fact.
   */
  requirePresent?: string[];

  /**
   * Literal substrings that a correct page must not contain (for a forbidden
   * fact, the obsolete name or statement; for a required fact, optionally the
   * old phrasing it replaced).
   *
   * @default undefined - no negative deterministic probe; the judge alone
   *   decides this fact.
   */
  requireAbsent?: string[];
}

/**
 * A source definition that grounds a page expectation. This is grading-only
 * evidence handed to the judge; it is authored separately from and never
 * compared against the runtime sidecars, so it cannot reveal the dependency
 * graph to either arm.
 */
export interface SourceEvidence {
  /** Repository-relative path to the source file the claim depends on. */
  path: string;

  /**
   * Qualified symbol within `path` whose behavior the claim depends on, for
   * example `AuthService.authenticate`.
   *
   * @default undefined - the whole file is the evidence, no single symbol.
   */
  symbol?: string;

  /** Why this definition grounds the expectation, for the judge's context. */
  explanation: string;
}

/**
 * The ground-truth expectation for one wiki page under a scenario: why the
 * mutation affects the page, the facts a correct page must state, the stale
 * facts it must drop, and the source evidence the judge grades against.
 */
export interface PageExpectation {
  /** Repository-relative wiki page path, for example `openwiki/architecture/overview.md`. */
  page: string;

  /** Why the mutation makes this page's current prose wrong or incomplete. */
  rationale: string;

  /** Facts a synchronized page must state. */
  requiredFacts: FactExpectation[];

  /** Stale claims a synchronized page must no longer contain. */
  forbiddenFacts: FactExpectation[];

  /** Source definitions the expectation is grounded in, for the judge. */
  sourceEvidence: SourceEvidence[];
}

/**
 * One reproducible source-change scenario: a mutation applied to a throwaway
 * checkout of the frozen baseline, plus the hand-authored ground truth for
 * grading the wiki the update agent produces.
 */
export interface EvalScenario {
  /** Stable identifier used on the CLI and in results, for example `async-auth`. */
  id: string;

  /** One-line human title for reports. */
  title: string;

  /** Rough scope of the change, for reporting and selection. */
  complexity: ScenarioComplexity;

  /** What the change is and why it is a realistic edit, for reports and the judge. */
  description: string;

  /**
   * Applies the reproducible source mutation to a throwaway repo checkout. It
   * edits real source files in place under `cwd` and returns nothing; mutating
   * the source tree is the whole effect. It must never touch anything outside
   * `cwd`, and the result must still compile (spec section 9).
   *
   * @param cwd - Absolute path to the throwaway repository the mutation edits.
   */
  applyMutation: (cwd: string) => Promise<void>;

  /** Pages whose current prose the mutation makes wrong or incomplete. */
  expectedAffectedPages: PageExpectation[];

  /**
   * Pages that must stay accurate through the mutation and so must not be
   * rewritten. Used to score unnecessary semantic edits (spec section 6).
   *
   * @default undefined - the scenario asserts nothing about unaffected pages.
   */
  expectedUnaffectedPages?: string[];
}
