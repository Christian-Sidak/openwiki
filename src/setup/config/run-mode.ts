import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { ConnectorId } from "../../connectors/types.js";
import {
  readRepositoryWikiInstructions,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";
import { getConfigModeId } from "../steps/machine.js";

type OnboardingMode = {
  description: string;
  id: string;
  name: string;
  sourceIds: ConnectorId[];
  suggestedSources: string[];
  suggestedGoal: string;
};

export const ONBOARDING_TEMPLATES = [
  {
    description:
      "Maintain a structured project wiki from a local Git repository, with code-oriented pages for architecture, workflows, source maps, and operational guidance.",
    id: "code",
    name: "Code",
    sourceIds: ["langsmith"],
    suggestedSources: ["Local Git repository"],
    suggestedGoal:
      "A code wiki for this local repository. Prioritize a concise quickstart, architecture overview, source map, key workflows, domain concepts, operations/runbook notes, testing guidance, and integration points. Inspect git history to understand reasoning behind code changes and the progression of the repository. Keep pages grounded in the repository structure and recent code changes. Prefer practical navigation for engineers over generic summaries.",
  },
  {
    description:
      "A personal assistant wiki that builds memory from email, notes, social/research sources, and web search so you can ask about projects, priorities, people, and recurring context.",
    id: "personal",
    name: "Personal",
    sourceIds: [
      "git-repo",
      "google",
      "notion",
      "web-search",
      "hackernews",
      "x",
    ],
    suggestedSources: [
      "Gmail",
      "Notion",
      "Web Search (Tavily)",
      "Hacker News",
      "X/Twitter",
    ],
    suggestedGoal:
      "Your personal brain. Track active projects, people, organizations, decisions, commitments, follow-ups, useful links, recurring themes, and fresh external signals. Organize the wiki so a personal assistant can answer what changed, what matters, what needs attention, and where supporting evidence came from. Be selective: summarize durable context and explicit action items, not every raw item.",
  },
] as const satisfies readonly OnboardingMode[];

export function ensureRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): OpenWikiOnboardingConfig {
  if (getConfigModeId(config) === mode) {
    return mode === "code" && config.wikiGoal !== undefined
      ? { ...config, wikiGoal: undefined }
      : config;
  }

  const runModeTemplate = ONBOARDING_TEMPLATES.find(
    (option) => option.id === mode,
  );
  if (!runModeTemplate) {
    return config;
  }

  return {
    ...config,
    modeId: runModeTemplate.id,
    modeName: runModeTemplate.name,
    templateId: runModeTemplate.id,
    templateName: runModeTemplate.name,
    ...(mode === "code" ? { wikiGoal: undefined } : {}),
  };
}

export async function hydrateRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  repoRoot: string,
): Promise<OpenWikiOnboardingConfig> {
  if (mode !== "code") {
    return config;
  }

  const wikiGoal = await readRepositoryWikiInstructions(repoRoot);

  return { ...config, wikiGoal };
}
