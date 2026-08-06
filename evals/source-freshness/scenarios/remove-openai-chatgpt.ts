/**
 * Scenario: the openai-chatgpt provider is removed (large).
 *
 * A subsystem removal. The `openai-chatgpt` provider (ChatGPT OAuth login
 * against the Codex backend) is dropped: it leaves the `OpenWikiProvider` union,
 * `PROVIDER_CONFIGS`, and `SELECTABLE_OPENWIKI_PROVIDERS` in `src/constants.ts`,
 * its two `createModel`-time branches (token refresh and the Codex-backed
 * `ChatOpenAI` client) are deleted from `src/agent/index.ts`, and the ChatGPT
 * account display is dropped from `src/cli.tsx`. The
 * `src/agent/openai-chatgpt-oauth.ts` module is intentionally left in place as
 * now-unused code, so lingering source-map references to that file stay
 * accurate; only the provider wiring is gone. Three pages present openai-chatgpt
 * as a first-class provider.
 */

import { editFile, replaceOnce } from "./mutation-helpers.js";
import type { EvalScenario, PageExpectation } from "./types.js";

/** The `openai-chatgpt` member of the `OpenWikiProvider` union. */
const UNION_MATCH = `  | "openai"
  | "openai-chatgpt"
  | "openai-compatible"`;

/** The union with the member removed. */
const UNION_REPLACE = `  | "openai"
  | "openai-compatible"`;

/** The `openai-chatgpt` entry in the `SELECTABLE_OPENWIKI_PROVIDERS` array. */
const SELECTABLE_MATCH = `  "openai",
  "openai-chatgpt",
  "anthropic",`;

/** The selectable list with the entry removed. */
const SELECTABLE_REPLACE = `  "openai",
  "anthropic",`;

/**
 * The `openai-chatgpt` entry in `PROVIDER_CONFIGS`, with its trailing newline so
 * removal leaves the surrounding entries flush.
 */
const CONFIG_MATCH = `  "openai-chatgpt": {
    apiKeyEnvKey: OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
    authMethod: "oauth",
    label: "OpenAI (ChatGPT login)",
    modelOptions: OPENAI_MODEL_OPTIONS,
  },
`;

/**
 * The doc comment on `OPENAI_MODEL_OPTIONS`, which references the removed
 * provider. Rewritten so the constants.ts head handed to the judge carries no
 * stale openai-chatgpt mention.
 */
const COMMENT_MATCH = `/**
 * Model options offered by OpenAI. Shared by the \`openai\` (API key) and
 * \`openai-chatgpt\` (OAuth login) providers so the two always expose an
 * identical model list.
 */`;

/** The rewritten single-provider comment. */
const COMMENT_REPLACE = `/** Model options offered by the OpenAI provider. */`;

/** The startup token-refresh branch keyed on the removed provider. */
const STARTUP_BRANCH_MATCH = `    ensureProviderRegion(provider);

    if (provider === "openai-chatgpt") {
      // Refresh before the model is built, so \`createModel\` stays synchronous.
      await ensureFreshChatGptTokens();
      emitDebug(options, "chatgpt.token=fresh");
    }

    const modelId = resolveModelId(options, provider);`;

/** The startup path with the openai-chatgpt refresh branch removed. */
const STARTUP_BRANCH_REPLACE = `    ensureProviderRegion(provider);

    const modelId = resolveModelId(options, provider);`;

/**
 * The `createModel` branch that builds the Codex-backed `ChatOpenAI` client,
 * matched through the start of the following `openrouter` branch so removal
 * leaves clean spacing.
 */
const CLIENT_BRANCH_MATCH = `  if (provider === "openai-chatgpt") {
    // Already refreshed by \`ensureFreshChatGptTokens()\` before the run started.
    const tokens = readCodexTokensFromEnv();

    if (!tokens) {
      throw new Error(CHATGPT_LOGIN_INCOMPLETE_MESSAGE);
    }

    // Reuse LangChain's existing ChatOpenAI Responses-API integration (correct
    // tool-calling + SSE parsing for DeepAgents) pointed at the Codex backend:
    // - useResponsesApi routes to POST {baseURL}/responses
    // - zdrEnabled forces \`store: false\`, which the Codex backend requires
    // - defaultHeaders carry the account id / originator / beta header
    return new ChatOpenAI({
      apiKey: tokens.access,
      model: modelId,
      useResponsesApi: true,
      zdrEnabled: true,
      // The Codex backend rejects non-streaming requests
      // ("Stream must be set to true"), so force the streaming transport for
      // every generation — including the non-streaming \`.invoke()\` calls
      // DeepAgents' agent node issues internally.
      streaming: true,
      ...retryOptions,
      configuration: {
        baseURL: CODEX_RESPONSES_BASE_URL,
        defaultHeaders: {
          "chatgpt-account-id": tokens.accountId,
          originator: CODEX_ORIGINATOR,
          "OpenAI-Beta": "responses=experimental",
        },
        fetch: createCodexFetch(modelId),
      },
    });
  }

  if (provider === "openrouter") {`;

/** The model-client path with the openai-chatgpt branch removed. */
const CLIENT_BRANCH_REPLACE = `  if (provider === "openrouter") {`;

/** The ChatGPT account-display computation in the CLI header. */
const CLI_ACCOUNT_MATCH = `  const chatGptAccount =
    configuredProvider === "openai-chatgpt"
      ? formatChatGptAccountFromEnv()
      : null;`;

/** The account display forced off now the provider is gone. */
const CLI_ACCOUNT_REPLACE = `  const chatGptAccount = null;`;

/**
 * Remove the openai-chatgpt provider across constants, the agent's model
 * factory, and the CLI header.
 *
 * @param cwd - The throwaway checkout the mutation edits in place.
 */
async function applyMutation(cwd: string): Promise<void> {
  await editFile(cwd, "src/constants.ts", (content) => {
    let next = replaceOnce(content, UNION_MATCH, UNION_REPLACE);
    next = replaceOnce(next, SELECTABLE_MATCH, SELECTABLE_REPLACE);
    next = replaceOnce(next, CONFIG_MATCH, "");
    next = replaceOnce(next, COMMENT_MATCH, COMMENT_REPLACE);
    return next;
  });

  await editFile(cwd, "src/agent/index.ts", (content) => {
    let next = replaceOnce(
      content,
      STARTUP_BRANCH_MATCH,
      STARTUP_BRANCH_REPLACE,
    );
    next = replaceOnce(next, CLIENT_BRANCH_MATCH, CLIENT_BRANCH_REPLACE);
    return next;
  });

  await editFile(cwd, "src/cli.tsx", (content) =>
    replaceOnce(content, CLI_ACCOUNT_MATCH, CLI_ACCOUNT_REPLACE),
  );
}

/**
 * The single in-cap source evidence for the removal: the provider union no
 * longer contains openai-chatgpt. This sits within the first 8000 characters of
 * `src/constants.ts` (the judge's per-file cap), unlike `PROVIDER_CONFIGS` or the
 * deep `createModel` branch, and unambiguously proves openai-chatgpt is gone.
 */
const UNION_EVIDENCE = {
  path: "src/constants.ts",
  symbol: "OpenWikiProvider",
  explanation:
    "The provider union no longer lists openai-chatgpt, so it is no longer a " +
    "supported provider and no createModel branch builds a Codex-backed client.",
} as const;

/**
 * A page that presents openai-chatgpt as a first-class provider via a bold
 * `**openai-chatgpt**` bullet. A synchronized page drops that bullet; the change
 * adds no affirmative claim, so the signal is entirely forbidden-fact.
 *
 * @param page - The repo-relative wiki page path.
 *
 * @param what - What the bullet documents, for the rationale.
 */
function boldBulletPage(page: string, what: string): PageExpectation {
  return {
    page,
    rationale:
      `Presents openai-chatgpt as a supported provider via a bold bullet that ${what}. ` +
      "openai-chatgpt has been removed from the provider set, so the bullet is obsolete.",
    requiredFacts: [],
    forbiddenFacts: [
      {
        id: "no-chatgpt-bullet",
        description:
          "The page must no longer present openai-chatgpt as a supported " +
          "provider option.",
        requireAbsent: ["**openai-chatgpt**"],
      },
    ],
    sourceEvidence: [UNION_EVIDENCE],
  };
}

/** The remove-openai-chatgpt scenario. */
export const removeOpenAiChatgptScenario: EvalScenario = {
  id: "remove-openai-chatgpt",
  title: "Remove the openai-chatgpt provider",
  complexity: "large",
  description:
    "A subsystem removal: the openai-chatgpt provider (ChatGPT OAuth login " +
    "against the Codex backend) is dropped from OpenWiki. It is removed from the " +
    "OpenWikiProvider union, PROVIDER_CONFIGS, and SELECTABLE_OPENWIKI_PROVIDERS " +
    "in src/constants.ts; its two createModel-time branches (token refresh and " +
    "the Codex-backed ChatOpenAI client) are deleted from src/agent/index.ts; and " +
    "the ChatGPT account display is dropped from src/cli.tsx. openai-chatgpt is no " +
    "longer a selectable provider and OpenWiki never builds a Codex-backed " +
    "client. The src/agent/openai-chatgpt-oauth.ts module file is left in place " +
    "as now-unused code, so references to that file remaining in source maps are " +
    "still accurate.",
  applyMutation,
  expectedAffectedPages: [
    boldBulletPage(
      "openwiki/architecture/overview.md",
      "describes the Codex-backed ChatOpenAI client it maps to",
    ),
    boldBulletPage(
      "openwiki/agent/workflow.md",
      "describes its createModel branch and token handling",
    ),
    {
      page: "openwiki/cli/usage.md",
      rationale:
        "Enumerates openai-chatgpt among the accepted OPENWIKI_PROVIDER values " +
        "and documents a dedicated credential-table row for it. openai-chatgpt " +
        "is no longer in SELECTABLE_OPENWIKI_PROVIDERS or the provider union.",
      requiredFacts: [],
      forbiddenFacts: [
        {
          id: "no-provider-enum",
          description:
            "The accepted-provider enumeration must no longer list " +
            "openai-chatgpt among the OPENWIKI_PROVIDER values.",
          requireAbsent: ["openai, openai-chatgpt, copilot"],
        },
        {
          id: "no-cred-row",
          description:
            "The credential table must no longer have an openai-chatgpt row.",
          requireAbsent: ["| openai-chatgpt "],
        },
      ],
      sourceEvidence: [UNION_EVIDENCE],
    },
  ],
};
