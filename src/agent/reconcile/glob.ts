/**
 * Compiles one manifest source pattern to a RegExp over repo-relative,
 * forward-slash paths. Supported syntax, in order of application:
 *   "**"  any number of path segments, including none
 *   "*"   any characters within one segment
 *   "?"   one character within one segment
 * Everything else is literal. This is the whole grammar; plans that need more
 * should list more patterns.
 */
export function compileGlob(pattern: string): RegExp {
  // Sentinels standing in for glob metacharacters while literal regex
  // characters are escaped, then expanded to regex fragments below. Written as
  // unicode escapes for legibility; each is a control/replacement code point
  // that cannot appear in a repo-relative path, so it can never collide with
  // literal input.
  const DOUBLE = "\uFFFD";
  const SINGLE = "\u0001";
  const QMARK = "\u0002";

  const tokenized = pattern
    .replaceAll("**", DOUBLE)
    .replaceAll("*", SINGLE)
    .replaceAll("?", QMARK);
  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    // "a/**/b" and "**/b": swallow whole segments plus their slash.
    .replaceAll(`${DOUBLE}/`, "(?:[^/]+/)*")
    // trailing "a/**": the directory's entire subtree.
    .replaceAll(`/${DOUBLE}`, "(?:/.*)?")
    // bare "**": anything.
    .replaceAll(DOUBLE, ".*")
    .replaceAll(SINGLE, "[^/]*")
    .replaceAll(QMARK, "[^/]");

  return new RegExp(`^${source}$`);
}

/**
 * True when the path matches at least one pattern.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => compileGlob(pattern).test(path));
}

/**
 * The subset of paths matching at least one pattern.
 */
export function filterMatching(paths: string[], patterns: string[]): string[] {
  const compiled = patterns.map(compileGlob);
  return paths.filter((path) => compiled.some((regex) => regex.test(path)));
}
