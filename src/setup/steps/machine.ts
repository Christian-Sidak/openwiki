import { existsSync } from "node:fs";
import path from "node:path";
import {
  getMissingProviderEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderSecretKeyEnvKey,
  normalizeProvider,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  providerRequiresApiKey,
  providerRequiresBaseUrl,
  providerRequiresRegion,
  providerRequiresSecretKey,
  providerUsesAwsSdkCredentials,
  providerUsesExternalCliAuth,
  providerUsesOAuth,
  resolveConfiguredProvider,
  resolveProviderRegion,
} from "../../config/constants.js";
import {
  isChatGptTokenExpired,
  readCodexTokensFromEnv,
} from "../../agent/openai-chatgpt-oauth.js";
import type { AuthProviderId } from "../../auth/types.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import {
  isOpenWikiOnboardingCompleteSync,
  isRepositoryCodeOnboardingCompleteSync,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";

export type PromptStep =
  | "api-key"
  | "base-url"
  | "code-repo-confirm"
  | "code-repo-path"
  | "external-cli-auth"
  | "final"
  | "gcp-location"
  | "gcp-project"
  | "langsmith"
  | "model"
  | "oauth-login"
  | "provider"
  | "region"
  | "run-mode"
  | "secret-key"
  | "source-auth"
  | "global-cron-custom"
  | "global-cron-mode"
  | "global-power-mode"
  | "source-description"
  | "source-description-custom"
  | "source-langsmith-key"
  | "source-langsmith-projects"
  | "source-langsmith-region"
  | "source-langsmith-workspaces"
  | "source-menu"
  | "source-path"
  | "source-confirm-continue"
  | "source-secret"
  | "template"
  | "wiki-goal";

export type SetupStepState = "current" | "done" | "optional" | "pending";

export function needsCredentialSetup(
  modelIdOverride: string | null = null,
  mode: OpenWikiRunMode = "personal",
): boolean {
  const provider = resolveConfiguredProvider();

  const needsCredentials =
    !hasValidConfiguredProvider() ||
    needsAwsCredentialRepair(provider) ||
    needsCredentialStep(provider) ||
    needsSecretKeyStep(provider) ||
    needsBaseUrlStep(provider) ||
    needsRegionStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    needsLangSmithStep();

  if (needsCredentials) {
    return true;
  }

  return mode === "code"
    ? !isRepositoryCodeOnboardingCompleteSync(getDefaultCodeRepoRootPath())
    : !isOpenWikiOnboardingCompleteSync();
}

export function needsAwsCredentialRepair(provider: OpenWikiProvider): boolean {
  return (
    providerUsesAwsSdkCredentials(provider) &&
    getMissingProviderEnvKey(provider) !== null
  );
}

/**
 * Whether the provider still needs its primary credential collected. For
 * `oauth` providers this is a valid, non-expired stored token; for API-key
 * providers it is a pasted key; for keyless providers (gemini-enterprise) it is
 * the required GCP project id.
 */
export function needsCredentialStep(provider: OpenWikiProvider): boolean {
  if (providerUsesOAuth(provider)) {
    return !hasValidStoredToken();
  }

  return (
    getMissingProviderEnvKey(provider) !== null &&
    credentialStep(provider) !== null
  );
}

/** The step that collects the provider's primary credential. */
export function credentialStep(provider: OpenWikiProvider): PromptStep | null {
  if (providerUsesOAuth(provider)) {
    return "oauth-login";
  }

  if (providerUsesAwsSdkCredentials(provider)) {
    return null;
  }

  if (providerUsesExternalCliAuth(provider)) {
    return "external-cli-auth";
  }

  if (providerRequiresApiKey(provider)) {
    return "api-key";
  }

  return getProviderProjectEnvKey(provider) ? "gcp-project" : null;
}

/**
 * The setup steps that apply to a provider and run mode, in the order the wizard
 * walks them. Unlike the skip-based waterfall in {@link getInitialStep}, this
 * includes steps already satisfied by the environment, so navigation can reach
 * and re-edit an auto-skipped step. The provider's primary credential step
 * ({@link credentialStep}) is emitted once; for keyless providers that step is
 * the GCP project, so it is not appended again below.
 */
export function orderedSetupSteps(
  provider: OpenWikiProvider,
  mode: OpenWikiRunMode,
  allowModeSelection: boolean,
): PromptStep[] {
  const steps: PromptStep[] = [];

  if (allowModeSelection) {
    steps.push("run-mode");
  }

  steps.push("provider");

  const primary = credentialStep(provider);
  if (primary) {
    steps.push(primary);
  }

  if (providerRequiresSecretKey(provider)) {
    steps.push("secret-key");
  }
  if (getProviderProjectEnvKey(provider) && primary !== "gcp-project") {
    steps.push("gcp-project");
  }
  if (
    getProviderProjectEnvKey(provider) &&
    getProviderLocationEnvKey(provider)
  ) {
    steps.push("gcp-location");
  }
  if (providerRequiresBaseUrl(provider)) {
    steps.push("base-url");
  }
  if (providerRequiresRegion(provider)) {
    steps.push("region");
  }

  steps.push("model");
  steps.push("langsmith");

  // Personal mode's template is fixed by the run mode, so it skips the
  // Code/Personal chooser and walks straight into the wiki brief. Only code
  // mode needs a spine step after langsmith (repo confirmation).
  if (mode === "code") {
    steps.push("code-repo-confirm");
  }

  return steps;
}

/**
 * The step after `step` in the applicable spine, or null when `step` is the last
 * spine step or outside it. Drives forward navigation: Enter advances to the
 * next applicable step in order rather than skipping ones already satisfied by
 * the environment, so setup reads as a sequential walk.
 */
export function nextSetupStep(
  step: PromptStep | null,
  provider: OpenWikiProvider,
  mode: OpenWikiRunMode,
  allowModeSelection: boolean,
): PromptStep | null {
  if (step === null) {
    return null;
  }
  const spine = orderedSetupSteps(provider, mode, allowModeSelection);
  const index = spine.indexOf(step);
  return index >= 0 && index + 1 < spine.length ? spine[index + 1] : null;
}

function hasValidStoredToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = readCodexTokensFromEnv(env);

  return tokens !== null && !isChatGptTokenExpired(tokens.expiresAtMs);
}

export function needsGcpProjectStep(provider: OpenWikiProvider): boolean {
  const projectEnvKey = getProviderProjectEnvKey(provider);

  return projectEnvKey ? !process.env[projectEnvKey] : false;
}

export function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

export function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

export function needsSecretKeyStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresSecretKey(provider)) {
    return false;
  }

  return !isSecretKeyConfigured(provider);
}

export function isSecretKeyConfigured(provider: OpenWikiProvider): boolean {
  const secretKeyEnvKey = getProviderSecretKeyEnvKey(provider);

  return secretKeyEnvKey ? Boolean(process.env[secretKeyEnvKey]) : false;
}

export function needsRegionStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresRegion(provider)) {
    return false;
  }

  return !isRegionConfigured(provider);
}

/**
 * Whether the optional LangSmith tracing step still needs to be shown.
 *
 * The step is optional, so "answered" must include skipping it. Skipping does
 * not persist `LANGSMITH_API_KEY`. `saveOpenWikiEnv` strips empty values, so
 * the key is simply absent afterwards. What the step always records instead is
 * `LANGCHAIN_TRACING_V2` (`"false"` on skip, `"true"` when a key is entered),
 * which survives because it is non-empty. So the step is unanswered only when
 * neither a key is present (e.g. from a shell export) nor a tracing decision
 * has been recorded.
 */
export function needsLangSmithStep(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !env.LANGSMITH_API_KEY && env.LANGCHAIN_TRACING_V2 === undefined;
}

export function isRegionConfigured(provider: OpenWikiProvider): boolean {
  return resolveProviderRegion(provider) !== undefined;
}

export function isCredentialConfigured(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? hasValidStoredToken()
    : getMissingProviderEnvKey(provider) === null;
}

/**
 * Resolve a checklist row's status. The active step wins, so navigating back to
 * an already-done step shows the current-row cursor rather than a check; a done
 * step reads done; anything else falls to its resting status.
 */
export function resolveStepStatus(
  id: PromptStep,
  activeStep: PromptStep | null,
  done: boolean,
  resting: "optional" | "pending" = "pending",
): SetupStepState {
  if (id === activeStep) {
    return "current";
  }
  if (done) {
    return "done";
  }
  return resting;
}

export function getOAuthAuthorizationStatusText({
  authProvider,
  copiedToClipboard,
}: {
  authProvider?: AuthProviderId;
  copiedToClipboard: boolean;
}): string {
  if (copiedToClipboard) {
    return "Full URL copied to clipboard. Use the link above if your terminal supports it.";
  }

  const authCommand = authProvider
    ? `openwiki auth ${authProvider}`
    : "openwiki auth <provider>";

  return `Use the terminal link above. If it is not clickable, cancel and run ${authCommand} in a plain terminal.`;
}

export function getConfigModeId(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeId ?? config.templateId;
}

export function isCodeMode(config: OpenWikiOnboardingConfig): boolean {
  return getConfigModeId(config) === "code";
}

export function hasValidConfiguredProvider(): boolean {
  return normalizeProvider(process.env[OPENWIKI_PROVIDER_ENV_KEY]) !== null;
}

export function getDefaultCodeRepoRootPath(): string {
  return findNearestGitRepoRoot(process.cwd()) ?? process.cwd();
}

export function findNearestGitRepoRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);

  while (true) {
    if (existsSync(path.join(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

export function isSourceStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("source-"));
}

export function isScheduleStep(step: PromptStep | null): boolean {
  return Boolean(step?.startsWith("global-"));
}
