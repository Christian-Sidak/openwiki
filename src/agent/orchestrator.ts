import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { OPEN_WIKI_DIR } from "../constants.js";
import { clearActiveRun } from "./crash-guard.js";
import {
  AGENT_MAX_CONCURRENCY,
  createOpenWikiAgent,
  parseStreamEvent,
} from "./index.js";
import { adoptExistingWiki, enumerateSectionDirs } from "./plan/adopt.js";
import { routeUnitFailure, TestStopError } from "./boundary.js";
import { deriveStamp } from "./manifest/derive.js";
import { filterMatching } from "./reconcile/glob.js";
import { readManifest, writeManifest } from "./manifest/io.js";
import {
  createSuggestionCollector,
  createSuggestRelatedSectionTool,
  validateSuggestions,
  type SectionSuggestion,
} from "./suggestions.js";
import {
  assignUnclaimedPaths,
  planSections,
  proposeSourcesForSection,
  toManifestSections,
} from "./plan/planner.js";
import { reconcile, type SectionVerdict } from "./reconcile/reconcile.js";
import { collectRepoSkeleton, type RepoSkeleton } from "./plan/skeleton.js";
import {
  ABANDON_LIMIT,
  type ManifestSection,
  type OpenWikiManifest,
} from "./manifest/types.js";
import {
  createEntryPageMessage,
  createSectionUnitMessage,
  type SectionTocEntry,
} from "./prompt.js";
import { TruncationError, TruncationMonitor } from "./truncation-monitor.js";
import type { OpenWikiIgnore } from "./openwiki-ignore.js";
import type {
  OpenWikiCommand,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./types.js";
import { writeLastUpdateMetadata } from "./utils.js";

/**
 * Everything a unit invocation needs from the surrounding run.
 */
export interface UnitRunDeps {
  cwd: string;

  model: BaseChatModel;

  options: OpenWikiRunOptions;

  /**
   * Effective wiki language; matches the persisted one, so no translation
   * pass fires.
   *
   * @default undefined — the wiki uses the default output language
   */
  language?: string;
}

/**
 * What a finished unit hands back besides its pages on disk.
 */
export interface UnitRunResult {
  suggestions: SectionSuggestion[];
}

/**
 * Inputs the routing edit in index.ts assembles.
 */
export interface ReconcileRunInput {
  command: OpenWikiCommand;

  cwd: string;

  modelId: string;

  openWikiIgnore: OpenWikiIgnore;

  unitDeps: UnitRunDeps;

  /**
   * Maintainer-provided wiki goal, folded into planning prompts.
   *
   * @default undefined — no goal was configured
   */
  wikiGoal?: string;
}

/**
 * Why the run stopped early, if it did.
 */
type StopReason = { errorClass: string; message: string } | undefined;

/**
 * The reconcile loop: load-or-build manifest, verdicts, sequential units,
 * entry page last, derived stamp. Init, update, resume, and bootstrap are all
 * this function; only the manifest's starting pointers differ.
 */
export async function runReconcileCommand(
  input: ReconcileRunInput,
): Promise<OpenWikiRunResult> {
  const { cwd } = input;
  const skeleton = await collectRepoSkeleton(cwd, input.openWikiIgnore);
  let manifest = await loadOrCreateManifest(input, skeleton);

  // Persist before any work: from this write on, every crash is resumable.
  await writeManifest(cwd, manifest);

  let stopReason: StopReason;

  try {
    manifest = await fillMissingSources(input, manifest, skeleton);
    manifest = await absorbUnclaimed(input, manifest, skeleton);
    // Dead sections drop before verdicts: a section whose only source was
    // deleted would otherwise be judged stale (the deletion is in its diff)
    // and then executed after its entry and pages are already gone.
    manifest = await dropDeadSections(cwd, manifest, skeleton);

    const { runHead, verdicts } = await reconcile(
      cwd,
      manifest,
      input.openWikiIgnore,
    );

    ({ manifest, stopReason } = await executeWorkList(
      input,
      manifest,
      verdicts,
      runHead,
      skeleton,
    ));
  } finally {
    await writeManifest(cwd, manifest);
    clearActiveRun();
  }

  await finalize(input, manifest, stopReason);

  return buildResult(input, manifest, stopReason);
}

/**
 * No manifest + no wiki → plan. No manifest + wiki → adopt. Else use it.
 */
async function loadOrCreateManifest(
  input: ReconcileRunInput,
  skeleton: RepoSkeleton,
): Promise<OpenWikiManifest> {
  const existing = await readManifest(input.cwd);

  if (existing) {
    return existing;
  }

  const wikiExists =
    (await enumerateSectionDirs(input.cwd).catch(() => [])).length > 0;
  const model = input.unitDeps.model;

  if (wikiExists) {
    emit(input, "Adopting the existing wiki into a manifest.");
    return adoptExistingWiki(input.cwd, model, skeleton);
  }

  emit(input, "No wiki found; planning sections.");
  const sections = toManifestSections(
    await planSections(model, skeleton, input.wikiGoal),
  );
  return { version: 1, sections };
}

/**
 * Adoption can leave sources empty; the planner fills them before reconcile.
 */
async function fillMissingSources(
  input: ReconcileRunInput,
  manifest: OpenWikiManifest,
  skeleton: RepoSkeleton,
): Promise<OpenWikiManifest> {
  const sections = [...manifest.sections];

  for (const [index, section] of sections.entries()) {
    if (section.sources.length > 0) {
      continue;
    }

    sections[index] = {
      ...section,
      sources: await proposeSourcesForSection(
        input.unitDeps.model,
        skeleton,
        section.path,
        section.brief,
      ),
    };
  }

  const next = { ...manifest, sections };
  await writeManifest(input.cwd, next);
  return next;
}

/**
 * Routes unclaimed changed paths through the planner before units run.
 */
async function absorbUnclaimed(
  input: ReconcileRunInput,
  manifest: OpenWikiManifest,
  skeleton: RepoSkeleton,
): Promise<OpenWikiManifest> {
  const { unclaimed } = await reconcile(
    input.cwd,
    manifest,
    input.openWikiIgnore,
  );

  if (unclaimed.length === 0) {
    return manifest;
  }

  emit(
    input,
    `New code claimed by no section: ${unclaimed.length} path(s); planning.`,
  );
  const decision = await assignUnclaimedPaths(
    input.unitDeps.model,
    manifest,
    unclaimed,
    skeleton,
  );
  const sections = manifest.sections.map((section) => {
    const extension = decision.extend.find(
      (entry) => entry.path === section.path,
    );
    return extension
      ? { ...section, sources: [...section.sources, ...extension.addSources] }
      : section;
  });
  const next: OpenWikiManifest = {
    ...manifest,
    sections: [...sections, ...toManifestSections(decision.add)],
  };

  await writeManifest(input.cwd, next);
  return next;
}

/**
 * Sections whose sources no longer match any tracked file are removed, pages
 * included: their domain left the repo. Individual dead globs inside a
 * still-alive section are left alone on purpose; they match nothing, cost
 * nothing, and mislead nobody, so pruning them buys only cosmetics.
 * Sections with empty sources survive: that's the adoption degrade rule's
 * "pending planner assignment" sentinel.
 */
async function dropDeadSections(
  cwd: string,
  manifest: OpenWikiManifest,
  skeleton: RepoSkeleton,
): Promise<OpenWikiManifest> {
  const survivors: ManifestSection[] = [];

  for (const section of manifest.sections) {
    const alive =
      section.sources.length === 0 ||
      filterMatching(skeleton.trackedFiles, section.sources).length > 0;

    if (alive) {
      survivors.push(section);
    } else {
      await rm(path.join(cwd, OPEN_WIKI_DIR, section.path), {
        recursive: true,
        force: true,
      });
    }
  }

  if (survivors.length === manifest.sections.length) {
    return manifest;
  }

  const next = { ...manifest, sections: survivors };
  await writeManifest(cwd, next);
  return next;
}

/**
 * Sequential unit loop. Pointers advance only to the pinned runHead.
 */
async function executeWorkList(
  input: ReconcileRunInput,
  manifest: OpenWikiManifest,
  verdicts: SectionVerdict[],
  runHead: string,
  skeleton: RepoSkeleton,
): Promise<{ manifest: OpenWikiManifest; stopReason: StopReason }> {
  let current = manifest;
  let done = 0;

  const update = async (
    sectionPath: string,
    patch: Partial<ManifestSection>,
  ): Promise<void> => {
    current = {
      ...current,
      sections: current.sections.map((section) =>
        section.path === sectionPath ? { ...section, ...patch } : section,
      ),
    };
    await writeManifest(input.cwd, current);
  };

  // Validated unit suggestions widen the target's sources and queue the
  // target THIS run so the new claim doesn't miss the change that prompted
  // it. Pushing onto `verdicts` mid-iteration is deliberate: array iteration
  // visits appended items.
  const applySuggestions = async (
    raw: SectionSuggestion[],
    triggering: Extract<SectionVerdict, { kind: "missing" | "stale" }>,
  ): Promise<void> => {
    const { accepted } = validateSuggestions(
      raw,
      current,
      skeleton.trackedFiles,
    );

    for (const suggestion of accepted) {
      const target = current.sections.find(
        (section) => section.path === suggestion.sectionPath,
      );

      if (!target) {
        continue;
      }

      await update(target.path, {
        sources: [...target.sources, suggestion.glob],
      });

      const queued = current.sections.find(
        (section) => section.path === suggestion.sectionPath,
      );

      if (queued) {
        verdicts.push({
          kind: "stale",
          section: queued,
          changedFiles: filterMatching(
            triggering.kind === "stale"
              ? triggering.changedFiles
              : skeleton.trackedFiles,
            [suggestion.glob],
          ),
        });
        emit(
          input,
          `Claim added: ${suggestion.sectionPath} now watches ${suggestion.glob} (${suggestion.reason}); queued this run.`,
        );
      }
    }
  };

  for (const verdict of verdicts) {
    if (verdict.kind === "abandoned") {
      continue;
    }
    if (verdict.kind === "fast-forward") {
      await update(verdict.section.path, { head: runHead });
      continue;
    }

    const stopAfter = Number(process.env.OPENWIKI_TEST_STOP_AFTER ?? NaN);
    if (Number.isFinite(stopAfter) && done >= stopAfter) {
      // Deterministic e2e hook: simulate an environmental stop (quota-like)
      // after N completed units. Harmless unless the env var is set.
      return {
        manifest: current,
        stopReason: routeStop(new TestStopError(stopAfter)),
      };
    }

    const toc: SectionTocEntry[] = current.sections.map((section) => ({
      path: section.path,
      brief: section.brief,
    }));
    const outcome = await runOneSection(input, verdict, runHead, toc);

    if (typeof outcome === "object" && "kind" in outcome) {
      await update(verdict.section.path, { head: runHead, attempts: 0 });
      done += 1;
      emit(
        input,
        `Section ${verdict.section.path} ${verdict.kind === "missing" ? "written" : "refreshed"}.`,
      );

      await applySuggestions(outcome.suggestions, verdict);
      continue;
    }
    if (outcome === "attributable") {
      const attempts = verdict.section.attempts + 1;
      await update(verdict.section.path, {
        attempts,
        ...(attempts >= ABANDON_LIMIT ? { abandoned: true } : {}),
      });
      emit(
        input,
        attempts >= ABANDON_LIMIT
          ? `Section ${verdict.section.path} abandoned after ${attempts} attempts; page frozen. Fix or split it by editing ${OPEN_WIKI_DIR}/.manifest.json.`
          : `Section ${verdict.section.path} failed (attempt ${attempts}); continuing.`,
      );
      continue;
    }

    return { manifest: current, stopReason: outcome };
  }

  return { manifest: current, stopReason: undefined };
}

/**
 * One bounded agent invocation. The factory gives it the same backend,
 * guard, prompt discipline, and middleware as a full run, plus an in-memory
 * checkpointer (units restart, never resume). Throws on stream error, abort,
 * or truncation; the boundary routes what the throw means. Suggestions are
 * collected here and validated by the orchestrator, never applied by the unit.
 */
export async function runUnitInvocation(
  deps: UnitRunDeps,
  userMessage: string,
  label: string,
): Promise<UnitRunResult> {
  const collector = createSuggestionCollector();
  const agent = await createOpenWikiAgent({
    command: "update",
    cwd: deps.cwd,
    language: deps.language,
    model: deps.model,
    onEvent: deps.options.onEvent,
    outputMode: "repository",
    extraTools: [createSuggestRelatedSectionTool(collector)],
  });
  const monitor = new TruncationMonitor();

  const stream = await agent.streamEvents(
    { messages: [{ role: "user", content: userMessage }] },
    {
      configurable: { thread_id: `unit-${label}-${Date.now()}` },
      version: "v3",
      signal: deps.options.signal,
      callbacks: [monitor],
      maxConcurrency: AGENT_MAX_CONCURRENCY,
    },
  );

  for await (const chunk of stream) {
    const event = parseStreamEvent(chunk);

    if (event) {
      deps.options.onEvent?.(event);
    }
  }

  if (monitor.truncated) {
    throw new TruncationError(monitor.truncationCount);
  }

  return { suggestions: collector.drain() };
}

/**
 * Runs one unit with one in-run transient retry and one truncation retry.
 */
async function runOneSection(
  input: ReconcileRunInput,
  verdict: Extract<SectionVerdict, { kind: "missing" | "stale" }>,
  runHead: string,
  toc: SectionTocEntry[],
  truncationRetry = false,
): Promise<
  | { kind: "done"; suggestions: SectionSuggestion[] }
  | "attributable"
  | Exclude<StopReason, undefined>
> {
  const task = {
    sectionPath: verdict.section.path,
    brief: verdict.section.brief,
    sources: verdict.section.sources,
    mode:
      verdict.kind === "missing" ? ("generate" as const) : ("refresh" as const),
    changedFiles: verdict.kind === "stale" ? verdict.changedFiles : undefined,
    truncationRetry,
    toc,
  };

  try {
    const result = await runUnitInvocation(
      input.unitDeps,
      createSectionUnitMessage(task),
      verdict.section.path.replaceAll("/", "-"),
    );
    return { kind: "done", suggestions: result.suggestions };
  } catch (error) {
    const route = routeUnitFailure(error);

    if (route.kind === "transient") {
      emit(
        input,
        `Rate limited; retrying ${verdict.section.path} in ${Math.round(route.delayMs / 1000)}s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      return runOneSection(input, verdict, runHead, toc, truncationRetry);
    }
    if (route.kind === "attributable") {
      if (route.truncated && !truncationRetry) {
        emit(
          input,
          `Section ${verdict.section.path} truncated; retrying with smaller pages.`,
        );
        return runOneSection(input, verdict, runHead, toc, true);
      }
      return "attributable";
    }

    return routeStop(error);
  }
}

/**
 * Renders an environmental stop into the flat {errorClass, message} the run
 * result and emitted summary report.
 */
function routeStop(error: unknown): Exclude<StopReason, undefined> {
  const route = routeUnitFailure(error);
  return {
    errorClass: `${route.classification.errorClass}${route.classification.errorDetail ? `.${route.classification.errorDetail}` : ""}`,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Entry page (model first, deterministic fallback), then the derived stamp.
 */
async function finalize(
  input: ReconcileRunInput,
  manifest: OpenWikiManifest,
  stopReason: StopReason,
): Promise<void> {
  const written = manifest.sections.filter((section) => section.head !== null);

  if (written.length > 0) {
    let entryPageWritten = false;

    // After an environmental stop the model call would fail for the same
    // reason the run stopped, so skip straight to the deterministic page.
    if (!stopReason) {
      try {
        await runUnitInvocation(
          input.unitDeps,
          createEntryPageMessage(written),
          "quickstart",
        );
        entryPageWritten = true;
      } catch {
        // fall through to the deterministic page
      }
    }

    if (!entryPageWritten) {
      await writeFile(
        path.join(input.cwd, OPEN_WIKI_DIR, "quickstart.md"),
        renderFallbackEntryPage(written),
        "utf8",
      );
    }
  }

  const stamp = await deriveStamp(input.cwd, manifest);
  await writeLastUpdateMetadata(
    input.command,
    input.cwd,
    input.modelId,
    "repository",
    stamp.status,
    input.unitDeps.language,
    stamp.abandoned,
  );
}

/**
 * No-model quickstart used when the run stopped environmentally (the model
 * call would fail for the same reason the run stopped). Plain but complete:
 * every link resolves, which is the property that matters.
 */
function renderFallbackEntryPage(sections: SectionTocEntry[]): string {
  const links = sections
    .map(
      (section) =>
        `- [${section.path.replace(/\/$/, "")}](${section.path})${section.brief ? ` : ${section.brief}` : ""}`,
    )
    .join("\n");

  return `# Quickstart\n\nGenerated wiki sections:\n\n${links}\n`;
}

/**
 * Emits the run's one-line summary and assembles the OpenWikiRunResult from
 * the final manifest: section counts plus complete-vs-partial status.
 */
function buildResult(
  input: ReconcileRunInput,
  manifest: OpenWikiManifest,
  stopReason: StopReason,
): OpenWikiRunResult {
  const total = manifest.sections.length;
  const done = manifest.sections.filter(
    (section) => section.head !== null,
  ).length;
  const abandoned = manifest.sections.filter(
    (section) => section.abandoned,
  ).length;

  emit(
    input,
    stopReason
      ? `Stopped early (${stopReason.errorClass}): ${done} of ${total} sections current. Re-run (or wait for the schedule) to resume.`
      : `${done} of ${total} sections current${abandoned > 0 ? `, ${abandoned} abandoned` : ""}.`,
  );

  return {
    command: input.command,
    model: input.modelId,
    sections: { total, done, failed: total - done, abandoned },
    runStatus: done === total ? "complete" : "partial",
  };
}

/**
 * Sends one orchestrator narration line to the run's event stream.
 */
function emit(input: ReconcileRunInput, text: string): void {
  input.unitDeps.options.onEvent?.({ type: "text", text: `${text}\n\n` });
}
