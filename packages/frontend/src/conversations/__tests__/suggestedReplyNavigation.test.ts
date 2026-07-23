import { describe, expect, it } from "vitest";

import { resolveNextSuggestedReplyForTabCycle } from "../suggestedReplyNavigation";

describe("resolveNextSuggestedReplyForTabCycle", () => {
  it("returns the first suggestion when input is empty", () => {
    expect(
      resolveNextSuggestedReplyForTabCycle({
        inputValue: "",
        suggestions: ["First", "Second"],
      }),
    ).toBe("First");
  });

  it("returns the next suggestion when input matches a suggestion", () => {
    expect(
      resolveNextSuggestedReplyForTabCycle({
        inputValue: "First",
        suggestions: ["First", "Second", "Third"],
      }),
    ).toBe("Second");
  });

  it("wraps to first suggestion after the last one", () => {
    expect(
      resolveNextSuggestedReplyForTabCycle({
        inputValue: "Third",
        suggestions: ["First", "Second", "Third"],
      }),
    ).toBe("First");
  });

  it("returns null when input does not match suggestions", () => {
    expect(
      resolveNextSuggestedReplyForTabCycle({
        inputValue: "Custom text",
        suggestions: ["First", "Second"],
      }),
    ).toBeNull();
  });

  it("ignores empty suggestions", () => {
    expect(
      resolveNextSuggestedReplyForTabCycle({
        inputValue: "",
        suggestions: ["", "   ", "First"],
      }),
    ).toBe("First");
  });
});
