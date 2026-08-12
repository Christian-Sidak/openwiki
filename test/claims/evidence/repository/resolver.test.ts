import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../../../src/agent/openwiki-ignore.ts";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../../../src/claims/core/errors.ts";
import { RepositoryEvidenceResolver } from "../../../../src/claims/evidence/repository/resolver.ts";
import type { LanguageEvidenceAdapter } from "../../../../src/claims/evidence/repository/tree-sitter-adapter.ts";

/**
 * Creates a minimal injected language adapter for registration tests.
 *
 * @param id - Stable adapter identifier.
 * @param extensions - Extensions registered by the adapter.
 * @returns Synchronous adapter that reports every symbol as unresolved.
 */
function createTestAdapter(
  id: string,
  extensions: readonly string[],
): LanguageEvidenceAdapter {
  return {
    id,
    extensions,
    resolveSymbol: () => null,
  };
}

describe("RepositoryEvidenceResolver", () => {
  let rootDir: string;
  let cleanupDirectories: string[];

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-claims-repo-"));
    cleanupDirectories = [rootDir];
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  });

  /**
   * Writes a repository fixture, creating its parent directories.
   *
   * @param relativePath - Repository-relative fixture path.
   * @param content - Complete fixture contents.
   */
  async function writeFixture(
    relativePath: string,
    content: string,
  ): Promise<void> {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  test("hashes whole files deterministically", async () => {
    await writeFixture("notes.txt", "stable evidence\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const first = await resolver.resolve("repo://notes.txt");
    const second = await resolver.resolve("repo://notes.txt");

    expect(first).toEqual(second);
    expect(first?.evidence.resource).toBe("repo://notes.txt");
    expect(first?.evidence.version).toMatch(
      /^repo-file-v1:sha256:[a-f0-9]{64}$/u,
    );
    expect(first?.content).toBe("stable evidence\n");
  });

  test("keeps symbol versions stable across formatting-only edits", async () => {
    await writeFixture("fixture.ts", "const TOKEN_TTL =\n  24;\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const before = await resolver.resolve("repo://fixture.ts#TOKEN_TTL");

    await writeFixture("fixture.ts", "const TOKEN_TTL = 24;\n");
    const reformatted = await resolver.resolve("repo://fixture.ts#TOKEN_TTL");
    await writeFixture("fixture.ts", "const TOKEN_TTL = 12;\n");
    const changed = await resolver.resolve("repo://fixture.ts#TOKEN_TTL");

    expect(reformatted?.evidence.version).toBe(before?.evidence.version);
    expect(reformatted?.content).not.toBe(before?.content);
    expect(changed?.evidence.version).not.toBe(before?.evidence.version);
  });

  test("returns null for missing files and directories", async () => {
    await mkdir(path.join(rootDir, "directory"));
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://missing.ts")).resolves.toBeNull();
    await expect(resolver.resolve("repo://directory")).resolves.toBeNull();
  });

  test("does not fall back when a supported symbol is missing or ambiguous", async () => {
    await writeFixture(
      "fixture.ts",
      "class First { run() {} } class Second { run() {} }",
    );
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(
      resolver.resolve("repo://fixture.ts#missing"),
    ).resolves.toBeNull();
    await expect(resolver.resolve("repo://fixture.ts#run")).resolves.toBeNull();
  });

  test("falls back to whole-file evidence for unsupported languages", async () => {
    await writeFixture("fixture.py", "class Service:\n    pass\n");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve("repo://fixture.py#Service");

    expect(resolved?.evidence.resource).toBe("repo://fixture.py#Service");
    expect(resolved?.evidence.version).toMatch(
      /^repo-file-v1:sha256:[a-f0-9]{64}$/u,
    );
    expect(resolved?.content).toBe("class Service:\n    pass\n");
  });

  test("rejects malformed supported source", async () => {
    await writeFixture("fixture.ts", "export const broken =");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://fixture.ts#broken")).rejects.toThrow(
      EvidenceResolutionError,
    );
  });

  test("rejects ignored evidence", async () => {
    await writeFixture("private/secret.ts", "export const secret = true;");
    const resolver = new RepositoryEvidenceResolver({
      rootDir,
      openWikiIgnore: new OpenWikiIgnore(["private/"]),
    });

    await expect(
      resolver.resolve("repo://private/secret.ts#secret"),
    ).rejects.toThrow(EvidenceResourceError);
  });

  test("rejects direct symbolic links", async () => {
    await writeFixture("target.ts", "export const target = true;");
    await symlink("target.ts", path.join(rootDir, "link.ts"));
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://link.ts#target")).rejects.toThrow(
      EvidenceResolutionError,
    );
  });

  test("rejects paths that escape through a parent symbolic link", async () => {
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "openwiki-claims-outside-"),
    );
    cleanupDirectories.push(outsideDir);
    await writeFile(
      path.join(outsideDir, "secret.ts"),
      "export const secret = true;",
      "utf8",
    );
    await symlink(outsideDir, path.join(rootDir, "escape"), "dir");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(
      resolver.resolve("repo://escape/secret.ts#secret"),
    ).rejects.toThrow(EvidenceResolutionError);
  });

  test("rejects parent symbolic links even when they remain inside the repository", async () => {
    await writeFixture("actual/value.ts", "export const value = true;");
    await symlink("actual", path.join(rootDir, "alias"), "dir");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(
      resolver.resolve("repo://alias/value.ts#value"),
    ).rejects.toThrow(EvidenceResolutionError);
  });

  test("rejects alternate-case filesystem aliases when the filesystem resolves them", async () => {
    await writeFixture("CaseSensitive.ts", "export const value = true;");
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const aliasResource = "repo://casesensitive.ts#value";
    let aliasExists = true;
    try {
      await writeFile(path.join(rootDir, "casesensitive.ts"), "", {
        flag: "ax",
      });
      aliasExists = false;
      await rm(path.join(rootDir, "casesensitive.ts"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
    }

    if (aliasExists) {
      await expect(resolver.resolve(aliasResource)).rejects.toThrow(
        EvidenceResolutionError,
      );
    } else {
      await expect(resolver.resolve(aliasResource)).resolves.toBeNull();
    }
  });

  test("supports normalized synchronous and asynchronous custom adapters", async () => {
    await writeFixture("one.CUSTOM", "first");
    await writeFixture("two.async", "second");
    const synchronous: LanguageEvidenceAdapter = {
      id: "sync-v1",
      extensions: [" .CUSTOM "],
      resolveSymbol: ({ source }) => ({ content: source, normalized: source }),
    };
    const asynchronous: LanguageEvidenceAdapter = {
      id: "async-v1",
      extensions: [".async"],
      resolveSymbol: ({ source }) =>
        Promise.resolve({
          content: source,
          normalized: source,
        }),
    };
    const resolver = new RepositoryEvidenceResolver({
      rootDir,
      adapters: [synchronous, asynchronous],
    });

    const syncResult = await resolver.resolve("repo://one.CUSTOM#value");
    const asyncResult = await resolver.resolve("repo://two.async#value");

    expect(syncResult?.content).toBe("first");
    expect(asyncResult?.content).toBe("second");
  });

  test("rejects invalid and duplicate normalized adapter registrations", () => {
    expect(
      () =>
        new RepositoryEvidenceResolver({
          rootDir,
          adapters: [
            createTestAdapter("first-v1", [".X"]),
            createTestAdapter("second-v1", [" .x "]),
          ],
        }),
    ).toThrow(EvidenceResourceError);
    expect(
      () =>
        new RepositoryEvidenceResolver({
          rootDir,
          adapters: [createTestAdapter(" ", [".x"])],
        }),
    ).toThrow(EvidenceResourceError);
    expect(
      () =>
        new RepositoryEvidenceResolver({
          rootDir,
          adapters: [createTestAdapter("empty-v1", [])],
        }),
    ).toThrow(EvidenceResourceError);
    expect(
      () =>
        new RepositoryEvidenceResolver({
          rootDir,
          adapters: [createTestAdapter("invalid-v1", ["typescript"])],
        }),
    ).toThrow(EvidenceResourceError);
  });

  test("persists canonical repository resource identities", async () => {
    await writeFixture("src/value.txt", "evidence");
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve(
      "repo://src\\value%2Etxt#Thing%23member",
    );

    expect(resolved?.evidence.resource).toBe(
      "repo://src/value.txt#Thing%23member",
    );
  });

  test("rejects lexical traversal before touching the filesystem", async () => {
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await expect(resolver.resolve("repo://../secret.ts")).rejects.toThrow(
      EvidenceResourceError,
    );
  });
});
