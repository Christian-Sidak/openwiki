import { ToolMessage } from "@langchain/core/messages";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MUTATION_PATH_METADATA_KEY } from "../../../../src/agent/docs-only-backend.ts";
import { createClaimsAuthoringMiddleware } from "../../../../src/claims/brains/code/middleware.ts";
import { ClaimSession } from "../../../../src/claims/brains/code/session.ts";
import { ClaimsStore } from "../../../../src/claims/brains/code/store.ts";
import type { PageClaims } from "../../../../src/claims/brains/code/types.ts";
import type { Claim } from "../../../../src/claims/core/types.ts";

/**
 * Middleware type returned by the Claims authoring factory.
 */
type ClaimsMiddleware = ReturnType<typeof createClaimsAuthoringMiddleware>;

/**
 * Concrete Claims tool wrapper hook.
 */
type ClaimsToolWrapper = NonNullable<ClaimsMiddleware["wrapToolCall"]>;

/**
 * Existing claim fixture used to protect deletion.
 */
const EXISTING_CLAIM: Claim = {
  id: "claim_existing",
  statement: "The page contains a fact.",
  evidence: [{ resource: "memory://fact", version: "revision:1" }],
};

/**
 * Creates an empty or persisted Claims session.
 *
 * @param claims - Initial claims for `/openwiki/page.md`.
 * @returns Run-scoped session.
 */
function createSession(claims: Claim[] = []): ClaimSession {
  return new ClaimSession({
    resolver: { resolve: () => Promise.resolve(null) },
    persisted:
      claims.length === 0
        ? new Map<string, PageClaims>()
        : new Map([
            [
              "/openwiki/page.md",
              {
                schemaVersion: 1,
                pageVersion: `sha256:${"a".repeat(64)}`,
                claims,
              },
            ],
          ]),
    issues: [],
    orphanPages: [],
  });
}

/**
 * Creates a backend-confirmed mutation result.
 *
 * @param pathValue - Backend-confirmed mutated path.
 * @param status - Tool completion status.
 * @returns Mutation ToolMessage.
 */
function mutationMessage(
  pathValue: string,
  status: "success" | "error" = "success",
): ToolMessage {
  return new ToolMessage({
    content: status === "success" ? "Wrote file." : "Write failed.",
    metadata: { [MUTATION_PATH_METADATA_KEY]: pathValue },
    status,
    tool_call_id: "write-1",
  });
}

/**
 * Invokes the middleware wrapper with a minimal tool-call request.
 *
 * @param middleware - Claims middleware under test.
 * @param toolName - Filesystem tool name.
 * @param requestedPath - Requested filesystem path.
 * @param handler - Underlying tool handler.
 * @returns Middleware tool result.
 */
async function invokeMiddleware(
  middleware: ClaimsMiddleware,
  toolName: string,
  requestedPath: string,
  handler: Parameters<ClaimsToolWrapper>[1],
): Promise<Awaited<ReturnType<ClaimsToolWrapper>>> {
  const wrapper = middleware.wrapToolCall;
  if (!wrapper) {
    throw new Error("Claims middleware is missing its tool wrapper.");
  }
  const request = {
    toolCall: {
      args: { file_path: requestedPath },
      id: "claims-call-1",
      name: toolName,
    },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  } as unknown as Parameters<ClaimsToolWrapper>[0];
  return wrapper(request, handler);
}

describe("createClaimsAuthoringMiddleware", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-middleware-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  /**
   * Creates the factual page used for finalization assertions.
   */
  async function createPage(): Promise<void> {
    const pagePath = path.join(rootDir, "openwiki/page.md");
    await mkdir(path.dirname(pagePath), { recursive: true });
    await writeFile(pagePath, "# Page\n", "utf8");
  }

  test("returns an actionable error before a factual write without fetch", async () => {
    const session = createSession();
    const middleware = createClaimsAuthoringMiddleware(session);
    const handler = vi.fn(() =>
      Promise.resolve(mutationMessage("/openwiki/page.md")),
    );

    const result = await invokeMiddleware(
      middleware,
      "write_file",
      "/openwiki/page.md",
      handler,
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    if (!ToolMessage.isInstance(result)) {
      throw new Error("Expected an authoring error ToolMessage.");
    }
    expect(result.status).toBe("error");
    expect(result.content).toContain("Call fetch_claims");
    expect(result.tool_call_id).toBe("claims-call-1");
    expect(handler).not.toHaveBeenCalled();
  });

  test("records a backend-confirmed write after fetch for finalization", async () => {
    await createPage();
    const session = createSession();
    const middleware = createClaimsAuthoringMiddleware(session);
    const success = mutationMessage("/openwiki/page.md");
    const handler = vi.fn(() => Promise.resolve(success));
    session.fetchClaims("/openwiki/page.md");

    const result = await invokeMiddleware(
      middleware,
      "write_file",
      "/openwiki/page.md",
      handler,
    );
    const store = new ClaimsStore(rootDir);
    await session.finalize(store);

    expect(result).toBe(success);
    expect(handler).toHaveBeenCalledOnce();
    await expect(store.loadPage("/openwiki/page.md")).resolves.toEqual(
      expect.objectContaining({ claims: [] }),
    );
  });

  test("does not record unconfirmed, mismatched, or failed mutations", async () => {
    await createPage();
    const store = new ClaimsStore(rootDir);

    for (const result of [
      new ToolMessage({ content: "No metadata.", tool_call_id: "write-1" }),
      mutationMessage("/openwiki/other.md"),
      mutationMessage("/openwiki/page.md", "error"),
    ]) {
      const session = createSession();
      const middleware = createClaimsAuthoringMiddleware(session);
      session.fetchClaims("/openwiki/page.md");
      await invokeMiddleware(
        middleware,
        "write_file",
        "/openwiki/page.md",
        () => Promise.resolve(result),
      );
      await session.finalize(store);
      await expect(store.loadPage("/openwiki/page.md")).resolves.toBeNull();
    }
  });

  test("ignores structural page writes", async () => {
    const session = createSession();
    const middleware = createClaimsAuthoringMiddleware(session);
    const success = mutationMessage("/openwiki/index.md");
    const handler = vi.fn(() => Promise.resolve(success));

    const result = await invokeMiddleware(
      middleware,
      "write_file",
      "/openwiki/index.md",
      handler,
    );

    expect(result).toBe(success);
    expect(handler).toHaveBeenCalledOnce();
  });

  test("blocks deletion with remaining claims before calling the backend", async () => {
    const session = createSession([EXISTING_CLAIM]);
    const middleware = createClaimsAuthoringMiddleware(session);
    const handler = vi.fn(() =>
      Promise.resolve(mutationMessage("/openwiki/page.md")),
    );
    session.fetchClaims("/openwiki/page.md");

    const result = await invokeMiddleware(
      middleware,
      "delete_file",
      "/openwiki/page.md",
      handler,
    );

    expect(ToolMessage.isInstance(result)).toBe(true);
    if (!ToolMessage.isInstance(result)) {
      throw new Error("Expected a deletion error ToolMessage.");
    }
    expect(result.status).toBe("error");
    expect(result.content).toContain("Delete all claims");
    expect(handler).not.toHaveBeenCalled();
  });
});
