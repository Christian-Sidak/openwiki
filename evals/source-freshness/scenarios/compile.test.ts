/**
 * Authoring-time integrity gate: every scenario mutation still typechecks.
 *
 * Spec section 9 and section 27 require that a scenario's post-mutation source
 * compiles, so a malformed patch fails loudly here instead of skewing a
 * token-spending run. For each scenario this copies `src/`, `tsconfig.json`, and
 * `package.json` into a throwaway temp tree, symlinks the repo's `node_modules`,
 * applies the mutation, and runs the real `tsc --noEmit`. The developer checkout
 * is never touched.
 *
 * Running `tsc` five times is slow, so the compile cases are gated behind
 * `OWSF_COMPILE=1` and stay out of the fast default suite:
 *
 *   OWSF_COMPILE=1 npx vitest run evals/source-freshness/scenarios/compile.test.ts
 *
 * The structural validation below always runs and is cheap.
 *
 * All subprocess calls use `execFile` with an argument array and no shell, and
 * every path is the temp root joined with a literal constant (command-injection
 * and path-containment guardrails).
 */

import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ALL_SCENARIOS, validateScenarios } from "./index.js";
import type { EvalScenario } from "./types.js";

const execFileAsync = promisify(execFile);

/** Repo root, four levels up from evals/source-freshness/scenarios/. */
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/** Only run the expensive per-scenario compile when explicitly requested. */
const COMPILE_ENABLED = process.env.OWSF_COMPILE === "1";

/** Generous ceiling for a full `tsc` pass over the copied source tree. */
const TSC_TIMEOUT_MS = 300_000;

/** Result of a single typecheck attempt. */
interface CompileResult {
  /** Whether `tsc --noEmit` exited zero. */
  ok: boolean;

  /**
   * Combined `tsc` stdout and stderr, for the failure message.
   *
   * @default "" - the command produced no diagnostics.
   */
  output: string;
}

/**
 * Materialize the source tree, apply `scenario`'s mutation, and typecheck it with
 * the repository's own `tsc`. The temp tree is removed before returning.
 *
 * @param scenario - The scenario whose post-mutation source is typechecked.
 */
async function compileWithMutation(
  scenario: EvalScenario,
): Promise<CompileResult> {
  const cwd = await mkdtemp(join(tmpdir(), "owsf-compile-"));
  try {
    await cp(join(REPO_ROOT, "src"), join(cwd, "src"), { recursive: true });
    await cp(join(REPO_ROOT, "tsconfig.json"), join(cwd, "tsconfig.json"));
    await cp(join(REPO_ROOT, "package.json"), join(cwd, "package.json"));
    await symlink(join(REPO_ROOT, "node_modules"), join(cwd, "node_modules"));

    await scenario.applyMutation(cwd);

    try {
      await execFileAsync(
        join(REPO_ROOT, "node_modules", ".bin", "tsc"),
        ["--noEmit", "-p", "tsconfig.json"],
        { cwd, maxBuffer: 32 * 1024 * 1024 },
      );
      return { ok: true, output: "" };
    } catch (error) {
      const shell = error as { stdout?: string; stderr?: string };
      return {
        ok: false,
        output: `${shell.stdout ?? ""}${shell.stderr ?? ""}`.trim(),
      };
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("scenario registry", () => {
  test("all registered scenarios are structurally valid", () => {
    expect(() => validateScenarios(ALL_SCENARIOS)).not.toThrow();
  });
});

describe.skipIf(!COMPILE_ENABLED)("scenario mutations typecheck", () => {
  test.each(ALL_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s produces a source tree that compiles",
    async (_id, scenario) => {
      const result = await compileWithMutation(scenario);
      expect(result.ok, result.output).toBe(true);
    },
    TSC_TIMEOUT_MS,
  );
});
