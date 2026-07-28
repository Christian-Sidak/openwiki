import { OPENWIKI_MODEL_ID_ENV_KEY } from "../../config/constants.js";
import type { OpenWikiProvider } from "../../config/constants.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";
import {
  credentialStep,
  getConfigModeId,
  hasValidConfiguredProvider,
  isCodeMode,
  needsAwsCredentialRepair,
  needsBaseUrlStep,
  needsCredentialStep,
  needsGcpProjectStep,
  needsRegionStep,
  needsSecretKeyStep,
  orderedSetupSteps,
  type PromptStep,
} from "./machine.js";

export function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  allowModeSelection = false,
  walkAll = false,
): PromptStep | null {
  if (walkAll) {
    // Explicit --init: always start at the top and walk every applicable step,
    // even ones already configured, instead of skipping to the first unset one.
    return orderedSetupSteps(provider, mode, allowModeSelection)[0] ?? null;
  }

  if (allowModeSelection) {
    return "run-mode";
  }

  if (!hasValidConfiguredProvider()) {
    return "provider";
  }

  if (needsAwsCredentialRepair(provider)) {
    return "region";
  }

  const nextCredentialStep = credentialStep(provider);

  if (needsCredentialStep(provider) && nextCredentialStep) {
    return nextCredentialStep;
  }

  if (needsSecretKeyStep(provider)) {
    return "secret-key";
  }

  if (needsGcpProjectStep(provider)) {
    return "gcp-project";
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (needsRegionStep(provider)) {
    return "region";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (!process.env.LANGSMITH_API_KEY) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

export function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  forceModelStep = false,
): PromptStep | null {
  if (needsAwsCredentialRepair(provider)) {
    return "region";
  }

  const nextCredentialStep = credentialStep(provider);

  if (needsCredentialStep(provider) && nextCredentialStep) {
    return nextCredentialStep;
  }

  return getNextStepAfterApiKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsSecretKeyStep(provider)) {
    return "secret-key";
  }

  return getNextStepAfterSecretKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterSecretKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsGcpProjectStep(provider)) {
    return "gcp-project";
  }

  return getNextStepAfterGcpLocation(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterGcpLocation(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  forceModelStep = false,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsRegionStep(provider)) {
    return "region";
  }

  return getNextStepAfterRegion(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

export function getNextStepAfterRegion(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (
    modelIdOverride === null &&
    (forceModelStep || process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
  ) {
    return "model";
  }

  if (!process.env.LANGSMITH_API_KEY) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}
