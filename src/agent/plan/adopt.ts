import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { OPEN_WIKI_DIR } from "../../constants.js";
import { readLastUpdate } from "../utils.js";
import { validatePlanAgainstRepo, PlanningError } from "./planner.js";
import { PlanSchema, type SectionPlan } from "./schema.js";
import type { RepoSkeleton } from "./skeleton.js";
import type { ManifestSection, OpenWikiManifest } from "../manifest/types.js";

/**
 * Per-page byte cap when sampling existing pages for source extraction.
 */
const PAGE_SAMPLE_BYTES = 3_000;

/**
 * Builds a manifest for a wiki that predates the manifest system. Sources are
 * extracted from the existing pages (they cite the paths they document), and
 * heads seed from the stamp's gitHead: trust the old claim exactly once.
 * Entry-page links with no target directory, the leftovers of a crashed
 * init, become null-head entries so broken wikis repair themselves.
 */
export async function adoptExistingWiki(
  cwd: string,
  model: BaseChatModel,
  skeleton: RepoSkeleton,
): Promise<OpenWikiManifest> {
  const stamp = await readLastUpdate(cwd, "repository");
  const seedHead = stamp?.gitHead ?? null;
  const sectionDirs = await enumerateSectionDirs(cwd);
  const deadSections = await deadLinkSections(cwd, sectionDirs);

  const extracted =
    sectionDirs.length > 0
      ? await extractSources(cwd, model, skeleton, sectionDirs)
      : [];

  const adopted: ManifestSection[] = extracted.map((plan) => ({
    path: plan.path,
    sources: plan.sources,
    head: seedHead,
    attempts: 0,
    brief: plan.brief,
  }));
  const repaired: ManifestSection[] = deadSections.map((dir) => ({
    path: dir,
    sources: [],
    head: null,
    attempts: 0,
    brief:
      "Recovered from a dead entry-page link; planner assigns sources on first run.",
  }));

  return { version: 1, sections: [...adopted, ...repaired] };
}

/**
 * Wiki section directories, skipping loose files (stamp, quickstart, plan).
 */
export async function enumerateSectionDirs(cwd: string): Promise<string[]> {
  const entries = await readdir(path.join(cwd, OPEN_WIKI_DIR), {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${entry.name}/`)
    .sort();
}

/**
 * Quickstart links whose target directory does not exist. Markdown links to
 * local paths only; external URLs and anchors are ignored.
 */
export async function deadLinkSections(
  cwd: string,
  existingDirs: string[],
): Promise<string[]> {
  let quickstart: string;

  try {
    quickstart = await readFile(
      path.join(cwd, OPEN_WIKI_DIR, "quickstart.md"),
      "utf8",
    );
  } catch {
    return [];
  }

  const existing = new Set(existingDirs);
  const dead = new Set<string>();

  for (const match of quickstart.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].replace(/^\.\//, "");
    const topDir = target.split("/")[0];

    // Skip parent-escape links: "../x/y.md" would otherwise register a "../"
    // section, the same traversal io.ts and validatePlanAgainstRepo reject.
    if (
      topDir &&
      topDir !== ".." &&
      target.includes("/") &&
      !existing.has(`${topDir}/`)
    ) {
      dead.add(`${topDir}/`);
    }
  }

  return [...dead].sort();
}

/**
 * One structured call: read page samples, report the sources each section
 * documents.
 */
async function extractSources(
  cwd: string,
  model: BaseChatModel,
  skeleton: RepoSkeleton,
  sectionDirs: string[],
): Promise<SectionPlan[]> {
  const samples: string[] = [];

  for (const dir of sectionDirs) {
    samples.push(`--- section ${dir} ---\n${await samplePages(cwd, dir)}`);
  }

  const prompt = [
    "This wiki already exists. For each section below, report the repo source",
    "globs its pages document. Extract from the pages (they cite paths and",
    "source maps); do not invent coverage the pages don't claim.",
    "Globs must match real paths from this tracked-file sample:",
    skeleton.trackedFiles.slice(0, 400).join("\n"),
    samples.join("\n\n"),
  ].join("\n\n");

  const structured = model.withStructuredOutput<{ sections: SectionPlan[] }>(
    PlanSchema,
  );
  const result = await structured.invoke(prompt);
  const problems = validatePlanAgainstRepo(result.sections, skeleton);
  const knownDirs = new Set(sectionDirs);
  const filtered = result.sections.filter((section) =>
    knownDirs.has(section.path),
  );

  if (filtered.length === 0) {
    throw new PlanningError(
      `Adoption extracted no valid sections${problems.length > 0 ? `:\n- ${problems.join("\n- ")}` : "."}`,
    );
  }

  // Sections whose extracted globs fail validation degrade to null-head
  // (regenerate) rather than failing adoption; the orchestrator treats
  // empty sources as "planner assigns on first run".
  return filtered.map((section) => ({
    ...section,
    sources:
      validatePlanAgainstRepo([section], skeleton).length > 0
        ? []
        : section.sources,
  }));
}

/**
 * Reads up to three pages from a section directory (truncated per page) as the
 * evidence the extractor reads source globs out of.
 */
async function samplePages(cwd: string, dir: string): Promise<string> {
  const dirPath = path.join(cwd, OPEN_WIKI_DIR, dir);
  const entries = await readdir(dirPath);
  const pages = entries.filter((entry) => entry.endsWith(".md")).slice(0, 3);
  const blocks: string[] = [];

  for (const page of pages) {
    const content = await readFile(path.join(dirPath, page), "utf8");
    blocks.push(`# ${page}\n${content.slice(0, PAGE_SAMPLE_BYTES)}`);
  }

  return blocks.join("\n\n");
}
