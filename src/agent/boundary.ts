import {
  classifyError,
  type ErrorClassification,
} from "../telemetry/errors.js";
import type { TelemetryErrorClass } from "../telemetry/types.js";

/**
 * How the orchestrator responds to a unit failure, keyed to the #500
 * taxonomy.
 */
export type UnitFailureRoute =
  /**
   * The section's fault (truncation, context overflow, tool error): count an
   * attempt, move on.
   */
  | {
      kind: "attributable";
      classification: ErrorClassification;
      truncated: boolean;
    }
  /**
   * Not the section's fault (quota, auth, network, infra, abort): stop the
   * run, count nothing.
   */
  | { kind: "environmental"; classification: ErrorClassification }
  /**
   * Worth waiting out in-run: retry the unit after the delay.
   */
  | { kind: "transient"; classification: ErrorClassification; delayMs: number };

/**
 * In-run waits longer than this are pointless; the schedule is the backoff.
 */
const MAX_TRANSIENT_WAIT_MS = 120_000;

/**
 * In-run wait used for a transient failure that carries no Retry-After hint.
 */
const DEFAULT_TRANSIENT_WAIT_MS = 15_000;

/**
 * provider_error details worth waiting out in-run. Everything else
 * provider-side stops the run.
 */
const TRANSIENT_PROVIDER_DETAILS: ReadonlySet<string> = new Set([
  "rate_limit",
  "overloaded",
]);

/**
 * Families that are never the section's fault: the environment, the provider
 * account, the network path, or our own infrastructure. Attributable is the
 * residual: output_error (truncation), context_limit_error (section too big,
 * narrowing helps), tool_error, okf_error, agent_error.
 */
const ENVIRONMENTAL_CLASSES: ReadonlySet<TelemetryErrorClass> = new Set([
  "config_error",
  "filesystem_error",
  "network_error",
  "build_error",
  "checkpointer_error",
  "aborted",
]);

/**
 * Classifies a unit failure into the three responses. A rate-limit with a
 * short Retry-After is transient; one demanding a long wait is treated as
 * quota-like (environmental), because holding a run (or a CI runner) for an
 * hour loses to stopping and letting the next scheduled run resume.
 */
export function routeUnitFailure(error: unknown): UnitFailureRoute {
  const classification = classifyError(error);
  const { errorClass, errorDetail } = classification;

  if (
    errorClass === "provider_error" &&
    errorDetail !== undefined &&
    TRANSIENT_PROVIDER_DETAILS.has(errorDetail)
  ) {
    const delayMs = parseRetryAfterMs(error) ?? DEFAULT_TRANSIENT_WAIT_MS;

    return delayMs <= MAX_TRANSIENT_WAIT_MS
      ? { kind: "transient", classification, delayMs }
      : {
          kind: "environmental",
          classification: { errorClass, errorDetail: "quota_exceeded" },
        };
  }

  if (
    errorClass === "provider_error" ||
    ENVIRONMENTAL_CLASSES.has(errorClass)
  ) {
    return { kind: "environmental", classification };
  }

  return {
    kind: "attributable",
    classification,
    truncated: errorClass === "output_error" && errorDetail === "truncated",
  };
}

/**
 * Best-effort Retry-After extraction from SDK errors: headers first, then
 * message text.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null) {
    const headers = (error as { headers?: unknown }).headers;
    const raw =
      typeof (headers as Headers)?.get === "function"
        ? (headers as Headers).get("retry-after")
        : (headers as Record<string, string> | undefined)?.["retry-after"];
    const seconds = raw ? Number(raw) : NaN;

    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const message = error instanceof Error ? error.message : "";
  const match = /retry(?:-| )after[:\s]+(\d+)/i.exec(message);

  return match ? Number(match[1]) * 1000 : undefined;
}

/**
 * Stop signal for the deterministic e2e hook; classified as environmental.
 */
export class TestStopError extends Error {
  override name = "AbortError"; // rides the existing aborted classification

  /**
   * @param afterSections - The OPENWIKI_TEST_STOP_AFTER value that tripped it.
   */
  constructor(afterSections: number) {
    super(`OPENWIKI_TEST_STOP_AFTER=${afterSections} reached`);
  }
}
