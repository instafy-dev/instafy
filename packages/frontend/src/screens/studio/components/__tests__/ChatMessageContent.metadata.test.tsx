// @vitest-environment jsdom

import { act, createContext, memo, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationMessageMetadataProvider, useConversationMessageMetadata } from "../../../../conversations/ConversationMessageMetadata";
import { createInitialConversation, type ConversationState } from "../../../../conversations/conversationState";
import { MessageContent } from "../ChatMessageContent";
import { tokenizeChatLine } from "../chatMessageDialect";

const WorkspaceVersion = createContext(0);
const openConversation = vi.fn();
const showStatus = vi.fn();
const metadataRendered = vi.fn();

vi.mock("../chatMessageDialect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chatMessageDialect")>();
  return { ...actual, tokenizeChatLine: vi.fn(actual.tokenizeChatLine) };
});
vi.mock("../../../../conversations/ConversationsProvider", () => ({
  useConversations: () => { throw new Error("Message content must not subscribe to draft state."); },
}));
vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => { throw new Error("Message content must not create a history observer."); },
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => {
    const version = useContext(WorkspaceVersion);
    return {
      openConversationTab: (id: string) => openConversation(version, id),
      openPanelTab: () => {},
      requestUrlPush: () => {},
    };
  },
}));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus }) }));

const MetadataProbe = memo(function MetadataProbe() {
  metadataRendered(useConversationMessageMetadata());
  return null;
});

describe("message metadata subscriptions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const primary = {
    ...createInitialConversation({ localId: "primary" }),
    controllerId: "primary-controller", extraAgentHandles: ["custom-agent"],
  };
  const related = {
    ...createInitialConversation({ localId: "related" }), controllerId: "related-controller",
  };
  const content = "Ask @custom-agent and @new-agent. See [[conversation:related-controller|Related]].";

  async function render(conversations: ConversationState[], version = 0, activeId = "primary") {
    await act(async () => {
      root.render(
        <ConversationMessageMetadataProvider conversations={conversations} activeConversationId={activeId}>
          <WorkspaceVersion.Provider value={version}>
            <MetadataProbe />
            <MessageContent content={content} />
          </WorkspaceVersion.Provider>
        </ConversationMessageMetadataProvider>,
      );
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    metadataRendered.mockClear();
    openConversation.mockClear();
    showStatus.mockClear();
    vi.mocked(tokenizeChatLine).mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not retokenize unchanged bodies on drafts, unread changes, or workspace context churn", async () => {
    await render([primary, related]);
    const calls = vi.mocked(tokenizeChatLine).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(metadataRendered).toHaveBeenCalledTimes(1);

    for (let version = 1; version <= 3; version++) {
      await render([{ ...primary, draft: `Draft ${version}`, unreadCount: version }, related], version);
    }

    expect(metadataRendered).toHaveBeenCalledTimes(1);
    expect(tokenizeChatLine).toHaveBeenCalledTimes(calls);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="chat-message-inline-reference"]')?.click();
    });
    // Stable render callbacks still dispatch through the latest committed workspace.
    expect(openConversation).toHaveBeenCalledWith(3, "related");
  });

  it("updates reference availability and navigation when conversations are added, remapped, or removed", async () => {
    await render([primary]);
    const reference = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-message-inline-reference"]');
    expect(reference()?.getAttribute("aria-label")).toContain("is unavailable");

    await render([primary, related]);
    expect(reference()?.getAttribute("aria-label")).toBe("Open referenced conversation: Related");
    await render([primary, { ...related, localId: "remapped-related" }]);
    await act(async () => { reference()?.click(); });
    expect(openConversation).toHaveBeenLastCalledWith(0, "remapped-related");

    await render([primary]);
    expect(reference()?.getAttribute("aria-label")).toContain("is unavailable");
    await act(async () => { reference()?.click(); });
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(showStatus).toHaveBeenCalledTimes(1);
  });

  it("updates configured mentions on handle changes and active conversation changes", async () => {
    const mentions = () => Array.from(container.querySelectorAll('[data-testid="chat-agent-mention"]')).map((node) => node.textContent);
    await render([primary, related]);
    expect(mentions()).toEqual(["@custom-agent"]);

    await render([{ ...primary, extraAgentHandles: ["new-agent"] }, related]);
    expect(mentions()).toEqual(["@new-agent"]);
    await render([primary, related], 0, "related");
    expect(mentions()).toEqual([]);
  });
});
