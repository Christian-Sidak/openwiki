import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { computeFloor, deriveStamp } from "../src/agent/manifest/derive.ts";
import {
  compileGlob,
  filterMatching,
  matchesAny,
} from "../src/agent/manifest/glob.ts";
import {
  ManifestValidationError,
  getManifestPath,
  readManifest,
  validateManifest,
  writeManifest,
} from "../src/agent/manifest/io.ts";
import type {
  ManifestSection,
  OpenWikiManifest,
} from "../src/agent/manifest/types.ts";

const execFileAsync = promisify(execFile);

/**
 * Temp dirs created during the run, removed in afterAll so the suite leaves no
 * scratch repos behind.
 */
const scratchDirs: string[] = [];

async function makeScratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `openwiki-manifest-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Runs git with a fixed binary and a literal arg array (no shell, no
 * interpolation), mirroring test/update-noop.test.ts.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(label: string): Promise<string> {
  const repo = await makeScratchDir(label);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenWiki Test"]);
  return repo;
}

/**
 * Writes a file and commits it, returning the new HEAD sha.
 */
async function commit(
  repo: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(repo, file), content, "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * A valid section with sensible defaults; override any field per case.
 */
function section(overrides: Partial<ManifestSection> = {}): ManifestSection {
  return {
    path: "a/",
    sources: ["src/a/**"],
    head: null,
    attempts: 0,
    ...overrides,
  };
}

function manifest(sections: ManifestSection[]): OpenWikiManifest {
  return { version: 1, sections };
}

afterAll(async () => {
  await Promise.all(
    scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("compileGlob / matchesAny", () => {
  test("* stays within one segment", () => {
    expect(compileGlob("src/*.ts").test("src/a.ts")).toBe(true);
    expect(compileGlob("src/*.ts").test("src/a/b.ts")).toBe(false);
    // The segment boundary is the whole point of *: it must not swallow "/".
    expect(compileGlob("src/*").test("src/a")).toBe(true);
    expect(compileGlob("src/*").test("src/a/b")).toBe(false);
  });

  test("? matches exactly one non-slash character", () => {
    const glob = compileGlob("src/v?/mod.ts");
    expect(glob.test("src/v1/mod.ts")).toBe(true);
    expect(glob.test("src/v12/mod.ts")).toBe(false);
    expect(glob.test("src/v/mod.ts")).toBe(false);
  });

  test("** at the start spans zero or more leading segments", () => {
    const glob = compileGlob("**/foo.ts");
    expect(glob.test("foo.ts")).toBe(true);
    expect(glob.test("a/foo.ts")).toBe(true);
    expect(glob.test("a/b/foo.ts")).toBe(true);
    // Must anchor on a segment boundary, not a substring.
    expect(glob.test("xfoo.ts")).toBe(false);
  });

  test("** in the middle spans zero or more inner segments", () => {
    const glob = compileGlob("src/**/index.ts");
    expect(glob.test("src/index.ts")).toBe(true);
    expect(glob.test("src/a/index.ts")).toBe(true);
    expect(glob.test("src/a/b/index.ts")).toBe(true);
    expect(glob.test("lib/a/index.ts")).toBe(false);
  });

  test("trailing ** covers the whole subtree without matching sibling prefixes", () => {
    const glob = compileGlob("src/api/**");
    expect(glob.test("src/api")).toBe(true);
    expect(glob.test("src/api/client.ts")).toBe(true);
    expect(glob.test("src/api/v1/client.ts")).toBe(true);
    // The false-positive case: a sibling that merely shares the prefix.
    expect(glob.test("src/apix.ts")).toBe(false);
  });

  test("dots are literal, not wildcards", () => {
    const glob = compileGlob("**/foo.ts");
    expect(glob.test("a/foo.ts")).toBe(true);
    expect(glob.test("a/fooXts")).toBe(false);
  });

  test("matchesAny / filterMatching combine patterns", () => {
    const patterns = ["src/api/**", "src/billing/*.ts"];
    expect(matchesAny("src/api/x/y.ts", patterns)).toBe(true);
    expect(matchesAny("src/billing/charge.ts", patterns)).toBe(true);
    expect(matchesAny("src/other/x.ts", patterns)).toBe(false);

    expect(
      filterMatching(
        ["src/api/x.ts", "src/billing/charge.ts", "docs/readme.md"],
        patterns,
      ),
    ).toEqual(["src/api/x.ts", "src/billing/charge.ts"]);
  });
});

describe("validateManifest", () => {
  test("a well-formed manifest yields no problems", () => {
    expect(
      validateManifest(
        manifest([
          section({ path: "a/", head: "0".repeat(40) }),
          section({ path: "b/c/", sources: ["src/b/**", "lib/*.ts"] }),
        ]),
      ),
    ).toEqual([]);
  });

  test("non-object and non-array shapes short-circuit", () => {
    expect(validateManifest(null)).toEqual(["manifest is not an object"]);
    expect(validateManifest(42)).toEqual(["manifest is not an object"]);
    expect(validateManifest({ version: 1, sections: "nope" })).toEqual([
      "sections is not an array",
    ]);
  });

  test("unknown version is reported", () => {
    expect(validateManifest({ version: 2, sections: [] })).toContain(
      "unknown version: 2",
    );
  });

  test("path must be a relative dir with a trailing slash", () => {
    for (const bad of ["a", "/a/", "a/b"]) {
      expect(validateManifest(manifest([section({ path: bad })]))).toContain(
        'sections[0]: path must be a relative dir with trailing slash and no ".." segments',
      );
    }
  });

  test("path may not contain a .. traversal segment", () => {
    for (const bad of ["../", "../a/", "a/../b/"]) {
      expect(validateManifest(manifest([section({ path: bad })]))).toContain(
        'sections[0]: path must be a relative dir with trailing slash and no ".." segments',
      );
    }
  });

  test("sources must be non-empty repo-relative globs outside openwiki/", () => {
    const msg =
      "sections[0]: sources must be non-empty repo-relative globs outside openwiki/";
    expect(validateManifest(manifest([section({ sources: [] })]))).toContain(
      msg,
    );
    expect(
      validateManifest(manifest([section({ sources: ["/abs/x.ts"] })])),
    ).toContain(msg);
    expect(
      validateManifest(manifest([section({ sources: ["../escape.ts"] })])),
    ).toContain(msg);
    expect(
      validateManifest(manifest([section({ sources: ["openwiki/notes.md"] })])),
    ).toContain(msg);
    expect(
      validateManifest(
        manifest([section({ sources: [42 as unknown as string] })]),
      ),
    ).toContain(msg);
  });

  test("head must be a sha or null; attempts must be a non-negative number", () => {
    expect(
      validateManifest(manifest([section({ head: 5 as unknown as string })])),
    ).toContain("sections[0]: head must be a commit sha or null");
    expect(validateManifest(manifest([section({ attempts: -1 })]))).toContain(
      "sections[0]: attempts must be a non-negative number",
    );
    expect(
      validateManifest(
        manifest([section({ attempts: "1" as unknown as number })]),
      ),
    ).toContain("sections[0]: attempts must be a non-negative number");
  });

  test("duplicate paths are flagged on the later occurrence", () => {
    const problems = validateManifest(
      manifest([section({ path: "a/" }), section({ path: "a/" })]),
    );
    expect(problems).toContain('sections[1]: duplicate path "a/"');
  });

  test("multiple problems in one section are all reported together", () => {
    const problems = validateManifest(
      manifest([
        {
          path: "bad",
          sources: [],
          head: 3 as unknown as string,
          attempts: -2,
        },
      ]),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'sections[0]: path must be a relative dir with trailing slash and no ".." segments',
        "sections[0]: sources must be non-empty repo-relative globs outside openwiki/",
        "sections[0]: head must be a commit sha or null",
        "sections[0]: attempts must be a non-negative number",
      ]),
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("computeFloor", () => {
  test("linear history: the floor is the oldest head, regardless of order", async () => {
    const repo = await initRepo("floor-linear");
    const c1 = await commit(repo, "f.txt", "1", "c1");
    const c2 = await commit(repo, "f.txt", "2", "c2");
    const c3 = await commit(repo, "f.txt", "3", "c3");

    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: c3 }),
        section({ path: "b/", head: c1 }),
        section({ path: "c/", head: c2 }),
      ]),
    );
    expect(floor).toBe(c1);
  });

  test("identical heads: the floor is that commit", async () => {
    const repo = await initRepo("floor-same");
    const c1 = await commit(repo, "f.txt", "1", "c1");

    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "b/", head: c1 }),
      ]),
    );
    expect(floor).toBe(c1);
  });

  test("an unknown sha yields no floor", async () => {
    const repo = await initRepo("floor-unknown");
    const c1 = await commit(repo, "f.txt", "1", "c1");

    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "b/", head: "0".repeat(40) }),
      ]),
    );
    expect(floor).toBeUndefined();
  });

  test("diverged heads yield no floor", async () => {
    const repo = await initRepo("floor-diverged");
    const base = await commit(repo, "f.txt", "base", "c1");
    const a2 = await commit(repo, "a.txt", "a", "a2");
    await git(repo, ["checkout", "-b", "sideb", base]);
    const b2 = await commit(repo, "b.txt", "b", "b2");

    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: a2 }),
        section({ path: "b/", head: b2 }),
      ]),
    );
    expect(floor).toBeUndefined();
  });

  test("a null head yields no floor", async () => {
    const repo = await initRepo("floor-null");
    const c1 = await commit(repo, "f.txt", "1", "c1");

    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "b/", head: null }),
      ]),
    );
    expect(floor).toBeUndefined();
  });

  test("abandoned sections are excluded from the floor", async () => {
    const repo = await initRepo("floor-abandoned");
    const c1 = await commit(repo, "f.txt", "1", "c1");
    const c2 = await commit(repo, "f.txt", "2", "c2");

    // The abandoned section pins the newer commit and a null head, but neither
    // should count: the floor is the one active section's head.
    const floor = await computeFloor(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "b/", head: c2, abandoned: true }),
        section({ path: "c/", head: null, abandoned: true }),
      ]),
    );
    expect(floor).toBe(c1);
  });
});

describe("deriveStamp", () => {
  test("partial when any active section has never been written", async () => {
    const repo = await initRepo("stamp-partial");
    const c1 = await commit(repo, "f.txt", "1", "c1");

    const stamp = await deriveStamp(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "b/", head: null }),
      ]),
    );
    expect(stamp).toEqual({ status: "partial" });
    expect(stamp.gitHead).toBeUndefined();
  });

  test("complete with the floor as gitHead when every active section is written", async () => {
    const repo = await initRepo("stamp-complete");
    const c1 = await commit(repo, "f.txt", "1", "c1");
    const c2 = await commit(repo, "f.txt", "2", "c2");

    const stamp = await deriveStamp(
      repo,
      manifest([
        section({ path: "a/", head: c2 }),
        section({ path: "b/", head: c1 }),
      ]),
    );
    expect(stamp).toEqual({ status: "complete", gitHead: c1 });
  });

  test("an abandoned null head does not make the wiki partial, and is surfaced", async () => {
    const repo = await initRepo("stamp-abandoned");
    const c1 = await commit(repo, "f.txt", "1", "c1");

    const stamp = await deriveStamp(
      repo,
      manifest([
        section({ path: "a/", head: c1 }),
        section({ path: "stuck/", head: null, abandoned: true }),
      ]),
    );
    expect(stamp).toEqual({
      status: "complete",
      gitHead: c1,
      abandoned: ["stuck/"],
    });
  });
});

describe("writeManifest / readManifest", () => {
  test("round-trips and leaves no temp file behind", async () => {
    const repo = await makeScratchDir("io-roundtrip");
    const original = manifest([
      section({ path: "a/", head: "0".repeat(40), attempts: 0 }),
      section({ path: "b/", head: null, attempts: 1, brief: "billing" }),
    ]);

    await writeManifest(repo, original);

    expect(await readManifest(repo)).toEqual(original);

    // Atomicity: the tmp file used for the rename must not survive the write.
    const wikiDir = path.dirname(getManifestPath(repo));
    const leftovers = (await readdir(wikiDir)).filter((name) =>
      name.includes(".manifest.json.tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  test("readManifest returns undefined when the file is absent", async () => {
    const repo = await makeScratchDir("io-absent");
    expect(await readManifest(repo)).toBeUndefined();
  });

  test("readManifest throws ManifestValidationError on a corrupt manifest", async () => {
    const repo = await makeScratchDir("io-corrupt");
    await writeManifest(repo, manifest([section({ path: "a/" })]));
    // Hand-corrupt: drop the required path from the persisted section.
    await writeFile(
      getManifestPath(repo),
      JSON.stringify({
        version: 1,
        sections: [{ sources: ["src/a/**"], head: null, attempts: 0 }],
      }),
      "utf8",
    );

    await expect(readManifest(repo)).rejects.toBeInstanceOf(
      ManifestValidationError,
    );
  });
});
