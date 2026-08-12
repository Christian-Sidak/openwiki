import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../core/errors.js";

/**
 * Source fragment and stable syntax representation returned by a language adapter.
 */
export interface SymbolResolution {
  /**
   * Exact source text owned by the resolved declaration.
   */
  content: string;

  /**
   * Whitespace-insensitive syntax serialization used for version hashing.
   */
  normalized: string;
}

/**
 * Resolution result supported by native and future asynchronous adapters.
 */
export type LanguageEvidenceResolution =
  SymbolResolution | null | Promise<SymbolResolution | null>;

/**
 * Language-specific symbol resolver used behind repository evidence.
 */
export interface LanguageEvidenceAdapter {
  /**
   * Stable adapter and normalization algorithm identifier.
   */
  id: string;

  /**
   * Lowercase source extensions handled by the adapter.
   */
  extensions: readonly string[];

  /**
   * Resolves one unique logical declaration.
   *
   * @param input - Source path, content, and requested symbol.
   * @returns Resolved declaration, or `null` when missing or ambiguous.
   */
  resolveSymbol(input: {
    /**
     * Repository-relative source path.
     */
    path: string;

    /**
     * Complete current source text.
     */
    source: string;

    /**
     * Simple or dotted logical symbol name.
     */
    symbol: string;
  }): LanguageEvidenceResolution;
}

/**
 * Declaration node types that can establish a stable logical source identity.
 */
const DECLARATION_NAME_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  [
    ["abstract_class_declaration", ["name"]],
    ["abstract_method_signature", ["name"]],
    ["class_declaration", ["name"]],
    ["enum_declaration", ["name"]],
    ["field_definition", ["property"]],
    ["function_declaration", ["name"]],
    ["function_signature", ["name"]],
    ["generator_function_declaration", ["name"]],
    ["interface_declaration", ["name"]],
    ["internal_module", ["name"]],
    ["method_definition", ["name"]],
    ["method_signature", ["name"]],
    ["property_signature", ["name"]],
    ["public_field_definition", ["name"]],
    ["type_alias_declaration", ["name"]],
    ["variable_declarator", ["name"]],
  ],
);

/**
 * Tree-sitter adapter for one grammar and extension family.
 */
export class TreeSitterLanguageAdapter implements LanguageEvidenceAdapter {
  /**
   * Stable adapter and normalization identifier.
   */
  readonly id: string;

  /**
   * Lowercase source extensions supported by this adapter.
   */
  readonly extensions: readonly string[];

  /**
   * Initialized Tree-sitter parser.
   */
  private readonly parser: Parser;

  constructor(options: {
    /**
     * Stable adapter identifier included in persisted evidence versions.
     */
    id: string;

    /**
     * Lowercase source extensions supported by the grammar.
     */
    extensions: readonly string[];

    /**
     * Native Tree-sitter language object.
     */
    language: NonNullable<Parameters<Parser["setLanguage"]>[0]>;
  }) {
    const id = options.id.trim();
    if (!id) {
      throw new EvidenceResourceError("Language adapter id cannot be empty.");
    }
    if (options.extensions.length === 0) {
      throw new EvidenceResourceError(
        `Language adapter ${id} must register at least one extension.`,
      );
    }

    const extensions = options.extensions.map((extension) =>
      normalizeExtension(extension, id),
    );
    if (new Set(extensions).size !== extensions.length) {
      throw new EvidenceResourceError(
        `Language adapter ${id} cannot register duplicate extensions.`,
      );
    }

    this.id = id;
    this.extensions = extensions;
    try {
      this.parser = new Parser();
      this.parser.setLanguage(options.language);
    } catch (error) {
      throw new EvidenceResolutionError(
        `Unable to initialize Tree-sitter adapter ${id}: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Resolves a unique simple or dotted declaration name.
   *
   * @param input - Source path, content, and requested symbol.
   * @returns Resolved source and syntax serialization, or `null`.
   */
  resolveSymbol(input: {
    /**
     * Repository-relative source path.
     */
    path: string;

    /**
     * Complete source text.
     */
    source: string;

    /**
     * Simple or dotted logical symbol name.
     */
    symbol: string;
  }): SymbolResolution | null {
    let tree: Parser.Tree;
    try {
      tree = this.parser.parse(input.source);
    } catch (error) {
      throw new EvidenceResolutionError(
        `Tree-sitter failed to parse ${input.path}: ${toErrorMessage(error)}`,
      );
    }

    if (tree.rootNode.hasError) {
      throw new EvidenceResolutionError(
        `Tree-sitter produced a syntax error for ${input.path}`,
      );
    }

    const candidates = collectDeclarations(tree.rootNode, input.source);
    const exact = candidates.filter(
      (candidate) => candidate.qualifiedName === input.symbol,
    );
    const matches =
      exact.length > 0
        ? exact
        : candidates.filter((candidate) => candidate.name === input.symbol);

    if (matches.length !== 1) {
      return null;
    }

    const [match] = matches;
    return {
      content: input.source.slice(match.node.startIndex, match.node.endIndex),
      normalized: serializeSyntax(match.node, input.source),
    };
  }
}

/**
 * Internal logical declaration candidate.
 */
interface DeclarationCandidate {
  /**
   * Simple declaration name.
   */
  name: string;

  /**
   * Ancestor-qualified declaration name.
   */
  qualifiedName: string;

  /**
   * Syntax node whose complete contents establish the evidence.
   */
  node: Parser.SyntaxNode;
}

/**
 * Collects declaration candidates and dotted ancestor names.
 *
 * @param root - Parsed syntax-tree root.
 * @param source - Complete source text.
 * @returns Stable source-order declaration candidates.
 */
function collectDeclarations(
  root: Parser.SyntaxNode,
  source: string,
): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];

  /**
   * Visits one syntax node and its declaration ancestry.
   *
   * @param node - Current syntax node.
   * @param ancestors - Logical containing declarations.
   */
  function visit(node: Parser.SyntaxNode, ancestors: readonly string[]): void {
    const nameNode = findDeclarationName(node);
    const name = nameNode
      ? source.slice(nameNode.startIndex, nameNode.endIndex)
      : undefined;
    const nextAncestors = name ? [...ancestors, name] : ancestors;

    if (name) {
      candidates.push({
        name,
        qualifiedName: nextAncestors.join("."),
        node,
      });
    }

    for (const child of node.namedChildren) {
      visit(child, nextAncestors);
    }
  }

  visit(root, []);
  return candidates;
}

/**
 * Returns the logical name node for a supported declaration.
 *
 * @param node - Candidate syntax node.
 * @returns Declaration name node, or `null` for non-declarations.
 */
function findDeclarationName(
  node: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  const fields = DECLARATION_NAME_FIELDS.get(node.type);
  if (!fields) {
    return null;
  }
  for (const field of fields) {
    const nameNode = node.childForFieldName(field);
    if (nameNode) {
      return nameNode;
    }
  }
  return null;
}

/**
 * Serializes syntax without whitespace trivia while retaining structure and tokens.
 *
 * @param node - Syntax node to serialize.
 * @param source - Complete source text used for leaf values.
 * @returns Stable structural representation.
 */
function serializeSyntax(node: Parser.SyntaxNode, source: string): string {
  if (node.childCount === 0) {
    return `${node.type}:${JSON.stringify(
      source.slice(node.startIndex, node.endIndex),
    )}`;
  }

  return `(${node.type}${node.children
    .map((child) => ` ${serializeSyntax(child, source)}`)
    .join("")})`;
}

/**
 * Converts an unknown thrown value into safe diagnostic text.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable message without inspecting external state.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Canonicalizes and validates one adapter extension.
 *
 * @param extension - Configured source extension.
 * @param adapterId - Owning adapter identifier for diagnostics.
 * @returns Lowercase dot-prefixed extension.
 */
function normalizeExtension(extension: string, adapterId: string): string {
  const normalized = extension.trim().toLowerCase();
  if (!/^\.[a-z0-9]+$/u.test(normalized)) {
    throw new EvidenceResourceError(
      `Language adapter ${adapterId} has invalid extension: ${extension}`,
    );
  }
  return normalized;
}

/**
 * Creates the built-in JavaScript and TypeScript evidence adapters.
 *
 * @returns Adapter list used by the repository resolver.
 */
export function createBuiltInLanguageEvidenceAdapters(): LanguageEvidenceAdapter[] {
  return [
    new TreeSitterLanguageAdapter({
      id: "javascript-v1",
      extensions: [".js", ".jsx", ".mjs", ".cjs"],
      language: JavaScript,
    }),
    new TreeSitterLanguageAdapter({
      id: "typescript-v1",
      extensions: [".ts", ".mts", ".cts"],
      language: TypeScriptLanguages.typescript,
    }),
    new TreeSitterLanguageAdapter({
      id: "tsx-v1",
      extensions: [".tsx"],
      language: TypeScriptLanguages.tsx,
    }),
  ];
}
