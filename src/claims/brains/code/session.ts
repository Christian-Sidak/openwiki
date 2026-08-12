import { randomUUID } from "node:crypto";
import { ClaimSessionError } from "../../core/errors.js";
import { applyClaimOperations, cloneClaims } from "../../core/mutations.js";
import { normalizeWikiPagePath } from "./paths.js";
import { ClaimsStore } from "./store.js";
import type { Claim, EvidenceResolver } from "../../core/types.js";
import type {
  FetchClaimsResult,
  GroundingIssue,
  PageClaims,
  UpdateClaimsInput,
} from "./types.js";
import { CODE_CLAIMS_SCHEMA_VERSION } from "./types.js";

/**
 * Injectable Claim session options.
 */
export interface ClaimSessionOptions {
  /**
   * Deterministic repository evidence resolver.
   */
  resolver: EvidenceResolver;

  /**
   * Valid persisted page state loaded before the run.
   */
  persisted: Map<string, PageClaims>;

  /**
   * Deterministic preflight issues requiring reconciliation.
   */
  issues: GroundingIssue[];

  /**
   * Sidecars whose Markdown pages no longer exist.
   */
  orphanPages: string[];

  /**
   * Identifier factory used for newly added claims.
   *
   * @default a `claim_`-prefixed cryptographically random UUID.
   */
  createClaimId?: () => string;
}

/**
 * Internal mutable state for one generated page during one run.
 */
interface WorkingPageState {
  /**
   * Complete current working claim set.
   */
  claims: Claim[];

  /**
   * Completion gate for the latest queued mutation on this page.
   */
  pendingMutation: Promise<void>;

  /**
   * Monotonic claim revision incremented after every successful mutation batch.
   */
  revision: number;

  /**
   * Most recent revision returned through `fetch_claims`.
   *
   * @default undefined until the agent fetches this page's claims.
   */
  fetchedRevision?: number;

  /**
   * Claim revision used by the latest successful Markdown write.
   *
   * @default undefined until the page is written after a matching fetch.
   */
  writtenRevision?: number;

  /**
   * Whether the page was deleted after fetching an empty claim set.
   *
   * @default false.
   */
  deleted: boolean;
}

/**
 * Run-scoped authoritative working claim state.
 */
export class ClaimSession {
  /**
   * Deterministic evidence resolver.
   */
  private readonly resolver: EvidenceResolver;

  /**
   * Working page state keyed by canonical virtual path.
   */
  private readonly pages = new Map<string, WorkingPageState>();

  /**
   * Sidecars eligible for successful-run orphan cleanup.
   */
  private readonly orphanPages: string[];

  /**
   * OpenWiki-owned identifier factory.
   */
  private readonly createClaimId: () => string;

  constructor(options: ClaimSessionOptions) {
    this.resolver = options.resolver;
    this.orphanPages = [
      ...new Set(options.orphanPages.map(normalizeWikiPagePath)),
    ].sort((left, right) => left.localeCompare(right));
    this.createClaimId =
      options.createClaimId ??
      (() => `claim_${randomUUID().replaceAll("-", "")}`);

    const issuePages = new Set(
      options.issues.map((issue) => normalizeWikiPagePath(issue.page)),
    );
    for (const [page, persisted] of options.persisted) {
      const normalizedPage = normalizeWikiPagePath(page);
      if (this.pages.has(normalizedPage)) {
        throw new ClaimSessionError(
          `Duplicate persisted claim page: ${normalizedPage}`,
        );
      }
      this.pages.set(normalizedPage, {
        claims: cloneClaims(persisted.claims),
        pendingMutation: Promise.resolve(),
        revision: 0,
        deleted: false,
      });
    }
    for (const page of issuePages) {
      if (!this.pages.has(page)) {
        this.pages.set(page, {
          claims: [],
          pendingMutation: Promise.resolve(),
          revision: 0,
          deleted: false,
        });
      }
    }
  }

  /**
   * Validates, resolves, and atomically applies a claim mutation batch.
   *
   * @param input - Page and ordered claim operations.
   * @returns Canonical page, new revision, and complete claim identifiers.
   */
  async updateClaims(input: UpdateClaimsInput): Promise<{
    /**
     * Canonical virtual page path.
     */
    page: string;

    /**
     * New run-scoped claim revision.
     */
    revision: number;

    /**
     * Complete stable claim identifiers after the mutation.
     */
    claimIds: string[];
  }> {
    const page = normalizeWikiPagePath(input.page);
    const current = this.getOrCreatePage(page);
    const previousMutation = current.pendingMutation;
    let releaseMutation = (): void => undefined;
    current.pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    await previousMutation;

    try {
      current.claims = await applyClaimOperations({
        claims: current.claims,
        operations: input.operations,
        resolver: this.resolver,
        createClaimId: this.createClaimId,
      });
      current.revision += 1;
      current.fetchedRevision = undefined;
      current.writtenRevision = undefined;
      current.deleted = false;
      return {
        page,
        revision: current.revision,
        claimIds: current.claims.map((claim) => claim.id),
      };
    } finally {
      releaseMutation();
    }
  }

  /**
   * Returns and records the authoritative claim revision used for page writing.
   *
   * @param pageInput - Virtual generated-page path.
   * @returns Complete cloned claim state and current revision.
   */
  fetchClaims(pageInput: string): FetchClaimsResult {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.getOrCreatePage(page);
    state.fetchedRevision = state.revision;
    return {
      revision: state.revision,
      claims: cloneClaims(state.claims),
    };
  }

  /**
   * Returns claims to OpenWiki-owned transforms without satisfying agent fetch ordering.
   *
   * @param pageInput - Virtual generated-page path.
   * @returns Complete cloned working claims.
   */
  inspectClaims(pageInput: string): Claim[] {
    return cloneClaims(
      this.getOrCreatePage(normalizeWikiPagePath(pageInput)).claims,
    );
  }

  /**
   * Verifies that the agent fetched the exact current revision before a page write.
   *
   * @param pageInput - Virtual generated-page path.
   */
  assertReadyForWrite(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.getOrCreatePage(page);
    if (state.fetchedRevision !== state.revision) {
      throw new ClaimSessionError(
        `Call fetch_claims for ${page} before writing or deleting it.`,
      );
    }
  }

  /**
   * Verifies fetch ordering and an empty claim set before page deletion.
   *
   * @param pageInput - Virtual generated-page path.
   */
  assertReadyForDeletion(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    this.assertReadyForWrite(page);
    const state = this.getOrCreatePage(page);
    if (state.claims.length > 0) {
      throw new ClaimSessionError(
        `Delete all claims for ${page} with update_claims, then call fetch_claims before deleting the page.`,
      );
    }
  }

  /**
   * Records a successful agent Markdown write at the fetched revision.
   *
   * @param pageInput - Virtual generated-page path.
   */
  recordWrite(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    this.assertReadyForWrite(page);
    const state = this.getOrCreatePage(page);
    state.writtenRevision = state.revision;
    state.deleted = false;
  }

  /**
   * Records a successful deletion after the agent removed every page claim.
   *
   * @param pageInput - Virtual generated-page path.
   */
  recordDeletion(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    this.assertReadyForDeletion(page);
    const state = this.getOrCreatePage(page);
    state.writtenRevision = state.revision;
    state.deleted = true;
  }

  /**
   * Records a Claims-constrained OpenWiki-owned translation.
   *
   * Translation receives the complete current claims directly from the session,
   * so it is equivalent to a code-owned fetch and write at the unchanged revision.
   *
   * @param pageInput - Virtual generated-page path.
   */
  recordOwnedTranslation(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.getOrCreatePage(page);
    state.fetchedRevision = state.revision;
    state.writtenRevision = state.revision;
    state.deleted = false;
  }

  /**
   * Persists only pages synchronized during this successful run.
   *
   * Unaddressed pages keep their prior sidecars or remain sidecar-free, preserving
   * their stale or ungrounded signal for the next preflight.
   *
   * @param store - OpenWiki-owned claim persistence.
   */
  async finalize(store: ClaimsStore): Promise<void> {
    for (const orphan of this.orphanPages) {
      await store.deletePage(orphan);
    }

    for (const [page, state] of this.pages) {
      await state.pendingMutation;
      if (state.writtenRevision !== state.revision) {
        continue;
      }
      if (state.deleted) {
        await store.deletePage(page);
        continue;
      }

      await store.writePage(page, {
        schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
        pageVersion: await store.hashPage(page),
        claims: cloneClaims(state.claims),
      });
    }
  }

  /**
   * Gets or initializes empty page state for a newly planned page.
   *
   * @param page - Canonical virtual generated-page path.
   * @returns Mutable run-scoped page state.
   */
  private getOrCreatePage(page: string): WorkingPageState {
    const existing = this.pages.get(page);
    if (existing) {
      return existing;
    }
    const created: WorkingPageState = {
      claims: [],
      pendingMutation: Promise.resolve(),
      revision: 0,
      deleted: false,
    };
    this.pages.set(page, created);
    return created;
  }
}
