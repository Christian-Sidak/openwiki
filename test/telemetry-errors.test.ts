import { describe, expect, test } from "vitest";

import { classifyError } from "../src/telemetry/errors.ts";
import { TruncationError } from "../src/agent/truncation-monitor.ts";

/**
 * The reliability branch adds exactly two rules on top of the health-telemetry
 * taxonomy (`test/telemetry.test.ts` covers the rest): a name-route for the
 * truncation error we throw, and a widened quota-message fallback. This file
 * guards only those two so a taxonomy refactor cannot silently drop them.
 */
describe("classifyError - truncation route", () => {
  test("a thrown TruncationError is a context_limit_error we own", () => {
    // Routed by name, before status or message are read, because a truncation is
    // an output cut off at the max-tokens cap: our problem to fix, not a retry.
    expect(classifyError(new TruncationError(3))).toEqual({
      errorClass: "context_limit_error",
      errorDetail: "truncation",
    });
  });
});

describe("classifyError - quota message fallback", () => {
  /**
   * Message-only quota phrasings, carrying no status or provider code, so the
   * message regex is the only thing that can catch them. A 429 with the same
   * wording classifies as `rate_limit` on the status branch first, by design; the
   * fallback exists for the codeless, statusless errors seen in the wild (#494's
   * "The usage limit has been reached" among them).
   */
  const quotaMessages: readonly string[] = [
    "The usage limit has been reached",
    "Your credit balance is too low to continue",
    "insufficient credit to complete this request",
    "monthly quota exceeded for this key",
  ];

  test.each(quotaMessages)("%s is provider_error/quota_exceeded", (message) => {
    expect(classifyError(new Error(message))).toEqual({
      errorClass: "provider_error",
      errorDetail: "quota_exceeded",
    });
  });

  test("wording without any quota signal is not forced into quota_exceeded", () => {
    // "slow down" phrasing carries no status here, so it falls through the whole
    // regex chain to the catch-all rather than being mistaken for exhaustion.
    expect(classifyError(new Error("too many requests, slow down"))).toEqual({
      errorClass: "agent_error",
    });
  });
});
