#!/usr/bin/env node

import { createInterface } from "node:readline";
import { OPENWIKI_VERSION } from "../constants.js";
import { RETRIEVAL_TOOL_DEFINITIONS } from "./mcp-tools.js";
import { RetrievalService } from "./search-service.js";
import type { EmbeddingProvider } from "./semantic.js";
import type { SearchScope } from "./types.js";

interface JsonRpcRequest {
  id?: number | string;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}

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
            "Use search for focused wiki, source_code, or tests retrieval. Use change_surface before public or cross-package edits, and trace_symbols once after changing public symbols. Verify citations in source. All tools are read-only and return bounded excerpts.",
          protocolVersion: "2025-06-18",
          serverInfo: { name: "openwiki-retrieval", version: OPENWIKI_VERSION },
        });
        return;
      case "ping":
        writeResult(request.id, {});
        return;
      case "tools/list":
        writeResult(request.id, { tools: RETRIEVAL_TOOL_DEFINITIONS });
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
  const limit = optionalInteger(args.limit, 8);
  let result: unknown;
  switch (name) {
    case "search":
      result = await service.search(
        requiredString(args.query, "query"),
        optionalScope(args.scope),
        limit,
      );
      break;
    case "change_surface":
      result = await service.changeSurface(
        requiredString(args.query, "query"),
        optionalInteger(args.limit, 6),
      );
      break;
    case "trace_symbols":
      result = await service.traceSymbols(
        requiredStrings(args.symbols, "symbols"),
        optionalInteger(args.limit, 4),
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

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array.`);
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${name} must be a non-empty string array.`);
    }
    strings.push(item);
  }
  return strings;
}

function optionalInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function optionalScope(value: unknown): SearchScope {
  return value === "source_code" ||
    value === "tests" ||
    value === "wiki" ||
    value === "all"
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
