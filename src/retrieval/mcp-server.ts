#!/usr/bin/env node

import { createInterface } from "node:readline";
import { OPENWIKI_VERSION } from "../constants.js";
import { RetrievalService } from "./search-service.js";
import type { EmbeddingProvider } from "./semantic.js";
import type { SearchScope } from "./types.js";

interface JsonRpcRequest {
  id?: number | string;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  tool(
    "symbol_trace",
    "After editing, re-index source and trace one exact public symbol through implementation, exports, publish/generated mirrors, initialization, consumer imports, and tests. Missing groups are verification gaps, not proof that a layer is required.",
    querySchema({ limit: integerSchema(1, 12, 6) }),
  ),
  tool(
    "change_surface",
    "Find the complete change surface for a feature: relevant OKF concepts, implementation, exports, publish/generated mirrors, initialization, consumer imports, and tests. Use this first for public or cross-package changes.",
    querySchema({ limit: integerSchema(1, 12, 6) }),
  ),
  tool(
    "test_search",
    "Find analogous focused tests using hybrid keyword, BM25, and semantic ranking restricted to test/spec source chunks. Use this to derive lifecycle, transition, isolation, reset, and composition checks before implementing stateful behavior.",
    searchSchema(),
  ),
  tool(
    "hybrid_search",
    "Hybrid reciprocal-rank search across BM25, semantic vectors, weighted keywords, and the OKF concept graph.",
    searchSchema(),
  ),
  tool(
    "okf_graph_search",
    "Search OKF concept metadata, then expand across semantic Markdown relationships, incoming links, and shared tags.",
    querySchema({
      hops: integerSchema(0, 2, 1),
      limit: integerSchema(1, 20, 8),
    }),
  ),
  tool(
    "semantic_search",
    "Vector semantic search over bounded wiki/source candidates. The response reports whether OpenAI embeddings or the deterministic local vector fallback was used.",
    searchSchema(),
  ),
  tool(
    "bm25_search",
    "BM25 lexical search over wiki sections and source-code chunks.",
    searchSchema(),
  ),
  tool(
    "keyword_search",
    "Fast field-weighted exact and token search over OKF metadata, headings, paths, and content.",
    searchSchema(),
  ),
] as const;

const options = parseOptions(process.argv.slice(2));
const service = new RetrievalService(options);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeError(null, -32700, "Invalid JSON-RPC message.");
    return;
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    writeError(request.id ?? null, -32600, "Invalid JSON-RPC request.");
    return;
  }
  if (request.id === undefined) return;
  try {
    switch (request.method) {
      case "initialize":
        writeResult(request.id, {
          capabilities: { tools: { listChanged: false } },
          instructions:
            "Use change_surface first for public, cross-package, generated-artifact, or runtime-registration changes. Verify returned citations in source before editing. Use hybrid_search for broad discovery, okf_graph_search for related concepts, semantic_search for vocabulary mismatch, BM25 for precise terms, and keyword_search for exact symbols. All tools are read-only and return bounded excerpts.",
          protocolVersion: "2025-06-18",
          serverInfo: { name: "openwiki-retrieval", version: OPENWIKI_VERSION },
        });
        return;
      case "ping":
        writeResult(request.id, {});
        return;
      case "tools/list":
        writeResult(request.id, { tools: TOOL_DEFINITIONS });
        return;
      case "tools/call":
        await callTool(request.id, request.params ?? {});
        return;
      default:
        writeError(request.id, -32601, "Method not found.");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Retrieval failed.";
    writeResult(request.id, {
      content: [{ text: message.slice(0, 500), type: "text" }],
      isError: true,
    });
  }
}

async function callTool(
  id: number | string,
  params: Record<string, unknown>,
): Promise<void> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  const query = requiredString(args.query, "query");
  const limit = optionalInteger(args.limit, 8);
  let result: unknown;
  switch (name) {
    case "symbol_trace":
      result = await service.symbolTrace(query, optionalInteger(args.limit, 6));
      break;
    case "change_surface":
      result = await service.changeSurface(
        query,
        optionalInteger(args.limit, 6),
      );
      break;
    case "test_search":
      result = await service.testSearch(query, optionalInteger(args.limit, 5));
      break;
    case "hybrid_search":
      result = await service.hybridSearch(
        query,
        optionalScope(args.scope),
        limit,
      );
      break;
    case "okf_graph_search":
      result = await service.okfGraphSearch(
        query,
        limit,
        optionalInteger(args.hops, 1),
      );
      break;
    case "semantic_search":
      result = await service.semanticSearch(
        query,
        optionalScope(args.scope),
        limit,
      );
      break;
    case "bm25_search":
      result = await service.bm25Search(
        query,
        optionalScope(args.scope),
        limit,
      );
      break;
    case "keyword_search":
      result = await service.keywordSearch(
        query,
        optionalScope(args.scope),
        limit,
      );
      break;
    default:
      throw new Error(`Unknown retrieval tool: ${name || "(missing)"}.`);
  }
  writeResult(id, {
    content: [{ text: JSON.stringify(result), type: "text" }],
  });
}

function parseOptions(args: string[]): {
  embeddingProvider: EmbeddingProvider;
  repoRoot: string;
  wikiRoot: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Expected --repo-root, --wiki-root, and optional --embedding-provider values.",
      );
    }
    values.set(flag, value);
  }
  const provider = values.get("--embedding-provider") ?? "local";
  if (provider !== "local" && provider !== "openai") {
    throw new Error("embedding provider must be local or openai.");
  }
  return {
    embeddingProvider: provider,
    repoRoot: values.get("--repo-root") ?? process.cwd(),
    wikiRoot: values.get("--wiki-root") ?? `${process.cwd()}/openwiki`,
  };
}

function tool(name: string, description: string, inputSchema: object): object {
  return {
    annotations: { destructiveHint: false, readOnlyHint: true },
    description,
    inputSchema,
    name,
  };
}

function searchSchema(): object {
  return querySchema({
    limit: integerSchema(1, 10, 5),
    scope: {
      default: "all",
      enum: ["all", "wiki", "source"],
      type: "string",
    },
  });
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

function integerSchema(
  minimum: number,
  maximum: number,
  defaultValue: number,
): object {
  return { default: defaultValue, maximum, minimum, type: "integer" };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function optionalScope(value: unknown): SearchScope {
  return value === "source" || value === "wiki" || value === "all"
    ? value
    : "all";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeResult(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, jsonrpc: "2.0", result })}\n`);
}

function writeError(
  id: number | string | null,
  code: number,
  message: string,
): void {
  process.stdout.write(
    `${JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" })}\n`,
  );
}
