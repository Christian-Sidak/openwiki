/**
 * Scenario: a new `local-docs` data-source connector is added (feature addition).
 *
 * A capability-adding change of the shape OpenWiki's own docs describe as "adding
 * a connector" (integrations/connectors.md): a new source connector that ingests
 * Markdown and plain-text documents from a configured local directory tree. The
 * change is genuinely multi-layer, and two of its edges are forced by the
 * compiler rather than added for show:
 *
 * - `src/connectors/types.ts` gains a `"local-docs"` member of the `ConnectorId`
 *   union (the type surface the docs call "ground truth for what exists today").
 * - `src/connectors/sources/local-docs.ts` is a new connector module implementing
 *   the ingest behavior, modeled on the existing `web-search.ts`.
 * - `src/connectors/registry.ts` imports and registers it. The registry map is
 *   `Record<ConnectorId, ConnectorRuntime>`, so adding the union member *forces*
 *   the registry entry (TS2741 otherwise); `CONNECTOR_IDS` gains it too so
 *   `isConnectorId()` recognizes it.
 * - `src/ingestion.ts` gains a `case "local-docs"` in the per-connector synthesis
 *   guidance `switch (connector.id)`. That switch has no `default`, so it only
 *   typechecks while exhaustive over `ConnectorId` — adding the union member
 *   *forces* the new case (TS7030 otherwise).
 * - `test/local-docs.test.ts` covers the new connector (idiomatic vitest, modeled
 *   on `test/hackernews.test.ts`).
 *
 * The connector is registered and ingestable via config, but deliberately not
 * wired into `src/credentials.tsx` interactive onboarding (a realistic
 * "connector landed, onboarding UI is a follow-up" increment, mirroring the
 * module-preserving discipline of the removal scenario). Because onboarding does
 * not yet offer it, the onboarding-source lists stay defensibly correct and are
 * not graded; only the connector *inventory* becomes stale.
 *
 * Three pages document that inventory and must react: the connector count and
 * `ConnectorId` union (integrations/connectors.md), the connector-source mirror
 * (integrations/index.md), and the list of bespoke connector source modules
 * (architecture/overview.md). The eval never runs the connector's ingest, so no
 * filesystem reads or network calls happen during the benchmark.
 */

import {
  editFile,
  insertAfter,
  replaceOnce,
  writeNewFile,
} from "./mutation-helpers.js";
import type { EvalScenario, PageExpectation } from "./types.js";

/** The id of the connector this scenario adds. */
const CONNECTOR_ID = "local-docs";

/**
 * The two-line slice of the `ConnectorId` union the new member is threaded
 * between (alphabetical, after `langsmith` and before `notion`).
 */
const UNION_MATCH = `  | "langsmith"
  | "notion"`;

/** The union slice with the `local-docs` member inserted. */
const UNION_REPLACE = `  | "langsmith"
  | "local-docs"
  | "notion"`;

/** The registry import the new connector's factory import is placed after. */
const IMPORT_ANCHOR = `import { createLangSmithConnector } from "./sources/langsmith/index.js";`;

/** The factory import for the new connector module. */
const IMPORT_INSERT = `
import { createLocalDocsConnector } from "./sources/local-docs.js";`;

/** The tail of the `CONNECTOR_IDS` array the new id is appended to. */
const IDS_MATCH = `  "langsmith",
  "slack",
] as const satisfies readonly ConnectorId[];`;

/** The `CONNECTOR_IDS` tail with the new id appended. */
const IDS_REPLACE = `  "langsmith",
  "slack",
  "local-docs",
] as const satisfies readonly ConnectorId[];`;

/** The registry-map entry the new connector's entry is placed after. */
const MAP_ANCHOR = `    langsmith: createLangSmithConnector(),`;

/** The registry-map entry that wires the new connector into the exhaustive map. */
const MAP_INSERT = `
    "local-docs": createLocalDocsConnector(),`;

/**
 * The `case "langsmith"` label in `createConnectorSynthesisGuidance`; the new
 * `local-docs` case is inserted immediately before it. The surrounding switch has
 * no `default`, so it typechecks only while exhaustive over `ConnectorId`.
 */
const SYNTHESIS_ANCHOR = `    case "langsmith":`;

/** The new synthesis-guidance case plus the original `langsmith` label. */
const SYNTHESIS_REPLACE = `    case "local-docs":
      return \`
- Treat local documents as user-authored source material: prefer documents added or edited recently and those whose titles or headings indicate decisions, plans, specifications, runbooks, or open questions.
- Route durable findings to canonical pages such as /themes.md and /commitments.md, and keep /sources/local-docs.md as a compact evidence index keyed by relative path. Do not paste whole documents into the wiki.\`;
    case "langsmith":`;

/**
 * Full contents of the new `src/connectors/sources/local-docs.ts` module,
 * modeled on the existing `web-search.ts` connector (bare config props,
 * `readConnectorConfig`/`readConnectorState`/`writeRawJson`/`writeConnectorState`
 * flow, staged early-return results). Inner backticks and `${}` are escaped so
 * they land verbatim in the written file.
 */
const CONNECTOR_SOURCE = `import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  createRunId,
  readConnectorConfig,
  readConnectorState,
  updateStateWithRun,
  writeConnectorState,
  writeRawJson,
} from "../io.js";
import type {
  ConnectorDefinition,
  ConnectorIngestOptions,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "../types.js";

type LocalDocsConfig = {
  enabled?: boolean;
  extensions?: string[];
  maxFiles?: number;
  root?: string;
};

const STATE_PATH = "~/.openwiki/connectors/local-docs/state.json";

const definition: ConnectorDefinition = {
  backend: "direct-api",
  description:
    "Ingests Markdown and plain-text documents from a configured local directory tree into the raw cache for wiki synthesis.",
  displayName: "Local Docs",
  id: "local-docs",
  mode: "personal",
  requiredEnv: [],
  supportsAgenticDiscovery: false,
};

export function createLocalDocsConnector(): ConnectorRuntime {
  return {
    ...definition,
    ingest,
  };
}

async function ingest(
  options: ConnectorIngestOptions = {},
): Promise<ConnectorIngestResult> {
  const runId = createRunId();
  const config = {
    ...(await readConnectorConfig<LocalDocsConfig>("local-docs", {
      enabled: true,
      extensions: [".md", ".mdx", ".txt"],
      maxFiles: 200,
    })),
    ...((options.connectorConfig ?? {}) as LocalDocsConfig),
  };
  const state = await readConnectorState("local-docs");
  const warnings: string[] = [];
  const rawFiles: string[] = [];

  if (!config.enabled) {
    return {
      connectorId: "local-docs",
      message:
        "Local Docs connector is not enabled. Set enabled=true in ~/.openwiki/connectors/local-docs/config.json.",
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "skipped",
      warnings,
    };
  }

  const root = config.root?.trim();
  if (!root) {
    return {
      connectorId: "local-docs",
      message:
        "No local docs directory configured. Set root in ~/.openwiki/connectors/local-docs/config.json.",
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "skipped",
      warnings,
    };
  }

  const extensions = normalizeExtensions(config.extensions);
  const maxFiles = normalizeMaxFiles(config.maxFiles);

  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    return {
      connectorId: "local-docs",
      message: \`Failed to read local docs directory \${root}: \${
        error instanceof Error ? error.message : String(error)
      }.\`,
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "error",
      warnings,
    };
  }

  const documents: { content: string; relativePath: string }[] = [];
  for (const entry of entries) {
    if (documents.length >= maxFiles) {
      warnings.push(
        \`Reached maxFiles=\${maxFiles}; additional documents were skipped.\`,
      );
      break;
    }
    if (!extensions.includes(path.extname(entry).toLowerCase())) {
      continue;
    }
    try {
      documents.push({
        content: await readFile(path.join(root, entry), "utf8"),
        relativePath: entry,
      });
    } catch (error) {
      warnings.push(
        \`Skipped \${entry}: \${
          error instanceof Error ? error.message : String(error)
        }.\`,
      );
    }
  }

  if (documents.length === 0) {
    return {
      connectorId: "local-docs",
      message: \`No matching documents found under \${root}.\`,
      rawFiles,
      runId,
      statePath: STATE_PATH,
      status: "skipped",
      warnings,
    };
  }

  rawFiles.push(
    await writeRawJson("local-docs", runId, "local-docs.json", {
      documentCount: documents.length,
      documents,
      fetchedAt: new Date().toISOString(),
      instanceId: options.instanceId,
      root,
    }),
  );

  await writeConnectorState(
    "local-docs",
    updateStateWithRun(state, {
      at: new Date().toISOString(),
      rawFiles,
      runId,
      status: "success",
      warnings,
    }),
  );

  return {
    connectorId: "local-docs",
    message: \`Ingested \${documents.length} local document\${
      documents.length === 1 ? "" : "s"
    } from \${root}.\`,
    rawFiles,
    runId,
    statePath: STATE_PATH,
    status: "success",
    warnings,
  };
}

function normalizeExtensions(value: string[] | undefined): string[] {
  const extensions = (value ?? [".md", ".mdx", ".txt"])
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));

  return extensions.length > 0 ? extensions : [".md", ".mdx", ".txt"];
}

function normalizeMaxFiles(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 200;
  }

  return Math.max(1, Math.min(2000, Math.trunc(value)));
}
`;

/**
 * Full contents of the new `test/local-docs.test.ts`, modeled on
 * `test/hackernews.test.ts` (hermetic temp `HOME`, temp fixture tree). The
 * compile gate typechecks only `src/`, so this file is authored idiomatically but
 * not gate-verified, and the benchmark never runs the suite.
 */
const CONNECTOR_TEST = `import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLocalDocsConnector } from "../src/connectors/sources/local-docs.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  const home = await makeTempDir("openwiki-local-docs-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("local-docs connector", () => {
  test("exposes the expected connector definition", () => {
    const connector = createLocalDocsConnector();

    expect(connector.id).toBe("local-docs");
    expect(connector.displayName).toBe("Local Docs");
    expect(connector.backend).toBe("direct-api");
    expect(connector.mode).toBe("personal");
    expect(connector.requiredEnv).toEqual([]);
    expect(connector.supportsAgenticDiscovery).toBe(false);
  });

  test("skips when no root directory is configured", async () => {
    const result = await createLocalDocsConnector().ingest();

    expect(result.status).toBe("skipped");
    expect(result.connectorId).toBe("local-docs");
    expect(result.rawFiles).toEqual([]);
  });

  test("ingests matching documents from the configured root", async () => {
    const root = await makeTempDir("openwiki-local-docs-src-");
    await writeFile(path.join(root, "notes.md"), "# Notes Alpha", "utf8");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await writeFile(
      path.join(root, "nested", "spec.txt"),
      "Beta specification",
      "utf8",
    );
    await writeFile(path.join(root, "ignore.bin"), "binary", "utf8");

    const result = await createLocalDocsConnector().ingest({
      connectorConfig: { root },
    });

    expect(result.status).toBe("success");
    expect(result.rawFiles).toHaveLength(1);
    expect(result.message).toContain("Ingested 2 local documents");
  });
});
`;

/**
 * The exact `ConnectorId` union literal the connectors page prints today as
 * "ground truth for what exists today". A synchronized page inserts `local-docs`,
 * so the old eight-member string is gone.
 */
const STALE_UNION_LITERAL =
  '"git-repo" | "google" | "hackernews" | "langsmith" | "notion" | "slack" | "web-search" | "x"';

/**
 * Add the `local-docs` connector across the connector type surface, a new source
 * module, the registry, the per-connector synthesis switch, and a test.
 *
 * @param cwd - The throwaway checkout the mutation edits in place.
 */
async function applyMutation(cwd: string): Promise<void> {
  await editFile(cwd, "src/connectors/types.ts", (content) =>
    replaceOnce(content, UNION_MATCH, UNION_REPLACE),
  );

  await writeNewFile(
    cwd,
    "src/connectors/sources/local-docs.ts",
    CONNECTOR_SOURCE,
  );

  await editFile(cwd, "src/connectors/registry.ts", (content) => {
    let next = insertAfter(content, IMPORT_ANCHOR, IMPORT_INSERT);
    next = replaceOnce(next, IDS_MATCH, IDS_REPLACE);
    next = insertAfter(next, MAP_ANCHOR, MAP_INSERT);
    return next;
  });

  await editFile(cwd, "src/ingestion.ts", (content) =>
    replaceOnce(content, SYNTHESIS_ANCHOR, SYNTHESIS_REPLACE),
  );

  await writeNewFile(cwd, "test/local-docs.test.ts", CONNECTOR_TEST);
}

/**
 * Source evidence proving the connector now exists: the new module's definition,
 * its registration, and the union member. All three are small/near the top of
 * their files, so they land inside the judge's per-file source-evidence cap.
 */
const CONNECTOR_EVIDENCE = [
  {
    path: "src/connectors/sources/local-docs.ts",
    symbol: "createLocalDocsConnector",
    explanation:
      "The new connector module: definition id 'local-docs', displayName " +
      "'Local Docs', backend 'direct-api'. Its existence makes the connector " +
      "inventory nine.",
  },
  {
    path: "src/connectors/registry.ts",
    explanation:
      "CONNECTOR_IDS and the createConnectorRegistry() map now include " +
      "'local-docs', so it is a registered, recognized connector.",
  },
  {
    path: "src/connectors/types.ts",
    symbol: "ConnectorId",
    explanation:
      "The ConnectorId union now lists 'local-docs' alongside the original " +
      "eight ids.",
  },
] as const;

/** The add-local-docs-connector scenario. */
export const addLocalDocsConnectorScenario: EvalScenario = {
  id: "add-local-docs-connector",
  title: "Add a local-docs data-source connector",
  complexity: "large",
  description:
    "A feature addition of the shape OpenWiki documents as 'adding a connector': " +
    "a new 'local-docs' source connector that ingests Markdown and plain-text " +
    "documents from a configured local directory tree. It adds a member to the " +
    "ConnectorId union (src/connectors/types.ts), a new connector module " +
    "(src/connectors/sources/local-docs.ts), a registry import + CONNECTOR_IDS " +
    "entry + registry-map entry (src/connectors/registry.ts), a per-connector " +
    "synthesis-guidance case (src/ingestion.ts), and a test (test/local-docs.test.ts). " +
    "The registry map (Record<ConnectorId, ConnectorRuntime>) and the exhaustive " +
    "synthesis switch both force their edits at compile time. The connector is " +
    "registered and ingestable via config but not yet wired into interactive " +
    "onboarding, so the connector inventory is stale while onboarding-source " +
    "lists stay correct. OpenWiki now supports nine built-in connectors.",
  applyMutation,
  expectedAffectedPages: [
    {
      page: "openwiki/integrations/connectors.md",
      rationale:
        "The authoritative connectors reference: it states OpenWiki ships " +
        "'eight built-in connectors', prints the ConnectorId union as 'ground " +
        "truth for what exists today', and tabulates the connectors. Adding " +
        "local-docs makes the count nine, adds a union member, and adds a table " +
        "row.",
      requiredFacts: [
        {
          id: "names-local-docs",
          description:
            "The connector inventory now includes the new local-docs (Local " +
            "Docs) connector: a source connector that ingests Markdown and " +
            "plain-text documents from a configured local directory tree.",
          requirePresent: [CONNECTOR_ID],
        },
      ],
      forbiddenFacts: [
        {
          id: "stale-count",
          description:
            "The page must no longer say OpenWiki ships eight built-in " +
            "connectors; there are now nine.",
          requireAbsent: ["eight built-in connectors"],
        },
        {
          id: "stale-union",
          description:
            "The ConnectorId union must include local-docs, so the old " +
            "eight-member union literal is out of date.",
          requireAbsent: [STALE_UNION_LITERAL],
        },
      ],
      sourceEvidence: [...CONNECTOR_EVIDENCE],
    },
    {
      page: "openwiki/integrations/index.md",
      rationale:
        "The integrations index is a one-line mirror of the connectors page's " +
        "frontmatter: it says 'eight built-in connectors' and lists the sources " +
        "by display name. A synchronized index reflects nine connectors and " +
        "names Local Docs.",
      requiredFacts: [
        {
          id: "names-local-docs",
          description:
            "The connector list now names the new Local Docs connector among " +
            "the built-in sources.",
        },
      ],
      forbiddenFacts: [
        {
          id: "stale-count",
          description:
            "The mirror must no longer say eight built-in connectors; there " +
            "are now nine.",
          requireAbsent: ["eight built-in connectors"],
        },
      ],
      sourceEvidence: [CONNECTOR_EVIDENCE[0], CONNECTOR_EVIDENCE[1]],
    },
    {
      page: "openwiki/architecture/overview.md",
      rationale:
        "The architecture overview enumerates the bespoke connector source " +
        "modules under src/connectors/ as '(git-repo, gmail, hackernews, slack, " +
        "web-search, x)'. local-docs.ts is a new bespoke source module, so the " +
        "list is now incomplete.",
      requiredFacts: [
        {
          id: "module-listed",
          description:
            "The list of source-specific connector ingestion modules under " +
            "src/connectors/ now includes local-docs.",
          requirePresent: [CONNECTOR_ID],
        },
      ],
      forbiddenFacts: [
        {
          id: "stale-module-list",
          description:
            "The parenthesized list of source-specific ingestion modules must " +
            "now include local-docs, so the old six-item list is out of date.",
          requireAbsent: [
            "(git-repo, gmail, hackernews, slack, web-search, x)",
          ],
        },
      ],
      sourceEvidence: [CONNECTOR_EVIDENCE[0], CONNECTOR_EVIDENCE[1]],
    },
  ] satisfies PageExpectation[],
};
