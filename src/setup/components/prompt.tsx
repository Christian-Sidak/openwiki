import { Box, Text } from "ink";
import {
  DEFAULT_PROVIDER,
  DEFAULT_VERTEX_LOCATION,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderLabel,
  getProviderLocationEnvKey,
  getProviderProjectEnvKey,
  getProviderRegionEnvKey,
  getProviderRegionEnvKeys,
  getProviderSecretKeyEnvKey,
  OPENWIKI_MODEL_ID_ENV_KEY,
  type OpenWikiProvider,
  resolveProviderRegion,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../../config/constants.js";
import type { OpenWikiRunMode } from "../../cli/commands.js";
import type { ExternalCliAuthState } from "../../auth/external-cli-auth.js";
import { validateCronExpression } from "../../scheduling/schedules.js";
import type { OpenWikiOnboardingConfig } from "../onboarding.js";
import { isCodeMode, type PromptStep } from "../steps/machine.js";
import { ONBOARDING_TEMPLATES } from "../config/run-mode.js";
import { getModelSelectionOptions } from "../config/model-selection.js";
import {
  CODE_REPO_OPTIONS,
  CRON_MODE_OPTIONS,
  FINAL_OPTIONS,
  getConfigModeName,
  getFinalOptionLabel,
  getLangsmithRegionLabel,
  LANGSMITH_REGION_OPTIONS,
  POWER_MODE_OPTIONS,
  RUN_MODE_OPTIONS,
  SOURCE_CONTINUE_OPTIONS,
} from "../config/options.js";
import { getApiKeyFieldLabel, getProviderArticle } from "../display.js";
import {
  getConnectedSourceCount,
  getSourceDescriptionPrompt,
  getSourceInstanceCount,
  getSourceInstances,
  getSourceMenuLabel,
  type SourceSetupOption,
} from "../sources.js";
import { getAwsCredentialRepairMessage } from "../credential-detail.js";
import type { LangsmithWorkspaceDraft, SourceSetupState } from "../types.js";
import {
  BorderedInput,
  BorderedMultilineInput,
  SegmentedCronInput,
} from "./inputs.js";
import { SelectionMarker, SourceConnectionStatus } from "./layout.js";
import { ExternalCliAuthPrompt, OAuthAuthorizationLink } from "./oauth.js";

export function Prompt({
  codeRepoPathInput,
  codeRepoRoot,
  codeRepoSelectionIndex,
  externalCliAuth,
  cronFieldSelectionIndex,
  cronModeSelectionIndex,
  finalSelectionIndex,
  input,
  inputDisplayWidth,
  isCustomModelInput,
  langsmithDraft,
  langsmithRegionSelectionIndex,
  langsmithWorkspaceSelectionIndex,
  langsmithWorkspaces,
  modelSelectionIndex,
  onboardingConfig,
  powerModeSelectionIndex,
  provider,
  providerSelectionIndex,
  runModeSelectionIndex,
  secretInputIndex,
  selectedMode,
  selectedSource,
  sourceOptions,
  sourceContinueSelectionIndex,
  sourceDescriptionSelectionIndex,
  sourceSelectionIndex,
  sourceState,
  step,
  suggestedCronDescription,
  suggestedCronExpression,
  templateSelectionIndex,
}: {
  codeRepoPathInput: string;
  codeRepoRoot: string;
  codeRepoSelectionIndex: number;
  externalCliAuth: ExternalCliAuthState;
  cronFieldSelectionIndex: number;
  cronModeSelectionIndex: number;
  finalSelectionIndex: number;
  input: string;
  inputDisplayWidth: number;
  isCustomModelInput: boolean;
  langsmithDraft: LangsmithWorkspaceDraft | null;
  langsmithRegionSelectionIndex: number;
  langsmithWorkspaceSelectionIndex: number;
  langsmithWorkspaces: LangsmithWorkspaceDraft[];
  modelSelectionIndex: number;
  onboardingConfig: OpenWikiOnboardingConfig;
  powerModeSelectionIndex: number;
  provider: OpenWikiProvider;
  providerSelectionIndex: number;
  runModeSelectionIndex: number;
  secretInputIndex: number;
  selectedMode: OpenWikiRunMode;
  selectedSource: SourceSetupOption;
  sourceOptions: readonly SourceSetupOption[];
  sourceContinueSelectionIndex: number;
  sourceDescriptionSelectionIndex: number;
  sourceSelectionIndex: number;
  sourceState: SourceSetupState;
  step: PromptStep;
  suggestedCronDescription: string;
  suggestedCronExpression: string;
  templateSelectionIndex: number;
}) {
  if (step === "run-mode") {
    const selectedMode =
      RUN_MODE_OPTIONS[runModeSelectionIndex] ?? RUN_MODE_OPTIONS[0];

    return (
      <Box flexDirection="column">
        <Text>Choose what OpenWiki should initialize.</Text>
        {RUN_MODE_OPTIONS.map((option, index) => (
          <Text key={option.id}>
            <SelectionMarker isSelected={index === runModeSelectionIndex} />{" "}
            {option.name} <Text color="gray">({option.id})</Text>
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selectedMode.name}</Text>
          <Text color="gray">{selectedMode.description}</Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "provider") {
    return (
      <Box flexDirection="column">
        <Text>Choose a model provider.</Text>
        {SELECTABLE_OPENWIKI_PROVIDERS.map((providerOption, index) => (
          <Text key={providerOption}>
            <SelectionMarker isSelected={index === providerSelectionIndex} />{" "}
            {getProviderLabel(providerOption)}
            <Text color="gray"> ({providerOption})</Text>
            {providerOption === DEFAULT_PROVIDER ? (
              <Text color="gray"> default</Text>
            ) : null}
          </Text>
        ))}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "api-key") {
    return (
      <Box flexDirection="column">
        <Text>Paste your {getApiKeyFieldLabel(provider)}.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${getProviderApiKeyEnvKey(provider)}=`}
          secret
          value={input}
        />
        <Text color="gray">Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "external-cli-auth") {
    return (
      <ExternalCliAuthPrompt
        authState={externalCliAuth}
        input={input}
        provider={provider}
      />
    );
  }

  if (step === "secret-key") {
    return (
      <Box flexDirection="column">
        <Text>Paste your {getProviderLabel(provider)} secret access key.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${getProviderSecretKeyEnvKey(provider)}=`}
          secret
          value={input}
        />
        <Text color="gray">Press Enter to save it.</Text>
      </Box>
    );
  }

  if (step === "gcp-project") {
    return (
      <Box flexDirection="column">
        <Text>Enter the Google Cloud project ID with Vertex AI access.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderProjectEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          OpenWiki authenticates with Google Application Default Credentials
          (run: gcloud auth application-default login). Press Enter to save it.
        </Text>
      </Box>
    );
  }

  if (step === "gcp-location") {
    return (
      <Box flexDirection="column">
        <Text>
          Enter a Vertex AI location, or press Enter to use{" "}
          {DEFAULT_VERTEX_LOCATION}.
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderLocationEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          For example global, europe-west1, or us-east5. Press Enter to
          continue.
        </Text>
      </Box>
    );
  }

  if (step === "base-url") {
    return (
      <Box flexDirection="column">
        <Text>Enter the {getProviderLabel(provider)} base URL.</Text>
        <Text>
          <Text color="gray">$</Text> {getProviderBaseUrlEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          For example an OpenAI-compatible gateway endpoint (such as a LiteLLM
          gateway). Press Enter to save it.
        </Text>
      </Box>
    );
  }

  if (step === "region") {
    const resolvedRegion = resolveProviderRegion(provider);
    const credentialRepairMessage = getAwsCredentialRepairMessage(provider);

    return (
      <Box flexDirection="column">
        {credentialRepairMessage ? (
          <Text color="yellow">⚠ {credentialRepairMessage}</Text>
        ) : null}
        <Text>
          Enter the {getProviderLabel(provider)} region
          {resolvedRegion ? `, or press Enter to keep ${resolvedRegion}` : ""}.
        </Text>
        <Text>
          <Text color="gray">$</Text> {getProviderRegionEnvKey(provider)}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
        <Text color="gray">
          Uses {getProviderRegionEnvKeys(provider).join(", ")}. For example
          us-east-1.
        </Text>
      </Box>
    );
  }

  if (step === "model") {
    if (isCustomModelInput) {
      return (
        <Box flexDirection="column">
          <Text>Paste a custom model ID.</Text>
          <BorderedInput
            maxDisplayWidth={inputDisplayWidth}
            marginTop={1}
            prefix={`${OPENWIKI_MODEL_ID_ENV_KEY}=`}
            value={input}
          />
          <Text color="gray">Press Enter to save it.</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text>
          Choose {getProviderArticle(provider)} {getProviderLabel(provider)}{" "}
          model.
        </Text>
        {getModelSelectionOptions(provider).map((option, index) => {
          if (option.kind === "custom") {
            return (
              <Text key="custom">
                <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
                Custom model ID
              </Text>
            );
          }

          return (
            <Text key={option.id}>
              <SelectionMarker isSelected={index === modelSelectionIndex} />{" "}
              {option.label} <Text color="gray">{option.id}</Text>
              {option.id === getDefaultModelId(provider) ? (
                <Text color="gray"> default</Text>
              ) : null}
            </Text>
          );
        })}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "langsmith") {
    return (
      <Box flexDirection="column">
        <Text>Optional: paste a LangSmith API key for tracing.</Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="LANGSMITH_API_KEY optional="
          secret
          value={input}
        />
        <Text color="gray">Press Enter with an empty value to skip.</Text>
      </Box>
    );
  }

  if (step === "template") {
    const selectedTemplate =
      ONBOARDING_TEMPLATES[templateSelectionIndex] ?? ONBOARDING_TEMPLATES[0];

    return (
      <Box flexDirection="column">
        <Text>Choose how OpenWiki should run.</Text>
        {ONBOARDING_TEMPLATES.map((template, index) => (
          <Text key={template.id}>
            <SelectionMarker isSelected={index === templateSelectionIndex} />{" "}
            {template.name}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selectedTemplate.name}</Text>
          <Text color="gray">{selectedTemplate.description}</Text>
          {selectedTemplate.suggestedSources.length > 0 ? (
            <Text color="gray">
              Suggested sources: {selectedTemplate.suggestedSources.join(", ")}
            </Text>
          ) : (
            <Text color="gray">Start from a blank wiki brief.</Text>
          )}
        </Box>
        <Text color="gray">
          Press Enter, then edit the brief on the next step.
        </Text>
      </Box>
    );
  }

  if (step === "wiki-goal") {
    return (
      <Box flexDirection="column">
        <Text>Customize what this wiki should understand.</Text>
        {getConfigModeName(onboardingConfig) ? (
          <Text color="gray">Mode: {getConfigModeName(onboardingConfig)}</Text>
        ) : null}
        <Text color="gray">
          Edit the brief below. Keep what is useful, delete what is not.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Edit wiki brief</Text>
          <BorderedMultilineInput
            maxDisplayWidth={inputDisplayWidth}
            value={input}
          />
        </Box>
        <Text color="gray">Press Enter to continue.</Text>
      </Box>
    );
  }

  if (step === "code-repo-confirm") {
    return (
      <Box flexDirection="column">
        <Text>Use this repository?</Text>
        <Box marginTop={1}>
          <Text color="cyan">{codeRepoRoot}</Text>
        </Box>
        <Text color="gray">
          OpenWiki will run in this directory and write the initial openwiki/
          folder there.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {CODE_REPO_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker isSelected={index === codeRepoSelectionIndex} />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "code-repo-path") {
    return (
      <Box flexDirection="column">
        <Text>Choose the repository directory.</Text>
        <Text color="gray">
          Enter an existing directory. OpenWiki will write openwiki/ there.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="path="
          value={codeRepoPathInput}
        />
        <Text color="gray">Press Enter to confirm this path.</Text>
      </Box>
    );
  }

  if (step === "source-menu") {
    // LangSmith workspaces live in state until setup completes (not onboarding
    // source instances), so count them here for the menu's configured display.
    const langsmithWorkspaceCount = sourceOptions.some(
      (source) => source.id === "langsmith",
    )
      ? langsmithWorkspaces.length
      : 0;
    const configuredCount =
      getConnectedSourceCount(onboardingConfig, sourceOptions) +
      langsmithWorkspaceCount;

    return (
      <Box flexDirection="column">
        <Text>Configure sources for this mode.</Text>
        {sourceOptions.map((source, index) => {
          const isLangsmith = source.id === "langsmith";
          const sourceInstances = getSourceInstances(
            onboardingConfig,
            source.id,
          );
          const count = isLangsmith
            ? langsmithWorkspaces.length
            : sourceInstances.length;
          return (
            <Box flexDirection="column" key={source.id}>
              <Text>
                <SelectionMarker isSelected={index === sourceSelectionIndex} />{" "}
                {getSourceMenuLabel(source, count)}{" "}
                <SourceConnectionStatus
                  count={count}
                  isConfigured={count > 0}
                />
              </Text>
              {isLangsmith
                ? langsmithWorkspaces.map((workspace) => (
                    <Text color="gray" key={workspace.apiKeyEnv}>
                      {"  "}- {getLangsmithRegionLabel(workspace.region)}:{" "}
                      {workspace.projects.join(", ")}
                    </Text>
                  ))
                : sourceInstances.map((sourceInstance) => (
                    <Text color="gray" key={sourceInstance.id}>
                      {"  "}- {sourceInstance.name ?? sourceInstance.id}{" "}
                      <Text color="gray">({sourceInstance.id})</Text>
                    </Text>
                  ))}
            </Box>
          );
        })}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Next</Text>
          <Text>
            <SelectionMarker
              isSelected={sourceSelectionIndex === sourceOptions.length}
            />{" "}
            Continue{" "}
            {configuredCount === 0 ? (
              <Text color="gray">(no sources configured)</Text>
            ) : null}
          </Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-path") {
    return (
      <Box flexDirection="column">
        <Text>Choose the local Git repository directory.</Text>
        <Text color="gray">
          Default is the directory where you started OpenWiki. Edit it to use a
          different checkout.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix="path="
          value={input}
        />
        <Text color="gray">Press Enter to save this source.</Text>
      </Box>
    );
  }

  if (step === "source-secret") {
    const secretInput = selectedSource.secretInputs[secretInputIndex];
    return (
      <Box flexDirection="column">
        <Text>{selectedSource.displayName} setup</Text>
        {selectedSource.instructions.map((instruction, index) => (
          <Text key={instruction}>
            {index + 1}. {instruction}
          </Text>
        ))}
        {secretInput ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Enter credential</Text>
            <BorderedInput
              maxDisplayWidth={inputDisplayWidth}
              prefix={`${secretInput.envKey}${
                secretInput.optional ? " optional" : ""
              }=`}
              secret
              value={input}
            />
            <Text color="gray">
              {secretInput.optional
                ? "Press Enter with an empty value to skip."
                : "Press Enter to save this value."}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  if (step === "source-auth") {
    return (
      <Box flexDirection="column">
        <Text>{selectedSource.displayName} authorization</Text>
        {sourceState.authUrl ? (
          <OAuthAuthorizationLink
            authProvider={selectedSource.authProvider}
            copiedToClipboard={Boolean(sourceState.copiedAuthUrlToClipboard)}
            url={sourceState.authUrl}
          />
        ) : (
          <Text color="gray">
            Press Enter to open the authorization URL and wait for the callback.
          </Text>
        )}
      </Box>
    );
  }

  if (step === "source-description") {
    return (
      <Box flexDirection="column">
        <Text>{getSourceDescriptionPrompt(selectedSource)}</Text>
        <Text color="gray">
          Choose an example description, or write your own.
        </Text>
        {selectedSource.examples.map((example, index) => (
          <Text key={example}>
            <SelectionMarker
              isSelected={index === sourceDescriptionSelectionIndex}
            />{" "}
            {example}
          </Text>
        ))}
        <Text>
          <SelectionMarker
            isSelected={
              sourceDescriptionSelectionIndex >= selectedSource.examples.length
            }
          />{" "}
          Custom description
        </Text>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-description-custom") {
    return (
      <Box flexDirection="column">
        <Text>{getSourceDescriptionPrompt(selectedSource)}</Text>
        <Text color="gray">
          Type what OpenWiki should focus on for this source.
        </Text>
        <BorderedMultilineInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          value={input}
        />
        <Text color="gray">Optional. Press Enter to continue.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-workspaces") {
    const workspaceCount = langsmithWorkspaces.length;
    return (
      <Box flexDirection="column">
        <Text>LangSmith workspaces to document.</Text>
        <Text color="gray">
          A LangSmith key is region-bound, so each workspace has its own region
          and key. Select one to edit (clear its projects to remove it).
        </Text>
        {langsmithWorkspaces.map((workspace, index) => (
          <Text key={workspace.apiKeyEnv}>
            <SelectionMarker
              isSelected={index === langsmithWorkspaceSelectionIndex}
            />{" "}
            {getLangsmithRegionLabel(workspace.region)}:{" "}
            {workspace.projects.join(", ")}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <SelectionMarker
              isSelected={langsmithWorkspaceSelectionIndex === workspaceCount}
            />{" "}
            Add a workspace
          </Text>
          <Text>
            <SelectionMarker
              isSelected={
                langsmithWorkspaceSelectionIndex === workspaceCount + 1
              }
            />{" "}
            Done
          </Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-key") {
    const apiKeyEnv = langsmithDraft?.apiKeyEnv ?? "OPENWIKI_LANGSMITH_API_KEY";
    return (
      <Box flexDirection="column">
        <Text>LangSmith API key for this workspace.</Text>
        <Text color="gray">
          The connector&apos;s own read key (not your app&apos;s tracing key).
          Saved to ~/.openwiki/.env as {apiKeyEnv}, never committed.
        </Text>
        <BorderedInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          prefix={`${apiKeyEnv}=`}
          secret
          value={input}
        />
        <Text color="gray">
          Press Enter to confirm (empty keeps the saved key).
        </Text>
      </Box>
    );
  }

  if (step === "source-langsmith-projects") {
    return (
      <Box flexDirection="column">
        <Text>Which projects should this wiki document in this workspace?</Text>
        <Text color="gray">
          Comma-separated project names (as in LANGCHAIN_PROJECT). Written to
          openwiki/.langsmith.json.
        </Text>
        <BorderedMultilineInput
          maxDisplayWidth={inputDisplayWidth}
          marginTop={1}
          value={input}
        />
        <Text color="gray">Press Enter to confirm.</Text>
      </Box>
    );
  }

  if (step === "source-langsmith-region") {
    const selectedRegion =
      LANGSMITH_REGION_OPTIONS[langsmithRegionSelectionIndex] ??
      LANGSMITH_REGION_OPTIONS[0];

    return (
      <Box flexDirection="column">
        <Text>Which LangSmith region is this workspace in?</Text>
        {LANGSMITH_REGION_OPTIONS.map((option, index) => (
          <Text key={option.id}>
            <SelectionMarker
              isSelected={index === langsmithRegionSelectionIndex}
            />{" "}
            {option.name} <Text color="gray">({option.host})</Text>
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">{selectedRegion.description}</Text>
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "global-cron-mode") {
    return (
      <Box flexDirection="column">
        <Text>
          {isCodeMode(onboardingConfig)
            ? "When should GitHub Actions refresh this code wiki?"
            : "When should OpenWiki run all ingestion?"}
        </Text>
        <Text color="gray">
          {isCodeMode(onboardingConfig)
            ? "OpenWiki will write a scheduled GitHub Actions workflow for this repository."
            : "All configured sources run sequentially at this time."}
        </Text>
        <Text color="gray">Suggested: {suggestedCronDescription}</Text>
        {CRON_MODE_OPTIONS.map((option, index) => (
          <Text key={option}>
            <SelectionMarker isSelected={index === cronModeSelectionIndex} />{" "}
            {option}
          </Text>
        ))}
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "global-cron-custom") {
    const validation = validateCronExpression(input);
    return (
      <Box flexDirection="column">
        <Text>
          {isCodeMode(onboardingConfig)
            ? "Enter one GitHub Actions cron schedule for this code wiki."
            : "Enter one cron schedule for all ingestion."}
        </Text>
        <SegmentedCronInput
          activeFieldIndex={cronFieldSelectionIndex}
          expression={input}
          fallbackExpression={suggestedCronExpression}
          maxDisplayWidth={inputDisplayWidth}
        />
        {input ? (
          <Text color={validation.valid ? "cyan" : "red"}>
            {validation.valid ? validation.description : validation.error}
          </Text>
        ) : (
          <Text color="gray">Example: 0 2 * * *</Text>
        )}
        <Text color="gray">
          Type in each field. Use right/left arrows or Tab to move; spaces also
          move fields.
        </Text>
        <Text color="gray">Press Enter to save a valid schedule.</Text>
      </Box>
    );
  }

  if (step === "global-power-mode") {
    return (
      <Box flexDirection="column">
        <Text>Keep your Mac awake for scheduled refreshes?</Text>
        <Text color="gray">
          OpenWiki can use macOS pmset to wake 2 minutes before the shared
          ingestion schedule and sleep 30 minutes after it.
        </Text>
        {sourceState.savedScheduleWarning ? (
          <Text color="yellow">{sourceState.savedScheduleWarning}</Text>
        ) : null}
        <Box flexDirection="column" marginTop={1}>
          {POWER_MODE_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker isSelected={index === powerModeSelectionIndex} />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">
          macOS has one global repeat power schedule. Setting this can replace
          an existing pmset repeat wake/sleep schedule.
        </Text>
      </Box>
    );
  }

  if (step === "source-confirm-continue") {
    const missingSources = sourceOptions.filter(
      (source) => getSourceInstanceCount(onboardingConfig, source.id) === 0,
    );
    return (
      <Box flexDirection="column">
        <Text>Some sources for this mode are not configured yet.</Text>
        {missingSources.map((source) => (
          <Text color="gray" key={source.id}>
            - {source.displayName}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          {SOURCE_CONTINUE_OPTIONS.map((option, index) => (
            <Text key={option}>
              <SelectionMarker
                isSelected={index === sourceContinueSelectionIndex}
              />{" "}
              {option}
            </Text>
          ))}
        </Box>
        <Text color="gray">Use up/down arrows, then press Enter.</Text>
      </Box>
    );
  }

  if (step === "final") {
    return (
      <Box flexDirection="column">
        <Text>Setup is complete.</Text>
        {FINAL_OPTIONS.map((option, index) => {
          const label = getFinalOptionLabel(option, selectedMode);
          return (
            <Text key={option}>
              <SelectionMarker isSelected={index === finalSelectionIndex} />{" "}
              {label}
            </Text>
          );
        })}
        <Text color="gray">
          {selectedMode === "code"
            ? "Run now writes the initial openwiki/ directory. Open chat skips the initial run."
            : "Run now executes one source-specific ingestion and wiki update per configured source. Run later opens chat so you can start ingestion when you are ready."}
        </Text>
      </Box>
    );
  }

  return null;
}
