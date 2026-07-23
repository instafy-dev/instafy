// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  createChatSendQueueKey,
  readChatSendQueue,
  writeChatSendQueue,
  type QueuedChatSendItem,
} from "../chatSendQueueStorage";

describe("chatSendQueueStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves an exact Shared Browser runtime override across reloads", () => {
    const key = createChatSendQueueKey("project-1", "conversation-1");
    const item: QueuedChatSendItem = {
      id: "queued-1",
      message: "Click the visible link",
      editorState: null,
      createdAt: 1_786_000_000_000,
      targetAgentHandles: ["octo"],
      browserPageTarget: {
        id: "page-1",
        url: "https://example.com/",
        host: "example.com",
        label: "Example Domain",
      },
      browserLaunchMode: null,
      metadata: { browserTransport: "shared" },
      runtimeOverride: {
        runtimeId: "shared-runtime-1",
        runtimeDisplayName: null,
        preferRuntime: true,
      },
    };

    writeChatSendQueue(key, [item]);

    expect(readChatSendQueue(key)).toEqual([item]);
  });
});
