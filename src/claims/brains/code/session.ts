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

  /**
   * Whether deterministic preflight requires agent-owned reconciliation.
   */
  requiresReconciliation: boolean;
}

/**
 * One synchronized page frozen for a finalization pass.
 */
interface FinalizablePage {
  /**
   * Canonical generated-page path.
   */
  page: string;

  /**
   * Mutable run state selected at the start of finalization.
   */
  state: WorkingPageState;

  /**
   * Hash of the finalized Markdown.
   *
   * @default undefined when the page was deleted.
   */
  pageVersion?: string;
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
        requiresReconciliation: issuePages.has(normalizedPage),
      });
    }
    for (const page of issuePages) {
      if (!this.pages.has(page)) {
        this.pages.set(page, {
          claims: [],
          pendingMutation: Promise.resolve(),
          revision: 0,
          deleted: false,
          requiresReconciliation: true,
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
   * Returns factual constraints for an OpenWiki-owned translation.
   *
   * A code-owned translation may bypass the agent fetch tool only when the page
   * existed in valid persisted state and deterministic preflight found no issue.
   *
   * @param pageInput - Virtual generated-page path.
   * @returns Complete cloned claims, or `null` when the agent must reconcile it.
   */
  getOwnedTranslationClaims(pageInput: string): Claim[] | null {
    const page = normalizeWikiPagePath(pageInput);
    const state = this.pages.get(page);
    if (!state || state.requiresReconciliation) {
      return null;
    }
    return cloneClaims(state.claims);
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
   * This records only the code-owned write; a later agent edit still requires
   * its own `fetch_claims` call.
   *
   * @param pageInput - Virtual generated-page path.
   */
  recordOwnedTranslation(pageInput: string): void {
    const page = normalizeWikiPagePath(pageInput);
    if (this.getOwnedTranslationClaims(page) === null) {
      throw new ClaimSessionError(
        `Cannot translate ${page} outside agent reconciliation.`,
      );
    }
    const state = this.pages.get(page);
    if (!state) {
      throw new ClaimSessionError(`Missing working state for ${page}.`);
    }
    state.fetchedRevision = undefined;
    state.writtenRevision = state.revision;
    state.deleted = false;
  }

  /**
   * Persists pages synchronized during this successful run.
   *
   * Unaddressed pages keep their prior state. Every eligible page is rechecked
   * against current evidence and finalized Markdown before sidecars are mutated.
   *
   * @param store - OpenWiki-owned claim persistence.
   */
  async finalize(store: ClaimsStore): Promise<void> {
    const ready: FinalizablePage[] = [];

    for (const [page, state] of this.pages) {
      await state.pendingMutation;
      if (state.writtenRevision !== state.revision) {
        continue;
      }
      await this.assertEvidenceStillCurrent(page, state.claims);
      ready.push({
        page,
        state,
        pageVersion: state.deleted ? undefined : await store.hashPage(page),
      });
    }

    for (const orphan of this.orphanPages) {
      await store.deletePage(orphan);
    }

    for (const item of ready) {
      if (item.state.deleted) {
        await store.deletePage(item.page);
        continue;
      }
      if (!item.pageVersion) {
        throw new ClaimSessionError(
          `Missing finalized page version for ${item.page}.`,
        );
      }
      await store.writePage(item.page, {
        schemaVersion: CODE_CLAIMS_SCHEMA_VERSION,
        pageVersion: item.pageVersion,
        claims: cloneClaims(item.state.claims),
      });
    }
  }

  /**
   * Verifies that a page's evidence still matches the versions accepted this run.
   *
   * @param page - Canonical virtual generated-page path.
   * @param claims - Complete claims about to be persisted.
   */
  private async assertEvidenceStillCurrent(
    page: string,
    claims: readonly Claim[],
  ): Promise<void> {
    for (const claim of claims) {
      for (const evidence of claim.evidence) {
        const current = await this.resolver.resolve(evidence.resource);
        if (!current) {
          throw new ClaimSessionError(
            `Evidence disappeared before finalizing ${page}: ${evidence.resource}`,
          );
        }
        if (current.evidence.version !== evidence.version) {
          throw new ClaimSessionError(
            `Evidence changed before finalizing ${page}: ${evidence.resource}`,
          );
        }
      }
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
      requiresReconciliation: true,
    };
    this.pages.set(page, created);
    return created;
  }
}
