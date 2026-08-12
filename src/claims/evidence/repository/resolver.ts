import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { OpenWikiIgnore } from "../../../agent/openwiki-ignore.js";
import {
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../core/errors.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "./resource.js";
import type { EvidenceResolver, ResolvedEvidence } from "../../core/types.js";
import type { LanguageEvidenceAdapter } from "./tree-sitter-adapter.js";
import { createBuiltInLanguageEvidenceAdapters } from "./tree-sitter-adapter.js";

/**
 * Repository evidence resolver options.
 */
export interface RepositoryEvidenceResolverOptions {
  /**
   * Absolute repository root.
   */
  rootDir: string;

  /**
   * Read-boundary rules shared with the OpenWiki agent.
   *
   * @default an inactive rule set that permits every safe repository path.
   */
  openWikiIgnore?: OpenWikiIgnore;

  /**
   * Language adapters used for symbol evidence.
   *
   * @default the built-in JavaScript, TypeScript, and TSX adapters.
   */
  adapters?: LanguageEvidenceAdapter[];
}

/**
 * Resolves and versions `repo://` evidence without model involvement.
 */
export class RepositoryEvidenceResolver implements EvidenceResolver {
  /**
   * Absolute repository root.
   */
  private readonly rootDir: string;

  /**
   * Lazily resolved physical repository root.
   *
   * @default undefined until the first existing evidence file is resolved.
   */
  private realRootDirPromise?: Promise<string>;

  /**
   * Repository read-boundary rules.
   */
  private readonly openWikiIgnore: OpenWikiIgnore;

  /**
   * Extension-to-language-adapter lookup.
   */
  private readonly adapters: Map<string, LanguageEvidenceAdapter>;

  constructor(options: RepositoryEvidenceResolverOptions) {
    if (!path.isAbsolute(options.rootDir)) {
      throw new EvidenceResourceError(
        "Repository evidence root must be absolute.",
      );
    }

    this.rootDir = path.resolve(options.rootDir);
    this.openWikiIgnore = options.openWikiIgnore ?? new OpenWikiIgnore([]);
    this.adapters = new Map();

    for (const adapter of options.adapters ??
      createBuiltInLanguageEvidenceAdapters()) {
      const adapterId = adapter.id.trim();
      if (!adapterId || adapterId !== adapter.id) {
        throw new EvidenceResourceError(
          "Language adapter id must be non-empty and cannot contain surrounding whitespace.",
        );
      }
      if (adapter.extensions.length === 0) {
        throw new EvidenceResourceError(
          `Language adapter ${adapterId} must register at least one extension.`,
        );
      }
      for (const extension of adapter.extensions) {
        const normalizedExtension = normalizeExtension(extension, adapterId);
        if (this.adapters.has(normalizedExtension)) {
          throw new EvidenceResourceError(
            `Multiple evidence adapters register ${normalizedExtension}`,
          );
        }
        this.adapters.set(normalizedExtension, adapter);
      }
    }
  }

  /**
   * Resolves the current symbol or source-file representation.
   *
   * @param resource - Canonical `repo://` resource.
   * @returns Current evidence, or `null` when the file/symbol no longer exists.
   */
  async resolve(resource: string): Promise<ResolvedEvidence | null> {
    const parsed = parseRepositoryEvidenceResource(resource);
    const canonicalResource = formatRepositoryEvidenceResource(parsed);
    if (this.openWikiIgnore.ignores(parsed.path)) {
      throw new EvidenceResourceError(
        `Evidence path is excluded by .openwikiignore: ${parsed.path}`,
      );
    }

    const absolutePath = this.resolveSafePath(parsed.path);
    let source: string;
    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new EvidenceResolutionError(
          `Evidence cannot reference a symbolic link: ${parsed.path}`,
        );
      }
      if (!metadata.isFile()) {
        return null;
      }
      const realRootDir = await this.getRealRootDir();
      const physicalPath = await realpath(absolutePath);
      const expectedPhysicalPath = path.resolve(realRootDir, parsed.path);
      if (
        !isPathInside(realRootDir, physicalPath) ||
        physicalPath !== expectedPhysicalPath
      ) {
        throw new EvidenceResolutionError(
          `Evidence path traverses a symbolic link or filesystem alias: ${parsed.path}`,
        );
      }
      source = await readFile(physicalPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      if (error instanceof EvidenceResolutionError) {
        throw error;
      }
      throw new EvidenceResolutionError(
        `Unable to read evidence ${parsed.path}: ${toErrorMessage(error)}`,
      );
    }

    if (!parsed.symbol) {
      return {
        evidence: {
          resource: canonicalResource,
          version: version("repo-file-v1", source),
        },
        content: source,
      };
    }

    const adapter = this.adapters.get(
      path.posix.extname(parsed.path).toLowerCase(),
    );
    if (!adapter) {
      return {
        evidence: {
          resource: canonicalResource,
          version: version("repo-file-v1", source),
        },
        content: source,
      };
    }

    const resolved = await adapter.resolveSymbol({
      path: parsed.path,
      source,
      symbol: parsed.symbol,
    });
    if (!resolved) {
      return null;
    }

    return {
      evidence: {
        resource: canonicalResource,
        version: version(`tree-sitter-${adapter.id}`, resolved.normalized),
      },
      content: resolved.content,
    };
  }

  /**
   * Resolves a repository-relative path while enforcing root containment.
   *
   * @param relativePath - Normalized repository-relative POSIX path.
   * @returns Absolute contained filesystem path.
   */
  private resolveSafePath(relativePath: string): string {
    const absolutePath = path.resolve(this.rootDir, relativePath);
    const relative = path.relative(this.rootDir, absolutePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new EvidenceResourceError(
        `Evidence path escapes the repository: ${relativePath}`,
      );
    }
    return absolutePath;
  }

  /**
   * Resolves and caches the physical repository root for symlink checks.
   *
   * @returns Canonical filesystem path for the repository root.
   */
  private async getRealRootDir(): Promise<string> {
    this.realRootDirPromise ??= realpath(this.rootDir).catch(
      (error: unknown) => {
        throw new EvidenceResolutionError(
          `Unable to resolve repository root ${this.rootDir}: ${toErrorMessage(error)}`,
        );
      },
    );
    return this.realRootDirPromise;
  }
}

/**
 * Determines whether a physical path remains inside a physical root.
 *
 * @param rootDir - Canonical root directory.
 * @param candidate - Canonical candidate path.
 * @returns Whether the candidate is contained by the root.
 */
function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Canonicalizes and validates an injected adapter extension.
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
 * Creates an algorithm-prefixed SHA-256 evidence version.
 *
 * @param algorithm - Stable resolver algorithm identifier.
 * @param content - Canonical representation to hash.
 * @returns Persistable opaque evidence version.
 */
function version(algorithm: string, content: string): string {
  return `${algorithm}:sha256:${createHash("sha256")
    .update(content)
    .digest("hex")}`;
}

/**
 * Determines whether a filesystem error means the evidence disappeared.
 *
 * @param error - Unknown filesystem failure.
 * @returns Whether the error represents a missing path.
 */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Converts an unknown error into diagnostic text.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error detail.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
