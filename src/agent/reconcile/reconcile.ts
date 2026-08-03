import type { OpenWikiIgnore } from "../openwiki-ignore.js";
import { gatherRepoEvidence, type RepoEvidence } from "./evidence.js";
import { compileGlob } from "./glob.js";
import type { ManifestSection, OpenWikiManifest } from "../manifest/types.js";

/**
 * What one section needs this run.
 */
export type SectionVerdict =
  | { kind: "missing"; section: ManifestSection }
  | { kind: "stale"; section: ManifestSection; changedFiles: string[] }
  | { kind: "fast-forward"; section: ManifestSection }
  | { kind: "abandoned"; section: ManifestSection };

/**
 * The full mechanical result of a reconcile pass. Zero agent calls to
 * produce.
 */
export interface ReconcileResult {
  /**
   * Pinned run head; every pointer advance this run uses it.
   */
  runHead: string;

  verdicts: SectionVerdict[];

  /**
   * Changed paths no section claims: the new-domain signal for the planner.
   */
  unclaimed: string[];
}

/**
 * Gathers evidence and computes verdicts. The only entry point Phase 4 calls.
 */
export async function reconcile(
  cwd: string,
  manifest: OpenWikiManifest,
  ignore: OpenWikiIgnore,
): Promise<ReconcileResult> {
  const evidence = await gatherRepoEvidence(cwd, ignore);
  return computeVerdicts(manifest, evidence);
}

/**
 * Pure verdict computation, exported separately so tests can inject evidence.
 *
 * Per section: null head → missing; changed ∩ sources non-empty → stale with
 * exactly that file list; empty → fast-forward (sound because the claim is
 * scoped: "nothing this section documents changed"). Unclaimed = changed
 * paths matching no section, scanned from the oldest non-null head so
 * nothing slips between per-section ranges.
 */
export async function computeVerdicts(
  manifest: OpenWikiManifest,
  evidence: RepoEvidence,
): Promise<ReconcileResult> {
  const verdicts: SectionVerdict[] = [];
  const allClaimed = manifest.sections.flatMap((section) =>
    section.sources.map(compileGlob),
  );

  for (const section of manifest.sections) {
    if (section.abandoned) {
      verdicts.push({ kind: "abandoned", section });
      continue;
    }
    if (section.head === null) {
      verdicts.push({ kind: "missing", section });
      continue;
    }

    // No short-circuit when section.head === runHead: the committed diff is
    // empty there, but changedSince still folds in dirtyPaths, so an
    // uncommitted edit to an otherwise up-to-date section is caught rather
    // than passed over as fast-forward.
    const changed = await evidence.changedSince(section.head);
    const compiled = section.sources.map(compileGlob);
    const changedFiles = changed.filter((path) =>
      compiled.some((regex) => regex.test(path)),
    );

    verdicts.push(
      changedFiles.length > 0
        ? { kind: "stale", section, changedFiles }
        : { kind: "fast-forward", section },
    );
  }

  const unclaimed = await computeUnclaimed(manifest, evidence, allClaimed);

  return { runHead: evidence.runHead, verdicts, unclaimed };
}

/**
 * Changed paths claimed by nobody. Scanned from the oldest written head; on a
 * fresh init (no written heads) there is nothing to scan against, dirty paths
 * included, because the planner is about to see the whole tree anyway.
 */
async function computeUnclaimed(
  manifest: OpenWikiManifest,
  evidence: RepoEvidence,
  claimed: RegExp[],
): Promise<string[]> {
  const writtenHeads = manifest.sections
    .map((section) => section.head)
    .filter((head): head is string => head !== null);

  if (writtenHeads.length === 0) {
    return [];
  }

  // Union of per-head changes covers everything since the oldest head without
  // needing ancestry math here: changedSince is per-head and cached.
  const changed = new Set<string>();

  for (const head of new Set(writtenHeads)) {
    for (const path of await evidence.changedSince(head)) {
      changed.add(path);
    }
  }

  return [...changed].filter(
    (path) => !claimed.some((regex) => regex.test(path)),
  );
}
