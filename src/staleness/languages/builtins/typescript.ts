/**
 * TypeScript language definition for source-grounded freshness.
 */

import {
  ancestorContainerNames,
  fieldText,
  joinQualified,
} from "../qualified-name.js";
import type { LanguageDefinition } from "../types.js";

/**
 * Ancestor node types that contribute a segment to a qualified name (classes,
 * interfaces, and namespaces).
 */
const CONTAINER_TYPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "internal_module",
  "module",
]);

/**
 * Tags query capturing the top-level and nested definitions a wiki page is
 * likely to reference. Const-bound arrow and function expressions are treated
 * as functions, matching how they read in documentation.
 */
const QUERY_SOURCE = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.type
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
`;

/**
 * TypeScript grammar wired to the shared tags-query consumer.
 */
export const typescriptLanguage: LanguageDefinition = {
  id: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  grammarWasmModule: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  querySource: QUERY_SOURCE,
  commentNodeTypes: new Set(["comment"]),

  deriveQualifiedName(definitionNode, nameNode) {
    const containers = ancestorContainerNames(definitionNode, (ancestor) =>
      CONTAINER_TYPES.has(ancestor.type)
        ? fieldText(ancestor, "name")
        : undefined,
    );

    return joinQualified(containers, nameNode.text);
  },
};
