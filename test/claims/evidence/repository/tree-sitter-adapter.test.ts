import JavaScript from "tree-sitter-javascript";
import { describe, expect, test } from "vitest";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../../../src/claims/core/errors.ts";
import {
  createBuiltInLanguageEvidenceAdapters,
  TreeSitterLanguageAdapter,
} from "../../../../src/claims/evidence/repository/tree-sitter-adapter.ts";
import type {
  LanguageEvidenceAdapter,
  SymbolResolution,
} from "../../../../src/claims/evidence/repository/tree-sitter-adapter.ts";

/**
 * Built-in adapters indexed by a representative source extension.
 */
const BUILT_IN_ADAPTERS = createBuiltInLanguageEvidenceAdapters();

/**
 * Finds the built-in adapter for a source path.
 *
 * @param sourcePath - Repository-relative fixture path.
 * @returns Matching built-in language adapter.
 */
function adapterFor(sourcePath: string): LanguageEvidenceAdapter {
  const extension = `.${sourcePath.split(".").pop()?.toLowerCase() ?? ""}`;
  const adapter = BUILT_IN_ADAPTERS.find((candidate) =>
    candidate.extensions.includes(extension),
  );
  if (!adapter) {
    throw new Error(`Missing fixture adapter for ${sourcePath}`);
  }
  return adapter;
}

/**
 * Resolves a fixture symbol and requires it to be unique.
 *
 * @param sourcePath - Repository-relative fixture path.
 * @param source - Complete fixture source.
 * @param symbol - Logical declaration name.
 * @returns Unique symbol resolution.
 */
async function resolveRequired(
  sourcePath: string,
  source: string,
  symbol: string,
): Promise<SymbolResolution> {
  const resolved = await adapterFor(sourcePath).resolveSymbol({
    path: sourcePath,
    source,
    symbol,
  });
  if (!resolved) {
    throw new Error(`Expected ${symbol} to resolve in ${sourcePath}`);
  }
  return resolved;
}

describe("TreeSitterLanguageAdapter", () => {
  test.each([
    ["fixture.js", "export function greet() { return 'hello'; }", "greet"],
    [
      "fixture.js",
      "export class Service { endpoint = '/'; }",
      "Service.endpoint",
    ],
    ["fixture.jsx", "export function View() { return <main />; }", "View"],
    ["fixture.ts", "export type Identifier = string;", "Identifier"],
    ["fixture.tsx", "export function Card() { return <article />; }", "Card"],
  ])("resolves declarations in %s", async (sourcePath, source, symbol) => {
    const resolved = await resolveRequired(sourcePath, source, symbol);
    const simpleSymbol = symbol.slice(symbol.lastIndexOf(".") + 1);

    expect(resolved.content).toContain(simpleSymbol);
    expect(resolved.normalized).toContain(simpleSymbol);
  });

  test.each([
    ["function", "function load() {}", "load"],
    ["function signature", "declare function load(): void;", "load"],
    ["constant", "const load = () => 1;", "load"],
    ["class", "class Service {}", "Service"],
    ["class method", "class Service { load() {} }", "Service.load"],
    ["class field", "class Service { endpoint = '/'; }", "Service.endpoint"],
    ["interface", "interface Service { load(): void; }", "Service"],
    ["interface method", "interface Service { load(): void; }", "Service.load"],
    [
      "interface property",
      "interface Service { endpoint: string; }",
      "Service.endpoint",
    ],
    ["type alias", "type Result = string | Error;", "Result"],
    ["enum", "enum Mode { Fast, Safe }", "Mode"],
    ["namespace", "namespace Tools { export const id = 1; }", "Tools"],
    [
      "namespace member",
      "namespace Tools { export const id = 1; }",
      "Tools.id",
    ],
    [
      "abstract class",
      "abstract class Worker { abstract run(): void; }",
      "Worker",
    ],
    [
      "abstract method",
      "abstract class Worker { abstract run(): void; }",
      "Worker.run",
    ],
  ])("resolves a TypeScript %s", async (_kind, source, symbol) => {
    const resolved = await resolveRequired("fixture.ts", source, symbol);
    const simpleSymbol = symbol.slice(symbol.lastIndexOf(".") + 1);

    expect(resolved.content).toContain(simpleSymbol);
  });

  test("resolves a qualified symbol without accepting an ambiguous alias", async () => {
    const source = "class First { run() {} } class Second { run() {} }";
    const adapter = adapterFor("fixture.ts");

    expect(
      await adapter.resolveSymbol({
        path: "fixture.ts",
        source,
        symbol: "run",
      }),
    ).toBeNull();
    const resolved = await adapter.resolveSymbol({
      path: "fixture.ts",
      source,
      symbol: "Second.run",
    });

    expect(resolved?.content).toContain("run");
  });

  test("preserves fingerprints across formatting-only changes", async () => {
    const multiline = await resolveRequired(
      "fixture.ts",
      "const TOKEN_TTL =\n  24;",
      "TOKEN_TTL",
    );
    const singleLine = await resolveRequired(
      "fixture.ts",
      "const TOKEN_TTL = 24;",
      "TOKEN_TTL",
    );

    expect(multiline.normalized).toBe(singleLine.normalized);
    expect(multiline.content).not.toBe(singleLine.content);
  });

  test.each([
    [
      "identifier",
      "const TOKEN_TTL = input + 24;",
      "const TOKEN_TTL = value + 24;",
    ],
    ["literal", "const TOKEN_TTL = 24;", "const TOKEN_TTL = 12;"],
    ["operator", "const TOKEN_TTL = 24 + 1;", "const TOKEN_TTL = 24 - 1;"],
    [
      "comment",
      "const TOKEN_TTL = /* hours */ 24;",
      "const TOKEN_TTL = /* minutes */ 24;",
    ],
    [
      "structure",
      "const TOKEN_TTL = () => 24;",
      "const TOKEN_TTL = () => { return 24; };",
    ],
  ])("changes fingerprints after a %s edit", async (_kind, before, after) => {
    const beforeResolution = await resolveRequired(
      "fixture.ts",
      before,
      "TOKEN_TTL",
    );
    const afterResolution = await resolveRequired(
      "fixture.ts",
      after,
      "TOKEN_TTL",
    );

    expect(beforeResolution.normalized).not.toBe(afterResolution.normalized);
  });

  test("returns null for a missing symbol", async () => {
    expect(
      await adapterFor("fixture.js").resolveSymbol({
        path: "fixture.js",
        source: "export const present = true;",
        symbol: "missing",
      }),
    ).toBeNull();
  });

  test("rejects malformed supported source", async () => {
    await expect(
      Promise.resolve().then(() =>
        adapterFor("fixture.ts").resolveSymbol({
          path: "fixture.ts",
          source: "export const broken =",
          symbol: "broken",
        }),
      ),
    ).rejects.toThrow(EvidenceResolutionError);
  });

  test("normalizes configured extensions", () => {
    const adapter = new TreeSitterLanguageAdapter({
      id: "fixture-v1",
      extensions: [" .JSX "],
      language: JavaScript,
    });

    expect(adapter.extensions).toEqual([".jsx"]);
  });

  test.each([
    { id: " ", extensions: [".js"] },
    { id: "fixture-v1", extensions: [] },
    { id: "fixture-v1", extensions: ["js"] },
    { id: "fixture-v1", extensions: [".JS", ".js"] },
  ])("rejects invalid adapter configuration %#", (options) => {
    expect(
      () =>
        new TreeSitterLanguageAdapter({
          ...options,
          language: JavaScript,
        }),
    ).toThrow(EvidenceResourceError);
  });
});
