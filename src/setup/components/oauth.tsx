import { Box, Text } from "ink";
import {
  getProviderApiKeyEnvKey,
  getProviderLabel,
  type OpenWikiProvider,
} from "../../config/constants.js";
import type { AuthProviderId } from "../../auth/types.js";
import {
  getExternalCliAuthAdapter,
  type ExternalCliAuthState,
} from "../../auth/external-cli-auth.js";
import { formatTerminalHyperlink, mask } from "../display.js";
import { getOAuthAuthorizationStatusText } from "../steps/machine.js";

export function OAuthAuthorizationLink({
  authProvider,
  copiedToClipboard,
  url,
}: {
  authProvider?: AuthProviderId;
  copiedToClipboard: boolean;
  url: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan" underline>
          {formatTerminalHyperlink(url, "Open authorization URL")}
        </Text>
      </Text>
      <Text color={copiedToClipboard ? "green" : "gray"}>
        {getOAuthAuthorizationStatusText({
          authProvider,
          copiedToClipboard,
        })}
      </Text>
    </Box>
  );
}

export function OAuthLoginPrompt({
  copied,
  input,
  isLoggingIn,
  loginUrl,
  provider,
}: {
  copied: boolean;
  input: string;
  isLoggingIn: boolean;
  loginUrl: string | null;
  provider: OpenWikiProvider;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        ChatGPT login
      </Text>
      <Text>
        Sign in with your {getProviderLabel(provider)} account to authorize
        OpenWiki.
      </Text>
      {loginUrl ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">
            Opening your browser. If it does not open, copy this URL:
          </Text>
          <Text color="cyan" wrap="wrap">
            {loginUrl}
          </Text>
          <Text color="gray">
            Press <Text bold>c</Text> to copy the URL
            {copied ? <Text color="green"> (copied)</Text> : null}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              If the browser cannot reach this machine, paste the redirect URL
              or authorization code and press Enter:
            </Text>
            <Text>
              <Text color="gray">&gt; </Text>
              {input.length > 0 ? (
                <Text color="yellow">{input}</Text>
              ) : (
                <Text color="gray">(paste here)</Text>
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text color="gray">Starting the ChatGPT login...</Text>
      )}
      <Text color="gray">
        {isLoggingIn
          ? "Waiting for browser sign-in or pasted URL..."
          : "Login failed. Press Enter to retry."}
      </Text>
    </Box>
  );
}

export function ExternalCliAuthPrompt({
  authState,
  input,
  provider,
}: {
  authState: ExternalCliAuthState;
  input: string;
  provider: OpenWikiProvider;
}) {
  const adapter = getExternalCliAuthAdapter(provider);
  const envKey = getProviderApiKeyEnvKey(provider) ?? "API key";

  if (!adapter) {
    return null;
  }

  if (authState.kind === "idle" || authState.kind === "checking") {
    return (
      <Text color="gray">
        Checking for an existing {adapter.credentialDescription}...
      </Text>
    );
  }

  if (authState.kind === "logging-in") {
    return (
      <Text color="gray">
        Running `{adapter.loginCommand}` — follow the prompts in this
        terminal...
      </Text>
    );
  }

  if (authState.kind === "detected") {
    return (
      <Box flexDirection="column">
        <Text>Detected an existing {adapter.credentialDescription}.</Text>
        <Text color="gray">
          Press Enter to use it, Tab to sign in again, or paste a different
          token below.
        </Text>
        <Text>
          <Text color="gray">$</Text> {envKey}={" "}
          <Text color="yellow">
            {input.length > 0 ? mask(input) : `<from ${adapter.name}>`}
          </Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>No {adapter.credentialDescription} detected.</Text>
      {authState.kind === "login-failed" ? (
        <Text color="red">
          `{adapter.loginCommand}` did not complete successfully.
        </Text>
      ) : null}
      {authState.kind === "not-detected" && authState.cliAvailable ? (
        <Text color="gray">
          Press Tab to run `{adapter.loginCommand}`, or paste a token below.
        </Text>
      ) : (
        <Text color="gray">
          {adapter.installHint} You can also paste a token below for CI or other
          headless use.
        </Text>
      )}
      <Text>
        <Text color="gray">$</Text> {envKey}={" "}
        <Text color="yellow">{mask(input)}</Text>
      </Text>
      <Text color="gray">Press Enter to save it.</Text>
    </Box>
  );
}
