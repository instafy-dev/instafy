import { describe, expect, it } from "vitest";

import { formatGhostSuggestionRemainderForDisplay } from "../ghostSuggestionDisplay";

describe("ghostSuggestionDisplay", () => {
  it("preserves a leading space visually in ghost suggestions", () => {
    expect(formatGhostSuggestionRemainderForDisplay(" you?")).toBe("\u00A0you?");
  });

  it("preserves multiple leading spaces visually in ghost suggestions", () => {
    expect(formatGhostSuggestionRemainderForDisplay("  doing well")).toBe("\u00A0\u00A0doing well");
  });

  it("leaves already-tight remainders unchanged", () => {
    expect(formatGhostSuggestionRemainderForDisplay("you?")).toBe("you?");
  });
});
