import { describe, expect, it } from "vitest";
import {
  normalizeReasoningEffort,
  reasoningEffortLabel,
  REASONING_EFFORT_OPTIONS,
} from "../aiReasoning";

describe("normalizeReasoningEffort", () => {
  it("accepts the known levels, case- and whitespace-insensitively", () => {
    expect(normalizeReasoningEffort("minimal")).toBe("minimal");
    expect(normalizeReasoningEffort("LOW")).toBe("low");
    expect(normalizeReasoningEffort("  Medium ")).toBe("medium");
    expect(normalizeReasoningEffort("High")).toBe("high");
  });

  it("returns null for anything unrecognized (inherit)", () => {
    expect(normalizeReasoningEffort(null)).toBeNull();
    expect(normalizeReasoningEffort(undefined)).toBeNull();
    expect(normalizeReasoningEffort("")).toBeNull();
    expect(normalizeReasoningEffort("ultra")).toBeNull();
    expect(normalizeReasoningEffort(3)).toBeNull();
  });
});

describe("reasoningEffortLabel", () => {
  it("maps every option id to its display label", () => {
    for (const option of REASONING_EFFORT_OPTIONS) {
      expect(reasoningEffortLabel(option.id)).toBe(option.label);
    }
  });

  it("orders levels low→high", () => {
    expect(REASONING_EFFORT_OPTIONS.map((o) => o.id)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});
