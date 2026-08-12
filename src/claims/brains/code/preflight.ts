import type { EvidenceResolver, ResolvedEvidence } from "../../core/types.js";
import type { GroundingContext, GroundingIssue, PageClaims } from "./types.js";
import { ClaimsStore } from "./store.js";

/**
 * Complete deterministic preflight result used to create a run session.
 */
export interface ClaimsPreflightResult {
  /**
   * Compact prompt-facing reconciliation worklist.
   */
  context: GroundingContext;

  /**
   * Valid persisted sidecars keyed by virtual page path.
   */
  persisted: Map<string, PageClaims>;

  /**
   * Sidecars whose generated Markdown no longer exists.
   */
  orphanPages: string[];
}

/**
 * Runs global claim freshness and page synchronization checks.
 *
 * Each evidence resource resolves once per preflight. Resolution errors are
 * intentionally allowed to propagate so a parser or filesystem failure cannot
 * be mistaken for deleted evidence.
 *
 * @param store - Repository claim persistence.
 * @param resolver - Repository evidence resolver.
 * @returns Persisted state, orphan inventory, and stable-order issues.
 */
export async function runClaimsPreflight(
  store: ClaimsStore,
  resolver: EvidenceResolver,
): Promise<ClaimsPreflightResult> {
  const pages = await store.discoverPages();
  const persisted = await store.loadPages(pages);
  const pageSet = new Set(pages);
  const orphanPages = (await store.discoverSidecarPages()).filter(
    (page) => !pageSet.has(page),
  );
  const issues: GroundingIssue[] = [];
  const resolutionCache = new Map<string, Promise<ResolvedEvidence | null>>();

  /**
   * Resolves one resource through the run-local deduplication cache.
   *
   * @param resource - Stable evidence resource.
   * @returns Current resolved evidence or `null`.
   */
  function resolveOnce(resource: string): Promise<ResolvedEvidence | null> {
    const cached = resolutionCache.get(resource);
    if (cached) {
      return cached;
    }
    const pending = resolver.resolve(resource);
    resolutionCache.set(resource, pending);
    return pending;
  }

  for (const page of pages) {
    const pageClaims = persisted.get(page);
    if (!pageClaims) {
      issues.push({ page, kind: "ungrounded-page" });
      continue;
    }

    if ((await store.hashPage(page)) !== pageClaims.pageVersion) {
      issues.push({ page, kind: "out-of-sync-page" });
    }

    for (const claim of pageClaims.claims) {
      const changedResources: string[] = [];
      const unresolvedResources: string[] = [];

      for (const evidence of claim.evidence) {
        const current = await resolveOnce(evidence.resource);
        if (!current) {
          unresolvedResources.push(evidence.resource);
        } else if (current.evidence.version !== evidence.version) {
          changedResources.push(evidence.resource);
        }
      }

      if (unresolvedResources.length > 0) {
        issues.push({
          page,
          kind: "unresolved",
          claimId: claim.id,
          resources: unresolvedResources.sort(),
        });
      } else if (changedResources.length > 0) {
        issues.push({
          page,
          kind: "stale",
          claimId: claim.id,
          resources: changedResources.sort(),
        });
      }
    }
  }

  issues.sort(compareGroundingIssues);
  orphanPages.sort((left, right) => left.localeCompare(right));
  return {
    context: { issues },
    persisted,
    orphanPages,
  };
}

/**
 * Produces deterministic prompt and test ordering for grounding issues.
 *
 * @param left - First issue.
 * @param right - Second issue.
 * @returns Standard array-sort comparison.
 */
function compareGroundingIssues(
  left: GroundingIssue,
  right: GroundingIssue,
): number {
  return (
    left.page.localeCompare(right.page) ||
    left.kind.localeCompare(right.kind) ||
    (left.claimId ?? "").localeCompare(right.claimId ?? "")
  );
}
