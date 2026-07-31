import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ActiveRunRecord } from "../src/agent/active-run.ts";

// Replace utils so the guard's stamp call is observable and never touches the
// filesystem. crash-guard only imports persistRunMetadataIfChanged from here.
vi.mock("../src/agent/utils.ts", () => ({
  persistRunMetadataIfChanged: vi.fn(() => Promise.resolve(true)),
}));

// Imported after vi.mock so the guard binds to the mocked utils. The active-run
// module is the real one: the guard and this test share its module state.
const { installCrashGuard } = await import("../src/crash-guard.ts");
const { registerActiveRun, getActiveRun, clearActiveRun } =
  await import("../src/agent/active-run.ts");
const { persistRunMetadataIfChanged } = await import("../src/agent/utils.ts");

const persistMock = vi.mocked(persistRunMetadataIfChanged);

/**
 * A synthetic in-flight run. `cwd` is a plain string the mocked stamp never
 * resolves or writes to, so no filesystem path is created by these tests.
 */
const ACTIVE_RUN: ActiveRunRecord = {
  command: "update",
  cwd: "<fake-run-root>",
  modelId: "test-model",
  outputMode: "local-wiki",
  snapshotBefore: null,
  language: "en",
};

/**
 * The global handlers installCrashGuard added during a test, tracked so
 * afterEach can remove exactly those and leave the worker's own handlers alone.
 */
let addedRejection: Array<(...args: unknown[]) => void> = [];
let addedException: Array<(...args: unknown[]) => void> = [];
let exitSpy: ReturnType<typeof vi.spyOn>;

/**
 * Installs the guard and returns the single unhandledRejection listener it
 * registered, so the test can invoke it directly instead of emitting a real
 * process event (which would also trip the worker's own handlers).
 */
function installAndCaptureRejectionListener(): (...args: unknown[]) => void {
  const rejectionBefore = process.listeners("unhandledRejection");
  const exceptionBefore = process.listeners("uncaughtException");

  installCrashGuard();

  addedRejection = process
    .listeners("unhandledRejection")
    .filter((listener) => !rejectionBefore.includes(listener)) as Array<
    (...args: unknown[]) => void
  >;
  addedException = process
    .listeners("uncaughtException")
    .filter((listener) => !exceptionBefore.includes(listener)) as Array<
    (...args: unknown[]) => void
  >;

  return addedRejection[0];
}

beforeEach(() => {
  persistMock.mockClear();
  // Stub the exit and stderr writes so a simulated crash neither kills the
  // vitest worker nor prints noise into the reporter.
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  for (const listener of addedRejection) {
    process.removeListener("unhandledRejection", listener);
  }
  for (const listener of addedException) {
    process.removeListener("uncaughtException", listener);
  }
  addedRejection = [];
  addedException = [];
  clearActiveRun();
  vi.restoreAllMocks();
});

describe("installCrashGuard", () => {
  test("stamps the active run interrupted, clears it, and exits non-zero", async () => {
    registerActiveRun(ACTIVE_RUN);
    const onRejection = installAndCaptureRejectionListener();

    onRejection(new Error("simulated crash"));

    await vi.waitFor(() => expect(persistMock).toHaveBeenCalledTimes(1));

    expect(persistMock).toHaveBeenCalledWith(
      ACTIVE_RUN.command,
      ACTIVE_RUN.cwd,
      ACTIVE_RUN.modelId,
      ACTIVE_RUN.outputMode,
      ACTIVE_RUN.snapshotBefore,
      "interrupted",
      ACTIVE_RUN.language,
    );
    expect(getActiveRun()).toBeUndefined();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });

  test("still exits non-zero when there is no active run to stamp", async () => {
    clearActiveRun();
    const onRejection = installAndCaptureRejectionListener();

    onRejection(new Error("simulated crash"));

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(persistMock).not.toHaveBeenCalled();
  });

  test("swallows a stamp failure and exits anyway", async () => {
    persistMock.mockRejectedValueOnce(new Error("stamp write failed"));
    registerActiveRun(ACTIVE_RUN);
    const onRejection = installAndCaptureRejectionListener();

    onRejection(new Error("simulated crash"));

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });
});
