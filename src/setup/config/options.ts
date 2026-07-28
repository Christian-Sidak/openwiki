import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { LangSmithRegion } from "../../connectors/sources/langsmith/setup.js";
import type { OpenWikiOnboardingConfig } from "../onboarding.js";
import { ONBOARDING_TEMPLATES } from "./run-mode.js";

export const RUN_MODE_OPTIONS = [
  {
    description:
      "Build a local personal brain wiki in ~/.openwiki/wiki from configured sources.",
    id: "personal",
    name: "Personal",
  },
  {
    description:
      "Build repository documentation in ./openwiki for this codebase.",
    id: "code",
    name: "Code",
  },
] as const satisfies readonly {
  description: string;
  id: OpenWikiRunMode;
  name: string;
}[];

export const LANGSMITH_REGION_OPTIONS = [
  {
    description: "US workspaces. The default.",
    host: "https://api.smith.langchain.com",
    id: "us",
    name: "US",
  },
  {
    description: "EU workspaces.",
    host: "https://eu.api.smith.langchain.com",
    id: "eu",
    name: "EU",
  },
] as const satisfies readonly {
  description: string;
  host: string;
  id: LangSmithRegion;
  name: string;
}[];

export const CRON_MODE_OPTIONS = [
  "Use suggested schedule",
  "Enter custom cron",
] as const;
export const POWER_MODE_OPTIONS = [
  "Set up Mac wake/sleep window",
  "Skip power setup",
] as const;
export const SOURCE_CONTINUE_OPTIONS = [
  "Go back to connections",
  "Continue without all sources",
] as const;
export const FINAL_OPTIONS = ["Run ingestion now", "Run later"] as const;
export const CODE_REPO_OPTIONS = ["Confirm and continue", "Edit path"] as const;

export function getRunModeSelectionIndex(mode: OpenWikiRunMode): number {
  const index = RUN_MODE_OPTIONS.findIndex((option) => option.id === mode);
  return index === -1 ? 0 : index;
}

export function getLangsmithRegionSelectionIndex(
  region: LangSmithRegion,
): number {
  const index = LANGSMITH_REGION_OPTIONS.findIndex(
    (option) => option.id === region,
  );
  return index === -1 ? 0 : index;
}

export function getLangsmithRegionLabel(region: LangSmithRegion): string {
  const option = LANGSMITH_REGION_OPTIONS.find((item) => item.id === region);
  return option ? `${option.name} (${option.host})` : region;
}

export function getRunModeName(mode: OpenWikiRunMode): string {
  return RUN_MODE_OPTIONS.find((option) => option.id === mode)?.name ?? mode;
}

export function getConfigModeName(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeName ?? config.templateName;
}

export function getTemplateGoal(templateId: string | undefined): string {
  return (
    ONBOARDING_TEMPLATES.find((template) => template.id === templateId)
      ?.suggestedGoal ?? ""
  );
}

export function getFinalOptionLabel(
  option: (typeof FINAL_OPTIONS)[number],
  mode: OpenWikiRunMode,
): string {
  if (mode !== "code") {
    return option;
  }

  return option === "Run ingestion now" ? "Run OpenWiki now" : "Open chat";
}
