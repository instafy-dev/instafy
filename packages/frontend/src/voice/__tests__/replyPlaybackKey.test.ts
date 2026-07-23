import { describe, expect, it } from "vitest";
import {
  findLatestDisplayableAssistantReply,
  findLatestSpeakableAssistantReply,
  isDisplayableAssistantReplyMessage,
  isSpeakableAssistantReplyMessage,
  resolveSpeechReplyMessageForPlayback,
  resolveSpeechReplyPlaybackKey,
} from "../replyPlaybackKey";

describe("replyPlaybackKey", () => {
  it("prefers job or run identifiers over volatile message ids", () => {
    expect(
      resolveSpeechReplyPlaybackKey({
        id: "assistant-2",
        metadata: {
          jobId: "job-123",
        },
      }),
    ).toBe("job-123");
    expect(
      resolveSpeechReplyPlaybackKey({
        id: "assistant-3",
        metadata: {
          run_id: "run-123",
        },
      }),
    ).toBe("run-123");
  });

  it("excludes timeline assistant messages from spoken playback", () => {
    expect(
      isSpeakableAssistantReplyMessage({
        id: "token-usage-1",
        role: "assistant",
        content: "cache 0, output 125",
        timestamp: 1,
        messageType: "token_usage",
      }),
    ).toBe(false);
  });

  it("excludes assistant status messages from spoken playback", () => {
    expect(
      isSpeakableAssistantReplyMessage({
        id: "status-1",
        role: "assistant",
        content: "Retrying: the latest request requires workspace file changes, but the Codex reply produced no files.",
        timestamp: 1,
        messageType: "status",
      }),
    ).toBe(false);
  });

  it("excludes Codex fallback summaries even when they arrive as plain assistant text", () => {
    expect(
      isSpeakableAssistantReplyMessage({
        id: "assistant-fallback-1",
        role: "assistant",
        content: "Codex automation completed, but no final assistant message was returned.",
        timestamp: 1,
        messageType: null,
      }),
    ).toBe(false);
  });

  it("allows assistant error messages for display but not for spoken playback", () => {
    const message = {
      id: "assistant-error-1",
      role: "assistant" as const,
      content: "The provider could not execute that action.",
      timestamp: 1,
      messageType: "error",
    };

    expect(isDisplayableAssistantReplyMessage(message)).toBe(true);
    expect(isSpeakableAssistantReplyMessage(message)).toBe(false);
  });

  it("returns the latest plain assistant reply", () => {
    const result = findLatestSpeakableAssistantReply([
      {
        id: "assistant-1",
        role: "assistant",
        content: "Real reply",
        timestamp: 1,
        messageType: null,
      },
      {
        id: "token-usage-1",
        role: "assistant",
        content: "cache 0, output 125",
        timestamp: 2,
        messageType: "token_usage",
      },
      {
        id: "status-1",
        role: "assistant",
        content:
          "Retrying: the latest request requires workspace file changes, but the Codex reply produced no files.",
        timestamp: 3,
        messageType: "status",
      },
      {
        id: "assistant-fallback-1",
        role: "assistant",
        content: "Codex automation completed, but no final assistant message was returned.",
        timestamp: 4,
        messageType: null,
      },
    ]);

    expect(result?.id).toBe("assistant-1");
  });

  it("returns the latest displayable assistant reply even when it is an error", () => {
    const result = findLatestDisplayableAssistantReply([
      {
        id: "assistant-1",
        role: "assistant",
        content: "Real reply",
        timestamp: 1,
        messageType: null,
      },
      {
        id: "assistant-error-1",
        role: "assistant",
        content: "The provider could not execute that action.",
        timestamp: 2,
        messageType: "error",
      },
    ]);

    expect(result?.id).toBe("assistant-error-1");
  });

  it("does not replay the current floor reply when entering voice mode", () => {
    const message = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "Already visible reply",
      timestamp: 1,
      messageType: null,
    };

    expect(resolveSpeechReplyMessageForPlayback(message, "assistant-1")).toBeNull();
    expect(resolveSpeechReplyMessageForPlayback(message, "assistant-0")).toMatchObject({
      id: "assistant-1",
      content: "Already visible reply",
      playbackKey: "assistant-1",
    });
  });
});
