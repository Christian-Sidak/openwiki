/**
 * Freshness preflight for the update no-op decision.
 *
 * The existing no-op check asks "has the git cursor moved?" That misses drift
 * that a commit range cannot see: an amended commit, a squash, a reverted-then-
 * reapplied change, or a wiki generated before a refactor landed. Source-
 * grounded freshness answers a different question, "does what the pages claim
 * still match the source?", by comparing recorded fingerprints against current
 * source. This preflight runs that check across every page that carries a
 * sidecar and reports the pages that are no longer fresh, so an update run can
 * refuse to skip when the wiki has drifted even though git looks quiet.
 *
 * The whole-file fast path keeps the common "nothing changed" case cheap: if a
 * source file's bytes are unchanged no grammar is loaded and no tree is parsed.
 */

import { createFreshnessEvaluator, type PageFreshness } from "./freshness.js";
import { listSourceGroundedPages, readSidecar } from "./storage.js";

/**
 * The outcome of a wiki-wide freshness preflight.
 */
export interface FreshnessPreflightResult {
  /**
   * Pages that are not fresh, ordered as discovered.
   */
  drifted: PageFreshness[];

  /**
   * True when every source-grounded page with a sidecar is fresh (or there are
   * no sidecars at all).
   */
  allFresh: boolean;
}

/**
 * Evaluate freshness for every source-grounded page that carries a sidecar.
 *
 * Pages without a sidecar are not yet participating in source-grounded
 * freshness and are silently skipped, so adopting the feature never makes a
 * previously skippable update suddenly run.
 *
 * @param cwd - Repository root.
 */
export async function checkWikiFreshness(
  cwd: string,
): Promise<FreshnessPreflightResult> {
  const evaluator = createFreshnessEvaluator(cwd);
  const pages = await listSourceGroundedPages(cwd);
  const drifted: PageFreshness[] = [];

  for (const page of pages) {
    const sidecar = await readSidecar(cwd, page);
    if (!sidecar) {
      continue;
    }

    const report = await evaluator.evaluatePage(sidecar);
    if (report.state !== "fresh") {
      drifted.push(report);
    }
  }

  return { drifted, allFresh: drifted.length === 0 };
}

/**
 * Summarize drift into a short reason string for the no-op decision, for
 * example `source drift: 2 page(s) not fresh (stale: 1, unknown: 1)`.
 *
 * @param drifted - The pages reported as not fresh.
 */
export function summarizeDrift(drifted: readonly PageFreshness[]): string {
  const counts = new Map<string, number>();
  for (const page of drifted) {
    counts.set(page.state, (counts.get(page.state) ?? 0) + 1);
  }

  const breakdown = [...counts.entries()]
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");

  return `source drift: ${drifted.length} page(s) not fresh (${breakdown})`;
}
