/**
 * Agent tool for recording a wiki page's source dependencies.
 *
 * After the agent writes or updates a source-grounded page, it calls
 * `record_source_dependencies` with the source files and symbols the page is
 * grounded in. The tool resolves each one to a fingerprint and persists a
 * sidecar next to the page, which the freshness preflight later reads to decide
 * whether the page has drifted. Symbols that cannot be resolved degrade to
 * whole-file tracking and are reported back so the agent can correct a bad
 * reference.
 */

import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isFileNotFoundError } from "../fs-errors.js";
import { FileSystemSourceReader } from "./freshness.js";
import { createDefaultRegistry } from "./languages/registry.js";
import {
  recordSourceDependencies,
  type RequestedDependency,
} from "./recorder.js";
import { SourceResolver } from "./resolver.js";
import {
  isSourceGroundedPage,
  normalizeRepoRelativePath,
  writeSidecarAtomic,
} from "./storage.js";

/**
 * Raw JSON Schema for the tool input, following the repository's tool
 * convention of hand-written schemas passed straight to
 * {@link DynamicStructuredTool}.
 */
const RECORD_TOOL_SCHEMA = {
  type: "object",
  properties: {
    page: {
      type: "string",
      description:
        "Repository-relative path to the wiki page, for example openwiki/architecture/auth.md.",
    },
    dependencies: {
      type: "array",
      description:
        "Source definitions this page is grounded in. Prefer a specific symbol; omit it to track the whole file.",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Repository-relative path to the source file, for example src/auth.ts.",
          },
          symbol: {
            type: "string",
            description:
              "Optional qualified symbol name, for example AuthService.authenticate or Store.Create.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  required: ["page", "dependencies"],
  additionalProperties: false,
} as const;

/**
 * Narrow an untrusted tool input into a page path and a list of requested
 * dependencies, throwing a descriptive error on malformed input.
 *
 * @param input - The raw tool input.
 */
function parseToolInput(input: unknown): {
  page: string;
  requests: RequestedDependency[];
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("input must be an object");
  }

  const candidate = input as {
    page?: unknown;
    dependencies?: unknown;
  };

  if (typeof candidate.page !== "string" || candidate.page.length === 0) {
    throw new Error("page must be a non-empty string");
  }

  if (!Array.isArray(candidate.dependencies)) {
    throw new Error("dependencies must be an array");
  }

  const requests: RequestedDependency[] = candidate.dependencies.map(
    (entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`dependencies[${index}] must be an object`);
      }

      const dependency = entry as { path?: unknown; symbol?: unknown };
      if (typeof dependency.path !== "string" || dependency.path.length === 0) {
        throw new Error(
          `dependencies[${index}].path must be a non-empty string`,
        );
      }

      return {
        path: dependency.path,
        symbol:
          typeof dependency.symbol === "string" && dependency.symbol.length > 0
            ? dependency.symbol
            : undefined,
      };
    },
  );

  return { page: candidate.page, requests };
}

/**
 * Build the source-grounding tools for a repository-mode run rooted at `cwd`.
 *
 * @param cwd - Repository root the wiki and its sources live in.
 */
export function createSourceGroundingTools(
  cwd: string,
): StructuredToolInterface[] {
  const resolver = new SourceResolver(createDefaultRegistry());
  const reader = new FileSystemSourceReader(cwd);

  return [
    new DynamicStructuredTool({
      name: "record_source_dependencies",
      description:
        "Record the source files and symbols a wiki page is grounded in so future updates can detect when the page has drifted from the code. Call this after writing or updating a source-grounded page.",
      schema: RECORD_TOOL_SCHEMA,
      func: async (input) => {
        const { page, requests } = parseToolInput(input);

        const normalizedPage = normalizeRepoRelativePath(page);
        if (!isSourceGroundedPage(normalizedPage)) {
          return JSON.stringify(
            {
              ok: false,
              error: `page is not a source-grounded wiki page: ${page}`,
            },
            null,
            2,
          );
        }

        let pageBytes: string;
        try {
          pageBytes = await readFile(join(cwd, normalizedPage), "utf8");
        } catch (error) {
          if (isFileNotFoundError(error)) {
            return JSON.stringify(
              { ok: false, error: `page does not exist: ${page}` },
              null,
              2,
            );
          }
          throw error;
        }

        const { sidecar, warnings } = await recordSourceDependencies({
          page: normalizedPage,
          pageBytes,
          requests,
          resolver,
          reader,
        });

        await writeSidecarAtomic(cwd, sidecar);

        return JSON.stringify(
          {
            ok: true,
            page: normalizedPage,
            recorded: sidecar.sources.length,
            warnings,
          },
          null,
          2,
        );
      },
    }),
  ];
}
