interface ToolDefinition {
  annotations: { destructiveHint: false; readOnlyHint: true };
  description: string;
  inputSchema: object;
  name: string;
}

export const SEARCH_SCOPES = ["all", "wiki", "source_code", "tests"] as const;

function integerSchema(
  minimum: number,
  maximum: number,
  defaultValue: number,
): object {
  return { default: defaultValue, maximum, minimum, type: "integer" };
}

function querySchema(properties: Record<string, object>): object {
  return {
    additionalProperties: false,
    properties: {
      query: { maxLength: 500, minLength: 1, type: "string" },
      ...properties,
    },
    required: ["query"],
    type: "object",
  };
}

function tool(
  name: string,
  description: string,
  inputSchema: object,
): ToolDefinition {
  return {
    annotations: { destructiveHint: false, readOnlyHint: true },
    description,
    inputSchema,
    name,
  };
}

export const RETRIEVAL_TOOL_DEFINITIONS = [
  tool(
    "search",
    "Search the wiki, implementation code, or tests with automatic exact, lexical, semantic, and OKF ranking. Use the tests scope only when analogous behavior is needed, and inspect cited source before relying on it.",
    querySchema({
      limit: integerSchema(1, 10, 5),
      scope: {
        default: "all",
        description:
          "Search all indexed content, only generated wiki pages, implementation source excluding tests, or only test/spec files.",
        enum: SEARCH_SCOPES,
        type: "string",
      },
    }),
  ),
  tool(
    "change_surface",
    "Map a public, stateful, or cross-package change before editing. Returns compact citations for implementation, state-transition producers, exports, publish mirrors, initialization, consumers, and tests.",
    querySchema({ limit: integerSchema(1, 12, 7) }),
  ),
  tool(
    "trace_symbols",
    "After editing public symbols, re-index once and verify them together across implementation, exports, generated/publish mirrors, initialization, consumers, and tests. Missing groups are verification gaps, not automatic requirements.",
    {
      additionalProperties: false,
      properties: {
        limit: integerSchema(1, 6, 4),
        symbols: {
          items: { maxLength: 200, minLength: 1, type: "string" },
          maxItems: 12,
          minItems: 1,
          type: "array",
        },
      },
      required: ["symbols"],
      type: "object",
    },
  ),
] as const satisfies readonly ToolDefinition[];
