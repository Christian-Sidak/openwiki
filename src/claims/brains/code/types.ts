import type { Claim, ClaimOperation } from "../../core/types.js";

/**
 * Current persisted code-brain sidecar schema version.
 */
export const CODE_CLAIMS_SCHEMA_VERSION = 1;

/**
 * OpenWiki-owned grounding state for one generated Markdown page.
 */
export interface PageClaims {
  /**
   * Persisted code-brain sidecar format version.
   */
  schemaVersion: number;

  /**
   * SHA-256 version of the finalized Markdown synchronized with these claims.
   */
  pageVersion: string;

  /**
   * Complete material claim set for the page.
   */
  claims: Claim[];
}

/**
 * Input accepted by the code-brain `update_claims` tool.
 */
export interface UpdateClaimsInput {
  /**
   * Virtual generated-page path below `/openwiki`.
   */
  page: string;

  /**
   * Atomic batch of mutations to validate and apply together.
   */
  operations: ClaimOperation[];
}

/**
 * Input accepted by the code-brain `fetch_claims` tool.
 */
export interface FetchClaimsInput {
  /**
   * Virtual generated-page path below `/openwiki`.
   */
  page: string;
}

/**
 * Result returned by the code-brain `fetch_claims` tool.
 */
export interface FetchClaimsResult {
  /**
   * Current run-scoped claim revision for authoring-order validation.
   */
  revision: number;

  /**
   * Complete working claim set for the requested page.
   */
  claims: Claim[];
}

/**
 * Deterministic reason a code-brain claim or page needs reconciliation.
 */
export type GroundingIssueKind =
  "stale" | "unresolved" | "ungrounded-page" | "out-of-sync-page";

/**
 * Compact prompt-facing code-brain grounding issue.
 */
export interface GroundingIssue {
  /**
   * Generated page requiring reconciliation.
   */
  page: string;

  /**
   * Deterministic issue category.
   */
  kind: GroundingIssueKind;

  /**
   * Existing claim identifier when the issue belongs to one claim.
   *
   * @default undefined when the issue belongs to the page as a whole.
   */
  claimId?: string;

  /**
   * Evidence resources whose state caused a claim-level issue.
   *
   * @default undefined for page-level synchronization issues.
   */
  resources?: string[];
}

/**
 * Deterministic Claims input supplied to a code-brain update agent.
 */
export interface GroundingContext {
  /**
   * Compact, stable-order reconciliation worklist.
   */
  issues: GroundingIssue[];
}

/**
 * Outstanding deterministic reconciliation work for one generated page.
 */
export interface ReconciliationObligation {
  /**
   * Generated page that may not yet finish the run.
   */
  page: string;

  /**
   * Original preflight issues whose claims still require mutation.
   *
   * @default an empty array when claim mutations are complete but the final
   * page write is still missing.
   */
  issues: GroundingIssue[];

  /**
   * Whether the page still requires a final fetch followed by a write or deletion.
   */
  requiresPageWrite: boolean;
}
