/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationState } from "../conversationState";
import type { ChatMessage } from "../../screens/studio/types";

const requestTitleMock = vi.hoisted(() => vi.fn());
const updateMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return {
    ...actual,
    controllerClient: {
      ...actual.controllerClient,
      conversations: {
        ...actual.controllerClient.conversations,
        requestTitle: requestTitleMock,
        updateMetadata: updateMetadataMock,
      },
    },
  };
});

import { useConversationAutoTitle } from "../useConversationAutoTitle";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const ME = "user-a";
let nextConversation = 0;

function userMessage(content: string, index: number, metadata: Record<string, unknown> | null = null): ChatMessage {
  return {
    id: `user-${index}`,
    role: "user",
    authorId: ME,
    content,
    timestamp: Date.now() + index,
    files: null,
    messageType: "user",
    metadata,
  };
}

function buildConversation(messages: ChatMessage[]): ConversationState {
  nextConversation += 1;
  return {
    localId: `turn-engine-conversation-${nextConversation}`,
    controllerId: `turn-engine-controller-${nextConversation}`,
    title: "New chat",
    parentConversationId: null,
    threadKind: null,
    hasRemoteMessages: false,
    messages,
  } as unknown as ConversationState;
}

function Harness({ conversations }: { conversations: ConversationState[] }) {
  useConversationAutoTitle({
    conversations,
    currentUserId: ME,
    resolveProjectId: () => PROJECT_ID,
    ensureControllerConversationId: async (_projectId, conversation) => conversation.controllerId,
    setConversationTitle: vi.fn(),
  });
  return null;
}

describe("useConversationAutoTitle and turn-engine turns", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    requestTitleMock.mockReset().mockResolvedValue({ success: true, title: null, error: null });
    updateMetadataMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAndSettle(conversations: ConversationState[]) {
    await act(async () => root.render(<Harness conversations={conversations} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("never seeds a title with a message that claims a turn engine, or that the controller stamped", async () => {
    await renderAndSettle([
      buildConversation([userMessage("Fix the failing login test", 0, { turnEngine: "claude-code" })]),
      buildConversation([userMessage("Rename the settings page", 0, { aiAccessMode: "claude-code" })]),
    ]);
    expect(requestTitleMock).not.toHaveBeenCalled();
  });

  it("passes over a later turn-engine message to an earlier one of the chat's own", async () => {
    await renderAndSettle([
      buildConversation([
        userMessage("Plan the spring launch", 0),
        userMessage("Fix the failing login test", 1, { aiAccessMode: "claude-code" }),
      ]),
    ]);
    expect(requestTitleMock).toHaveBeenCalledTimes(1);
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "Plan the spring launch" });
  });

  it("still seeds a title with any other message", async () => {
    await renderAndSettle([
      buildConversation([userMessage("Plan the summer launch", 0, { aiAccessMode: "managed" })]),
    ]);
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "Plan the summer launch" });
  });
});
