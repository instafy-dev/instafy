import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { parseUsage, resolveTokenUsageForMessage } from "../chatMessageDetailHelpers";

const JOB_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function message(id: string, overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    role: "assistant",
    authorId: null,
    content: "",
    timestamp: 1,
    files: null,
    messageType: null,
    metadata: null,
    ...overrides,
  };
}

// The Details-only usage row the controller writes for a Claude Code turn
// (docs/Local-Engine-Turns.md 2.6, 5.7): what Claude Code reported, with the
// model it ran, never a cost.
const CLAUDE_CODE_USAGE_DETAILS = {
  kind: "claude_code_turn_usage",
  billed: false,
  usage: {
    input_tokens: 120,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 850,
    output_tokens: 40,
  },
  model: "claude-test-model",
};

describe("a turn's token usage", () => {
  it("reads a usage that counts the cache apart as its row's words do, with the model it names", () => {
    // "Claude Code reported: input 1000, cached 850, output 40"
    expect(parseUsage(CLAUDE_CODE_USAGE_DETAILS)).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 850,
      outputTokens: 40,
      context: null,
      model: "claude-test-model",
    });
    // A row without a model, or with a blank one, names none.
    const { model: _model, ...withoutModel } = CLAUDE_CODE_USAGE_DETAILS;
    void _model;
    expect(parseUsage(withoutModel)).not.toHaveProperty("model");
    expect(parseUsage({ ...CLAUDE_CODE_USAGE_DETAILS, model: "  " })).not.toHaveProperty("model");
  });

  it("reads a Codex usage row as it always has", () => {
    expect(
      parseUsage({
        kind: "codex_turn_usage",
        usage: { input_tokens: 1200, cached_input_tokens: 900, output_tokens: 75 },
      }),
    ).toEqual({ inputTokens: 1200, cachedInputTokens: 900, outputTokens: 75, context: null });
    expect(parseUsage({ kind: "codex_turn_usage" })).toBeNull();
  });

  it("finds a Claude Code turn's usage row for its reply, with the model", () => {
    const reply = message("reply-1", {
      content: "Fixed the login test.",
      metadata: { source: "agent", outcome: "succeeded", jobId: JOB_ID, aiAccessMode: "claude-code" },
    });
    const usageRow = message("usage-1", {
      content: "Claude Code reported: input 1000, cached 850, output 40",
      messageType: "token_usage",
      metadata: { source: "agent", jobId: JOB_ID, messageType: "token_usage", details: CLAUDE_CODE_USAGE_DETAILS },
    });
    expect(resolveTokenUsageForMessage([reply, usageRow], "reply-1")).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 850,
      outputTokens: 40,
      model: "claude-test-model",
    });
  });
});
