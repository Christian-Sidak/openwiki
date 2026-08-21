import { describe, expect, test } from "vitest";
import {
  dispatchSubagent,
  unwrapSubagentResult,
} from "../../src/agent/subagent-dispatch.ts";

describe("unwrapSubagentResult", () => {
  test("passes a plain string through", () => {
    expect(unwrapSubagentResult("[Q-01]: how?")).toBe("[Q-01]: how?");
  });

  test("reads the text out of a Command state update", () => {
    // The shape a model-invoked task tool returns. String()-ing it gave
    // "[object Object]", so a well-formed [Q-NN] block was reported as an
    // infrastructure failure and semantic QA silently did not run.
    expect(
      unwrapSubagentResult({
        update: { messages: [{ content: "[Q-01]: how?" }] },
      }),
    ).toBe("[Q-01]: how?");
  });

  test("concatenates content blocks", () => {
    expect(
      unwrapSubagentResult({
        update: {
          messages: [
            {
              content: [
                { type: "text", text: "[Q-01]: how?" },
                { type: "text", text: "[Q-02]: why?" },
              ],
            },
          ],
        },
      }),
    ).toBe("[Q-01]: how?\n[Q-02]: why?");
  });
});

describe("dispatchSubagent", () => {
  test("strips the toolCall so the task tool returns text", async () => {
    // Which shape came back depended on an accident of registration: a PTC tool
    // called from the REPL had no toolCall and parsed fine, an ordinary model
    // tool had one and got a Command.
    let seen: { toolCall?: unknown } | undefined;
    const task = {
      invoke: (_input: unknown, config?: unknown) => {
        seen = config as { toolCall?: unknown };
        return Promise.resolve(
          (config as { toolCall?: { id?: string } })?.toolCall?.id
            ? { update: { messages: [{ content: "command form" }] } }
            : "text form",
        );
      },
    };
    const out = await dispatchSubagent(task, "page-author", "write it", {
      toolCall: { id: "call_1" },
      configurable: { thread_id: "t" },
    });
    expect(out).toBe("text form");
    expect(seen?.toolCall).toBeUndefined();
  });
});
