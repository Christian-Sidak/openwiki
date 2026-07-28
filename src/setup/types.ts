import type { LangSmithRegion } from "../connectors/sources/langsmith/setup.js";

export type PromptInputKey = {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  meta?: boolean;
  return?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  upArrow?: boolean;
};

export type SourceSetupState = {
  authUrl?: string;
  connectorConfig?: Record<string, unknown>;
  copiedAuthUrlToClipboard?: boolean;
  savedScheduleWarning?: string;
  secretValues: Record<string, string>;
};

/**
 * One LangSmith workspace as the wizard edits it. `apiKey` holds a value entered
 * this session (empty = keep the committed key); it is written to ~/.openwiki/.env
 * under `apiKeyEnv` on completion, never committed.
 */
export interface LangsmithWorkspaceDraft {
  apiKeyEnv: string;
  region: LangSmithRegion;
  apiKey: string;
  projects: string[];
}
