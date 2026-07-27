import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseFrontmatterFields,
  splitFrontmatter,
} from "../okf/frontmatter.js";
import type {
  IndexedChunk,
  OkfConcept,
  OkfRelationship,
  RepositoryCorpus,
} from "./types.js";

const MAX_FILE_BYTES = 256_000;
const MAX_FILES = 5_000;
const SOURCE_LINES_PER_CHUNK = 80;
const SOURCE_LINE_OVERLAP = 16;
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".svn",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|.*\.(?:crt|jks|key|keystore|p12|pem|pfx)|credentials\.json|token(?:\.json)?|cookies?(?:\.(?:db|sqlite|txt))?|\.git-credentials|hosts\.yml)$/iu;
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/gu;
const TEST_NAME =
  /\b(?:describe|it|test)(?:\.(?:each|only|skip|todo))?\s*\(\s*(["'`])([^\n]{1,160}?)\1/gu;

export interface RepositoryIndexOptions {
  repoRoot: string;
  wikiRoot: string;
}

export async function buildRepositoryCorpus(
  options: RepositoryIndexOptions,
): Promise<RepositoryCorpus> {
  const repoRoot = await resolveDirectory(options.repoRoot, "repository root");
  const wikiRoot = await resolveDirectory(options.wikiRoot, "wiki root");
  const wikiPages = await readWikiPages(wikiRoot);
  const concepts = buildConcepts(wikiPages);
  connectIncomingRelationships(concepts);
  return {
    chunks: [
      ...wikiPages.flatMap((page) => page.chunks),
      ...(await readSourceChunks(repoRoot, wikiRoot)),
    ],
    concepts,
  };
}

interface WikiPage {
  chunks: IndexedChunk[];
  concept: OkfConcept;
}

async function readWikiPages(wikiRoot: string): Promise<WikiPage[]> {
  const files = await walkFiles(wikiRoot, (file) => file.endsWith(".md"));
  return Promise.all(
    files.map(async (file) => {
      const content = await readBoundedTextFile(wikiRoot, file);
      const relative = toPosix(path.relative(wikiRoot, file));
      const conceptPath = `openwiki/${relative}`;
      const fields = parseFrontmatterFields(content) ?? {};
      const { body } = splitFrontmatter(content);
      const title = stringField(fields.title) ?? firstHeading(body) ?? relative;
      const description = stringField(fields.description);
      const type = stringField(fields.type) ?? "Reference";
      const resource = stringField(fields.resource);
      const tags = stringArray(fields.tags);
      return {
        chunks: chunkWikiPage({
          body,
          conceptPath,
          description,
          fields,
          relative,
          tags,
          title,
          type,
        }),
        concept: {
          ...(description ? { description } : {}),
          incoming: new Set<string>(),
          path: conceptPath,
          relationships: extractRelationships(body, relative),
          ...(resource ? { resource } : {}),
          tags,
          title,
          type,
        },
      };
    }),
  );
}

async function readSourceChunks(
  repoRoot: string,
  wikiRoot: string,
): Promise<IndexedChunk[]> {
  const files = await walkFiles(repoRoot, (file) => {
    const extension = path.extname(file).toLowerCase();
    return SOURCE_EXTENSIONS.has(extension);
  });
  const chunks: IndexedChunk[] = [];
  for (const file of files) {
    if (isContained(wikiRoot, file)) continue;
    const content = await readBoundedTextFile(repoRoot, file);
    const relative = toPosix(path.relative(repoRoot, file));
    const lines = content.split(/\r?\n/u);
    for (
      let start = 0;
      start < lines.length;
      start += SOURCE_LINES_PER_CHUNK - SOURCE_LINE_OVERLAP
    ) {
      const selected = lines.slice(start, start + SOURCE_LINES_PER_CHUNK);
      if (selected.every((line) => !line.trim())) continue;
      const lineStart = start + 1;
      const lineEnd = start + selected.length;
      const text = selected.join("\n");
      const testNames = extractTestNames(text);
      chunks.push({
        fields: [relative, ...testNames].join("\n"),
        id: `source:${relative}:${lineStart}`,
        kind: "source",
        lineEnd,
        lineStart,
        path: relative,
        scope: "source_code",
        tags: pathTags(relative),
        ...(testNames.length > 0 ? { testNames } : {}),
        text,
        title: path.basename(relative),
      });
    }
  }
  return chunks;
}

function chunkWikiPage(input: {
  body: string;
  conceptPath: string;
  description?: string;
  fields: Record<string, unknown>;
  relative: string;
  tags: string[];
  title: string;
  type: string;
}): IndexedChunk[] {
  const lines = input.body.split(/\r?\n/u);
  const headingIndexes = lines
    .map((line, index) => (/^#{1,3}\s+\S/u.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (headingIndexes.length === 0) headingIndexes.push(0);
  return headingIndexes.map((start, index) => {
    const end = headingIndexes[index + 1] ?? lines.length;
    const selected = lines.slice(start, end);
    const heading = selected[0]?.replace(/^#{1,3}\s+/u, "").trim();
    return {
      conceptPath: input.conceptPath,
      fields: JSON.stringify(input.fields),
      ...(heading ? { heading } : {}),
      id: `wiki:${input.relative}:${start + 1}`,
      kind: "wiki-section",
      lineEnd: Math.max(start + 1, end),
      lineStart: start + 1,
      path: input.conceptPath,
      scope: "wiki",
      tags: input.tags,
      text: [input.description, selected.join("\n")].filter(Boolean).join("\n"),
      title: input.title,
      type: input.type,
    };
  });
}

function buildConcepts(pages: WikiPage[]): Map<string, OkfConcept> {
  return new Map(pages.map((page) => [page.concept.path, page.concept]));
}

function connectIncomingRelationships(concepts: Map<string, OkfConcept>): void {
  for (const concept of concepts.values()) {
    concept.relationships = concept.relationships.filter((relationship) => {
      const target = concepts.get(relationship.target);
      if (!target) return false;
      target.incoming.add(concept.path);
      return true;
    });
  }
}

function extractRelationships(
  body: string,
  sourceRelative: string,
): OkfRelationship[] {
  const relationships: OkfRelationship[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const rawTarget = (match[2] ?? "").trim().split("#", 1)[0] ?? "";
    if (!rawTarget || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)) continue;
    const sourceDirectory = path.posix.dirname(toPosix(sourceRelative));
    const resolved = path.posix.normalize(
      path.posix.join(sourceDirectory, rawTarget),
    );
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) continue;
    const target = `openwiki/${resolved.endsWith(".md") ? resolved : `${resolved}.md`}`;
    const offset = match.index ?? 0;
    relationships.push({
      context: relationshipContext(body, offset),
      target,
    });
  }
  return relationships;
}

async function walkFiles(
  root: string,
  include: (file: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isSecretName(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (!isContained(root, candidate)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(candidate);
      } else if (entry.isFile() && include(candidate)) {
        files.push(candidate);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

async function readBoundedTextFile(
  root: string,
  file: string,
): Promise<string> {
  const resolved = await realpath(file);
  if (!isContained(root, resolved) || isSecretPath(resolved)) {
    throw new Error(
      "Refusing to read a path outside the indexed root or a secret-like file.",
    );
  }
  const info = await stat(resolved);
  if (info.size > MAX_FILE_BYTES) return "";
  const content = await readFile(resolved, "utf8");
  return content.includes("\0") ? "" : content;
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const resolved = await realpath(path.resolve(value));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return resolved;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isSecretPath(file: string): boolean {
  return file.split(path.sep).some(isSecretName);
}

function isSecretName(name: string): boolean {
  return (
    SECRET_FILE.test(name) ||
    /(?:credential|private[_-]?key|secret)/iu.test(name)
  );
}

function relationshipContext(body: string, offset: number): string {
  const start = Math.max(0, body.lastIndexOf("\n", offset - 160));
  const endCandidate = body.indexOf("\n", offset + 160);
  const end = endCandidate === -1 ? body.length : endCandidate;
  return body.slice(start, end).replace(/\s+/gu, " ").trim().slice(0, 320);
}

function pathTags(relative: string): string[] {
  return toPosix(relative)
    .split("/")
    .slice(0, -1)
    .filter((part) => part.length > 1);
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+?)\s*$/mu.exec(body)?.[1]?.trim();
}

function extractTestNames(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(TEST_NAME)]
        .map((match) => match[2]?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
