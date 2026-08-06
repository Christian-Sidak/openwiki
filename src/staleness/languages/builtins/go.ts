/**
 * Go language definition for source-grounded freshness.
 */

import type { Node } from "web-tree-sitter";

import { joinQualified } from "../qualified-name.js";
import type { LanguageDefinition } from "../types.js";

/**
 * Tags query for Go. Methods are qualified by their receiver type so that, for
 * example, `func (s *Store) Create()` resolves to `Store.Create`.
 */
const QUERY_SOURCE = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name)) @definition.type
`;

/**
 * Recover the receiver type name from a `method_declaration` node, ignoring the
 * pointer marker so both `(s Store)` and `(s *Store)` yield `Store`.
 *
 * @param methodNode - The `method_declaration` node.
 */
function receiverTypeName(methodNode: Node): string | undefined {
  const receiver = methodNode.childForFieldName("receiver");
  if (!receiver) {
    return undefined;
  }

  const [typeIdentifier] = receiver.descendantsOfType("type_identifier");
  return typeIdentifier?.text ?? undefined;
}

/**
 * Go grammar wired to the shared tags-query consumer.
 */
export const goLanguage: LanguageDefinition = {
  id: "go",
  extensions: [".go"],
  grammarWasmModule: "tree-sitter-wasms/out/tree-sitter-go.wasm",
  querySource: QUERY_SOURCE,
  commentNodeTypes: new Set(["comment"]),

  deriveQualifiedName(definitionNode, nameNode) {
    if (definitionNode.type === "method_declaration") {
      const receiver = receiverTypeName(definitionNode);
      if (receiver !== undefined) {
        return joinQualified([receiver], nameNode.text);
      }
    }

    return nameNode.text;
  },
};
