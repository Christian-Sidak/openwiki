import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { filterMatching } from "../reconcile/glob.js";
import {
  PlanSchema,
  UnclaimedDecisionSchema,
  type Plan,
  type SectionPlan,
  type UnclaimedDecision,
} from "./schema.js";
import type { RepoSkeleton } from "./skeleton.js";
import type { ManifestSection, OpenWikiManifest } from "../manifest/types.js";

/**
 * Planning failed even after one validation-feedback retry.
 */
export class PlanningError extends Error {
  override name = "PlanningError";
}

/**
 * Proposes the section list for a repo that has no wiki. One structured
 * call; the schema forces the shape, validateAgainstRepo forces the content,
 * and one retry with the validation problems appended covers flaky output.
 */
export async function planSections(
  model: BaseChatModel,
  skeleton: RepoSkeleton,
  wikiGoal: string | undefined,
): Promise<SectionPlan[]> {
  const prompt = [
    "Propose the section list for a documentation wiki covering this repository.",
    "Sections are major domains (architecture, workflows, key subsystems), not files.",
    "Each section lists the source globs it documents. Globs must match real paths shown below.",
    "Sections MAY claim overlapping globs, and cross-cutting sections (integrations, operations, security) SHOULD: a shared file staling two sections, each documenting its own angle, is the intended behavior.",
    wikiGoal ? `Wiki goal from the maintainers: ${wikiGoal}` : "",
    `Directory tree:\n${skeleton.treeSummary}`,
    `Key files:\n${skeleton.keyFiles}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const plan = await invokeWithRetry<Plan>(
    model,
    PlanSchema,
    prompt,
    (candidate) => validatePlanAgainstRepo(candidate.sections, skeleton),
  );

  return plan.sections;
}

/**
 * Routes unclaimed changed paths: widen an existing section or add a new one.
 * Same schema-and-validate treatment as the initial plan.
 */
export async function assignUnclaimedPaths(
  model: BaseChatModel,
  manifest: OpenWikiManifest,
  unclaimed: string[],
  skeleton: RepoSkeleton,
): Promise<UnclaimedDecision> {
  const prompt = [
    "These changed repository paths are claimed by no wiki section:",
    unclaimed.join("\n"),
    "Existing sections and their sources:",
    manifest.sections
      .map((section) => `${section.path} -> ${section.sources.join(", ")}`)
      .join("\n"),
    "For each path decide: extend an existing section's sources, or propose a new section.",
    "Every listed path must end up covered by exactly one decision.",
  ].join("\n\n");

  return invokeWithRetry<UnclaimedDecision>(
    model,
    UnclaimedDecisionSchema,
    prompt,
    (candidate) => validateDecision(candidate, manifest, unclaimed, skeleton),
  );
}

/**
 * Content validation the schema can't do: globs must hit real tracked files.
 */
export function validatePlanAgainstRepo(
  sections: SectionPlan[],
  skeleton: RepoSkeleton,
): string[] {
  const problems: string[] = [];

  for (const section of sections) {
    for (const glob of section.sources) {
      if (glob.startsWith("/") || glob.includes("..")) {
        problems.push(`${section.path}: glob "${glob}" must be repo-relative`);
      } else if (filterMatching(skeleton.trackedFiles, [glob]).length === 0) {
        problems.push(
          `${section.path}: glob "${glob}" matches no tracked file`,
        );
      }
    }
  }

  return problems;
}

/**
 * Content validation for an unclaimed-path decision: new sections' globs must
 * hit real files, extend targets must be known sections, and every unclaimed
 * path must end up covered by exactly one extend or add.
 */
export function validateDecision(
  decision: UnclaimedDecision,
  manifest: OpenWikiManifest,
  unclaimed: string[],
  skeleton: RepoSkeleton,
): string[] {
  const problems = validatePlanAgainstRepo(decision.add, skeleton);
  const known = new Set(manifest.sections.map((section) => section.path));

  for (const extension of decision.extend) {
    if (!known.has(extension.path)) {
      problems.push(`extend targets unknown section "${extension.path}"`);
    }
  }

  const newGlobs = [
    ...decision.extend.flatMap((extension) => extension.addSources),
    ...decision.add.flatMap((section) => section.sources),
  ];
  const stillUncovered = unclaimed.filter(
    (path) => filterMatching([path], newGlobs).length === 0,
  );

  if (stillUncovered.length > 0) {
    problems.push(`paths left uncovered: ${stillUncovered.join(", ")}`);
  }

  return problems;
}

/**
 * One structured call; on validation problems, one retry with the problems
 * appended.
 */
export async function invokeWithRetry<T>(
  model: BaseChatModel,
  schema: Parameters<BaseChatModel["withStructuredOutput"]>[0],
  prompt: string,
  validate: (candidate: T) => string[],
): Promise<T> {
  // No explicit generic on withStructuredOutput: its RunOutput is constrained
  // to Record<string, any>, which an unconstrained T does not satisfy. The
  // invoke result is cast to T instead, keeping any out of our own signatures.
  const structured = model.withStructuredOutput(schema);
  const first = (await structured.invoke(prompt)) as T;
  const problems = validate(first);

  if (problems.length === 0) {
    return first;
  }

  const second = (await structured.invoke(
    `${prompt}\n\nYour previous answer had these problems; fix all of them:\n- ${problems.join("\n- ")}`,
  )) as T;
  const remaining = validate(second);

  if (remaining.length > 0) {
    throw new PlanningError(
      `Planner output failed validation twice:\n- ${remaining.join("\n- ")}`,
    );
  }

  return second;
}

/**
 * Converts validated plans into fresh manifest entries.
 */
export function toManifestSections(plans: SectionPlan[]): ManifestSection[] {
  return plans.map((plan) => ({
    path: plan.path,
    sources: plan.sources,
    head: null,
    attempts: 0,
    brief: plan.brief,
  }));
}
