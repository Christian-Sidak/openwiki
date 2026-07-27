import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
      "export function createPredicate() { return true; }\n",
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
      path.join(repoRoot, "packages/publish/tests/predicate.test.ts"),
      "import { createPredicate } from 'koota';\ntest('public import', () => createPredicate());\n",
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
  test("supports keyword, BM25, and local vector ranking", async () => {
    const retrieval = service();
    const keyword = await retrieval.keywordSearch("createPredicate", "all", 5);
    const bm25 = await retrieval.bm25Search(
      "predicate consumer import",
      "all",
      5,
    );
    const semantic = await retrieval.semanticSearch(
      "consumer-facing package surface",
      "all",
      5,
    );

    expect(keyword.results[0]?.path).toMatch(/predicate|index/u);
    expect(bm25.results.some((hit) => hit.path.includes("publish/tests"))).toBe(
      true,
    );
    expect(semantic.engine).toBe("local-hashed-vector");
    expect(
      semantic.results.some(
        (hit) =>
          hit.path.includes("runtime.md") || hit.path.includes("publish"),
      ),
    ).toBe(true);
  });

  test("expands retrieval through OKF links and shared tags", async () => {
    const graph = await service().okfGraphSearch("query navigation", 5, 2);

    expect(graph.results.map((hit) => hit.path)).toContain(
      "openwiki/architecture/runtime.md",
    );
    expect(graph.results.map((hit) => hit.path)).toContain(
      "openwiki/quickstart.md",
    );
  });

  test("hybrid search reports component scores", async () => {
    const hybrid = await service().hybridSearch(
      "add predicate query public API",
      "all",
      5,
    );

    expect(hybrid.engine).toContain("hybrid-rrf");
    expect(hybrid.results[0]?.signals).toBeDefined();
  });

  test("test_search returns only bounded test citations", async () => {
    const result = await service().testSearch(
      "public predicate import lifecycle transition",
      3,
    );

    expect(result.engine).toContain("test-hybrid-rrf");
    expect(result.results.length).toBeLessThanOrEqual(3);
    expect(result.results.length).toBeGreaterThan(0);
    expect(
      result.results.every((hit) => /(?:test|spec)/iu.test(hit.path)),
    ).toBe(true);
  });

  test("change_surface groups cross-package evidence", async () => {
    const surface = await service().changeSurface(
      "add createPredicate query API",
      6,
    );

    expect(surface.relatedConcepts[0]?.path).toContain("openwiki/");
    expect(surface.groups.implementation.length).toBeGreaterThan(0);
    expect(surface.groups.exports.length).toBeGreaterThan(0);
    expect(surface.groups.publish_generated.length).toBeGreaterThan(0);
    expect(surface.groups.consumer.length).toBeGreaterThan(0);
    expect(surface.groups.tests.length).toBeGreaterThan(0);
    const results = Object.values(surface.groups).flat();
    expect(results).toHaveLength(6);
    expect(surface.relatedConcepts.length).toBeLessThanOrEqual(3);
    expect(
      Math.max(...results.map((result) => result.snippet.length)),
    ).toBeLessThanOrEqual(320);
    expect(JSON.stringify(surface).length).toBeLessThan(6_000);
  });

  test("symbol_trace refreshes post-edit source and reports missing layers", async () => {
    const retrieval = service();
    await retrieval.keywordSearch("createMatcher", "source", 5);
    await writeFile(
      path.join(repoRoot, "packages/core/src/query/matcher.ts"),
      "export function createMatcher() { return true; }\n",
    );

    const trace = await retrieval.symbolTrace("createMatcher", 6);

    expect(trace.groups.implementation[0]?.path).toContain("matcher.ts");
    expect(trace.missing).toContain("consumer");
    expect(trace.missing).toContain("tests");
    expect(trace.missing).toContain("exports");
    expect(Object.values(trace.groups).flat()).toHaveLength(1);
    await expect(
      retrieval.symbolTrace("createMatcher(); rm -rf /", 6),
    ).rejects.toThrow("single 1-100 character identifier");
  });

  test("never indexes secret-like files", async () => {
    const result = await service().keywordSearch(
      "never-index-this credentials",
      "all",
      20,
    );

    expect(result.results).toEqual([]);
  });

  test("bounds query length and result limits", async () => {
    const retrieval = service();
    await expect(retrieval.keywordSearch("x", "all", 21)).rejects.toThrow(
      "limit must be",
    );
    await expect(
      retrieval.keywordSearch("x".repeat(501), "all", 5),
    ).rejects.toThrow("query must be");
  });
});
