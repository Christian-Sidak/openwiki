import { describe, expect, test } from "vitest";

import {
  captureDefinitions,
  createDefaultRegistry,
} from "../../src/staleness/languages/registry.ts";

/**
 * Parse `source` with the grammar for `extension` and return the extracted
 * definitions as `{ kind, qualifiedName }` records for easy assertions.
 */
async function definitionsOf(
  extension: string,
  source: string,
): Promise<Array<{ kind: string; qualifiedName: string }>> {
  const registry = createDefaultRegistry();
  const loaded = await registry.loadForExtension(extension);
  if (!loaded) {
    throw new Error(`no language for ${extension}`);
  }

  const tree = loaded.parser.parse(source);
  if (!tree) {
    throw new Error("parse returned null");
  }

  return captureDefinitions(loaded, tree.rootNode).map((definition) => ({
    kind: definition.kind,
    qualifiedName: definition.qualifiedName,
  }));
}

describe("language registry definition extraction", () => {
  test("TypeScript: classes, methods, interfaces, and arrow consts", async () => {
    const definitions = await definitionsOf(
      ".ts",
      [
        "export interface Session {}",
        "export class AuthService {",
        "  authenticate(user: string) { return user; }",
        "}",
        "export const parseToken = (raw: string) => raw.trim();",
        "function topLevel() {}",
      ].join("\n"),
    );

    expect(definitions).toEqual(
      expect.arrayContaining([
        { kind: "interface", qualifiedName: "Session" },
        { kind: "class", qualifiedName: "AuthService" },
        { kind: "method", qualifiedName: "AuthService.authenticate" },
        { kind: "function", qualifiedName: "parseToken" },
        { kind: "function", qualifiedName: "topLevel" },
      ]),
    );
  });

  test("Python: methods are qualified by their enclosing class", async () => {
    const definitions = await definitionsOf(
      ".py",
      ["class Store:", "    def create(self):", "        return 1", ""].join(
        "\n",
      ),
    );

    expect(definitions).toEqual(
      expect.arrayContaining([
        { kind: "class", qualifiedName: "Store" },
        { kind: "function", qualifiedName: "Store.create" },
      ]),
    );
  });

  test("Go: methods are qualified by their receiver type", async () => {
    const definitions = await definitionsOf(
      ".go",
      [
        "package store",
        "type Store struct{}",
        "func (s *Store) Create() error { return nil }",
        "func New() *Store { return &Store{} }",
        "",
      ].join("\n"),
    );

    expect(definitions).toEqual(
      expect.arrayContaining([
        { kind: "type", qualifiedName: "Store" },
        { kind: "method", qualifiedName: "Store.Create" },
        { kind: "function", qualifiedName: "New" },
      ]),
    );
  });

  test("unknown extensions have no language", () => {
    const registry = createDefaultRegistry();
    expect(registry.supportsExtension(".rs")).toBe(false);
    expect(registry.supportsExtension(".TS")).toBe(true);
  });
});
