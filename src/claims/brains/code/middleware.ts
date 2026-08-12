import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { MUTATION_PATH_METADATA_KEY } from "../../../agent/docs-only-backend.js";
import { ClaimSessionError } from "../../core/errors.js";
import { isGroundedWikiPage, normalizeWikiPagePath } from "./paths.js";
import { ClaimSession } from "./session.js";

/**
 * Filesystem tools that create or change generated Markdown.
 */
const PAGE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Filesystem tools that delete generated Markdown.
 */
const PAGE_DELETE_TOOLS = new Set(["delete_file"]);

/**
 * Enforces claim-fetch ordering around generated-page mutations.
 *
 * @param session - Run-scoped authoritative claim state.
 * @returns LangChain middleware guarding page write and delete tools.
 */
export function createClaimsAuthoringMiddleware(session: ClaimSession) {
  return createMiddleware({
    name: "OpenWikiClaimsAuthoringMiddleware",
    wrapToolCall: async (request, handler) => {
      const requestedPath = getRequestedPath(request.toolCall.args);
      const isPageMutation =
        requestedPath !== undefined &&
        isGroundedWikiPage(requestedPath) &&
        (PAGE_WRITE_TOOLS.has(request.toolCall.name) ||
          PAGE_DELETE_TOOLS.has(request.toolCall.name));

      if (isPageMutation) {
        try {
          if (PAGE_DELETE_TOOLS.has(request.toolCall.name)) {
            session.assertReadyForDeletion(requestedPath);
          } else {
            session.assertReadyForWrite(requestedPath);
          }
        } catch (error) {
          return toAuthoringErrorMessage(
            error,
            request.toolCall.id,
            request.toolCall.name,
          );
        }
      }

      const result = await handler(request);
      if (!isPageMutation || !hasSuccessfulMutation(result, requestedPath)) {
        return result;
      }

      try {
        if (PAGE_DELETE_TOOLS.has(request.toolCall.name)) {
          session.recordDeletion(requestedPath);
        } else {
          session.recordWrite(requestedPath);
        }
      } catch (error) {
        return toAuthoringErrorMessage(
          error,
          request.toolCall.id,
          request.toolCall.name,
        );
      }
      return result;
    },
  });
}

/**
 * Converts an authoring-order failure into an actionable agent tool result.
 *
 * @param error - Unknown authoring guard failure.
 * @param toolCallId - Optional model-supplied tool call identifier.
 * @param toolName - Tool name used when no call identifier exists.
 * @returns Error ToolMessage that lets the agent recover in the same run.
 */
function toAuthoringErrorMessage(
  error: unknown,
  toolCallId: string | undefined,
  toolName: string,
): ToolMessage {
  if (!(error instanceof ClaimSessionError)) {
    throw error;
  }
  return new ToolMessage({
    content: error.message,
    status: "error",
    tool_call_id: toolCallId ?? toolName,
  });
}

/**
 * Reads a DeepAgents filesystem path from normalized or compatibility arguments.
 *
 * @param input - Unknown tool-call argument object.
 * @returns Requested path, or `undefined` for non-filesystem arguments.
 */
function getRequestedPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const candidate = record.file_path ?? record.path;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Determines whether a tool result contains a backend-confirmed mutation.
 *
 * @param result - Unknown tool handler result.
 * @param requestedPath - Expected mutation path.
 * @returns Whether the backend marked the requested mutation successful.
 */
function hasSuccessfulMutation(
  result: unknown,
  requestedPath: string,
): boolean {
  return getToolMessages(result).some((message) => {
    if (message.status === "error") {
      return false;
    }
    const mutatedPath = message.metadata?.[MUTATION_PATH_METADATA_KEY];
    if (typeof mutatedPath !== "string") {
      return false;
    }
    try {
      return (
        normalizeWikiPagePath(mutatedPath) ===
        normalizeWikiPagePath(requestedPath)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Extracts ToolMessages from direct and Command-like results.
 *
 * @param result - Unknown tool handler result.
 * @returns Tool messages contained by the result.
 */
function getToolMessages(result: unknown): ToolMessage[] {
  if (ToolMessage.isInstance(result)) {
    return [result];
  }
  if (typeof result !== "object" || result === null) {
    return [];
  }
  const candidate = result as { update?: { messages?: unknown[] } };
  return (candidate.update?.messages ?? []).filter(
    (message): message is ToolMessage => ToolMessage.isInstance(message),
  );
}
