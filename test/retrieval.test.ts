import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  RETRIEVAL_TOOL_DEFINITIONS,
  SEARCH_SCOPES,
} from "../src/retrieval/mcp-tools.ts";
import { RetrievalService } from "../src/retrieval/search-service.ts";

let root = "";
let repoRoot = "";
let wikiRoot = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwiki-retrieval-"));
  repoRoot = path.join(root, "repo");
  wikiRoot = path.join(root, "wiki");
  await Promise.all([
    mkdir(path.join(repoRoot, "packages/core/src/query"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/core/src/relation"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/core/tests"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/publish/src"), { recursive: true }),
    mkdir(path.join(repoRoot, "packages/publish/tests"), { recursive: true }),
    mkdir(path.join(repoRoot, "secrets"), { recursive: true }),
    mkdir(path.join(wikiRoot, "architecture"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(wikiRoot, "quickstart.md"),
      `---
type: Quickstart
title: Koota quickstart
description: Routes query changes into runtime and package validation.
tags: [query, navigation]
---

# Quickstart

For query changes, follow the [runtime contract](architecture/runtime.md).
`,
    ),
    writeFile(
      path.join(wikiRoot, "architecture/runtime.md"),
      `---
type: Architecture
title: Query runtime and package contract
description: Connects predicate implementation to public exports and consumer tests.
tags: [query, package, runtime]
---

# Query runtime

Implement predicates in \`packages/core/src/query/predicate.ts\`, export them from
\`packages/core/src/index.ts\`, mirror the public surface through
\`packages/publish/src/index.ts\`, and validate consumer imports in
\`packages/publish/tests/predicate.test.ts\`.

The [quickstart](../quickstart.md) routes adjacent changes here.
`,
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/query/predicate.ts"),
      "export const PUBLIC_PREDICATE_FACTORY = true;\nexport function createPredicate() { return true; }\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/relation/relation-events.ts"),
      "export function removeRelationPair() { emitRelationEvent('remove'); }\nfunction emitRelationEvent(type: string) { return type; }\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/src/index.ts"),
      "export { createPredicate } from './query/predicate';\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/publish/src/index.ts"),
      "export { createPredicate } from '@koota/core';\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/core/tests/predicate.test.ts"),
      "import { createPredicate } from '../src';\ndescribe('predicate lifecycle', () => {\n  test('tracks false-to-true transitions independently', () => createPredicate());\n});\n",
    ),
    writeFile(
      path.join(repoRoot, "packages/publish/tests/predicate.test.ts"),
      "import { createPredicate } from 'koota';\ndescribe('predicate lifecycle', () => {\n  test('tracks false-to-true transitions independently', () => createPredicate());\n});\n",
    ),
    writeFile(
      path.join(repoRoot, ".env"),
      "SECRET_PREDICATE_SURFACE=never-index-this\n",
    ),
    writeFile(
      path.join(repoRoot, "secrets/credentials.json"),
      '{"note":"predicate consumer package"}\n',
    ),
  ]);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function service(): RetrievalService {
  return new RetrievalService({
    embeddingProvider: "local",
    repoRoot,
    wikiRoot,
  });
}

describe("OKF-aware repository retrieval", () => {
  test("exposes three concise workflow-oriented MCP tools", () => {
    expect(RETRIEVAL_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "search",
      "change_surface",
      "trace_symbols",
    ]);
    expect(
      RETRIEVAL_TOOL_DEFINITIONS.every(
        (tool) =>
          tool.description.length >= 100 && tool.description.length < 300,
      ),
    ).toBe(true);
    expect(SEARCH_SCOPES).toEqual(["all", "wiki", "source_code", "tests"]);
  });

  test("automatically combines lexical, semantic, and OKF ranking", async () => {
    const retrieval = service();
    const exact = await retrieval.search("createPredicate", "source_code", 5);
    const concept = await retrieval.search("query navigation", "wiki", 5);
    const consumer = await retrieval.search(
      "consumer-facing package surface",
      "all",
      5,
    );

    expect(exact.results[0]?.path).toMatch(/predicate|index/u);
    expect(concept.results.map((hit) => hit.path)).toContain(
      "openwiki/architecture/runtime.md",
    );
    expect(
      consumer.results.some(
        (hit) =>
          hit.path.includes("runtime.md") || hit.path.includes("publish"),
      ),
    ).toBe(true);
  });

  test("supports distinct wiki, source_code, and tests scopes", async () => {
    const retrieval = service();
    const source = await retrieval.search("createPredicate", "source_code", 10);
    const tests = await retrieval.search(
      "false-to-true independent predicate transition",
      "tests",
      10,
    );

    expect(source.results.every((hit) => !/test|spec/iu.test(hit.path))).toBe(
      true,
    );
    expect(tests.scope).toBe("tests");
    expect(tests.results.length).toBeGreaterThan(0);
    expect(tests.results.every((hit) => /test|spec/iu.test(hit.path))).toBe(
      true,
    );
    expect(tests.results.flatMap((hit) => hit.testNames ?? [])).toContain(
      "tracks false-to-true transitions independently",
    );
    expect(
      tests.results.filter((hit) => hit.path.endsWith("predicate.test.ts")),
    ).toHaveLength(1);
    expect(tests.results[0]).not.toHaveProperty("signals");
    expect(tests.results[0]).not.toHaveProperty("score");
  });

  test("clamps broad result requests to the public maximum", async () => {
    const result = await service().search(
      "predicate query public API",
      "all",
      50,
    );

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  test("change_surface groups cross-package evidence", async () => {
    const surface = await service().changeSurface(
      "add createPredicate query API and track relation removal events",
      7,
    );

    expect(surface.relatedConcepts[0]?.path).toContain("openwiki/");
    expect(surface.groups.implementation.length).toBeGreaterThan(0);
    expect(surface.groups.state_transitions[0]?.path).toContain("relation");
    expect(surface.groups.exports.length).toBeGreaterThan(0);
    expect(surface.groups.publish_generated.length).toBeGreaterThan(0);
    expect(surface.groups.consumer.length).toBeGreaterThan(0);
    expect(surface.groups.tests.length).toBeGreaterThan(0);
    const results = Object.values(surface.groups).flat();
    expect(results).toHaveLength(7);
    expect(surface.relatedConcepts.length).toBeLessThanOrEqual(2);
    expect(
      Math.max(...results.map((result) => result.snippet.length)),
    ).toBeLessThanOrEqual(220);
    expect(JSON.stringify(surface).length).toBeLessThan(5_000);
  });

  test("trace_symbols reindexes once and accepts batched dotted symbols", async () => {
    const retrieval = service();
    await retrieval.search("createMatcher", "source_code", 5);
    await writeFile(
      path.join(repoRoot, "packages/core/src/query/matcher.ts"),
      "export function createMatcher() { return true; }\nexport const Entity = { changed() { return true; } };\n",
    );

    const response = await retrieval.traceSymbols(
      [
        "createMatcher",
        "Entity.changed",
        "PUBLIC_PREDICATE_FACTORY",
        "createMatcher",
      ],
      50,
    );
    const trace = response.traces[0];

    expect(trace.groups.implementation[0]?.path).toContain("matcher.ts");
    expect(trace.missing).toContain("consumer");
    expect(trace.missing).toContain("tests");
    expect(trace.missing).toContain("exports");
    expect(Object.values(trace.groups).flat()).toHaveLength(1);
    expect(response.traces.map((item) => item.symbol)).toEqual([
      "createMatcher",
      "Entity.changed",
      "PUBLIC_PREDICATE_FACTORY",
    ]);
    expect(response.traces[1]?.groups.implementation[0]?.path).toContain(
      "matcher.ts",
    );
    expect(response.traces[2]?.groups.implementation[0]?.path).toContain(
      "predicate.ts",
    );
    await expect(
      retrieval.traceSymbols(["createMatcher(); rm -rf /"], 6),
    ).rejects.toThrow("plain or dotted identifier");
  });

  test("never indexes secret-like files", async () => {
    const result = await service().search(
      "never-index-this credentials",
      "all",
      50,
    );

    expect(result.results).toEqual([]);
  });

  test("bounds query length", async () => {
    const retrieval = service();
    await expect(retrieval.search("x".repeat(501), "all", 5)).rejects.toThrow(
      "query must be",
    );
  });
});
