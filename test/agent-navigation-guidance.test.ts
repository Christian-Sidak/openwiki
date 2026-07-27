import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("repository coding-agent documentation guidance", () => {
  test("requires change-oriented navigation and validation guidance", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("Coding-agent utility requirements");
    expect(prompt).toContain("compact task-routing table");
    expect(prompt).toContain("exact source entry points");
    expect(prompt).toContain("important symbols or types");
    expect(prompt).toContain("runtime invariants and lifecycle ordering");
    expect(prompt).toContain("evidence-backed change recipes");
    expect(prompt).toContain("complete change surface");
    expect(prompt).toContain("shipped-surface correctness");
    expect(prompt).toContain("consumer-facing smoke test");
    expect(prompt).toContain("behavioral test matrix");
    expect(prompt).toContain("isolation between independent instances");
    expect(prompt).toContain("test_search");
    expect(prompt).toContain("Label expensive checks as conditional");
    expect(prompt).toContain(
      "simulate navigation for representative adjacent changes",
    );
  });

  test("does not apply repository coding guidance to the personal wiki", () => {
    const prompt = createSystemPrompt("init", "local-wiki");

    expect(prompt).not.toContain("Coding-agent utility requirements");
    expect(prompt).not.toContain("compact task-routing table");
  });
});
