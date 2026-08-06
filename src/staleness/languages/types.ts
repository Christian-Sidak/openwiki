/**
 * Language-plugin contract for source-grounded freshness.
 *
 * Each supported language contributes a {@link LanguageDefinition}. The guide
 * describes a per-language `loadLanguage()` plus `captureDefinitions()` pair,
 * but every grammar's definition extraction reduces to the same shape: run a
 * tree-sitter tags query, read the `@definition.*` and `@name` captures, and
 * derive a qualified name from the surrounding syntax. So the definitions here
 * only supply the language-specific data (grammar wasm, query source, comment
 * node types, qualified-name derivation) and the registry owns the single
 * generic tags-query consumer. This keeps grammar onboarding to "add a
 * definition object" rather than "write another capture walker".
 */

import type { Node } from "web-tree-sitter";

import type { SourceDependencyKind } from "../storage.js";

/**
 * One definition extracted from a parsed source file.
 */
export interface DefinitionCapture {
  /**
   * The kind of definition, mapped onto the storage vocabulary.
   */
  kind: SourceDependencyKind;

  /**
   * The bare identifier as written, for example `authenticate`.
   */
  name: string;

  /**
   * The fully qualified name including enclosing scopes, for example
   * `AuthService.authenticate`. Falls back to {@link name} when the definition
   * has no enclosing container.
   */
  qualifiedName: string;

  /**
   * Root node of the definition subtree, used for canonical fingerprinting.
   */
  node: Node;
}

/**
 * Everything the registry needs to load a grammar and extract its definitions.
 */
export interface LanguageDefinition {
  /**
   * Stable identifier for the language, for example `typescript`. Used as the
   * cache key for the loaded grammar and its compiled query.
   */
  id: string;

  /**
   * File extensions (including the leading dot, lowercased) that this language
   * claims. Extensions must be unique across the registry.
   */
  extensions: readonly string[];

  /**
   * Node-resolvable specifier for the grammar wasm, for example
   * `tree-sitter-wasms/out/tree-sitter-typescript.wasm`. Resolved against this
   * package's dependencies at load time.
   */
  grammarWasmModule: string;

  /**
   * Tree-sitter query source in tags style. Definitions must be captured as
   * `@definition.<kind>` with the identifier captured as `@name`.
   */
  querySource: string;

  /**
   * Node types treated as comments and skipped during canonicalization, so
   * comment-only edits stay fresh.
   */
  commentNodeTypes: ReadonlySet<string>;

  /**
   * Derive the qualified name for a captured definition from its subtree and
   * its identifier node, for example prefixing an enclosing class name or a Go
   * method's receiver type.
   *
   * @param definitionNode - Root of the captured definition subtree.
   *
   * @param nameNode - The `@name` identifier node.
   */
  deriveQualifiedName(definitionNode: Node, nameNode: Node): string;
}
