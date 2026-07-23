import { describe, expect, it } from "vitest";

import { toUserPromptSuggestion } from "../suggestedReplyVoice";

describe("toUserPromptSuggestion", () => {
  it("rewrites assistant-voice 'let me know if you want … explored' suggestions", () => {
    expect(toUserPromptSuggestion("Let me know if you want another section or accent color explored"))
      .toBe("Explore another section or accent color.");
  });

  it("rewrites assistant-voice 'tell me if you'd like me to …' suggestions", () => {
    expect(toUserPromptSuggestion("Tell me if you'd like me to wire up real content for the CTA links"))
      .toBe("Wire up real content for the CTA links.");
  });

  it("rewrites first-person capability phrasing into user ask", () => {
    expect(toUserPromptSuggestion("I can also add a testimonials section"))
      .toBe("Can you also add a testimonials section?");
  });

  it("keeps already user-voice prompts usable", () => {
    expect(toUserPromptSuggestion("Add a dark mode toggle"))
      .toBe("Add a dark mode toggle.");
  });
});
