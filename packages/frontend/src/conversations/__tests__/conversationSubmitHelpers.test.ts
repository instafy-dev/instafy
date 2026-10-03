import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));
vi.mock("../../lib/supabaseClient", () => ({
  hasSupabaseConfig: true,
  supabase: { storage: { from: () => storage } },
}));

import type { ChatMessage } from "../../screens/studio/types";
import { ChatAttachmentUploadError } from "../../lib/chatAttachments";
import {
  patchConversationMessageMetadata,
  sanitizeChatUploadFileName,
  uploadConversationAttachments,
} from "../conversationSubmitHelpers";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const CONVERSATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

  describe("uploadConversationAttachments", () => {
    beforeEach(() => {
      storage.upload.mockReset().mockResolvedValue({ data: {}, error: null });
      storage.remove.mockReset().mockResolvedValue({ data: [], error: null });
    });

    it("stores each file in the conversation's folder and keeps their order", async () => {
      const attachments = await uploadConversationAttachments({
        projectId: PROJECT,
        conversationId: CONVERSATION,
        files: [
          new File(["a"], "first shot.png", { type: "image/png" }),
          new File(["bb"], "base.txt", { type: "text/plain" }),
        ],
      });
      expect(attachments.map(({ kind, fileName, mimeType, sizeBytes }) => ({ kind, fileName, mimeType, sizeBytes })))
        .toEqual([
          { kind: "image", fileName: "first-shot.png", mimeType: "image/png", sizeBytes: 1 },
          { kind: "file", fileName: "base.txt", mimeType: "text/plain", sizeBytes: 2 },
        ]);
      for (const attachment of attachments) {
        expect(attachment.storagePath.startsWith(`${PROJECT}/${CONVERSATION}/`)).toBe(true);
      }
      expect(storage.upload.mock.calls.map(([path]) => path)).toEqual(
        attachments.map((attachment) => attachment.storagePath),
      );
    });

    it("sends all of a message's attachments or none: a failure removes the stored ones", async () => {
      storage.upload
        .mockResolvedValueOnce({ data: {}, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: "Payload too large", status: 413, statusCode: "413" } });
      const upload = uploadConversationAttachments({
        projectId: PROJECT,
        conversationId: CONVERSATION,
        files: [
          new File(["a"], "a.png", { type: "image/png" }),
          new File(["b"], "b.png", { type: "image/png" }),
        ],
      });
      await expect(upload).rejects.toBeInstanceOf(ChatAttachmentUploadError);
      await expect(upload).rejects.toThrow("Attachments must be 20 MB or smaller.");
      expect(storage.remove).toHaveBeenCalledWith([storage.upload.mock.calls[0][0]]);
    });
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
