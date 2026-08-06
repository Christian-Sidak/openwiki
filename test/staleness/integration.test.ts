import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  checkWikiFreshness,
  summarizeDrift,
} from "../../src/staleness/preflight.ts";
import { readSidecar } from "../../src/staleness/storage.ts";
import { createSourceGroundingTools } from "../../src/staleness/tool.ts";

const SOURCE = [
  "export class AuthService {",
  "  authenticate(user: string) {",
  "    return user.trim();",
  "  }",
  "}",
].join("\n");

const PAGE = [
  "# Authentication",
  "",
  "`AuthService.authenticate` trims and returns the user handle.",
  "",
].join("\n");

/**
 * Invoke the record_source_dependencies tool and return the parsed result.
 */
async function record(
  cwd: string,
  input: unknown,
): Promise<{ ok: boolean; recorded?: number; warnings?: unknown[] }> {
  const [tool] = createSourceGroundingTools(cwd);
  const raw = (await tool.invoke(input as never)) as string;
  return JSON.parse(raw) as {
    ok: boolean;
    recorded?: number;
    warnings?: unknown[];
  };
}

describe("source-grounding tool + freshness preflight on a real tree", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "owstale-int-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "openwiki", "architecture"), { recursive: true });
    await writeFile(join(cwd, "src", "auth.ts"), SOURCE, "utf8");
    await writeFile(
      join(cwd, "openwiki", "architecture", "auth.md"),
      PAGE,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("records a sidecar and reports the wiki as fresh", async () => {
    const result = await record(cwd, {
      page: "openwiki/architecture/auth.md",
      dependencies: [
        { path: "src/auth.ts", symbol: "AuthService.authenticate" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(1);
    expect(result.warnings).toEqual([]);

    const sidecar = await readSidecar(cwd, "openwiki/architecture/auth.md");
    expect(sidecar?.sources[0]).toMatchObject({
      path: "src/auth.ts",
      resolution: "symbol",
      symbol: "AuthService.authenticate",
    });

    const freshness = await checkWikiFreshness(cwd);
    expect(freshness.allFresh).toBe(true);
    expect(freshness.drifted).toEqual([]);
  });

  test("a semantic source change trips the preflight", async () => {
    await record(cwd, {
      page: "openwiki/architecture/auth.md",
      dependencies: [
        { path: "src/auth.ts", symbol: "AuthService.authenticate" },
      ],
    });

    // The documented behavior changes: trim -> toLowerCase.
    await writeFile(
      join(cwd, "src", "auth.ts"),
      SOURCE.replace("user.trim()", "user.toLowerCase()"),
      "utf8",
    );

    const freshness = await checkWikiFreshness(cwd);
    expect(freshness.allFresh).toBe(false);
    expect(freshness.drifted).toHaveLength(1);
    expect(freshness.drifted[0].state).toBe("stale");
    expect(summarizeDrift(freshness.drifted)).toContain("stale: 1");
  });

  test("a pure reformat keeps the wiki fresh", async () => {
    await record(cwd, {
      page: "openwiki/architecture/auth.md",
      dependencies: [
        { path: "src/auth.ts", symbol: "AuthService.authenticate" },
      ],
    });

    // Reformatting and a new comment: no semantic change.
    await writeFile(
      join(cwd, "src", "auth.ts"),
      [
        "export class AuthService {",
        "  authenticate( user: string ) {",
        "    // normalize the handle",
        "    return user.trim() ;",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const freshness = await checkWikiFreshness(cwd);
    expect(freshness.allFresh).toBe(true);
  });

  test("a bad symbol reference degrades to file tracking and warns", async () => {
    const result = await record(cwd, {
      page: "openwiki/architecture/auth.md",
      dependencies: [{ path: "src/auth.ts", symbol: "AuthService.nope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        path: "src/auth.ts",
        symbol: "AuthService.nope",
        reason: "symbol-not-found",
        degradedToFile: true,
      },
    ]);
  });
});
