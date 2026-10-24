// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  createChatSendQueueKey,
  readChatSendQueue,
  restoreEditedQueueItem,
  writeChatSendQueue,
  type QueuedChatSendItem,
} from "../chatSendQueueStorage";

describe("chatSendQueueStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([
    { current: ["a", "c", "new"], expected: ["a", "b", "c", "new"] },
    { current: ["a", "new"], expected: ["a", "b", "new"] },
    { current: ["new"], expected: ["b", "new"] },
    { current: ["b", "a", "c"], expected: ["a", "b", "c"] },
  ])("preserves the original local slot as neighbours change: %j", ({ current, expected }) => {
    const item = (id: string): QueuedChatSendItem => ({
      id, message: id, editorState: null, createdAt: 1, targetAgentHandles: [], browserPageTarget: null, browserLaunchMode: null,
    });
    expect(restoreEditedQueueItem(current.map(item), item("b"), ["a", "b", "c"]).map((entry) => entry.id)).toEqual(expected);
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
