/**
 * Python language definition for source-grounded freshness.
 */

import { ancestorContainerNames, joinQualified } from "../qualified-name.js";
import type { LanguageDefinition } from "../types.js";

/**
 * Tags query for Python. Methods are `function_definition` nodes nested inside
 * a class body; the class prefix is recovered by {@link deriveQualifiedName}.
 */
const QUERY_SOURCE = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
`;

/**
 * Python grammar wired to the shared tags-query consumer.
 */
export const pythonLanguage: LanguageDefinition = {
  id: "python",
  extensions: [".py", ".pyi"],
  grammarWasmModule: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  querySource: QUERY_SOURCE,
  commentNodeTypes: new Set(["comment"]),

  deriveQualifiedName(definitionNode, nameNode) {
    const containers = ancestorContainerNames(definitionNode, (ancestor) =>
      ancestor.type === "class_definition"
        ? (ancestor.childForFieldName("name")?.text ?? undefined)
        : undefined,
    );

    return joinQualified(containers, nameNode.text);
  },
};
