import type { StructuredToolInterface } from "@langchain/core/tools";
import { describe, expect, test, vi } from "vitest";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import {
  createClaimsDeleteFileTool,
  createClaimsTools,
} from "../../../../src/claims/brains/code/tools.ts";
import type {
  EvidenceResolver,
  ResolvedEvidence,
} from "../../../../src/claims/core/types.ts";

/**
 * Finds one named Claims tool.
 *
 * @param tools - Run-bound Claims tools.
 * @param name - Exact tool name.
 * @returns Matching structured tool.
 */
function getTool(
  tools: readonly StructuredToolInterface[],
  name: string,
): StructuredToolInterface {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing Claims tool ${name}`);
  }
  return tool;
}

/**
 * Creates a resolver that owns canonical resource versions.
 *
 * @returns Resolver for the tool fixtures.
 */
function createResolver(): EvidenceResolver {
  return {
    resolve(resource: string): Promise<ResolvedEvidence> {
      return Promise.resolve({
        evidence: {
          resource: resource.replace("draft", "canonical"),
          version: "memory-v1:revision:7",
        },
        content: "fixture content",
      });
    },
  };
}

/**
 * Creates an empty deterministic claim session.
 *
 * @returns Run-scoped Claims session.
 */
function createSession(): ClaimSession {
  return new ClaimSession({
    resolver: createResolver(),
    persisted: new Map(),
    issues: [],
    orphanPages: [],
    createClaimId: () => "claim_generated",
  });
}

describe("createClaimsTools", () => {
  test("exposes only update and fetch tools", () => {
    const tools = createClaimsTools(createSession());

    expect(tools.map((tool) => tool.name)).toEqual([
      "update_claims",
      "fetch_claims",
    ]);
    expect(getTool(tools, "update_claims").description).toContain(
      "OpenWiki resolves versions and IDs",
    );
  });

  test("returns OpenWiki-owned IDs and resolver-owned versions", async () => {
    const tools = createClaimsTools(createSession());
    const update = getTool(tools, "update_claims");
    const fetch = getTool(tools, "fetch_claims");
    const page = "/openwiki/page.md";

    const updateOutput: unknown = await update.invoke({
      page,
      operations: [
        {
          op: "add",
          statement: "  A generated fact.  ",
          evidence: [{ resource: "memory://draft/fact" }],
        },
      ],
    });
    const fetchOutput: unknown = await fetch.invoke({ page });

    expect(updateOutput).toBe(
      JSON.stringify(
        { page, revision: 1, claimIds: ["claim_generated"] },
        null,
        2,
      ),
    );
    expect(fetchOutput).toBe(
      JSON.stringify(
        {
          revision: 1,
          claims: [
            {
              id: "claim_generated",
              statement: "A generated fact.",
              evidence: [
                {
                  resource: "memory://canonical/fact",
                  version: "memory-v1:revision:7",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  test("rejects agent-supplied IDs, versions, and unknown properties on add", async () => {
    const update = getTool(createClaimsTools(createSession()), "update_claims");
    const page = "/openwiki/page.md";

    for (const operation of [
      {
        op: "add",
        id: "agent_id",
        statement: "Fact.",
        evidence: [{ resource: "memory://draft/fact" }],
      },
      {
        op: "add",
        statement: "Fact.",
        evidence: [
          { resource: "memory://draft/fact", version: "agent_version" },
        ],
      },
      {
        op: "add",
        statement: "Fact.",
        evidence: [{ resource: "memory://draft/fact" }],
        unknown: true,
      },
    ]) {
      await expect(
        update.invoke({ page, operations: [operation] }),
      ).rejects.toThrow();
    }
  });

  test("rejects empty, whitespace, and structurally invalid inputs", async () => {
    const tools = createClaimsTools(createSession());
    const update = getTool(tools, "update_claims");
    const fetch = getTool(tools, "fetch_claims");

    await expect(
      update.invoke({ page: "/openwiki/page.md", operations: [] }),
    ).rejects.toThrow();
    await expect(
      update.invoke({
        page: "/openwiki/page.md",
        operations: [
          {
            op: "add",
            statement: "Fact.",
            evidence: [{ resource: " " }],
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      fetch.invoke({ page: "/openwiki/page.md", unknown: true }),
    ).rejects.toThrow();
  });
});

describe("createClaimsDeleteFileTool", () => {
  test("deletes and records a fetched page with no remaining claims", async () => {
    const session = createSession();
    const page = "/openwiki/page.md";
    session.fetchClaims(page);
    const deleteFile = vi.fn(() => Promise.resolve({ path: page }));
    const backend = { delete: deleteFile };
    const recordDeletion = vi.spyOn(session, "recordDeletion");
    const tool = createClaimsDeleteFileTool(session, backend);

    const output: unknown = await tool.invoke({ file_path: page });

    expect(output).toBe(JSON.stringify({ deleted: page }));
    expect(deleteFile).toHaveBeenCalledWith(page);
    expect(recordDeletion).toHaveBeenCalledWith(page);
  });

  test("does not record deletion when the backend refuses it", async () => {
    const session = createSession();
    const page = "/openwiki/page.md";
    session.fetchClaims(page);
    const backend = {
      delete: vi.fn(() => Promise.resolve({ error: "permission denied" })),
    };
    const recordDeletion = vi.spyOn(session, "recordDeletion");
    const tool = createClaimsDeleteFileTool(session, backend);

    const output: unknown = await tool.invoke({ file_path: page });

    expect(output).toBe(JSON.stringify({ error: "permission denied" }));
    expect(recordDeletion).not.toHaveBeenCalled();
  });

  test("requires fetch ordering and a factual generated page", async () => {
    const session = createSession();
    const backend = {
      delete: vi.fn(() => Promise.resolve({ path: "/openwiki/page.md" })),
    };
    const tool = createClaimsDeleteFileTool(session, backend);

    await expect(
      tool.invoke({ file_path: "/openwiki/page.md" }),
    ).rejects.toThrow("Call fetch_claims");
    await expect(
      tool.invoke({ file_path: "/openwiki/index.md" }),
    ).rejects.toThrow("reserved or structural");
  });
});
