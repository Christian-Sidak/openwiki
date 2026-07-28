import {
  OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
  OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
  OPENWIKI_TAVILY_API_KEY_ENV_KEY,
  OPENWIKI_X_CLIENT_ID_ENV_KEY,
} from "../config/constants.js";
import type { AuthProviderId } from "../auth/types.js";
import type { ConnectorId } from "../connectors/types.js";
import { ONBOARDING_TEMPLATES } from "./config/run-mode.js";
import type { OpenWikiOnboardingConfig } from "./onboarding.js";

export type SourceSetupOption = {
  authProvider?: AuthProviderId;
  displayName: string;
  examples: string[];
  id: ConnectorId;
  instructions: string[];
  secretInputs: SourceSecretInput[];
};

export type SourceSecretInput = {
  envKey: string;
  label: string;
  optional?: boolean;
  secret?: boolean;
};

export const SOURCE_OPTIONS = [
  {
    displayName: "Local Git repository",
    examples: [
      "Track architecture notes from this repo.",
      "Summarize recent commits and changed files.",
    ],
    id: "git-repo",
    instructions: [
      "Choose the local repository directory OpenWiki should read.",
      "The default is the current working directory, and you can replace it with another path.",
      "You can add more repositories later in the connector config file.",
    ],
    secretInputs: [],
  },
  {
    displayName: "LangSmith traces",
    examples: ["support-bot-prod", "chat-agent"],
    id: "langsmith",
    instructions: [
      "Document how your agent runs, grounded in its LangSmith traces.",
      "List the projects to document; written to openwiki/.langsmith.json (committed).",
    ],
    // No secret input: the LangSmith key is captured by the earlier `langsmith`
    // spine step (and provided as a CI secret), and used at pull time, not here.
    secretInputs: [],
  },
  {
    authProvider: "notion",
    displayName: "Notion",
    examples: [
      "Ingest product specs, meeting notes, and research pages.",
      "Prioritize pages related to Applied AI and customer feedback.",
    ],
    id: "notion",
    instructions: [
      "OpenWiki uses Notion's hosted MCP OAuth flow.",
      "No client ID, client secret, or pasted Notion token is required.",
      "Approve access in the browser window when it opens.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "gmail",
    displayName: "Gmail",
    examples: [
      "Capture important project email threads from the last 24 hours.",
      "Look for vendor updates, customer feedback, and action items.",
    ],
    id: "google",
    instructions: [
      "Create OAuth credentials in Google Cloud for a desktop or web app.",
      "Enable the Gmail API for the Google Cloud project.",
      "Add http://127.0.0.1:53682/callback as an authorized redirect URI.",
      "Paste the client ID and client secret below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_ID_ENV_KEY,
        label: "Google OAuth client ID",
      },
      {
        envKey: OPENWIKI_GOOGLE_CLIENT_SECRET_ENV_KEY,
        label: "Google OAuth client secret",
        secret: true,
      },
    ],
  },
  {
    displayName: "Web Search (Tavily)",
    examples: [
      "Track a company, product category, or technical topic.",
      "Find launch posts, docs, pricing pages, and recent articles.",
    ],
    id: "web-search",
    instructions: [
      "Create a Tavily account and API key.",
      "Paste the Tavily API key below.",
      "Describe the topics, companies, or pages OpenWiki should search for on the next screen.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_TAVILY_API_KEY_ENV_KEY,
        label: "Tavily API key",
        secret: true,
      },
    ],
  },
  {
    displayName: "Hacker News",
    examples: [
      "Monitor threads about AI agents, evals, infrastructure, and startups.",
      "Capture notable discussions and links related to my research topics.",
    ],
    id: "hackernews",
    instructions: [
      "No account setup is required for Hacker News.",
      "OpenWiki uses public Hacker News feed and search APIs.",
      "Describe the topics, keywords, users, or story types OpenWiki should watch on the next screen.",
    ],
    secretInputs: [],
  },
  {
    authProvider: "x",
    displayName: "X / Twitter",
    examples: [
      "Track my home timeline, bookmarks, and key lists.",
      "Summarize tweets from AI researchers and product announcements.",
    ],
    id: "x",
    instructions: [
      "Create an X OAuth 2.0 app.",
      "Use a native app or public client when possible.",
      "Add http://127.0.0.1:53682/callback as a callback URI.",
      "Paste the OAuth client ID below.",
    ],
    secretInputs: [
      {
        envKey: OPENWIKI_X_CLIENT_ID_ENV_KEY,
        label: "X OAuth client ID",
      },
    ],
  },
] as const satisfies readonly SourceSetupOption[];

export function getSourceOption(sourceId: ConnectorId): SourceSetupOption {
  return (
    SOURCE_OPTIONS.find((source) => source.id === sourceId) ?? SOURCE_OPTIONS[0]
  );
}

export function needsEnvValue(secretInput: SourceSecretInput): boolean {
  return !process.env[secretInput.envKey];
}

export function addSourceInstanceConfig(
  config: OpenWikiOnboardingConfig,
  sourceInstance: OpenWikiOnboardingConfig["sourceInstances"][number],
): OpenWikiOnboardingConfig {
  const sourceInstances = [...config.sourceInstances, sourceInstance];
  return {
    ...config,
    sourceInstances,
    sources: deriveLegacySources(sourceInstances),
  };
}

export function deriveLegacySources(
  sourceInstances: OpenWikiOnboardingConfig["sourceInstances"],
): OpenWikiOnboardingConfig["sources"] {
  const sources: OpenWikiOnboardingConfig["sources"] = {};

  for (const sourceInstance of sourceInstances) {
    if (!sources[sourceInstance.connectorId]) {
      sources[sourceInstance.connectorId] = {
        connectedAt: sourceInstance.connectedAt,
        connectorConfig: sourceInstance.connectorConfig,
        ingestionGoal: sourceInstance.ingestionGoal,
      };
    }
  }

  return sources;
}

export function getSourceInstanceCount(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): number {
  return getSourceInstances(config, sourceId).length;
}

export function getSourceInstances(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): OpenWikiOnboardingConfig["sourceInstances"] {
  return config.sourceInstances.filter(
    (sourceInstance) => sourceInstance.connectorId === sourceId,
  );
}

export function getConnectedSourceCount(
  config: OpenWikiOnboardingConfig,
  sourceOptions: readonly SourceSetupOption[],
): number {
  const sourceIds = new Set(sourceOptions.map((source) => source.id));
  return config.sourceInstances.filter((sourceInstance) =>
    sourceIds.has(sourceInstance.connectorId),
  ).length;
}

export function createSourceInstanceId(
  sourceId: ConnectorId,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, sourceId) + 1;
  return `${sourceId}-${sourceCount}`;
}

export function createSourceInstanceName(
  source: SourceSetupOption,
  description: string,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, source.id) + 1;
  const trimmedDescription = description.trim();
  const suffix = trimmedDescription.length > 0 ? `: ${trimmedDescription}` : "";
  return `${source.displayName} ${sourceCount}${suffix}`.slice(0, 120);
}

export function getSourceMenuLabel(
  source: SourceSetupOption,
  sourceInstanceCount: number,
): string {
  return sourceInstanceCount > 0
    ? `Add another ${source.displayName}`
    : `Add ${source.displayName}`;
}

export function getTemplateSourceOptions(
  templateId: string | undefined,
): readonly SourceSetupOption[] {
  const template =
    ONBOARDING_TEMPLATES.find((option) => option.id === templateId) ??
    ONBOARDING_TEMPLATES[0];
  const sourceIds = new Set(template.sourceIds);
  const sourceOptions = SOURCE_OPTIONS.filter((source) =>
    sourceIds.has(source.id),
  );

  return sourceOptions.length > 0 ? sourceOptions : SOURCE_OPTIONS;
}

export function getSourceDescriptionPrompt(source: SourceSetupOption): string {
  if (source.id === "web-search") {
    return "Describe the topics, companies, or pages OpenWiki should search for.";
  }

  if (source.id === "hackernews") {
    return "Describe the topics, keywords, users, or story types OpenWiki should watch on Hacker News.";
  }

  if (source.id === "git-repo") {
    return "Describe what OpenWiki should understand about this repository.";
  }

  return `Describe what OpenWiki should look for in ${source.displayName}.`;
}

export function getSourceDescriptionOptionCount(
  source: SourceSetupOption,
): number {
  return source.examples.length + 1;
}

export function getStaticSourceConfig(
  sourceId: ConnectorId,
  query: string,
): Record<string, unknown> {
  const queries = query.trim().length > 0 ? [query.trim()] : [];

  if (sourceId === "web-search") {
    return {
      enabled: true,
      includeAnswer: true,
      includeImages: false,
      includeRawContent: false,
      maxResults: 5,
      queries,
      searchDepth: "basic",
      timeRange: "day",
      topic: "general",
    };
  }

  if (sourceId === "hackernews") {
    return {
      enabled: true,
      feeds: ["top", "new"],
      maxItemsPerFeed: 30,
      maxResultsPerQuery: 20,
      queries,
      queryTags: ["story"],
    };
  }

  return {
    enabled: true,
  };
}
