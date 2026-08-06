/**
 * Small syntax-tree helpers shared by the built-in languages when deriving
 * qualified names (for example prefixing a method with its enclosing class).
 */

import type { Node } from "web-tree-sitter";

/**
 * Text of the node's field-named child, if that field is present.
 *
 * @param node - Node whose child to read.
 *
 * @param fieldName - Grammar field name, for example `name`.
 */
export function fieldText(node: Node, fieldName: string): string | undefined {
  return node.childForFieldName(fieldName)?.text ?? undefined;
}

/**
 * Walk the ancestors of `node` (nearest first), map each to an optional
 * container name, and return the collected names ordered outermost-first so
 * they can be joined into a qualified path.
 *
 * @param node - Node whose ancestors to inspect.
 *
 * @param containerName - Maps an ancestor to its contributed name, or
 * `undefined` when the ancestor is not a naming scope.
 */
export function ancestorContainerNames(
  node: Node,
  containerName: (ancestor: Node) => string | undefined,
): string[] {
  const names: string[] = [];

  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const name = containerName(ancestor);
    if (name !== undefined) {
      names.unshift(name);
    }
  }

  return names;
}

/**
 * Join enclosing container names and a leaf identifier into a dotted qualified
 * name, for example `["AuthService"]` + `authenticate` becomes
 * `AuthService.authenticate`.
 *
 * @param containers - Enclosing scope names, outermost-first.
 *
 * @param leaf - The bare identifier being qualified.
 */
export function joinQualified(containers: string[], leaf: string): string {
  return [...containers, leaf].join(".");
}
