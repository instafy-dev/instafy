import { describe, expect, it } from "vitest";

import { parseLedgerTokenUsage } from "../ledgerTokenUsage";

describe("parseLedgerTokenUsage", () => {
  it("counts a cached prefix once, as part of the input", () => {
    // A production GPT-6 Luna turn: 50,351 input tokens of which 24,548 were
    // cached, and 173 output. The row used to read "75k tokens".
    expect(
      parseLedgerTokenUsage({
        input_tokens: 50_351,
        cached_input_tokens: 24_548,
        output_tokens: 173,
      }),
    ).toEqual({
      inputTokens: 50_351,
      cachedInputTokens: 24_548,
      outputTokens: 173,
      totalTokens: 50_524,
    });
  });

  it("parses numeric strings and tolerates missing counts", () => {
    expect(parseLedgerTokenUsage({ input_tokens: " 1200 ", output_tokens: "30" })).toEqual({
      inputTokens: 1200,
      cachedInputTokens: null,
      outputTokens: 30,
      totalTokens: 1230,
    });
    expect(parseLedgerTokenUsage(null).totalTokens).toBe(0);
    expect(parseLedgerTokenUsage({ input_tokens: "n/a" }).inputTokens).toBeNull();
  });
});
