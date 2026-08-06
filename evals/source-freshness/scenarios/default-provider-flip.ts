/**
 * Scenario: the default provider flips from OpenAI to Anthropic (medium).
 *
 * A single centralized edit in `src/constants.ts` with a broad, cascading
 * effect: `DEFAULT_PROVIDER` becomes `anthropic`, and because `DEFAULT_MODEL_ID`
 * and `SUGGESTED_MODEL_IDS` are derived from `PROVIDER_CONFIGS[DEFAULT_PROVIDER]`,
 * the default model changes from `gpt-5.6-terra` to `claude-haiku-4-5` with no
 * further edit. The credential auto-detection order is also reordered so
 * Anthropic is probed first. Two pages document the old order, default provider,
 * and default model verbatim, so a synchronized wiki must restate all three.
 */

import { editFile, replaceOnce } from "./mutation-helpers.js";
import type { EvalScenario } from "./types.js";

/**
 * Flip the default provider to Anthropic and move the Anthropic key to the front
 * of the auto-detection chain. `DEFAULT_MODEL_ID`/`SUGGESTED_MODEL_IDS` follow
 * automatically because they read `PROVIDER_CONFIGS[DEFAULT_PROVIDER]`.
 *
 * @param cwd - The throwaway checkout the mutation edits in place.
 */
async function applyMutation(cwd: string): Promise<void> {
  await editFile(cwd, "src/constants.ts", (content) => {
    let next = replaceOnce(
      content,
      'export const DEFAULT_PROVIDER = "openai";',
      'export const DEFAULT_PROVIDER = "anthropic";',
    );

    // Probe the Anthropic key first, ahead of OpenAI.
    next = replaceOnce(
      next,
      '    (env[OPENAI_API_KEY_ENV_KEY]\n      ? "openai"',
      "    (env[ANTHROPIC_API_KEY_ENV_KEY]\n" +
        '      ? "anthropic"\n' +
        "      : env[OPENAI_API_KEY_ENV_KEY]\n" +
        '      ? "openai"',
    );

    // Drop the now-duplicate Anthropic branch from its old position.
    next = replaceOnce(
      next,
      "          : env[ANTHROPIC_API_KEY_ENV_KEY]\n" +
        '            ? "anthropic"\n' +
        "            : env[BASETEN_API_KEY_ENV_KEY]",
      "          : env[BASETEN_API_KEY_ENV_KEY]",
    );

    return next;
  });
}

/**
 * Ground truth shared by the two pages that document the resolution order and
 * defaults identically.
 *
 * @param page - The repo-relative wiki page path.
 */
function resolutionPage(
  page: string,
): EvalScenario["expectedAffectedPages"][number] {
  return {
    page,
    rationale:
      "Documents the auto-detection order as 'OpenAI, OpenAI-compatible, " +
      "OpenRouter, Anthropic, ...' and the fallback as DEFAULT_PROVIDER " +
      "(openai) with default model gpt-5.6-terra; all three are now wrong.",
    requiredFacts: [
      {
        id: "anthropic-first",
        description:
          "The credential auto-detection order now probes Anthropic first, " +
          "ahead of OpenAI.",
      },
      {
        id: "default-provider-anthropic",
        description:
          "The fallback default provider (DEFAULT_PROVIDER) is now anthropic, not openai.",
      },
      {
        id: "default-model-haiku",
        description:
          "The default model is now claude-haiku-4-5 (Anthropic's first model " +
          "option), not gpt-5.6-terra, because it derives from " +
          "PROVIDER_CONFIGS[DEFAULT_PROVIDER].",
      },
    ],
    forbiddenFacts: [
      {
        id: "not-openai-first-order",
        description:
          "The page must no longer list the order with OpenAI ahead of Anthropic.",
        requireAbsent: ["OpenAI, OpenAI-compatible, OpenRouter, Anthropic"],
      },
      {
        id: "not-default-openai",
        description:
          "The page must no longer say the fallback default provider is openai.",
        requireAbsent: ["`DEFAULT_PROVIDER` (`openai`)"],
      },
      {
        id: "not-default-model-gpt",
        description:
          "The page must no longer name gpt-5.6-terra as the default model.",
        requireAbsent: ["default model (`gpt-5.6-terra`)"],
      },
    ],
    sourceEvidence: [
      {
        path: "src/constants.ts",
        symbol: "DEFAULT_PROVIDER",
        explanation: "Changed from openai to anthropic.",
      },
      {
        path: "src/constants.ts",
        symbol: "resolveConfiguredProvider",
        explanation:
          "The auto-detection ternary now checks ANTHROPIC_API_KEY first, " +
          "before OPENAI_API_KEY.",
      },
      {
        path: "src/constants.ts",
        symbol: "DEFAULT_MODEL_ID",
        explanation:
          "Derived from PROVIDER_CONFIGS[DEFAULT_PROVIDER].modelOptions[0].id, " +
          "which is now claude-haiku-4-5.",
      },
    ],
  };
}

/** The default-provider-flip scenario. */
export const defaultProviderFlipScenario: EvalScenario = {
  id: "default-provider-flip",
  title: "Default provider flips from OpenAI to Anthropic",
  complexity: "medium",
  description:
    "A centralized change in src/constants.ts: DEFAULT_PROVIDER becomes " +
    "anthropic, the credential auto-detection order probes Anthropic first, " +
    "and the derived DEFAULT_MODEL_ID/SUGGESTED_MODEL_IDS shift to Anthropic's " +
    "models (default now claude-haiku-4-5). One file, but the behavioral effect " +
    "spans provider identity, default model, and detection order, documented " +
    "verbatim on two pages.",
  applyMutation,
  expectedAffectedPages: [
    resolutionPage("openwiki/architecture/overview.md"),
    resolutionPage("openwiki/operations/credentials-and-updates.md"),
  ],
};
