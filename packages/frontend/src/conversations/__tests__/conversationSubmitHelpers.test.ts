import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../screens/studio/types";
import {
  mimeTypeToExtension,
  patchConversationMessageMetadata,
  sanitizeChatUploadFileName,
  shouldRetryChatImageUploadError,
} from "../conversationSubmitHelpers";

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    role: "user",
    content: "Hello",
    timestamp: 1,
    files: null,
    messageType: "user",
    metadata: null,
    ...overrides,
  };
}

describe("conversationSubmitHelpers", () => {
  it("sanitizes upload names and falls back to a default name", () => {
    expect(sanitizeChatUploadFileName(" cover shot?.png ")).toBe("cover-shot-.png");
    expect(sanitizeChatUploadFileName("   ")).toBe("image");
  });

  it("maps known mime types and falls back to a generic extension", () => {
    expect(mimeTypeToExtension("image/jpeg")).toBe("jpg");
    expect(mimeTypeToExtension("image/svg+xml")).toBe("svg");
    expect(mimeTypeToExtension("application/octet-stream")).toBe("img");
  });

  it("retries transient upload failures and ignores permanent ones", () => {
    expect(shouldRetryChatImageUploadError("Failed to fetch")).toBe(true);
    expect(shouldRetryChatImageUploadError("Origin apply failed (500)")).toBe(true);
    expect(shouldRetryChatImageUploadError("runtime_not_ready")).toBe(true);
    expect(shouldRetryChatImageUploadError("Origin apply failed (400)")).toBe(false);
    expect(shouldRetryChatImageUploadError("unsupported file type")).toBe(false);
    expect(shouldRetryChatImageUploadError("request origin access token failed (403): origin is not bound to the requested active runtime")).toBe(false);
    expect(shouldRetryChatImageUploadError("request origin access token failed (403): timeout policy denied")).toBe(false);
    expect(shouldRetryChatImageUploadError("request origin access token failed (503): runtime is starting")).toBe(true);
    expect(shouldRetryChatImageUploadError("origin apply failed (429): try later")).toBe(true);
  });

  it("patches conversation message metadata without dropping existing fields", () => {
    let updatedMetadata: ChatMessage["metadata"] | null = null;

    patchConversationMessageMetadata(
      (_conversationId, _messageId, updater) => {
        updatedMetadata = updater(
          createMessage({
            metadata: {
              existing: true,
            },
          }),
        ).metadata;
      },
      "conversation-1",
      "message-1",
      {
        uploaded: true,
      },
    );

    expect(updatedMetadata).toEqual({
      existing: true,
      uploaded: true,
    });
  });
});
