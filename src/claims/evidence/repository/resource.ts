import path from "node:path";
import { EvidenceResourceError } from "../../core/errors.js";

/**
 * Repository evidence URI prefix.
 */
export const REPOSITORY_EVIDENCE_PREFIX = "repo://";

/**
 * Parsed repository evidence identity.
 */
export interface RepositoryEvidenceResource {
  /**
   * Normalized repository-relative POSIX path.
   */
  path: string;

  /**
   * Optional logical symbol requested inside the source file.
   *
   * @default undefined, which selects whole-file evidence.
   */
  symbol?: string;
}

/**
 * Formats a validated repository evidence identity canonically.
 *
 * @param resource - Normalized repository path and optional symbol.
 * @returns Canonical `repo://path#symbol` resource.
 */
export function formatRepositoryEvidenceResource(
  resource: RepositoryEvidenceResource,
): string {
  let encodedPath: string;
  let encodedSymbol: string | undefined;
  try {
    encodedPath = resource.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    encodedSymbol =
      resource.symbol === undefined
        ? undefined
        : encodeURIComponent(resource.symbol);
  } catch {
    throw new EvidenceResourceError(
      "Repository evidence contains an invalid Unicode sequence.",
    );
  }

  const formatted = `${REPOSITORY_EVIDENCE_PREFIX}${encodedPath}${
    encodedSymbol === undefined ? "" : `#${encodedSymbol}`
  }`;
  const parsed = parseRepositoryEvidenceResource(formatted);
  if (parsed.path !== resource.path || parsed.symbol !== resource.symbol) {
    throw new EvidenceResourceError(
      `Repository evidence is not normalized: ${formatted}`,
    );
  }
  return formatted;
}

/**
 * Parses and validates a `repo://path#symbol` resource.
 *
 * @param resource - Repository evidence URI to parse.
 * @returns Canonical repository path and optional symbol.
 */
export function parseRepositoryEvidenceResource(
  resource: string,
): RepositoryEvidenceResource {
  if (!resource.startsWith(REPOSITORY_EVIDENCE_PREFIX)) {
    throw new EvidenceResourceError(
      `Unsupported evidence resource: ${resource}`,
    );
  }

  const body = resource.slice(REPOSITORY_EVIDENCE_PREFIX.length);
  const fragmentIndex = body.indexOf("#");
  const encodedPath =
    fragmentIndex === -1 ? body : body.slice(0, fragmentIndex);
  const encodedSymbol =
    fragmentIndex === -1 ? undefined : body.slice(fragmentIndex + 1);
  if (encodedSymbol?.includes("#")) {
    throw new EvidenceResourceError(
      `Evidence resource contains an unescaped fragment delimiter: ${resource}`,
    );
  }

  let decodedPath: string;
  let decodedSymbol: string | undefined;
  try {
    decodedPath = decodeURIComponent(encodedPath);
    decodedSymbol =
      encodedSymbol === undefined
        ? undefined
        : decodeURIComponent(encodedSymbol);
  } catch {
    throw new EvidenceResourceError(
      `Evidence resource contains invalid percent encoding: ${resource}`,
    );
  }

  if (containsControlCharacter(decodedPath)) {
    throw new EvidenceResourceError(
      `Evidence path contains a control character: ${resource}`,
    );
  }
  if (decodedSymbol !== undefined && containsControlCharacter(decodedSymbol)) {
    throw new EvidenceResourceError(
      `Evidence symbol contains a control character: ${resource}`,
    );
  }

  const normalized = path.posix
    .normalize(decodedPath.replace(/\\/gu, "/"))
    .replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//iu.test(normalized)
  ) {
    throw new EvidenceResourceError(
      `Evidence path must remain inside the repository: ${resource}`,
    );
  }
  const normalizedLower = normalized.toLowerCase();
  if (
    normalizedLower === ".git" ||
    normalizedLower.startsWith(".git/") ||
    normalizedLower === "openwiki" ||
    normalizedLower.startsWith("openwiki/")
  ) {
    throw new EvidenceResourceError(
      `Evidence cannot reference Git metadata or generated OpenWiki output: ${resource}`,
    );
  }
  if (decodedSymbol !== undefined && decodedSymbol.trim().length === 0) {
    throw new EvidenceResourceError(
      `Evidence symbol cannot be empty: ${resource}`,
    );
  }

  return {
    path: normalized,
    ...(decodedSymbol === undefined ? {} : { symbol: decodedSymbol.trim() }),
  };
}

/**
 * Detects characters that cannot safely participate in source identities.
 *
 * @param value - Decoded resource component.
 * @returns Whether the value contains a C0 or delete control character.
 */
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}
