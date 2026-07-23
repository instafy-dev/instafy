import { describe, expect, it } from "vitest";

import {
  isStandaloneAssistantGroupMessageType,
  resolvePreviousAssistantHandleAcrossTurns,
  shouldAssistantMessagesShareVisualGroup,
} from "../assistantMessageGrouping";

describe("assistantMessageGrouping", () => {
  it("keeps the previous assistant handle across a user turn", () => {
    const messages = [
      { role: "assistant", handle: "octo" },
      { role: "user", handle: null },
      { role: "assistant", handle: "octo" },
    ];

    expect(
      resolvePreviousAssistantHandleAcrossTurns(messages, 2, (message) => message.handle),
    ).toBe("octo");
  });

  it("resolves the previous assistant handle for contiguous assistant messages", () => {
    const messages = [
      { role: "assistant", handle: "octo" },
      { role: "assistant", handle: "octo" },
    ];

    expect(
      resolvePreviousAssistantHandleAcrossTurns(messages, 1, (message) => message.handle),
    ).toBe("octo");
  });

  it("resolves the latest assistant handle even across multiple user messages", () => {
    const messages = [
      { role: "assistant", handle: "octo" },
      { role: "user", handle: null },
      { role: "user", handle: null },
      { role: "assistant", handle: "builder-bot" },
    ];

    expect(
      resolvePreviousAssistantHandleAcrossTurns(messages, 3, (message) => message.handle),
    ).toBe("octo");
  });

  it("treats thread preview messages as standalone visual groups", () => {
    expect(isStandaloneAssistantGroupMessageType("agent_job_thread")).toBe(true);
    expect(
      shouldAssistantMessagesShareVisualGroup("status", "agent_job_thread"),
    ).toBe(false);
  });

  it("treats controller notices as standalone visual groups", () => {
    expect(isStandaloneAssistantGroupMessageType("runtime_alert")).toBe(true);
    expect(
      shouldAssistantMessagesShareVisualGroup("runtime_alert", "status"),
    ).toBe(false);
  });
});
