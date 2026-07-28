import {
  AWS_ACCESS_KEY_ID_ENV_KEY,
  AWS_BEARER_TOKEN_BEDROCK_ENV_KEY,
  AWS_SECRET_ACCESS_KEY_ENV_KEY,
  AWS_SESSION_TOKEN_ENV_KEY,
  BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY,
  BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY,
  getMissingProviderEnvKey,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderSecretKeyEnvKey,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
  type OpenWikiProvider,
  providerUsesAwsSdkCredentials,
  providerUsesOAuth,
} from "../config/constants.js";
import {
  type CodexTokens,
  formatChatGptAccount,
} from "../agent/openai-chatgpt-oauth.js";
import { openWikiEnvPath } from "../config/env.js";
import { isCredentialConfigured } from "./steps/machine.js";

export function getAwsCredentialRepairMessage(
  provider: OpenWikiProvider,
): string | null {
  if (!providerUsesAwsSdkCredentials(provider)) {
    return null;
  }

  const missingEnvKey = getMissingProviderEnvKey(provider);

  if (!missingEnvKey) {
    return null;
  }

  const pair =
    missingEnvKey === BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY ||
    missingEnvKey === BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY
      ? `${BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY} and ${BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY}`
      : `${AWS_ACCESS_KEY_ID_ENV_KEY} and ${AWS_SECRET_ACCESS_KEY_ENV_KEY}`;

  return `${missingEnvKey} is missing or blank. Set both ${pair}, or unset both in your shell and ${openWikiEnvPath}, then restart OpenWiki.`;
}

/**
 * Every managed env key the wizard lets you set for a provider, in checklist
 * order: the provider selection, its credential keys, the model, and the
 * LangSmith tracing key. Used to detect which of them a shell export is
 * currently shadowing (a shell var wins at runtime and would silently override
 * the choice made here). Returns key names only, never values.
 */
export function getWizardManagedEnvKeys(provider: OpenWikiProvider): string[] {
  return [
    OPENWIKI_PROVIDER_ENV_KEY,
    getProviderApiKeyEnvKey(provider),
    getProviderSecretKeyEnvKey(provider),
    getProviderProjectEnvKey(provider),
    getProviderLocationEnvKey(provider),
    getProviderBaseUrlEnvKey(provider),
    getProviderRegionEnvKey(provider),
    OPENWIKI_MODEL_ID_ENV_KEY,
    "LANGSMITH_API_KEY",
  ].filter((key): key is string => key !== undefined);
}

export function getCredentialSetupDetail(
  provider: OpenWikiProvider,
  tokens: CodexTokens | null = null,
): string {
  if (providerUsesOAuth(provider)) {
    if (!isCredentialConfigured(provider) && !tokens) {
      return "sign in with your ChatGPT account";
    }

    const account = formatChatGptAccount(
      tokens?.email ?? process.env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
      tokens?.planType ?? process.env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
    );

    return account ? `signed in as ${account}` : "signed in with ChatGPT";
  }

  if (providerUsesAwsSdkCredentials(provider)) {
    if (process.env[AWS_BEARER_TOKEN_BEDROCK_ENV_KEY]?.trim()) {
      return "Bedrock bearer token (takes precedence)";
    }

    const missingEnvKey = getMissingProviderEnvKey(provider);

    if (missingEnvKey) {
      if (
        missingEnvKey === BEDROCK_AWS_ACCESS_KEY_ID_ENV_KEY ||
        missingEnvKey === BEDROCK_AWS_SECRET_ACCESS_KEY_ENV_KEY
      ) {
        return "incomplete legacy Bedrock keys; set both or clear both";
      }

      if (
        missingEnvKey === AWS_ACCESS_KEY_ID_ENV_KEY ||
        missingEnvKey === AWS_SECRET_ACCESS_KEY_ENV_KEY
      ) {
        return "incomplete standard AWS credentials; set the full set or unset it";
      }

      return `incomplete AWS credential configuration (${missingEnvKey})`;
    }

    const legacyApiKey = getProviderApiKeyEnvKey(provider);
    const legacySecretKey = getProviderSecretKeyEnvKey(provider);
    const usesLegacyKeys = Boolean(
      legacyApiKey &&
      legacySecretKey &&
      process.env[legacyApiKey]?.trim() &&
      process.env[legacySecretKey]?.trim(),
    );

    const ignoresOrphanSessionToken = Boolean(
      process.env[AWS_SESSION_TOKEN_ENV_KEY]?.trim() &&
      !process.env[AWS_ACCESS_KEY_ID_ENV_KEY]?.trim() &&
      !process.env[AWS_SECRET_ACCESS_KEY_ENV_KEY]?.trim(),
    );

    return usesLegacyKeys
      ? "legacy Bedrock keys (take precedence)"
      : ignoresOrphanSessionToken
        ? "AWS SDK default credential chain (orphan AWS_SESSION_TOKEN ignored)"
        : "AWS SDK default credential chain";
  }

  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  return isCredentialConfigured(provider)
    ? "available from environment"
    : apiKeyEnvKey
      ? `save ${apiKeyEnvKey} to ${openWikiEnvPath}`
      : "configure Google Cloud credentials";
}
