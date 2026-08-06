/**
 * Source resolution and canonical fingerprinting for source-grounded freshness.
 *
 * This module turns a source file's bytes into the fingerprints the freshness
 * evaluator compares against a page's stored sidecar:
 *
 * - A cheap whole-file `file-bytes-v1` fingerprint, used as a fast path: if the
 *   file bytes are unchanged, every symbol in it is fresh with no parsing.
 * - A precise `tree-sitter-v1` fingerprint per definition, computed from a
 *   canonicalized syntax subtree. Canonicalization walks the AST recording node
 *   types, structure, and leaf text while skipping comments, so reformatting or
 *   comment edits keep a definition fresh but any semantic change makes it
 *   stale.
 */

import { extname } from "node:path";

import type { Node, Tree } from "web-tree-sitter";

import {
  captureDefinitions,
  type LanguageRegistry,
} from "./languages/registry.js";
import type { DefinitionCapture } from "./languages/types.js";
import {
  fingerprintDefinition,
  fingerprintFileBytes,
  type PersistedFingerprint,
} from "./storage.js";

/**
 * A parsed source file together with everything needed to fingerprint its
 * definitions. Always returned (never throws for an unsupported language), so
 * callers can distinguish "no grammar" from "symbol missing".
 */
export interface ParsedSourceFile {
  /**
   * Repository-relative POSIX path the file was resolved from.
   */
  path: string;

  /**
   * Lowercased file extension including the leading dot.
   */
  extension: string;

  /**
   * Whole-file fingerprint used as the freshness fast path.
   */
  fileBytes: PersistedFingerprint;

  /**
   * True when a grammar is registered for this file's extension.
   */
  supported: boolean;

  /**
   * True when parsing produced a usable tree and definitions were indexed. This
   * is `false` when the language is unsupported or the grammar failed to load.
   */
  parsed: boolean;

  /**
   * Definitions indexed by qualified name; the first occurrence wins when a
   * name is defined more than once (for example an overload set).
   */
  definitions: Map<string, DefinitionCapture>;

  /**
   * Comment node types skipped during canonicalization. Empty when the file's
   * language is unsupported.
   */
  commentNodeTypes: ReadonlySet<string>;
}

/**
 * Canonicalize a definition subtree into a deterministic string that ignores
 * comments and whitespace but preserves node structure, identifiers, and
 * literal text.
 *
 * Each node contributes a named/anonymous marker plus its type (length-prefixed
 * so a type name can never be confused with adjacent leaf text), and leaf nodes
 * additionally contribute their source text. Two subtrees hash equal exactly
 * when they are semantically identical up to formatting and comments.
 *
 * @param node - Root of the definition subtree.
 *
 * @param commentNodeTypes - Node types treated as comments and skipped.
 */
export function canonicalizeDefinition(
  node: Node,
  commentNodeTypes: ReadonlySet<string>,
): string {
  const parts: string[] = [];

  const visit = (current: Node): void => {
    if (commentNodeTypes.has(current.type)) {
      return;
    }

    parts.push(
      current.isNamed ? "N" : "T",
      String(current.type.length),
      current.type,
    );

    if (current.childCount === 0) {
      parts.push(String(current.text.length), current.text);
    }

    for (const child of current.children) {
      if (child) {
        visit(child);
      }
    }
  };

  visit(node);
  return parts.join("");
}

/**
 * Compute the `tree-sitter-v1` fingerprint for one captured definition.
 *
 * @param parsed - The parsed file the definition came from.
 *
 * @param capture - The definition to fingerprint.
 */
export function fingerprintCapture(
  parsed: ParsedSourceFile,
  capture: DefinitionCapture,
): PersistedFingerprint {
  return fingerprintDefinition(
    canonicalizeDefinition(capture.node, parsed.commentNodeTypes),
  );
}

/**
 * Look up a symbol by qualified name and compute its definition fingerprint, or
 * return `undefined` when the symbol is not present in the file.
 *
 * @param parsed - The parsed file to search.
 *
 * @param qualifiedName - Qualified symbol name, for example
 * `AuthService.authenticate`.
 */
export function fingerprintForSymbol(
  parsed: ParsedSourceFile,
  qualifiedName: string,
):
  | { capture: DefinitionCapture; fingerprint: PersistedFingerprint }
  | undefined {
  const capture = parsed.definitions.get(qualifiedName);
  if (!capture) {
    return undefined;
  }

  return { capture, fingerprint: fingerprintCapture(parsed, capture) };
}

/**
 * Parses source files and indexes their definitions using a language registry.
 *
 * The resolver is stateless beyond the registry's grammar cache, so a single
 * instance can be reused across a whole freshness run.
 */
export class SourceResolver {
  /**
   * @param registry - Language registry used to load grammars and queries.
   */
  constructor(private readonly registry: LanguageRegistry) {}

  /**
   * Parse a source file's bytes and index its definitions by qualified name.
   *
   * Never throws for an unsupported language or a grammar-load failure: the
   * returned {@link ParsedSourceFile} reports `supported`/`parsed` so callers
   * can map those cases onto the `unverified` freshness state.
   *
   * @param path - Repository-relative POSIX path (used only for its extension
   * and for reporting).
   *
   * @param bytes - The file's current bytes.
   */
  async parseFile(path: string, bytes: string): Promise<ParsedSourceFile> {
    const extension = extname(path).toLowerCase();
    const fileBytes = fingerprintFileBytes(bytes);

    if (!this.registry.supportsExtension(extension)) {
      return {
        path,
        extension,
        fileBytes,
        supported: false,
        parsed: false,
        definitions: new Map(),
        commentNodeTypes: new Set(),
      };
    }

    const definitions = new Map<string, DefinitionCapture>();

    let loaded;
    try {
      loaded = await this.registry.loadForExtension(extension);
    } catch {
      loaded = undefined;
    }

    if (!loaded) {
      return {
        path,
        extension,
        fileBytes,
        supported: true,
        parsed: false,
        definitions,
        commentNodeTypes: new Set(),
      };
    }

    let tree: Tree | null;
    try {
      tree = loaded.parser.parse(bytes);
    } catch {
      tree = null;
    }

    if (!tree) {
      return {
        path,
        extension,
        fileBytes,
        supported: true,
        parsed: false,
        definitions,
        commentNodeTypes: loaded.definition.commentNodeTypes,
      };
    }

    for (const capture of captureDefinitions(loaded, tree.rootNode)) {
      if (!definitions.has(capture.qualifiedName)) {
        definitions.set(capture.qualifiedName, capture);
      }
    }

    return {
      path,
      extension,
      fileBytes,
      supported: true,
      parsed: true,
      definitions,
      commentNodeTypes: loaded.definition.commentNodeTypes,
    };
  }
}
