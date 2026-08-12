import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../../src/claims/brains/code/types.ts";
import { ClaimSessionError } from "../../../../src/claims/core/errors.ts";
import type {
  Claim,
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

/**
 * Valid page version used where current Markdown bytes are irrelevant.
 */
const FIXTURE_PAGE_VERSION = `sha256:${"a".repeat(64)}`;

/**
 * Existing persisted claim fixture.
 */
const EXISTING_CLAIM: Claim = {
  id: "claim_existing",
  statement: "The feature is enabled.",
  evidence: [
    {
      resource: "memory://feature",
      version: "revision:1",
    },
  ],
};

/**
 * Creates a deterministic memory evidence resolver.
 *
 * @param outcomes - Resolution outcomes keyed by resource.
 * @returns Generic resolver for session tests.
 */
function createResolver(
  outcomes: ReadonlyMap<string, ResolvedEvidence | null | Error>,
): EvidenceResolver {
  return {
    resolve(resource: string): Promise<ResolvedEvidence | null> {
      const outcome = outcomes.get(resource);
      if (outcome instanceof Error) {
        return Promise.reject(outcome);
      }
      return Promise.resolve(outcome ?? null);
    },
  };
}

/**
 * Creates resolved memory evidence.
 *
 * @param resource - Stable evidence resource.
 * @param version - Current evidence version.
 * @returns Resolved evidence record.
 */
function resolved(resource: string, version: string): ResolvedEvidence {
  return {
    evidence: { resource, version },
    content: `content for ${resource}`,
  };
}

/**
 * Creates valid persisted state for one claim set.
 *
 * @param claims - Complete persisted claim set.
 * @param pageVersion - Synchronized page hash.
 * @returns Valid page claims.
 */
function persistedClaims(
  claims: Claim[],
  pageVersion = FIXTURE_PAGE_VERSION,
): PageClaims {
  return { schemaVersion: 1, pageVersion, claims };
}

describe("ClaimSession", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-session-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Writes one generated Markdown page.
   *
   * @param page - Virtual page path.
   * @param content - Complete Markdown contents.
   */
  async function writePage(page: string, content: string): Promise<void> {
    const absolute = path.join(rootDir, page.replace(/^\/+/u, ""));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  test("fetches cloned state and authorizes only the current revision", () => {
    const page = "/openwiki/page.md";
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([[page, persistedClaims([EXISTING_CLAIM])]]),
      issues: [],
      orphanPages: [],
    });

    expect(() => session.assertReadyForWrite(page)).toThrow(ClaimSessionError);
    const fetched = session.fetchClaims(page);
    fetched.claims[0].statement = "Mutated outside the session.";
    fetched.claims[0].evidence[0].version = "mutated";

    expect(fetched.revision).toBe(0);
    expect(session.getOwnedTranslationClaims(page)).toEqual([EXISTING_CLAIM]);
    expect(() => session.assertReadyForWrite(page)).not.toThrow();
  });

  test("preserves stable IDs and invalidates an earlier fetch after mutation", async () => {
    const page = "/openwiki/page.md";
    const resource = "memory://feature";
    const session = new ClaimSession({
      resolver: createResolver(
        new Map([[resource, resolved(resource, "revision:2")]]),
      ),
      persisted: new Map([[page, persistedClaims([EXISTING_CLAIM])]]),
      issues: [],
      orphanPages: [],
    });
    session.fetchClaims(page);

    const result = await session.updateClaims({
      page,
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "The feature is disabled.",
          evidence: [{ resource }],
        },
      ],
    });

    expect(result).toEqual({
      page,
      revision: 1,
      claimIds: ["claim_existing"],
    });
    expect(() => session.assertReadyForWrite(page)).toThrow(ClaimSessionError);
    expect(session.fetchClaims(page).claims[0]?.id).toBe("claim_existing");
  });

  test("serializes concurrent mutations on the same page", async () => {
    const page = "/openwiki/page.md";
    const firstResource = "memory://first";
    const secondResource = "memory://second";
    const generatedIds = ["claim_first", "claim_second"];
    const session = new ClaimSession({
      resolver: createResolver(
        new Map([
          [firstResource, resolved(firstResource, "revision:1")],
          [secondResource, resolved(secondResource, "revision:1")],
        ]),
      ),
      persisted: new Map(),
      issues: [],
      orphanPages: [],
      createClaimId: () => generatedIds.shift() ?? "claim_fallback",
    });

    const results = await Promise.all([
      session.updateClaims({
        page,
        operations: [
          {
            op: "add",
            statement: "First fact.",
            evidence: [{ resource: firstResource }],
          },
        ],
      }),
      session.updateClaims({
        page,
        operations: [
          {
            op: "add",
            statement: "Second fact.",
            evidence: [{ resource: secondResource }],
          },
        ],
      }),
    ]);

    expect(results.map((result) => result.revision)).toEqual([1, 2]);
    expect(session.fetchClaims(page).claims.map((claim) => claim.id)).toEqual([
      "claim_first",
      "claim_second",
    ]);
  });

  test("requires an empty fetched claim set before deletion", async () => {
    const page = "/openwiki/page.md";
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([[page, persistedClaims([EXISTING_CLAIM])]]),
      issues: [],
      orphanPages: [],
    });

    session.fetchClaims(page);
    expect(() => session.assertReadyForDeletion(page)).toThrow(
      "Delete all claims",
    );
    await session.updateClaims({
      page,
      operations: [{ op: "delete", id: "claim_existing" }],
    });
    expect(() => session.recordDeletion(page)).toThrow("Call fetch_claims");
    session.fetchClaims(page);
    expect(() => session.recordDeletion(page)).not.toThrow();
  });

  test("failed mutations preserve fetch and write eligibility", async () => {
    const page = "/openwiki/page.md";
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map([[page, persistedClaims([EXISTING_CLAIM])]]),
      issues: [],
      orphanPages: [],
    });
    session.fetchClaims(page);

    await expect(
      session.updateClaims({
        page,
        operations: [
          {
            op: "add",
            statement: "Missing fact.",
            evidence: [{ resource: "memory://missing" }],
          },
        ],
      }),
    ).rejects.toThrow(ClaimSessionError);

    expect(() => session.assertReadyForWrite(page)).not.toThrow();
  });

  test("finalizes only synchronized pages and removes orphans", async () => {
    const reconciledPage = "/openwiki/reconciled.md";
    const untouchedPage = "/openwiki/untouched.md";
    const orphanPage = "/openwiki/orphan.md";
    await writePage(reconciledPage, "# Reconciled\n");
    await writePage(untouchedPage, "# Untouched\n");
    const store = new ClaimsStore(rootDir);
    const reconciledPersisted = persistedClaims(
      [EXISTING_CLAIM],
      await store.hashPage(reconciledPage),
    );
    const untouchedPersisted = persistedClaims(
      [EXISTING_CLAIM],
      await store.hashPage(untouchedPage),
    );
    await store.writePage(reconciledPage, reconciledPersisted);
    await store.writePage(untouchedPage, untouchedPersisted);
    await store.writePage(orphanPage, persistedClaims([]));
    const untouchedSidecar = path.join(
      rootDir,
      "openwiki/.claims/untouched.json",
    );
    const untouchedBefore = await readFile(untouchedSidecar, "utf8");
    const resource = "memory://feature";
    const session = new ClaimSession({
      resolver: createResolver(
        new Map([[resource, resolved(resource, "revision:2")]]),
      ),
      persisted: new Map([
        [reconciledPage, reconciledPersisted],
        [untouchedPage, untouchedPersisted],
      ]),
      issues: [
        {
          page: reconciledPage,
          kind: "stale",
          claimId: "claim_existing",
          resources: [resource],
        },
      ],
      orphanPages: [orphanPage],
    });
    await session.updateClaims({
      page: reconciledPage,
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "The feature is reconciled.",
          evidence: [{ resource }],
        },
      ],
    });
    session.fetchClaims(reconciledPage);
    session.recordWrite(reconciledPage);

    await session.finalize(store);

    expect((await store.loadPage(reconciledPage))?.claims[0]?.statement).toBe(
      "The feature is reconciled.",
    );
    await expect(readFile(untouchedSidecar, "utf8")).resolves.toBe(
      untouchedBefore,
    );
    await expect(store.loadPage(orphanPage)).resolves.toBeNull();
  });

  test("does not mutate persisted sidecars before finalization", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Page\n");
    const store = new ClaimsStore(rootDir);
    const persisted = persistedClaims(
      [EXISTING_CLAIM],
      await store.hashPage(page),
    );
    await store.writePage(page, persisted);
    const resource = "memory://feature";
    const session = new ClaimSession({
      resolver: createResolver(
        new Map([[resource, resolved(resource, "revision:2")]]),
      ),
      persisted: new Map([[page, persisted]]),
      issues: [],
      orphanPages: [],
    });

    await session.updateClaims({
      page,
      operations: [
        {
          op: "update",
          id: "claim_existing",
          statement: "Working state only.",
          evidence: [{ resource }],
        },
      ],
    });

    await expect(store.loadPage(page)).resolves.toEqual(persisted);
  });

  test("persists only the reconciled portion of a legacy wiki", async () => {
    const reconciledPage = "/openwiki/reconciled.md";
    const remainingPage = "/openwiki/remaining.md";
    await writePage(reconciledPage, "# Reconciled\n");
    await writePage(remainingPage, "# Remaining\n");
    const store = new ClaimsStore(rootDir);
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map(),
      issues: [
        { page: reconciledPage, kind: "ungrounded-page" },
        { page: remainingPage, kind: "ungrounded-page" },
      ],
      orphanPages: [],
    });
    session.fetchClaims(reconciledPage);
    session.recordWrite(reconciledPage);

    await session.finalize(store);

    await expect(store.loadPage(reconciledPage)).resolves.toEqual(
      expect.objectContaining({ claims: [] }),
    );
    await expect(store.loadPage(remainingPage)).resolves.toBeNull();
  });

  test("records owned translations at the unchanged revision", async () => {
    const page = "/openwiki/page.md";
    await writePage(page, "# Translated\n");
    const store = new ClaimsStore(rootDir);
    const session = new ClaimSession({
      resolver: createResolver(
        new Map([
          [
            EXISTING_CLAIM.evidence[0].resource,
            resolved(
              EXISTING_CLAIM.evidence[0].resource,
              EXISTING_CLAIM.evidence[0].version,
            ),
          ],
        ]),
      ),
      persisted: new Map([[page, persistedClaims([EXISTING_CLAIM])]]),
      issues: [],
      orphanPages: [],
    });

    session.recordOwnedTranslation(page);
    expect(() => session.assertReadyForWrite(page)).toThrow(
      "Call fetch_claims",
    );
    await session.finalize(store);

    await expect(store.loadPage(page)).resolves.toEqual(
      expect.objectContaining({ claims: [EXISTING_CLAIM] }),
    );
  });

  test("exposes translation claims only for fresh persisted pages", () => {
    const freshPage = "/openwiki/fresh.md";
    const issueKinds = [
      "stale",
      "unresolved",
      "ungrounded-page",
      "out-of-sync-page",
    ] as const;
    const issuePages = issueKinds.map(
      (kind) => `/openwiki/${kind.replaceAll("-", "_")}.md`,
    );
    const persisted = new Map<string, PageClaims>([
      [freshPage, persistedClaims([EXISTING_CLAIM])],
      ...issuePages
        .slice(0, 2)
        .map((page) => [page, persistedClaims([EXISTING_CLAIM])] as const),
      [issuePages[3], persistedClaims([EXISTING_CLAIM])],
    ]);
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted,
      issues: issueKinds.map((kind, index) => ({
        page: issuePages[index],
        kind,
        ...(kind === "stale" || kind === "unresolved"
          ? {
              claimId: "claim_existing",
              resources: ["memory://feature"],
            }
          : {}),
      })),
      orphanPages: [],
    });

    const claims = session.getOwnedTranslationClaims(freshPage);
    expect(claims).toEqual([EXISTING_CLAIM]);
    if (claims) {
      claims[0].statement = "Mutated clone.";
    }
    expect(session.getOwnedTranslationClaims(freshPage)).toEqual([
      EXISTING_CLAIM,
    ]);
    for (const page of issuePages) {
      expect(session.getOwnedTranslationClaims(page)).toBeNull();
      expect(() => session.recordOwnedTranslation(page)).toThrow(
        "outside agent reconciliation",
      );
    }
    expect(
      session.getOwnedTranslationClaims("/openwiki/new-page.md"),
    ).toBeNull();
  });

  test.each([
    ["disappears", null, "Evidence disappeared"],
    ["changes", resolved("memory://feature", "revision:2"), "Evidence changed"],
  ])(
    "aborts all sidecar mutation when evidence %s before finalization",
    async (_condition, finalOutcome, expectedMessage) => {
      const page = "/openwiki/page.md";
      const orphan = "/openwiki/orphan.md";
      await writePage(page, "# Page\n");
      const store = new ClaimsStore(rootDir);
      await store.writePage(orphan, persistedClaims([]));
      const outcomes = new Map<string, ResolvedEvidence | null | Error>([
        ["memory://feature", resolved("memory://feature", "revision:1")],
      ]);
      const session = new ClaimSession({
        resolver: createResolver(outcomes),
        persisted: new Map(),
        issues: [{ page, kind: "ungrounded-page" }],
        orphanPages: [orphan],
        createClaimId: () => "claim_new",
      });
      await session.updateClaims({
        page,
        operations: [
          {
            op: "add",
            statement: "The feature exists.",
            evidence: [{ resource: "memory://feature" }],
          },
        ],
      });
      session.fetchClaims(page);
      session.recordWrite(page);
      outcomes.set("memory://feature", finalOutcome);
      const writeSidecar = vi.spyOn(store, "writePage");
      const deleteSidecar = vi.spyOn(store, "deletePage");

      await expect(session.finalize(store)).rejects.toThrow(expectedMessage);
      expect(writeSidecar).not.toHaveBeenCalled();
      expect(deleteSidecar).not.toHaveBeenCalled();
      await expect(store.loadPage(orphan)).resolves.not.toBeNull();
    },
  );

  test("validates every page hash before deleting or writing sidecars", async () => {
    const readyPage = "/openwiki/ready.md";
    const missingPage = "/openwiki/missing.md";
    const orphan = "/openwiki/orphan.md";
    await writePage(readyPage, "# Ready\n");
    await writePage(missingPage, "# Missing\n");
    const store = new ClaimsStore(rootDir);
    await store.writePage(orphan, persistedClaims([]));
    const session = new ClaimSession({
      resolver: createResolver(new Map()),
      persisted: new Map(),
      issues: [
        { page: readyPage, kind: "ungrounded-page" },
        { page: missingPage, kind: "ungrounded-page" },
      ],
      orphanPages: [orphan],
    });
    for (const page of [readyPage, missingPage]) {
      session.fetchClaims(page);
      session.recordWrite(page);
    }
    await unlink(path.join(rootDir, "openwiki/missing.md"));
    const writeSidecar = vi.spyOn(store, "writePage");
    const deleteSidecar = vi.spyOn(store, "deletePage");

    await expect(session.finalize(store)).rejects.toThrow("Unable to hash");
    expect(writeSidecar).not.toHaveBeenCalled();
    expect(deleteSidecar).not.toHaveBeenCalled();
    await expect(store.loadPage(orphan)).resolves.not.toBeNull();
  });
});
