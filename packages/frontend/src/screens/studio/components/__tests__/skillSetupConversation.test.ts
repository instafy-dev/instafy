import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { isSkillSetupConversation } from "../skillSetupConversation";

function user(content: string): ChatMessage {
  return { id: content, role: "user", content, timestamp: 1 };
}

const reply: ChatMessage = { id: "reply", role: "assistant", content: "Which Mandant is it?", timestamp: 2 };

describe("isSkillSetupConversation", () => {
  it("is a chat a person opened with a skill setup, for the rest of that chat", () => {
    for (const opener of [
      "/skills import https://github.com/acme/skills --start",
      "/skills start freefinance",
    ]) {
      expect(isSkillSetupConversation({
        messages: [user(opener), reply, user("Yes, that one"), reply],
        olderMessagesUnloaded: false,
        title: null,
      })).toBe(true);
    }
  });

  it("is not an import without --start, or an ordinary chat", () => {
    for (const messages of [
      [user("/skills import https://github.com/acme/skills"), reply],
      [user("Compare the two plans on their pricing pages"), reply],
    ]) {
      expect(isSkillSetupConversation({ messages, olderMessagesUnloaded: false, title: "Connect FreeFinance" })).toBe(false);
    }
  });

  it("falls back to a connector setup's title only while older messages are not loaded", () => {
    const later = [user("Yes, that one"), reply];
    expect(isSkillSetupConversation({ messages: later, olderMessagesUnloaded: true, title: "Connect FreeFinance" })).toBe(true);
    // Any other title, or a chat whose history is all here, stays ordinary.
    expect(isSkillSetupConversation({ messages: later, olderMessagesUnloaded: true, title: "Set up the deploy" })).toBe(false);
    expect(isSkillSetupConversation({ messages: later, olderMessagesUnloaded: true, title: null })).toBe(false);
    expect(isSkillSetupConversation({ messages: later, olderMessagesUnloaded: false, title: "Connect FreeFinance" })).toBe(false);
  });
});
