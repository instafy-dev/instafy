import { describe, expect, it } from "vitest";
import { normalizeChatMessageStashEnvelope } from "../chatMessageStashEnvelope";

describe("normalizeChatMessageStashEnvelope", () => {
  it("restores targeting, browser, metadata, and runtime fields", () => {
    expect(
      normalizeChatMessageStashEnvelope({
        targetAgentHandles: ["@Octo", "octo", "planner"],
        browserPageTarget: {
          id: "page-1",
          url: "https://example.test/",
          host: "example.test",
          label: "Example",
        },
        browserLaunchMode: "new_page",
        metadata: { replyContext: { messageId: "message-1" } },
        runtimeOverride: {
          runtimeId: "runtime-1",
          runtimeDisplayName: "Desktop",
          preferRuntime: true,
        },
      }),
    ).toEqual({
      targetAgentHandles: ["octo", "planner"],
      browserPageTarget: {
        id: "page-1",
        url: "https://example.test/",
        host: "example.test",
        label: "Example",
      },
      browserLaunchMode: "new_page",
      metadata: { replyContext: { messageId: "message-1" } },
      runtimeOverride: {
        runtimeId: "runtime-1",
        runtimeDisplayName: "Desktop",
        preferRuntime: true,
      },
    });
  });

  it("never restores a turn-engine claim, nor the runtime it pinned", () => {
    expect(
      normalizeChatMessageStashEnvelope({
        targetAgentHandles: ["octo"],
        metadata: { turnEngine: "claude-code", replyContext: { messageId: "message-1" } },
        runtimeOverride: { runtimeId: "desktop-runtime", runtimeDisplayName: null, preferRuntime: false },
      }),
    ).toEqual({
      targetAgentHandles: ["octo"],
      browserPageTarget: null,
      browserLaunchMode: null,
      metadata: { replyContext: { messageId: "message-1" } },
      runtimeOverride: null,
    });
  });

  it("fails closed to a text-only untargeted envelope", () => {
    expect(normalizeChatMessageStashEnvelope({ targetAgentHandles: [null], runtimeOverride: [] })).toEqual({
      targetAgentHandles: [],
      browserPageTarget: null,
      browserLaunchMode: null,
      metadata: null,
      runtimeOverride: null,
    });
  });
});
