import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import {
  createNotificationNudgeConversationObservation,
  isGenuineAssistantResponseForNotifications,
  observeNotificationNudgeAssistantResponses,
} from "../notificationNudgeEligibility";

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    authorId: "runtime-agent",
    content: "A completed answer",
    timestamp: 10_100,
    messageType: "assistant",
    metadata: null,
    ...overrides,
  };
}

describe("notification nudge eligibility", () => {
  it("recognizes only final user-visible assistant answers", () => {
    expect(isGenuineAssistantResponseForNotifications(createMessage())).toBe(true);
    expect(
      isGenuineAssistantResponseForNotifications(
        createMessage({ role: "user", authorId: "teammate", messageType: "user" }),
      ),
    ).toBe(false);
    expect(
      isGenuineAssistantResponseForNotifications(
        createMessage({ id: "status", messageType: "status", content: "Working…" }),
      ),
    ).toBe(false);
    expect(
      isGenuineAssistantResponseForNotifications(
        createMessage({ id: "error", messageType: "error", content: "Run failed" }),
      ),
    ).toBe(false);
    expect(isGenuineAssistantResponseForNotifications(createMessage({ content: " " }))).toBe(false);
  });

  it("baselines hydrated history and ignores older pages loaded later", () => {
    const initial = createNotificationNudgeConversationObservation(10_000);
    const hydrated = observeNotificationNudgeAssistantResponses({
      observation: initial,
      messages: [createMessage({ id: "history-answer", timestamp: 1_000 })],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    expect(hydrated.freshAssistantResponse).toBeNull();

    const withOlderPage = observeNotificationNudgeAssistantResponses({
      observation: hydrated.observation,
      messages: [
        createMessage({ id: "older-answer", timestamp: 500 }),
        createMessage({ id: "history-answer", timestamp: 1_000 }),
      ],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    expect(withOlderPage.freshAssistantResponse).toBeNull();
  });

  it("does not become eligible from teammate messages or while AI routing is off", () => {
    const initialized = observeNotificationNudgeAssistantResponses({
      observation: createNotificationNudgeConversationObservation(10_000),
      messages: [],
      historyReady: true,
      assistantRoutingEnabled: false,
    });

    const teammateMessage = createMessage({
      id: "teammate-message",
      role: "user",
      authorId: "teammate",
      messageType: "user",
    });
    const teammateObserved = observeNotificationNudgeAssistantResponses({
      observation: initialized.observation,
      messages: [teammateMessage],
      historyReady: true,
      assistantRoutingEnabled: false,
    });
    expect(teammateObserved.freshAssistantResponse).toBeNull();

    const assistantWhileOff = createMessage({ id: "assistant-while-off" });
    const aiOffObserved = observeNotificationNudgeAssistantResponses({
      observation: teammateObserved.observation,
      messages: [teammateMessage, assistantWhileOff],
      historyReady: true,
      assistantRoutingEnabled: false,
    });
    expect(aiOffObserved.freshAssistantResponse).toBeNull();

    const enabledLater = observeNotificationNudgeAssistantResponses({
      observation: aiOffObserved.observation,
      messages: [teammateMessage, assistantWhileOff],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    expect(enabledLater.freshAssistantResponse).toBeNull();
  });

  it("emits each live genuine assistant response exactly once", () => {
    const initialized = observeNotificationNudgeAssistantResponses({
      observation: createNotificationNudgeConversationObservation(10_000),
      messages: [],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    const response = createMessage({ id: "live-answer", timestamp: 10_100 });
    const received = observeNotificationNudgeAssistantResponses({
      observation: initialized.observation,
      messages: [response],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    expect(received.freshAssistantResponse?.id).toBe("live-answer");

    const repeated = observeNotificationNudgeAssistantResponses({
      observation: received.observation,
      messages: [response],
      historyReady: true,
      assistantRoutingEnabled: true,
    });
    expect(repeated.freshAssistantResponse).toBeNull();
  });
});
