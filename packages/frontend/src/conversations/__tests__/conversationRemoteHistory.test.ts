import { describe, expect, it } from "vitest";
import { controllerConversationHasRemoteMessages } from "../conversationRemoteHistory";

describe("controllerConversationHasRemoteMessages", () => {
  it("keeps a newly-created empty controller conversation eligible for onboarding", () => {
    expect(
      controllerConversationHasRemoteMessages({
        lastMessageId: null,
        lastMessageAt: null,
      }),
    ).toBe(false);
  });

  it("recognizes unhydrated remote history from either summary field", () => {
    expect(controllerConversationHasRemoteMessages({ lastMessageId: "message-1" })).toBe(true);
    expect(
      controllerConversationHasRemoteMessages({ lastMessageAt: "2026-07-13T19:00:00Z" }),
    ).toBe(true);
  });
});
