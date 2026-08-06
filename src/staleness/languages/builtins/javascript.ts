/**
 * JavaScript language definition for source-grounded freshness.
 */

import {
  ancestorContainerNames,
  fieldText,
  joinQualified,
} from "../qualified-name.js";
import type { LanguageDefinition } from "../types.js";

/**
 * Ancestor node types that contribute a segment to a qualified name.
 */
const CONTAINER_TYPES = new Set(["class_declaration"]);

/**
 * Tags query for JavaScript. Unlike TypeScript there are no interface, type
 * alias, or enum declarations; class names are plain identifiers.
 */
const QUERY_SOURCE = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
`;

/**
 * JavaScript grammar (also parses JSX) wired to the shared tags-query consumer.
 */
export const javascriptLanguage: LanguageDefinition = {
  id: "javascript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  grammarWasmModule: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
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
