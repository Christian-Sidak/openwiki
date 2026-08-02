import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the two side-effecting boundaries the guard reaches through, so the test
// asserts the calls without touching disk or the telemetry network.
vi.mock("../src/agent/utils.ts", () => ({
  persistRunMetadataIfChanged: vi.fn().mockResolvedValue(true),
  removeTemporaryPlanFile: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/telemetry/record-run-safe.ts", () => ({
  recordRunSafe: vi.fn().mockResolvedValue(undefined),
}));

import {
  clearActiveRun,
  getActiveRun,
  installCrashGuard,
  registerActiveRun,
  type ActiveRunRecord,
} from "../src/agent/crash-guard.ts";
import {
  persistRunMetadataIfChanged,
  removeTemporaryPlanFile,
} from "../src/agent/utils.ts";
import { recordRunSafe } from "../src/telemetry/record-run-safe.ts";

const FATAL_EVENTS = ["uncaughtException", "unhandledRejection"] as const;

/**
 * Resolves after one macrotask so setImmediate(exit) callbacks have a chance to
 * fire. Used to prove the exit did NOT run in that window while cleanup is
 * still pending.
 */
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * A representative in-flight run for the guard to stamp.
 */
const RUN: ActiveRunRecord = {
  command: "update",
  cwd: "/tmp/repo",
  modelId: "test-model",
  outputMode: "repository",
};

/**
 * Listener sets captured before each test so we can strip only the ones
 * installCrashGuard adds, leaving vitest's own handlers untouched.
 */
let priorListeners: Record<string, ReturnType<typeof process.listeners>>;

beforeEach(() => {
  vi.clearAllMocks();
  clearActiveRun();
  priorListeners = Object.fromEntries(
    FATAL_EVENTS.map((event) => [event, process.listeners(event)]),
  );
});

afterEach(() => {
  for (const event of FATAL_EVENTS) {
    for (const listener of process.listeners(event)) {
      if (!priorListeners[event].includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
  clearActiveRun();
  vi.restoreAllMocks();
});

describe("active run registry", () => {
  test("register / get / clear round-trips the active run", () => {
    expect(getActiveRun()).toBeUndefined();

    registerActiveRun(RUN);
    expect(getActiveRun()).toBe(RUN);

    clearActiveRun();
    expect(getActiveRun()).toBeUndefined();
  });
});

describe("installCrashGuard", () => {
  test("stamps the active run interrupted and fire-and-forgets telemetry on a fatal error", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    registerActiveRun(RUN);
    installCrashGuard();

    process.emit("uncaughtException", new Error("boom"));

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    // Dropped the temporary plan file, mirroring the graceful catch, so a
    // crash-path interrupt leaves no orphaned _plan.md.
    expect(removeTemporaryPlanFile).toHaveBeenCalledTimes(1);
    expect(removeTemporaryPlanFile).toHaveBeenCalledWith(
      "/tmp/repo",
      "repository",
    );

    // Stamped interrupted so the next scheduled update retries the window.
    expect(persistRunMetadataIfChanged).toHaveBeenCalledTimes(1);
    expect(persistRunMetadataIfChanged).toHaveBeenCalledWith(
      "update",
      "/tmp/repo",
      "test-model",
      "repository",
      null,
      "interrupted",
      undefined,
    );

    // The crash reaches the single telemetry boundary as a failure.
    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    expect(recordRunSafe).toHaveBeenCalledWith(
      "update",
      { outputMode: "repository" },
      expect.objectContaining({ outcome: "failure" }),
    );

    // The run is deregistered so a second fatal event does not double-stamp.
    expect(getActiveRun()).toBeUndefined();
  });

  test("stamps and records once when a fatal cascade fires several rejections", async () => {
    // Reproduces a double-fire seen during a live `--init --print` run against
    // the real openwiki checkout (not the synthetic fixture): a subagent
    // connection error and its downstream "Subagent ... failed" projection both
    // reached the process-level handler in the same tick. Only the first fatal
    // gets past the shutdownStarted latch, so cleanup and telemetry run once,
    // recording one dead run rather than one per rejection.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    registerActiveRun(RUN);
    installCrashGuard();

    process.emit("uncaughtException", new Error("Connection error."));
    process.emit(
      "uncaughtException",
      new Error("Subagent general-purpose failed"),
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    expect(removeTemporaryPlanFile).toHaveBeenCalledTimes(1);
    expect(persistRunMetadataIfChanged).toHaveBeenCalledTimes(1);
    expect(recordRunSafe).toHaveBeenCalledTimes(1);
    expect(getActiveRun()).toBeUndefined();
  });

  test("waits for cleanup to finish before exiting on a fatal cascade", async () => {
    // The bug this guards: a second fatal in the same tick scheduled its own
    // setImmediate(process.exit), which fired while the first fatal's stamp
    // write was still in flight, killing the process before the interrupted
    // stamp landed and leaving _plan.md orphaned. Gate the stamp on a promise we
    // control and prove the exit waits for it.
    let releaseStamp: () => void = () => undefined;
    const stampGate = new Promise<void>((resolve) => {
      releaseStamp = resolve;
    });
    vi.mocked(persistRunMetadataIfChanged).mockReturnValueOnce(
      stampGate.then(() => true),
    );

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    registerActiveRun(RUN);
    installCrashGuard();

    process.emit("uncaughtException", new Error("Connection error."));
    process.emit(
      "uncaughtException",
      new Error("Subagent general-purpose failed"),
    );

    // Let several macrotasks pass. With the old code the second fatal's exit
    // would have fired in this window; with the latch it must not, because the
    // first fatal is still awaiting the gated stamp.
    await tick();
    await tick();
    expect(exitSpy).not.toHaveBeenCalled();

    // Releasing the stamp lets the single exit fire — and only now.
    releaseStamp();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(persistRunMetadataIfChanged).toHaveBeenCalledTimes(1);
    expect(removeTemporaryPlanFile).toHaveBeenCalledTimes(1);
  });

  test("exits without stamping when no run is active", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    installCrashGuard();

    process.emit("uncaughtException", new Error("boom"));

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    expect(persistRunMetadataIfChanged).not.toHaveBeenCalled();
    expect(recordRunSafe).not.toHaveBeenCalled();
  });
});
