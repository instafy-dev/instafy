import { describe, expect, it } from "vitest";
import {
  createConversationRoutingMetadataPatch,
  extractConversationRoutingPreferences,
  getConversationRoutingMetadataKey,
} from "../conversationRoutingMetadata";

describe("conversationRoutingMetadata", () => {
  it("extracts per-user routing preferences and normalizes handles", () => {
    const userId = "user-123";
    const otherUserId = "user-456";
    const metadata = {
      [getConversationRoutingMetadataKey(otherUserId)]: {
        assistantEnabled: true,
        extraAgentHandles: ["other-agent"],
      },
      [getConversationRoutingMetadataKey(userId)]: {
        assistantEnabled: false,
        extraAgentHandles: [" Scout ", "scout", "camera", "", 42],
      },
    } satisfies Record<string, unknown>;

    expect(extractConversationRoutingPreferences(metadata, userId)).toEqual({
      assistantEnabled: false,
      extraAgentHandles: ["scout", "camera"],
    });
  });

  it("accepts the legacy boolean routing shape", () => {
    const userId = "user-123";
    const metadata = {
      [getConversationRoutingMetadataKey(userId)]: false,
    } satisfies Record<string, unknown>;

    expect(extractConversationRoutingPreferences(metadata, userId)).toEqual({
      assistantEnabled: false,
      extraAgentHandles: [],
    });
  });

  it("builds a per-user metadata patch with normalized handles", () => {
    const userId = "user-123";

    expect(
      createConversationRoutingMetadataPatch(userId, {
        assistantEnabled: true,
        extraAgentHandles: [" Scout ", "camera", "scout"],
      }),
    ).toEqual({
      [getConversationRoutingMetadataKey(userId)]: {
        assistantEnabled: true,
        extraAgentHandles: ["scout", "camera"],
        updatedAt: expect.any(String),
      },
    });
  });
});
