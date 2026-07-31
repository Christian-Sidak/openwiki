import { describe, expect, test } from "vitest";

import {
  classifyError,
  isQuotaExhaustedMessage,
} from "../src/telemetry/errors.ts";
import { TruncationError } from "../src/agent/truncation-monitor.ts";

/**
 * Builds a provider-SDK-shaped error: a real Error carrying the HTTP-ish
 * `status` that {@link classifyError} reads via its status extractor.
 */
function providerError(status: number, message = "request failed"): Error {
  return Object.assign(new Error(message), { status });
}

describe("classifyError", () => {
  test("a 429 whose message names quota exhaustion is provider_quota_exhausted", () => {
    expect(
      classifyError(providerError(429, "Your credit balance is too low")),
    ).toBe("provider_quota_exhausted");

    expect(
      classifyError(providerError(429, "The usage limit has been reached")),
    ).toBe("provider_quota_exhausted");
  });

  test("a plain 429 with no quota wording is provider_rate_limit", () => {
    expect(
      classifyError(providerError(429, "Too many requests, slow down")),
    ).toBe("provider_rate_limit");
  });

  test("an error named TruncationError routes to truncation", () => {
    expect(classifyError(new TruncationError(3))).toBe("truncation");
  });

  test("a 401/403 is provider_auth (sanity for the status branch)", () => {
    expect(classifyError(providerError(401))).toBe("provider_auth");
    expect(classifyError(providerError(403))).toBe("provider_auth");
  });

  test("an unmatched error falls through to the agent_error catch-all", () => {
    expect(classifyError(new Error("something unexpected"))).toBe(
      "agent_error",
    );
  });
});

describe("isQuotaExhaustedMessage", () => {
  /**
   * Table of provider phrasings: the wording, and whether it should read as a
   * "you are out of quota" 429 (true) versus a transient "slow down" 429 (false).
   */
  const cases: ReadonlyArray<{ message: string; expected: boolean }> = [
    { message: "usage limit reached", expected: true },
    { message: "The usage limit has been reached", expected: true },
    { message: "quota exceeded for this key", expected: true },
    { message: "monthly quota reached", expected: true },
    { message: "your credit balance is too low", expected: true },
    { message: "insufficient credit to complete", expected: true },
    { message: "USAGE LIMIT REACHED", expected: true },
    { message: "rate limit exceeded, retry shortly", expected: false },
    { message: "too many requests", expected: false },
    { message: "", expected: false },
  ];

  test.each(cases)("$message -> $expected", ({ message, expected }) => {
    expect(isQuotaExhaustedMessage(message)).toBe(expected);
  });
});
