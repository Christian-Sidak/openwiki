/**
 * Phase 5 unit test for the blinded LLM judge.
 *
 * Token-free: it asserts the prompt is blinded and complete, that the response
 * parser tolerates fences and prose and reconciles omitted facts pessimistically,
 * and that the chat-model adapter flattens message content. No live model is
 * called; a fake {@link JudgeModel} returns canned JSON.
 */

import { describe, expect, test } from "vitest";
import type { FactExpectation } from "../scenarios/types.js";
import {
  buildJudgePrompt,
  createChatModelJudge,
  judgePage,
  parseJudgeResponse,
  type InvokableChatModel,
  type JudgeModel,
  type JudgePageInput,
  type JudgePrompt,
} from "./judge.js";

const requiredFacts: FactExpectation[] = [
  { id: "r1", description: "documents the async signature of authenticate" },
  { id: "r2", description: "notes callers must await the result" },
];

const forbiddenFacts: FactExpectation[] = [
  {
    id: "f1",
    description: "claims authenticate returns a boolean synchronously",
  },
];

const pageInput: JudgePageInput = {
  scenarioDescription: "authenticate() became async and returns a Promise.",
  page: "openwiki/architecture/auth.md",
  rationale: "the auth page documents authenticate's signature and return type",
  requiredFacts,
  forbiddenFacts,
  sourceEvidence: [
    {
      path: "src/auth/service.ts",
      symbol: "AuthService.authenticate",
      explanation: "the method now returns Promise<Session>",
      sourceText: "async authenticate(): Promise<Session> { /* ... */ }",
    },
  ],
  before: "# Auth\n\n`authenticate` returns a boolean synchronously.\n",
  after: "# Auth\n\n`authenticate` is async; await its Promise<Session>.\n",
};

const factIds = {
  requiredFactIds: ["r1", "r2"],
  forbiddenFactIds: ["f1"],
};

describe("buildJudgePrompt", () => {
  const prompt = buildJudgePrompt(pageInput);
  const blob = `${prompt.system}\n${prompt.user}`.toLowerCase();

  test("stays blinded: no arm, sidecar, or freshness signal leaks in", () => {
    expect(blob).not.toContain("freshness");
    expect(blob).not.toContain("sidecar");
    expect(blob).not.toContain("source-deps");
    expect(blob).not.toContain("with arm");
    expect(blob).not.toContain("without arm");
    expect(blob).not.toContain("which arm");
  });

  test("labels the two pages anonymously", () => {
    expect(blob).toContain("baseline page");
    expect(blob).toContain("candidate page");
  });

  test("includes the change, rationale, facts, and resolved source evidence", () => {
    expect(prompt.user).toContain("authenticate() became async");
    expect(prompt.user).toContain(
      "documents the async signature of authenticate",
    );
    expect(prompt.user).toContain(
      "claims authenticate returns a boolean synchronously",
    );
    expect(prompt.user).toContain("src/auth/service.ts");
    expect(prompt.user).toContain("async authenticate(): Promise<Session>");
    expect(prompt.user).toContain("returns a boolean synchronously"); // baseline page body
    expect(prompt.user).toContain("await its Promise<Session>"); // candidate page body
  });
});

describe("parseJudgeResponse", () => {
  const complete = {
    verdict: "correct",
    requiredFacts: [
      { id: "r1", satisfied: true, explanation: "documents async" },
      { id: "r2", satisfied: true, explanation: "notes await" },
    ],
    forbiddenFacts: [{ id: "f1", stillPresent: false, explanation: "removed" }],
    unsupportedClaims: [],
    summary: "synchronized",
  };

  test("parses a clean JSON object", () => {
    const result = parseJudgeResponse(JSON.stringify(complete), factIds);
    expect(result.verdict).toBe("correct");
    expect(result.requiredFacts).toHaveLength(2);
    expect(result.requiredFacts.every((fact) => fact.satisfied)).toBe(true);
    expect(result.forbiddenFacts[0]?.stillPresent).toBe(false);
  });

  test("parses JSON wrapped in a ```json code fence", () => {
    const fenced = `\`\`\`json\n${JSON.stringify(complete)}\n\`\`\``;
    expect(parseJudgeResponse(fenced, factIds).verdict).toBe("correct");
  });

  test("parses JSON surrounded by prose", () => {
    const prose = `Here is my assessment:\n${JSON.stringify(complete)}\nHope that helps.`;
    expect(parseJudgeResponse(prose, factIds).verdict).toBe("correct");
  });

  test("reconciles omitted facts pessimistically", () => {
    const partial = JSON.stringify({
      verdict: "partially_correct",
      // r2 omitted; f1 omitted entirely.
      requiredFacts: [
        { id: "r1", satisfied: true, explanation: "documents async" },
      ],
      forbiddenFacts: [],
      unsupportedClaims: [],
      summary: "partial",
    });

    const result = parseJudgeResponse(partial, factIds);

    expect(result.verdict).toBe("partially_correct");
    const r2 = result.requiredFacts.find((fact) => fact.id === "r2");
    expect(r2?.satisfied).toBe(false); // omitted required fact defaults to unsatisfied
    const f1 = result.forbiddenFacts.find((fact) => fact.id === "f1");
    expect(f1?.stillPresent).toBe(true); // omitted forbidden fact defaults to still present
  });

  test("throws on an invalid verdict", () => {
    const bad = JSON.stringify({ ...complete, verdict: "synced" });
    expect(() => parseJudgeResponse(bad, factIds)).toThrow(/invalid verdict/u);
  });

  test("throws when there is no JSON object at all", () => {
    expect(() =>
      parseJudgeResponse("I cannot produce a verdict.", factIds),
    ).toThrow(/parseable JSON/u);
  });
});

describe("judgePage", () => {
  test("builds the prompt, invokes the model, and parses the result", async () => {
    let capturedPrompt: JudgePrompt | undefined;
    const model: JudgeModel = {
      async judge(prompt: JudgePrompt): Promise<string> {
        capturedPrompt = prompt;
        return JSON.stringify({
          verdict: "stale",
          requiredFacts: [
            { id: "r1", satisfied: false, explanation: "missing" },
            { id: "r2", satisfied: false, explanation: "missing" },
          ],
          forbiddenFacts: [
            { id: "f1", stillPresent: true, explanation: "still there" },
          ],
          unsupportedClaims: [],
          summary: "still stale",
        });
      },
    };

    const result = await judgePage({ input: pageInput, model });

    expect(result.verdict).toBe("stale");
    expect(result.forbiddenFacts[0]?.stillPresent).toBe(true);
    // The model was handed a blinded prompt.
    expect(capturedPrompt?.system).toContain("documentation-accuracy grader");
    expect(`${capturedPrompt?.user}`.toLowerCase()).not.toContain("freshness");
  });
});

describe("createChatModelJudge", () => {
  test("sends system and user messages and returns string content verbatim", async () => {
    let capturedMessages: unknown;
    const chat: InvokableChatModel = {
      async invoke(messages: unknown): Promise<unknown> {
        capturedMessages = messages;
        return { content: '{"verdict":"correct"}' };
      },
    };

    const raw = await createChatModelJudge(chat).judge({
      system: "SYS",
      user: "USER",
    });

    expect(raw).toBe('{"verdict":"correct"}');
    expect(capturedMessages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
  });

  test("flattens array message content, ignoring non-text parts", async () => {
    const chat: InvokableChatModel = {
      async invoke(): Promise<unknown> {
        return {
          content: [
            { type: "text", text: "abc" },
            { type: "image", url: "ignored" },
            { type: "text", text: "def" },
          ],
        };
      },
    };

    expect(
      await createChatModelJudge(chat).judge({ system: "S", user: "U" }),
    ).toBe("abcdef");
  });
});
