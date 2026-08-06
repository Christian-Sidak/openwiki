/**
 * Scenario: the provider retry contract changes (small).
 *
 * A realistic config-semantics edit in one file: the default retry count drops
 * from 3 to 2, and the accepted range widens from positive integers to
 * non-negative integers so that `0` becomes a valid value that disables retries.
 * The change is localized to `resolveProviderRetryAttempts()` in
 * `src/constants.ts`, but the retry contract is documented verbatim on two pages,
 * so a synchronized wiki must drop the "defaults to 3" and "positive integer"
 * claims and state the new default and the disable-with-zero behavior.
 */

import { editFile, replaceAll, replaceOnce } from "./mutation-helpers.js";
import type { EvalScenario } from "./types.js";

/**
 * Rewrite the retry-attempts resolver: default 3 to 2, validation regex from
 * "positive integer" to "non-negative integer", and both error messages to
 * match. The `Number.isSafeInteger` guard already accepts 0, so widening the
 * regex is all that is needed to make 0 a valid disable-retries value.
 *
 * @param cwd - The throwaway checkout the mutation edits in place.
 */
async function applyMutation(cwd: string): Promise<void> {
  await editFile(cwd, "src/constants.ts", (content) => {
    let next = replaceOnce(
      content,
      "export const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 3;",
      "export const DEFAULT_PROVIDER_RETRY_ATTEMPTS = 2;",
    );
    next = replaceOnce(next, "/^[1-9]\\d*$/u", "/^\\d+$/u");
    next = replaceAll(
      next,
      "Expected a positive integer.",
      "Expected a non-negative integer.",
      2,
    );
    return next;
  });
}

/** The provider-retry-contract scenario. */
export const retryContractScenario: EvalScenario = {
  id: "retry-contract",
  title: "Provider retry default drops to 2 and 0 disables retries",
  complexity: "small",
  description:
    "resolveProviderRetryAttempts() in src/constants.ts changes its default " +
    "from 3 to 2 retries and widens its accepted range from positive integers " +
    "to non-negative integers, so 0 is now valid and disables retries. This is " +
    "a small, single-file config-semantics change whose contract is documented " +
    "verbatim on the workflow and operations pages.",
  applyMutation,
  expectedAffectedPages: [
    {
      page: "openwiki/agent/workflow.md",
      rationale:
        "States 'unset values default to 3 retries' for " +
        "resolveProviderRetryAttempts(); the default is now 2.",
      requiredFacts: [
        {
          id: "default-is-2",
          description:
            "When OPENWIKI_PROVIDER_RETRY_ATTEMPTS is unset, the number of " +
            "retries after the first provider request is now 2, not 3.",
        },
      ],
      forbiddenFacts: [
        {
          id: "not-default-3",
          description:
            "The page must no longer claim unset retry attempts default to 3 retries.",
          requireAbsent: ["default to 3 retries"],
        },
      ],
      sourceEvidence: [
        {
          path: "src/constants.ts",
          symbol: "resolveProviderRetryAttempts",
          explanation:
            "Returns DEFAULT_PROVIDER_RETRY_ATTEMPTS (now 2) when the env var " +
            "is unset; this is the value passed to the model client's maxRetries.",
        },
        {
          path: "src/constants.ts",
          symbol: "DEFAULT_PROVIDER_RETRY_ATTEMPTS",
          explanation: "The default retry constant, changed from 3 to 2.",
        },
      ],
    },
    {
      page: "openwiki/operations/credentials-and-updates.md",
      rationale:
        "Describes OPENWIKI_PROVIDER_RETRY_ATTEMPTS as an 'optional positive " +
        "integer retry count ... defaults to 3 when unset'; both the type and " +
        "the default are now wrong.",
      requiredFacts: [
        {
          id: "default-is-2",
          description:
            "The retry count defaults to 2 when OPENWIKI_PROVIDER_RETRY_ATTEMPTS is unset.",
        },
        {
          id: "zero-disables",
          description:
            "The value now accepts non-negative integers, and 0 is valid and " +
            "disables retries entirely (previously only positive integers were allowed).",
        },
      ],
      forbiddenFacts: [
        {
          id: "not-positive-integer",
          description:
            "The page must no longer describe the value as a positive integer, " +
            "because 0 is now accepted.",
          requireAbsent: ["optional positive integer retry count"],
        },
        {
          id: "not-defaults-3",
          description:
            "The page must no longer say the retry count defaults to 3 when unset.",
          requireAbsent: ["defaults to 3 when unset"],
        },
      ],
      sourceEvidence: [
        {
          path: "src/constants.ts",
          symbol: "resolveProviderRetryAttempts",
          explanation:
            "Validation regex is now /^\\d+$/u (non-negative), so '0' passes " +
            "and returns 0 retries; the default when unset is DEFAULT_PROVIDER_RETRY_ATTEMPTS (2).",
        },
      ],
    },
  ],
};
