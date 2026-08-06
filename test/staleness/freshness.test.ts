import { describe, expect, test } from "vitest";

import {
  aggregateState,
  FreshnessEvaluator,
  type FreshnessState,
  type SourceReader,
} from "../../src/staleness/freshness.ts";
import { createDefaultRegistry } from "../../src/staleness/languages/registry.ts";
import { recordSourceDependencies } from "../../src/staleness/recorder.ts";
import { SourceResolver } from "../../src/staleness/resolver.ts";
import type {
  PersistedSourceDependency,
  SourceDependencySidecar,
} from "../../src/staleness/storage.ts";

/**
 * A mutable in-memory source tree, doubling as the {@link SourceReader} the
 * evaluator and recorder read through. Mirrors the eval harness's backend so
 * the same scenarios drive both.
 */
class MemReader implements SourceReader {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  set(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  readSource(path: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(path));
  }
}

const AUTH_ORIGINAL = [
  "export class AuthService {",
  "  authenticate(user: string) {",
  "    // look up the session token",
  "    return user.trim();",
  "  }",
  "}",
].join("\n");

/**
 * Record a single symbol dependency for a page and return the sidecar plus the
 * wiring needed to re-evaluate it after mutations.
 */
async function recordAuthPage(reader: MemReader): Promise<{
  sidecar: SourceDependencySidecar;
  evaluator: FreshnessEvaluator;
}> {
  const resolver = new SourceResolver(createDefaultRegistry());
  const { sidecar, warnings } = await recordSourceDependencies({
    page: "openwiki/architecture/auth.md",
    pageBytes: "# Auth\n\nAuthService.authenticate trims the user.\n",
    requests: [{ path: "src/auth.ts", symbol: "AuthService.authenticate" }],
    resolver,
    reader,
  });

  expect(warnings).toEqual([]);
  expect(sidecar.sources).toHaveLength(1);
  expect(sidecar.sources[0]).toMatchObject({
    path: "src/auth.ts",
    resolution: "symbol",
    kind: "method",
    symbol: "AuthService.authenticate",
  });

  return { sidecar, evaluator: new FreshnessEvaluator(resolver, reader) };
}

describe("aggregateState precedence", () => {
  test("takes the worst state: unverified > unknown > stale > fresh", () => {
    expect(aggregateState([])).toBe("fresh");
    expect(aggregateState(["fresh", "fresh"])).toBe("fresh");
    expect(aggregateState(["fresh", "stale"])).toBe("stale");
    expect(aggregateState(["stale", "unknown"])).toBe("unknown");
    expect(aggregateState(["unknown", "unverified"])).toBe("unverified");
    expect(aggregateState(["stale", "unverified", "fresh"])).toBe("unverified");
  });
});

describe("source-grounded freshness end to end", () => {
  test("unchanged source is fresh", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("fresh");
    expect(report.dependencies[0].reason).toBe("file-unchanged");
  });

  test("reformatting and comment edits stay fresh (canonical match)", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    // Same behavior, different whitespace and a rewritten comment. File bytes
    // differ, so this exercises the definition-level path, not the fast path.
    reader.set(
      "src/auth.ts",
      [
        "export class AuthService {",
        "  authenticate( user: string ) {",
        "",
        "    /* resolve the caller */",
        "    return user.trim() ;",
        "  }",
        "}",
      ].join("\n"),
    );

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("fresh");
    expect(report.dependencies[0].reason).toBe("definition-unchanged");
  });

  test("a semantic change makes the page stale", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    reader.set(
      "src/auth.ts",
      AUTH_ORIGINAL.replace(
        "return user.trim();",
        "return user.toLowerCase();",
      ),
    );

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("stale");
    expect(report.dependencies[0].reason).toBe("definition-changed");
  });

  test("editing a different definition in the same file stays fresh", async () => {
    const reader = new MemReader({
      "src/auth.ts": `${AUTH_ORIGINAL}\n\nexport function unrelated() {\n  return 1;\n}\n`,
    });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    reader.set(
      "src/auth.ts",
      `${AUTH_ORIGINAL}\n\nexport function unrelated() {\n  return 2;\n}\n`,
    );

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("fresh");
    expect(report.dependencies[0].reason).toBe("definition-unchanged");
  });

  test("renaming the tracked symbol is unknown, not stale", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    reader.set(
      "src/auth.ts",
      AUTH_ORIGINAL.replace("authenticate(user", "authorize(user"),
    );

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("unknown");
    expect(report.dependencies[0].reason).toBe("symbol-not-found");
  });

  test("deleting the source file is unknown", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const { sidecar, evaluator } = await recordAuthPage(reader);

    reader.remove("src/auth.ts");

    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("unknown");
    expect(report.dependencies[0].reason).toBe("source-file-missing");
  });

  test("a symbol dependency in an unsupported language is unverified once it changes", async () => {
    const reader = new MemReader({ "src/lib.rs": "fn authenticate() {}" });
    const evaluator = new FreshnessEvaluator(
      new SourceResolver(createDefaultRegistry()),
      reader,
    );

    // Hand-built dependency: a symbol was recorded against a language with no
    // grammar. We cannot re-derive the definition, so any file change is
    // unverifiable rather than silently fresh or falsely stale.
    const dependency: PersistedSourceDependency = {
      path: "src/lib.rs",
      resolution: "symbol",
      kind: "function",
      symbol: "authenticate",
      fileFingerprint: { algorithm: "file-bytes-v1", value: "sha256:stale" },
      definitionFingerprint: {
        algorithm: "tree-sitter-v1",
        value: "sha256:whatever",
      },
    };

    const verdict = await evaluator.evaluateDependency(dependency);
    expect(verdict.state).toBe("unverified");
    expect(verdict.reason).toBe("language-unsupported");
  });

  test("a page mixing fresh and stale dependencies aggregates to stale", async () => {
    const reader = new MemReader({
      "src/auth.ts": AUTH_ORIGINAL,
      "src/util.ts": "export function slug(s: string) { return s; }",
    });
    const resolver = new SourceResolver(createDefaultRegistry());
    const { sidecar } = await recordSourceDependencies({
      page: "openwiki/x.md",
      pageBytes: "# x\n",
      requests: [
        { path: "src/auth.ts", symbol: "AuthService.authenticate" },
        { path: "src/util.ts", symbol: "slug" },
      ],
      resolver,
      reader,
    });
    const evaluator = new FreshnessEvaluator(resolver, reader);

    reader.set(
      "src/util.ts",
      "export function slug(s: string) { return s.toLowerCase(); }",
    );

    const report = await evaluator.evaluatePage(sidecar);
    const byPath = new Map<string, FreshnessState>(
      report.dependencies.map((entry) => [entry.dependency.path, entry.state]),
    );
    expect(byPath.get("src/auth.ts")).toBe("fresh");
    expect(byPath.get("src/util.ts")).toBe("stale");
    expect(report.state).toBe("stale");
  });
});

describe("recorder degradation", () => {
  test("an unresolved symbol degrades to whole-file tracking with a warning", async () => {
    const reader = new MemReader({ "src/auth.ts": AUTH_ORIGINAL });
    const resolver = new SourceResolver(createDefaultRegistry());

    const { sidecar, warnings } = await recordSourceDependencies({
      page: "openwiki/x.md",
      pageBytes: "# x\n",
      requests: [{ path: "src/auth.ts", symbol: "AuthService.missing" }],
      resolver,
      reader,
    });

    expect(warnings).toEqual([
      {
        path: "src/auth.ts",
        symbol: "AuthService.missing",
        reason: "symbol-not-found",
        degradedToFile: true,
      },
    ]);
    expect(sidecar.sources[0]).toMatchObject({
      resolution: "file",
      kind: "file",
    });

    // The degraded file-level dependency still catches changes, just coarsely.
    const evaluator = new FreshnessEvaluator(resolver, reader);
    reader.set("src/auth.ts", `${AUTH_ORIGINAL}\n// touched\n`);
    const report = await evaluator.evaluatePage(sidecar);
    expect(report.state).toBe("stale");
    expect(report.dependencies[0].reason).toBe("file-changed");
  });

  test("a missing source file is dropped with a warning", async () => {
    const reader = new MemReader({});
    const resolver = new SourceResolver(createDefaultRegistry());

    const { sidecar, warnings } = await recordSourceDependencies({
      page: "openwiki/x.md",
      pageBytes: "# x\n",
      requests: [{ path: "src/gone.ts", symbol: "Gone" }],
      resolver,
      reader,
    });

    expect(sidecar.sources).toEqual([]);
    expect(warnings[0]).toMatchObject({
      reason: "source-file-missing",
      degradedToFile: false,
    });
  });
});
