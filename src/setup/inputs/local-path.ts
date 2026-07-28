import { homedir } from "node:os";
import path from "node:path";

export function sanitizeRepoId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "repo";
}

export function getDefaultLocalGitRepoPath(): string {
  return process.cwd();
}

export async function validateLocalDirectoryPath(
  value: string,
): Promise<string> {
  const normalizedPath = normalizeLocalPath(value);

  if (normalizedPath.length === 0) {
    throw new Error("Enter a local directory.");
  }

  const { stat } = await import("node:fs/promises");
  const pathStat = await stat(normalizedPath);

  if (!pathStat.isDirectory()) {
    throw new Error(`${normalizedPath} is not a directory.`);
  }

  return normalizedPath;
}

export function normalizeLocalPath(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return "";
  }

  if (trimmedValue === "~") {
    return homedir();
  }

  if (trimmedValue.startsWith("~/") || trimmedValue.startsWith("~\\")) {
    return path.resolve(homedir(), trimmedValue.slice(2));
  }

  return path.resolve(trimmedValue);
}
