/**
 * Language registry for source-grounded freshness.
 *
 * The registry owns the single generic tags-query consumer described in
 * {@link ./types.ts}: it resolves and loads grammar wasm, compiles each
 * language's tags query once, caches the result, and turns query matches into
 * {@link DefinitionCapture} records. Adding a language is a matter of
 * registering another {@link LanguageDefinition}, not writing another walker.
 */

import { createRequire } from "node:module";

import { Language, Parser, Query } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";

import type { SourceDependencyKind } from "../storage.js";
import { goLanguage } from "./builtins/go.js";
import { javascriptLanguage } from "./builtins/javascript.js";
import { pythonLanguage } from "./builtins/python.js";
import { typescriptLanguage } from "./builtins/typescript.js";
import type { DefinitionCapture, LanguageDefinition } from "./types.js";

/**
 * Resolves package-relative wasm paths against this module's dependencies,
 * independent of the process working directory.
 */
const requireFromHere = createRequire(import.meta.url);

/**
 * Definition kinds understood by the storage layer, used to reject stray
 * `@definition.*` capture suffixes.
 */
const KNOWN_KINDS: ReadonlySet<SourceDependencyKind> =
  new Set<SourceDependencyKind>([
    "class",
    "function",
    "interface",
    "method",
    "module",
    "type",
    "variable",
    "file",
  ]);

/**
 * Prefix marking a tags-query capture as a definition, for example
 * `@definition.method`.
 */
const DEFINITION_CAPTURE_PREFIX = "definition.";

/**
 * A grammar that has been loaded and had its tags query compiled.
 */
export interface LoadedLanguage {
  /**
   * The definition this loaded grammar came from.
   */
  definition: LanguageDefinition;

  /**
   * Parser configured with the loaded grammar.
   */
  parser: Parser;

  /**
   * Compiled tags query for the grammar.
   */
  query: Query;
}

/**
 * Map a `@definition.<kind>` capture name onto a storage kind, or `undefined`
 * when the suffix is not a recognized kind.
 *
 * @param captureName - Full capture name, for example `definition.method`.
 */
function kindFromCaptureName(
  captureName: string,
): SourceDependencyKind | undefined {
  const suffix = captureName.slice(DEFINITION_CAPTURE_PREFIX.length);
  return KNOWN_KINDS.has(suffix as SourceDependencyKind)
    ? (suffix as SourceDependencyKind)
    : undefined;
}

/**
 * A set of languages keyed by file extension, with lazy grammar loading.
 */
export class LanguageRegistry {
  /**
   * File extension (lowercased, dot-prefixed) to its language definition.
   */
  private readonly byExtension = new Map<string, LanguageDefinition>();

  /**
   * Language id to its in-flight or resolved load. Rejected loads are evicted
   * so a later call can retry.
   */
  private readonly loaded = new Map<string, Promise<LoadedLanguage>>();

  /**
   * Shared one-time WebAssembly runtime initialization.
   */
  private parserInit: Promise<void> | undefined;

  /**
   * @param definitions - Languages to register. Extensions must be unique.
   */
  constructor(definitions: readonly LanguageDefinition[]) {
    for (const definition of definitions) {
      for (const extension of definition.extensions) {
        const normalized = extension.toLowerCase();
        const existing = this.byExtension.get(normalized);
        if (existing && existing.id !== definition.id) {
          throw new Error(
            `Extension ${normalized} is claimed by both ${existing.id} and ${definition.id}`,
          );
        }
        this.byExtension.set(normalized, definition);
      }
    }
  }

  /**
   * The language definition registered for a file extension, if any.
   *
   * @param extension - File extension including the leading dot.
   */
  definitionForExtension(extension: string): LanguageDefinition | undefined {
    return this.byExtension.get(extension.toLowerCase());
  }

  /**
   * True when some registered language claims this file extension.
   *
   * @param extension - File extension including the leading dot.
   */
  supportsExtension(extension: string): boolean {
    return this.byExtension.has(extension.toLowerCase());
  }

  /**
   * Load and cache the grammar for a file extension, or return `undefined` when
   * no language claims it. A failed load is not cached.
   *
   * @param extension - File extension including the leading dot.
   */
  async loadForExtension(
    extension: string,
  ): Promise<LoadedLanguage | undefined> {
    const definition = this.definitionForExtension(extension);
    if (!definition) {
      return undefined;
    }

    return this.loadDefinition(definition);
  }

  /**
   * Load and cache a specific language definition.
   *
   * @param definition - The language to load.
   */
  private loadDefinition(
    definition: LanguageDefinition,
  ): Promise<LoadedLanguage> {
    const cached = this.loaded.get(definition.id);
    if (cached) {
      return cached;
    }

    const pending = this.instantiate(definition).catch((error: unknown) => {
      this.loaded.delete(definition.id);
      throw error;
    });
    this.loaded.set(definition.id, pending);
    return pending;
  }

  /**
   * Perform the actual grammar load and query compilation.
   *
   * @param definition - The language to instantiate.
   */
  private async instantiate(
    definition: LanguageDefinition,
  ): Promise<LoadedLanguage> {
    await this.ensureParserInit();

    const grammarPath = requireFromHere.resolve(definition.grammarWasmModule);
    const language = await Language.load(grammarPath);
    const parser = new Parser();
    parser.setLanguage(language);
    const query = new Query(language, definition.querySource);

    return { definition, parser, query };
  }

  /**
   * Initialize the WebAssembly runtime exactly once.
   */
  private ensureParserInit(): Promise<void> {
    if (!this.parserInit) {
      this.parserInit = Parser.init();
    }

    return this.parserInit;
  }
}

/**
 * Run a loaded language's tags query over a parsed tree and return one record
 * per definition, pairing each `@definition.*` capture with its `@name`.
 *
 * @param loaded - A loaded grammar and its compiled query.
 *
 * @param root - Root node of the parsed source file.
 */
export function captureDefinitions(
  loaded: LoadedLanguage,
  root: Node,
): DefinitionCapture[] {
  const results: DefinitionCapture[] = [];

  for (const match of loaded.query.matches(root)) {
    let definitionNode: Node | undefined;
    let definitionCaptureName: string | undefined;
    let nameNode: Node | undefined;

    for (const capture of match.captures) {
      if (capture.name.startsWith(DEFINITION_CAPTURE_PREFIX)) {
        definitionNode = capture.node;
        definitionCaptureName = capture.name;
      } else if (capture.name === "name") {
        nameNode = capture.node;
      }
    }

    if (!definitionNode || !definitionCaptureName || !nameNode) {
      continue;
    }

    const kind = kindFromCaptureName(definitionCaptureName);
    if (!kind) {
      continue;
    }

    results.push({
      kind,
      name: nameNode.text,
      qualifiedName: loaded.definition.deriveQualifiedName(
        definitionNode,
        nameNode,
      ),
      node: definitionNode,
    });
  }

  return results;
}

/**
 * Build a registry populated with the built-in languages (TypeScript,
 * JavaScript, Python, and Go).
 */
export function createDefaultRegistry(): LanguageRegistry {
  return new LanguageRegistry([
    typescriptLanguage,
    javascriptLanguage,
    pythonLanguage,
    goLanguage,
  ]);
}
