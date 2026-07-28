import {
  getProviderLabel,
  type OpenWikiProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../config/constants.js";

export function mask(value: string): string {
  if (value.length === 0) {
    return "";
  }

  return "*".repeat(value.length);
}

export function formatSecretInputDisplay(value: string): string {
  // Empty renders as nothing (just the cursor); dots for the entered length,
  // matching the non-secret inputs rather than printing a literal "empty".
  return "•".repeat(value.length);
}

export function formatTerminalHyperlink(url: string, label: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

export function getSingleLineInputDisplayValue(
  value: string,
  maxLength: number,
): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(-maxLength);
  }

  return `...${value.slice(-(maxLength - 3))}`;
}

export function moveSelectionIndex(
  currentIndex: number,
  offset: number,
  itemCount: number,
): number {
  if (itemCount <= 0) {
    return 0;
  }

  return (currentIndex + offset + itemCount) % itemCount;
}

export function getInputDisplayWidth(
  stdoutColumns: number | undefined,
): number {
  const defaultWidth = 64;

  if (!stdoutColumns || stdoutColumns <= 0) {
    return defaultWidth;
  }

  return Math.max(24, Math.min(96, stdoutColumns - 16));
}

export function getProviderArticle(provider: OpenWikiProvider): "a" | "an" {
  return provider === "baseten" ||
    provider === "fireworks" ||
    provider === "gemini" ||
    provider === "gemini-enterprise" ||
    provider === "nebius"
    ? "a"
    : "an";
}

/**
 * Label for the provider's primary credential input. Bedrock authenticates
 * with an IAM access key ID (paired with a secret access key), not a single
 * opaque API key, so its prompt reads differently from every other provider.
 */
export function getApiKeyFieldLabel(provider: OpenWikiProvider): string {
  return provider === "bedrock"
    ? `${getProviderLabel(provider)} access key ID`
    : `${getProviderLabel(provider)} API key`;
}

export function getProviderSelectionIndex(provider: OpenWikiProvider): number {
  const selectedIndex = SELECTABLE_OPENWIKI_PROVIDERS.findIndex(
    (providerOption) => providerOption === provider,
  );

  return selectedIndex === -1 ? 0 : selectedIndex;
}
