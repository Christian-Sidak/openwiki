/**
 * The scenario registry and structural validation.
 *
 * {@link ALL_SCENARIOS} is the ordered list every run selects from.
 * {@link validateScenarios} is the "scenarios compile and are well-formed"
 * integrity gate (spec section 27): it runs before any tokens are spent and
 * fails loudly on a malformed scenario rather than letting a typo skew grading.
 *
 * Phase 6 registers the five authored scenario modules here.
 */

import { addLocalDocsConnectorScenario } from "./add-local-docs-connector.js";
import { defaultProviderFlipScenario } from "./default-provider-flip.js";
import { providerResolutionExtractionScenario } from "./provider-resolution-extraction.js";
import { removeOpenAiChatgptScenario } from "./remove-openai-chatgpt.js";
import { retryContractScenario } from "./retry-contract.js";
import type { EvalScenario } from "./types.js";

/**
 * Every scenario the benchmark can run, in a stable order.
 *
 * Kept explicit so the runner and its tests have a single source of truth for
 * what exists.
 */
export const ALL_SCENARIOS: readonly EvalScenario[] = [
  retryContractScenario,
  defaultProviderFlipScenario,
  addLocalDocsConnectorScenario,
  removeOpenAiChatgptScenario,
  providerResolutionExtractionScenario,
];

/** A scenario id must be a lowercase slug so it is safe as a directory name. */
const SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * Validate a list of scenarios structurally, throwing on the first problem.
 * Enforces slug-safe unique ids, at least one expected page per scenario,
 * `openwiki/`-rooted page paths, and fact ids unique within each page. This is
 * the deterministic ground-truth check; it never runs the agent.
 *
 * @param scenarios - The scenarios to validate.
 */
export function validateScenarios(scenarios: readonly EvalScenario[]): void {
  const seenIds = new Set<string>();

  for (const scenario of scenarios) {
    if (!SCENARIO_ID_PATTERN.test(scenario.id)) {
      throw new Error(
        `scenario id "${scenario.id}" must be a lowercase slug (a-z, 0-9, hyphen)`,
      );
    }
    if (seenIds.has(scenario.id)) {
      throw new Error(`duplicate scenario id: ${scenario.id}`);
    }
    seenIds.add(scenario.id);

    if (scenario.expectedAffectedPages.length === 0) {
      throw new Error(
        `scenario ${scenario.id} must list at least one expected affected page`,
      );
    }

    for (const page of scenario.expectedAffectedPages) {
      if (!page.page.startsWith("openwiki/") || !page.page.endsWith(".md")) {
        throw new Error(
          `scenario ${scenario.id} page "${page.page}" must be an openwiki/*.md path`,
        );
      }

      const factIds = new Set<string>();
      for (const fact of [...page.requiredFacts, ...page.forbiddenFacts]) {
        if (fact.id.length === 0) {
          throw new Error(
            `scenario ${scenario.id} page "${page.page}" has a fact with an empty id`,
          );
        }
        if (factIds.has(fact.id)) {
          throw new Error(
            `scenario ${scenario.id} page "${page.page}" has duplicate fact id "${fact.id}"`,
          );
        }
        factIds.add(fact.id);
      }
    }
  }
}

/**
 * Select scenarios by id, preserving the requested order, or return every
 * registered scenario when no ids are given. Throws on an unknown id so a
 * mistyped `--scenario` fails fast instead of silently running nothing.
 *
 * @param ids - The scenario ids to select.
 *
 * @default undefined - return {@link ALL_SCENARIOS}.
 */
export function selectScenarios(ids?: string[]): EvalScenario[] {
  if (ids === undefined) {
    return [...ALL_SCENARIOS];
  }

  const byId = new Map(
    ALL_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  return ids.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(
        `unknown scenario id: ${id} (known: ${[...byId.keys()].join(", ") || "none"})`,
      );
    }
    return scenario;
  });
}
