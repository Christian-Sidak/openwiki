/**
 * Freshness evaluation for source-grounded wiki pages.
 *
 * Given a page's recorded {@link SourceDependencySidecar}, the evaluator reads
 * the current source, recomputes fingerprints, and classifies each dependency
 * into one of four states with a strict precedence:
 *
 * `unverified` > `unknown` > `stale` > `fresh`.
 *
 * A page's overall state is the worst (highest precedence) of its dependencies,
 * so any doubt bubbles up: a page is only `fresh` when every dependency is
 * confirmed unchanged. This is deliberately conservative because the state
 * gates whether an update run may treat the page as a no-op.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isFileNotFoundError } from "../fs-errors.js";
import { fingerprintForSymbol, SourceResolver } from "./resolver.js";
import { createDefaultRegistry } from "./languages/registry.js";
import {
  fingerprintFileBytes,
  normalizeRepoRelativePath,
  type PersistedSourceDependency,
  type SourceDependencySidecar,
} from "./storage.js";

/**
 * The four freshness states, ordered by the precedence used when aggregating a
 * page from its dependencies.
 *
 * - `fresh`: the tracked source is confirmed unchanged.
 * - `stale`: the tracked source changed in a way that affects the page.
 * - `unknown`: the anchor moved out from under us (file or symbol gone), so the
 *   change cannot be localized.
 * - `unverified`: freshness could not be computed (no grammar, parse failure,
 *   or missing fingerprint), so the page cannot be vouched for.
 */
export type FreshnessState = "fresh" | "stale" | "unknown" | "unverified";

/**
 * Precedence weights for {@link FreshnessState}; higher wins when aggregating.
 */
const STATE_PRECEDENCE: Record<FreshnessState, number> = {
  fresh: 0,
  stale: 1,
  unknown: 2,
  unverified: 3,
};

/**
 * Machine-readable explanation for a dependency's classified state, useful for
 * reporting and for the eval harness.
 */
export type FreshnessReason =
  | "file-unchanged"
  | "definition-unchanged"
  | "file-changed"
  | "definition-changed"
  | "source-file-missing"
  | "symbol-not-found"
  | "language-unsupported"
  | "parse-failed"
  | "missing-definition-fingerprint";

/**
 * The freshness verdict for a single recorded dependency.
 */
export interface DependencyFreshness {
  /**
   * The dependency that was evaluated.
   */
  dependency: PersistedSourceDependency;

  /**
   * Its classified freshness state.
   */
  state: FreshnessState;

  /**
   * Why it was classified this way.
   */
  reason: FreshnessReason;
}

/**
 * The aggregate freshness verdict for a page and its dependencies.
 */
export interface PageFreshness {
  /**
   * Repository-relative POSIX path of the page.
   */
  page: string;

  /**
   * Worst state across all dependencies (`fresh` when there are none).
   */
  state: FreshnessState;

  /**
   * Per-dependency verdicts, in sidecar order.
   */
  dependencies: DependencyFreshness[];
}

/**
 * Reads current source bytes for a repository-relative path. Abstracted so the
 * evaluator can run against the filesystem or an in-memory fixture.
 */
export interface SourceReader {
  /**
   * Return the file's current bytes, or `undefined` when it does not exist.
   *
   * @param path - Repository-relative POSIX path.
   */
  readSource(path: string): Promise<string | undefined>;
}

/**
 * Aggregate a set of dependency states into a single page state by taking the
 * highest precedence. Returns `fresh` for an empty set.
 *
 * @param states - The dependency states to combine.
 */
export function aggregateState(
  states: readonly FreshnessState[],
): FreshnessState {
  let worst: FreshnessState = "fresh";
  for (const state of states) {
    if (STATE_PRECEDENCE[state] > STATE_PRECEDENCE[worst]) {
      worst = state;
    }
  }
  return worst;
}

/**
 * A {@link SourceReader} backed by the real filesystem, rooted at a working
 * directory. Paths that fail normalization are reported as missing rather than
 * throwing, so a malformed stored path degrades to `unknown`.
 */
export class FileSystemSourceReader implements SourceReader {
  /**
   * @param cwd - Repository root that repo-relative paths resolve against.
   */
  constructor(private readonly cwd: string) {}

  async readSource(path: string): Promise<string | undefined> {
    let normalized: string;
    try {
      normalized = normalizeRepoRelativePath(path);
    } catch {
      return undefined;
    }

    try {
      return await readFile(join(this.cwd, normalized), "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

/**
 * Classifies recorded source dependencies as fresh, stale, unknown, or
 * unverified by recomputing their fingerprints against current source.
 */
export class FreshnessEvaluator {
  /**
   * @param resolver - Parses source and fingerprints definitions.
   *
   * @param reader - Supplies current source bytes.
   */
  constructor(
    private readonly resolver: SourceResolver,
    private readonly reader: SourceReader,
  ) {}

  /**
   * Evaluate every dependency of a page and aggregate a page-level state.
   *
   * @param sidecar - The page's recorded sidecar.
   */
  async evaluatePage(sidecar: SourceDependencySidecar): Promise<PageFreshness> {
    const dependencies = await Promise.all(
      sidecar.sources.map((dependency) => this.evaluateDependency(dependency)),
    );

    return {
      page: sidecar.page,
      state: aggregateState(dependencies.map((entry) => entry.state)),
      dependencies,
    };
  }

  /**
   * Classify a single dependency against current source.
   *
   * @param dependency - The recorded dependency to check.
   */
  async evaluateDependency(
    dependency: PersistedSourceDependency,
  ): Promise<DependencyFreshness> {
    const bytes = await this.reader.readSource(dependency.path);
    if (bytes === undefined) {
      return {
        dependency,
        state: "unknown",
        reason: "source-file-missing",
      };
    }

    // Fast path: if the whole file is byte-identical, nothing in it moved.
    const currentFile = fingerprintFileBytes(bytes);
    if (currentFile.value === dependency.fileFingerprint.value) {
      return { dependency, state: "fresh", reason: "file-unchanged" };
    }

    if (dependency.resolution === "file") {
      return { dependency, state: "stale", reason: "file-changed" };
    }

    // Symbol-level dependency: we need a symbol and a stored definition
    // fingerprint to compare against.
    if (!dependency.symbol || !dependency.definitionFingerprint) {
      return {
        dependency,
        state: "unverified",
        reason: "missing-definition-fingerprint",
      };
    }

    const parsed = await this.resolver.parseFile(dependency.path, bytes);
    if (!parsed.supported) {
      return {
        dependency,
        state: "unverified",
        reason: "language-unsupported",
      };
    }
    if (!parsed.parsed) {
      return { dependency, state: "unverified", reason: "parse-failed" };
    }

    const resolved = fingerprintForSymbol(parsed, dependency.symbol);
    if (!resolved) {
      return { dependency, state: "unknown", reason: "symbol-not-found" };
    }

    if (resolved.fingerprint.value === dependency.definitionFingerprint.value) {
      return {
        dependency,
        state: "fresh",
        reason: "definition-unchanged",
      };
    }

    return { dependency, state: "stale", reason: "definition-changed" };
  }
}

/**
 * Build a {@link FreshnessEvaluator} wired to the default language registry and
 * the real filesystem.
 *
 * @param cwd - Repository root that repo-relative paths resolve against.
 */
export function createFreshnessEvaluator(cwd: string): FreshnessEvaluator {
  return new FreshnessEvaluator(
    new SourceResolver(createDefaultRegistry()),
    new FileSystemSourceReader(cwd),
  );
}
