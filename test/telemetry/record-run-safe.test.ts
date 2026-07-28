import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// recordRunSafe is a pure branching bridge: it never touches the network or
// filesystem itself, so both boundaries are mocked and we assert on the single
// event object handed to recordRun.
vi.mock("../../src/telemetry/senders.ts", () => ({
  recordRun: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/connectors/registry.ts", () => ({
  getConfiguredConnectorIds: vi.fn(() => ["git-repo", "web-search"]),
}));

import type { OpenWikiRunOptions } from "../../src/agent/types.ts";
import { getConfiguredConnectorIds } from "../../src/connectors/registry.ts";
import { recordRun } from "../../src/telemetry/senders.ts";
import { recordRunSafe } from "../../src/telemetry/record-run-safe.ts";

type RunFacts = Parameters<typeof recordRunSafe>[2];
type RecordedEvent = Parameters<typeof recordRun>[0];

/**
 * Builds run options with only the fields recordRunSafe reads, cast to the full
 * options shape the rest of which it never touches.
 */
function runOptions(
  overrides: Partial<OpenWikiRunOptions> = {},
): OpenWikiRunOptions {
  return overrides;
}

/**
 * Returns the single event object passed to the (mocked) recordRun.
 */
function recordedEvent(): RecordedEvent {
  const calls = vi.mocked(recordRun).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]?.[0];
}

const SUCCESS: RunFacts = { outcome: "success", provider: "anthropic" };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordRunSafe command gating", () => {
  test("does not record chat runs", async () => {
    await recordRunSafe("chat", runOptions(), SUCCESS);

    expect(recordRun).not.toHaveBeenCalled();
    expect(getConfiguredConnectorIds).not.toHaveBeenCalled();
  });

  test("records init runs", async () => {
    await recordRunSafe("init", runOptions(), SUCCESS);

    expect(recordRun).toHaveBeenCalledTimes(1);
  });

  test("records update runs", async () => {
    await recordRunSafe("update", runOptions(), SUCCESS);

    expect(recordRun).toHaveBeenCalledTimes(1);
  });
});

describe("recordRunSafe init setup fields", () => {
  test("attaches mode, provider, and configured connectors on init", async () => {
    await recordRunSafe(
      "init",
      runOptions({ outputMode: "repository", telemetryFile: "/tmp/tee.json" }),
      { outcome: "success", provider: "openai" },
    );

    expect(recordedEvent()).toEqual({
      command: "init",
      configuredConnectors: ["git-repo", "web-search"],
      errorClass: undefined,
      mode: "code",
      outcome: "success",
      provider: "openai",
      telemetryFile: "/tmp/tee.json",
    });
    expect(getConfiguredConnectorIds).toHaveBeenCalledTimes(1);
  });

  test("maps a non-repository output mode to the personal brain mode", async () => {
    await recordRunSafe(
      "init",
      runOptions({ outputMode: "local-wiki" }),
      SUCCESS,
    );

    expect(recordedEvent().mode).toBe("personal");
  });

  test("defaults the output mode to local-wiki (personal) when unset", async () => {
    await recordRunSafe("init", runOptions(), SUCCESS);

    expect(recordedEvent().mode).toBe("personal");
  });

  test("falls back to an unknown provider when resolution never produced one", async () => {
    await recordRunSafe("init", runOptions(), { outcome: "failure" });

    expect(recordedEvent().provider).toBe("unknown");
  });

  test("forwards the run outcome and error class", async () => {
    await recordRunSafe("init", runOptions(), {
      errorClass: "agent_error",
      outcome: "failure",
      provider: "anthropic",
    });

    const event = recordedEvent();
    expect(event.outcome).toBe("failure");
    expect(event.errorClass).toBe("agent_error");
  });
});

describe("recordRunSafe update runs omit setup fields", () => {
  test("records only lifecycle fields and never reads configured connectors", async () => {
    await recordRunSafe(
      "update",
      runOptions({ outputMode: "repository", telemetryFile: "/tmp/up.json" }),
      { outcome: "success", provider: "openai" },
    );

    expect(recordedEvent()).toEqual({
      command: "update",
      errorClass: undefined,
      outcome: "success",
      telemetryFile: "/tmp/up.json",
    });
    expect(getConfiguredConnectorIds).not.toHaveBeenCalled();
  });
});
