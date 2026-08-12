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
import {
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../../../src/claims/core/errors.ts";

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

/**
 * Verifies one model-correctable Claims tool result.
 *
 * @param output - Unknown structured-tool output.
 */
function expectRetryableToolOutput(output: unknown): void {
  const parsed: unknown = JSON.parse(String(output));
  expect(parsed).toMatchObject({ retryable: true });
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    throw new Error("Expected a retryable Claims tool error.");
  }
  expect(typeof parsed.error).toBe("string");
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

  test("canonicalizes wiki-relative page paths at the tool boundary", async () => {
    const tools = createClaimsTools(createSession());
    const update = getTool(tools, "update_claims");
    const fetch = getTool(tools, "fetch_claims");

    const updateOutput: unknown = await update.invoke({
      page: "components/task.md",
      operations: [
        {
          op: "add",
          statement: "A task is queued.",
          evidence: [{ resource: "memory://draft/task" }],
        },
      ],
    });
    const fetchOutput: unknown = await fetch.invoke({
      page: "openwiki/components/task.md",
    });

    expect(JSON.parse(String(updateOutput))).toMatchObject({
      page: "/openwiki/components/task.md",
      revision: 1,
    });
    expect(JSON.parse(String(fetchOutput))).toMatchObject({
      revision: 1,
      claims: [{ statement: "A task is queued." }],
    });
  });

  test("rejects agent-supplied fields through the tool schema", async () => {
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
      ).rejects.toThrow("did not match expected schema");
    }
  });

  test("rejects structurally invalid inputs through the tool schema", async () => {
    const tools = createClaimsTools(createSession());
    const update = getTool(tools, "update_claims");
    const fetch = getTool(tools, "fetch_claims");

    await expect(
      update.invoke({ page: "/openwiki/page.md", operations: [] }),
    ).rejects.toThrow("did not match expected schema");
    await expect(
      fetch.invoke({ page: "/openwiki/page.md", unknown: true }),
    ).rejects.toThrow("did not match expected schema");
  });

  test("returns retryable errors for semantically invalid inputs", async () => {
    const tools = createClaimsTools(createSession());
    const update = getTool(tools, "update_claims");
    const fetch = getTool(tools, "fetch_claims");

    for (const invocation of [
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
      fetch.invoke({ page: "../outside.md" }),
    ]) {
      const output: unknown = await invocation;
      expectRetryableToolOutput(output);
    }
  });

  test("returns unresolved evidence as a retryable tool error", async () => {
    const resolver: EvidenceResolver = {
      resolve: () => Promise.resolve(null),
    };
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: [],
    });
    const update = getTool(createClaimsTools(session), "update_claims");

    const output: unknown = await update.invoke({
      page: "page.md",
      operations: [
        {
          op: "add",
          statement: "Missing fact.",
          evidence: [{ resource: "repo://src/missing.ts#missing" }],
        },
      ],
    });

    expect(JSON.parse(String(output))).toEqual({
      error: "Evidence does not resolve: repo://src/missing.ts#missing",
      retryable: true,
    });
  });

  test("returns invalid evidence resources as retryable tool errors", async () => {
    const resolver: EvidenceResolver = {
      resolve: () =>
        Promise.reject(new EvidenceResourceError("unsupported resource")),
    };
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: [],
    });
    const update = getTool(createClaimsTools(session), "update_claims");

    const output: unknown = await update.invoke({
      page: "page.md",
      operations: [
        {
          op: "add",
          statement: "Fact.",
          evidence: [{ resource: "web://unsupported" }],
        },
      ],
    });

    expectRetryableToolOutput(output);
    expect(String(output)).toContain("unsupported resource");
  });

  test("does not hide operational evidence failures", async () => {
    const resolver: EvidenceResolver = {
      resolve: () =>
        Promise.reject(new EvidenceResolutionError("parser unavailable")),
    };
    const session = new ClaimSession({
      resolver,
      persisted: new Map(),
      issues: [],
      orphanPages: [],
    });
    const update = getTool(createClaimsTools(session), "update_claims");

    await expect(
      update.invoke({
        page: "page.md",
        operations: [
          {
            op: "add",
            statement: "Fact.",
            evidence: [{ resource: "repo://src/page.ts#fact" }],
          },
        ],
      }),
    ).rejects.toThrow("parser unavailable");
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

    expect(JSON.parse(String(output))).toEqual({ deleted: page });
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

    expect(JSON.parse(String(output))).toEqual({ error: "permission denied" });
    expect(recordDeletion).not.toHaveBeenCalled();
  });

  test("returns retryable errors for invalid deletion ordering and paths", async () => {
    const session = createSession();
    const backend = {
      delete: vi.fn(() => Promise.resolve({ path: "/openwiki/page.md" })),
    };
    const tool = createClaimsDeleteFileTool(session, backend);

    for (const filePath of ["page.md", "/openwiki/index.md"]) {
      const output: unknown = await tool.invoke({ file_path: filePath });
      expectRetryableToolOutput(output);
    }
  });
});
