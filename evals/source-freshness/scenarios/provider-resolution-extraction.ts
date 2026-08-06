/**
 * Scenario: provider resolution is extracted into its own module (cross-cutting).
 *
 * A realistic architectural refactor that splits the `src/constants.ts`
 * god-file: the provider auto-detection and validation cluster
 * (`normalizeProvider`, `isValidProvider`, `resolveConfiguredProvider`, and the
 * private `hasNonEmptyEnvValue`) moves into a new `src/providers/resolution.ts`,
 * and `src/constants.ts` re-exports the public names so every existing importer
 * keeps working. No behavior changes; the module boundary does. Two pages state
 * that `resolveConfiguredProvider()` lives in `src/constants.ts`, so a
 * synchronized wiki must point at the new module.
 */

import { editFile, replaceOnce } from "./mutation-helpers.js";
import { writeNewFile } from "./mutation-helpers.js";
import type { EvalScenario } from "./types.js";

/**
 * The provider-resolution cluster exactly as it exists in `src/constants.ts`
 * today (contiguous, lines "normalizeProvider" through "hasNonEmptyEnvValue").
 * Matched verbatim and removed, then re-created in the new module.
 */
const RESOLUTION_CLUSTER = `export function normalizeProvider(
  value: string | null | undefined,
): OpenWikiProvider | null {
  if (value === undefined || value === null) {
    return null;
  }

  const provider = value.trim().toLowerCase();

  return isValidProvider(provider) ? provider : null;
}

export function isValidProvider(value: string): value is OpenWikiProvider {
  return value in PROVIDER_CONFIGS;
}

export function resolveConfiguredProvider(
  env: NodeJS.ProcessEnv = process.env,
): OpenWikiProvider {
  return (
    normalizeProvider(env[OPENWIKI_PROVIDER_ENV_KEY]) ??
    (env[OPENAI_API_KEY_ENV_KEY]
      ? "openai"
      : env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY]
        ? "openai-compatible"
        : env[OPENROUTER_API_KEY_ENV_KEY]
          ? "openrouter"
          : env[ANTHROPIC_API_KEY_ENV_KEY]
            ? "anthropic"
            : env[BASETEN_API_KEY_ENV_KEY]
              ? "baseten"
              : env[FIREWORKS_API_KEY_ENV_KEY]
                ? "fireworks"
                : env[NEBIUS_API_KEY_ENV_KEY]
                  ? "nebius"
                  : env[NVIDIA_API_KEY_ENV_KEY]
                    ? "nvidia"
                    : hasNonEmptyEnvValue(
                          env,
                          BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
                        ) ||
                        hasNonEmptyEnvValue(
                          env,
                          BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
                        )
                      ? "bedrock"
                      : DEFAULT_PROVIDER)
  );
}

function hasNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  key: string | undefined,
): boolean {
  return key !== undefined && Boolean(env[key]?.trim());
}`;

/** The re-export left behind in `src/constants.ts` after the move. */
const RESOLUTION_REEXPORT = `export {
  isValidProvider,
  normalizeProvider,
  resolveConfiguredProvider,
} from "./providers/resolution.js";`;

/** Full contents of the new `src/providers/resolution.ts` module. */
const RESOLUTION_MODULE = `/**
 * Provider resolution: which model provider OpenWiki uses for a run.
 *
 * Extracted from \`src/constants.ts\` so provider auto-detection and validation
 * live in a dedicated module instead of the shared constants god-file.
 * \`src/constants.ts\` re-exports these names, so existing importers are
 * unaffected.
 */

import {
  ANTHROPIC_API_KEY_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  DEFAULT_PROVIDER,
  FIREWORKS_API_KEY_ENV_KEY,
  NEBIUS_API_KEY_ENV_KEY,
  NVIDIA_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  PROVIDER_CONFIGS,
  type OpenWikiProvider,
} from "../constants.js";

/**
 * Normalize a raw provider string to a known {@link OpenWikiProvider}, or
 * \`null\` when it is absent or unrecognized.
 *
 * @param value - The raw provider string, typically from an env var.
 */
export function normalizeProvider(
  value: string | null | undefined,
): OpenWikiProvider | null {
  if (value === undefined || value === null) {
    return null;
  }

  const provider = value.trim().toLowerCase();

  return isValidProvider(provider) ? provider : null;
}

/**
 * Type guard for whether \`value\` names a configured provider.
 *
 * @param value - The candidate provider string.
 */
export function isValidProvider(value: string): value is OpenWikiProvider {
  return value in PROVIDER_CONFIGS;
}

/**
 * Resolve the active provider from the environment: an explicit
 * \`OPENWIKI_PROVIDER\` wins, otherwise the first provider whose credential env
 * var is present, otherwise {@link DEFAULT_PROVIDER}.
 *
 * @param env - The environment to read; defaults to \`process.env\`.
 */
export function resolveConfiguredProvider(
  env: NodeJS.ProcessEnv = process.env,
): OpenWikiProvider {
  return (
    normalizeProvider(env[OPENWIKI_PROVIDER_ENV_KEY]) ??
    (env[OPENAI_API_KEY_ENV_KEY]
      ? "openai"
      : env[OPENAI_COMPATIBLE_API_KEY_ENV_KEY]
        ? "openai-compatible"
        : env[OPENROUTER_API_KEY_ENV_KEY]
          ? "openrouter"
          : env[ANTHROPIC_API_KEY_ENV_KEY]
            ? "anthropic"
            : env[BASETEN_API_KEY_ENV_KEY]
              ? "baseten"
              : env[FIREWORKS_API_KEY_ENV_KEY]
                ? "fireworks"
                : env[NEBIUS_API_KEY_ENV_KEY]
                  ? "nebius"
                  : env[NVIDIA_API_KEY_ENV_KEY]
                    ? "nvidia"
                    : hasNonEmptyEnvValue(
                          env,
                          BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
                        ) ||
                        hasNonEmptyEnvValue(
                          env,
                          BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
                        )
                      ? "bedrock"
                      : DEFAULT_PROVIDER)
  );
}

/**
 * Whether \`env[key]\` is set to a non-empty (trimmed) value.
 *
 * @param env - The environment to read.
 *
 * @param key - The env key to test, or \`undefined\` for no key.
 */
function hasNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  key: string | undefined,
): boolean {
  return key !== undefined && Boolean(env[key]?.trim());
}
`;

/**
 * Move the provider-resolution cluster out of `src/constants.ts` into a new
 * `src/providers/resolution.ts`, leaving a re-export behind.
 *
 * @param cwd - The throwaway checkout the mutation edits in place.
 */
async function applyMutation(cwd: string): Promise<void> {
  await editFile(cwd, "src/constants.ts", (content) =>
    replaceOnce(content, RESOLUTION_CLUSTER, RESOLUTION_REEXPORT),
  );
  await writeNewFile(cwd, "src/providers/resolution.ts", RESOLUTION_MODULE);
}

/**
 * Ground truth shared by the two pages that name `src/constants.ts` as the home
 * of `resolveConfiguredProvider()`.
 *
 * @param page - The repo-relative wiki page path.
 */
function resolutionHomePage(
  page: string,
): EvalScenario["expectedAffectedPages"][number] {
  return {
    page,
    rationale:
      "Assigns ownership of provider resolution to src/constants.ts: it says " +
      "the provider is resolved via `resolveConfiguredProvider()` in " +
      "`src/constants.ts`. That responsibility (with isValidProvider and " +
      "normalizeProvider) is now defined in and owned by " +
      "src/providers/resolution.ts; src/constants.ts only re-exports the names " +
      "for compatibility and defines none of this logic anymore. The stale claim " +
      "is architectural ownership, not merely a file path.",
    requiredFacts: [
      {
        id: "resolution-module",
        description:
          "Provider auto-detection and validation (resolveConfiguredProvider, " +
          "isValidProvider, normalizeProvider) are now defined in and owned by " +
          "src/providers/resolution.ts; src/constants.ts only re-exports them.",
        requirePresent: ["src/providers/resolution.ts"],
      },
    ],
    forbiddenFacts: [
      {
        id: "not-defined-in-constants",
        description:
          "The page must no longer claim src/constants.ts is where " +
          "resolveConfiguredProvider() lives; that logic is defined in " +
          "src/providers/resolution.ts and only re-exported from constants.ts.",
        requireAbsent: ["`resolveConfiguredProvider()` in `src/constants.ts`"],
      },
    ],
    sourceEvidence: [
      {
        path: "src/providers/resolution.ts",
        symbol: "resolveConfiguredProvider",
        explanation:
          "The auto-detection function now lives here after being moved out of " +
          "src/constants.ts.",
      },
      {
        path: "src/constants.ts",
        explanation:
          "Now contains only a re-export: `export { isValidProvider, " +
          "normalizeProvider, resolveConfiguredProvider } from " +
          '"./providers/resolution.js";` instead of the definitions.',
      },
    ],
  };
}

/** The provider-resolution-extraction scenario. */
export const providerResolutionExtractionScenario: EvalScenario = {
  id: "provider-resolution-extraction",
  title: "Provider resolution extracted from constants.ts into its own module",
  complexity: "cross-cutting",
  description:
    "An architectural refactor that splits the src/constants.ts god-file: the " +
    "provider auto-detection and validation cluster (normalizeProvider, " +
    "isValidProvider, resolveConfiguredProvider, hasNonEmptyEnvValue) moves into " +
    "a new src/providers/resolution.ts module, and src/constants.ts re-exports " +
    "the public names so importers are unaffected. Behavior is unchanged; only " +
    "the module boundary moves: src/providers/resolution.ts now owns provider " +
    "resolution and src/constants.ts is reduced to a re-export shim. Two pages " +
    "name src/constants.ts as the module that owns and defines " +
    "resolveConfiguredProvider().",
  applyMutation,
  expectedAffectedPages: [
    resolutionHomePage("openwiki/architecture/overview.md"),
    resolutionHomePage("openwiki/operations/credentials-and-updates.md"),
  ],
};
