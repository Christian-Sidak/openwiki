/**
 * One wiki section: the unit of planning, writing, retry, and staleness.
 */
export interface ManifestSection {
  /**
   * Wiki-relative directory this section owns, with a trailing slash
   * (e.g. "architecture/"). Pages inside it belong to this section's unit.
   */
  path: string;

  /**
   * Repo-relative glob patterns this section documents (e.g. "src/billing/**").
   * Pointers into the code, never modifications of it. A changed file matching
   * one of these marks the section stale.
   */
  sources: string[];

  /**
   * Commit this section was last verified against. null means planned but
   * never written: the section enters the work list as "missing".
   */
  head: string | null;

  /**
   * Consecutive attributable failures (truncation, tool errors). Environmental
   * failures (quota, network) never increment this. Reset to 0 on success.
   */
  attempts: number;

  /**
   * Set when attempts reaches ABANDON_LIMIT. The page freezes at its last
   * head, leaves the floor, and is retried only after a human resets attempts.
   *
   * @default undefined — the section is active
   */
  abandoned?: boolean;

  /**
   * One-line planner description; becomes the writing unit's brief.
   *
   * @default undefined — the section predates briefs or was hand-added
   */
  brief?: string;
}

/**
 * The ledger: what the wiki is supposed to contain and where each part
 * stands. Mirrors the wiki's structure (one entry per section), so it grows
 * with the wiki, not with time. Committed to the repo next to the stamp.
 *
 * Deliberately no lease/lock field: concurrent writers can clobber each
 * other's pointer advances, which costs redone work but can never produce a
 * lie (writes are atomic, pointers advance only after verified pages). The
 * workflow's concurrency group serializes CI; local/CI collisions are rare
 * enough to accept until telemetry says otherwise.
 */
export interface OpenWikiManifest {
  /**
   * Schema version for forward migration.
   */
  version: 1;

  /**
   * One entry per wiki section, in planner order. The complete ledger of what
   * the wiki should contain and where each part stands.
   */
  sections: ManifestSection[];
}

/**
 * Attributable-failure count at which a section is abandoned.
 */
export const ABANDON_LIMIT = 3;
