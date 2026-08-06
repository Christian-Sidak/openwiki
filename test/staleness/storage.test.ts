import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  isSourceGroundedPage,
  listSourceGroundedPages,
  normalizeRepoRelativePath,
  readSidecar,
  removeOrphanSidecars,
  serializeSidecar,
  sidecarPathForPage,
  SOURCE_DEPS_SCHEMA_VERSION,
  type SourceDependencySidecar,
  writeSidecarAtomic,
} from "../../src/staleness/storage.ts";

function sidecarFor(page: string): SourceDependencySidecar {
  return {
    version: SOURCE_DEPS_SCHEMA_VERSION,
    page,
    pageFingerprint: { algorithm: "page-bytes-v1", value: "sha256:page" },
    sources: [
      {
        path: "src/b.ts",
        resolution: "file",
        kind: "file",
        fileFingerprint: { algorithm: "file-bytes-v1", value: "sha256:b" },
      },
      {
        path: "src/a.ts",
        resolution: "symbol",
        kind: "method",
        symbol: "A.run",
        fileFingerprint: { algorithm: "file-bytes-v1", value: "sha256:a" },
        definitionFingerprint: {
          algorithm: "tree-sitter-v1",
          value: "sha256:def",
        },
      },
    ],
  };
}

describe("normalizeRepoRelativePath", () => {
  test("keeps clean relative paths and converts separators", () => {
    expect(normalizeRepoRelativePath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoRelativePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeRepoRelativePath("./src/./a.ts")).toBe("src/a.ts");
  });

  test("rejects traversal, absolute paths, and NUL bytes", () => {
    expect(() => normalizeRepoRelativePath("../secret")).toThrow();
    expect(() => normalizeRepoRelativePath("a/../../secret")).toThrow();
    expect(() => normalizeRepoRelativePath("/etc/passwd")).toThrow();
    expect(() => normalizeRepoRelativePath("C:/Windows")).toThrow();
    expect(() => normalizeRepoRelativePath("a\0b")).toThrow();
  });
});

describe("isSourceGroundedPage", () => {
  test("includes content pages, excludes nav/dot-dir/non-markdown", () => {
    expect(isSourceGroundedPage("openwiki/architecture/auth.md")).toBe(true);
    expect(isSourceGroundedPage("openwiki/index.md")).toBe(false);
    expect(isSourceGroundedPage("openwiki/log.md")).toBe(false);
    expect(isSourceGroundedPage("openwiki/.source-deps/auth.json")).toBe(false);
    expect(isSourceGroundedPage("openwiki/architecture/diagram.png")).toBe(
      false,
    );
  });
});

describe("sidecarPathForPage", () => {
  test("maps a page under the wiki to a .json under .source-deps", () => {
    const path = sidecarPathForPage("/repo", "openwiki/architecture/auth.md");
    expect(path).toBe("/repo/openwiki/.source-deps/architecture/auth.json");
  });

  test("throws for a page outside the wiki", () => {
    expect(() => sidecarPathForPage("/repo", "docs/auth.md")).toThrow();
  });
});

describe("serializeSidecar", () => {
  test("is deterministic and sorts sources", () => {
    const once = serializeSidecar(sidecarFor("openwiki/x.md"));
    const twice = serializeSidecar(sidecarFor("openwiki/x.md"));
    expect(once).toBe(twice);
    expect(once.endsWith("\n")).toBe(true);
    // src/a.ts sorts before src/b.ts regardless of input order.
    expect(once.indexOf("src/a.ts")).toBeLessThan(once.indexOf("src/b.ts"));
  });
});

describe("filesystem round trip", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "owstale-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("writeSidecarAtomic then readSidecar recovers the sidecar", async () => {
    const sidecar = sidecarFor("openwiki/architecture/auth.md");
    await writeSidecarAtomic(cwd, sidecar);

    const read = await readSidecar(cwd, "openwiki/architecture/auth.md");
    expect(read).toBeDefined();
    // Sources come back sorted by the serializer.
    expect(read?.sources.map((s) => s.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("readSidecar returns undefined when the page does not match", async () => {
    await writeSidecarAtomic(cwd, sidecarFor("openwiki/architecture/auth.md"));

    // Corrupt the on-disk page field so it no longer matches the request path.
    const sidecarPath = sidecarPathForPage(
      cwd,
      "openwiki/architecture/auth.md",
    );
    await writeFile(
      sidecarPath,
      serializeSidecar(sidecarFor("openwiki/architecture/OTHER.md")),
      "utf8",
    );

    const read = await readSidecar(cwd, "openwiki/architecture/auth.md");
    expect(read).toBeUndefined();
  });

  test("readSidecar returns undefined on malformed JSON", async () => {
    const sidecarPath = sidecarPathForPage(cwd, "openwiki/auth.md");
    await mkdir(join(cwd, "openwiki", ".source-deps"), { recursive: true });
    await writeFile(sidecarPath, "{ not json", "utf8");

    expect(await readSidecar(cwd, "openwiki/auth.md")).toBeUndefined();
  });

  test("listSourceGroundedPages finds content pages and skips dot-dirs", async () => {
    await mkdir(join(cwd, "openwiki", "architecture"), { recursive: true });
    await mkdir(join(cwd, "openwiki", ".source-deps"), { recursive: true });
    await writeFile(
      join(cwd, "openwiki", "architecture", "auth.md"),
      "#",
      "utf8",
    );
    await writeFile(join(cwd, "openwiki", "index.md"), "#", "utf8");
    await writeFile(
      join(cwd, "openwiki", ".source-deps", "stray.json"),
      "{}",
      "utf8",
    );

    const pages = await listSourceGroundedPages(cwd);
    expect(pages).toEqual(["openwiki/architecture/auth.md"]);
  });

  test("removeOrphanSidecars deletes sidecars without a live page", async () => {
    await writeSidecarAtomic(cwd, sidecarFor("openwiki/live.md"));
    await writeSidecarAtomic(cwd, sidecarFor("openwiki/orphan.md"));

    const removed = await removeOrphanSidecars(cwd, ["openwiki/live.md"]);
    expect(removed).toEqual(["openwiki/orphan.md"]);
    expect(await readSidecar(cwd, "openwiki/orphan.md")).toBeUndefined();
    expect(await readSidecar(cwd, "openwiki/live.md")).toBeDefined();
  });
});
