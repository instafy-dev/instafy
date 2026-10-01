/** @vitest-environment jsdom */

import { act, useReducer, useRef, type Dispatch } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  conversationsReducer,
  createInitialConversation,
  type ConversationsAction,
  type ConversationsState,
} from "../conversationState";
import { usePendingConversationEffects } from "../usePendingConversationEffects";
import { useConversationAutoTitle } from "../useConversationAutoTitle";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
// A chat with a real title on the controller that this tab has not loaded:
// the space has more chats than the list holds, or the list is still loading.
const UNLOADED_CHAT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const KNOWN_CHAT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ME = "99999999-8888-4777-8666-555555555555";
const TEAMMATE = "77777777-8888-4777-8666-555555555555";

interface HarnessProps {
  placeholderActive: boolean;
  author: string;
  onState: (state: ConversationsState, dispatch: Dispatch<ConversationsAction>) => void;
}

function Harness({ placeholderActive, author, onState }: HarnessProps) {
  const known = {
    ...createInitialConversation({ localId: "known", controllerId: KNOWN_CHAT }),
    title: "Known chat",
    hasRemoteMessages: true,
  };
  const placeholder = createInitialConversation({ localId: "placeholder" });
  const [state, dispatch] = useReducer(conversationsReducer, {
    projectKey: PROJECT_ID,
    conversations: placeholderActive ? [known, placeholder] : [known],
    activeId: placeholderActive ? "placeholder" : "known",
    sequence: 7,
    runMap: {},
  });
  const lastBackgroundAtRef = useRef(0);
  const notifiedMessageIdsRef = useRef(new Set<string>());
  const delivered = useRef(false);
  const pending = delivered.current ? [] : [{
    id: "message-9",
    conversationId: UNLOADED_CHAT,
    projectId: PROJECT_ID,
    sessionId: null,
    createdBy: author,
    promptId: null,
    runId: null,
    role: "user" as const,
    content: "Yes, that one",
    metadata: null,
    createdAt: new Date().toISOString(),
  }];
  usePendingConversationEffects({
    state,
    projectKey: PROJECT_ID,
    currentUserId: ME,
    pendingConversationCreations: [],
    ackConversationCreations: vi.fn(),
    pendingConversationUpdates: [],
    ackConversationUpdates: vi.fn(),
    pendingConversationMessages: pending,
    ackConversationMessages: () => { delivered.current = true; },
    lastBackgroundAtRef,
    notifiedMessageIdsRef,
    dispatch,
    updateControllerConversationMetadata: vi.fn(),
  });
  useConversationAutoTitle({
    conversations: state.conversations,
    currentUserId: ME,
    resolveProjectId: () => PROJECT_ID,
    ensureControllerConversationId: async (_projectId, conversation) => conversation.controllerId,
    setConversationTitle: (id, title) => dispatch({ type: "SET_TITLE", id, title }),
  });
  onState(state, dispatch);
  return null;
}

describe("auto-title for a chat this tab learns of from one incoming message", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: { state: ConversationsState; dispatch: Dispatch<ConversationsAction> } | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    // Managed tier: the controller answers with no title.
    requestTitleMock.mockReset().mockResolvedValue({ success: true, title: null, error: null });
    updateMetadataMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function settle() {
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function run(placeholderActive: boolean, author: string) {
    await act(async () => root.render(
      <Harness
        placeholderActive={placeholderActive}
        author={author}
        onState={(state, dispatch) => { latest = { state, dispatch }; }}
      />,
    ));
    await settle();
  }

  function unloadedChat() {
    return latest?.state.conversations.find((conversation) => conversation.controllerId === UNLOADED_CHAT) ?? null;
  }

  it.each([
    ["a teammate's reply", false, TEAMMATE],
    ["a reply sent from another device", false, ME],
    ["a reply bound to the empty chat on screen", true, ME],
  ])("never titles that chat from %s", async (_case, placeholderActive, author) => {
    await run(placeholderActive, author);
    const chat = unloadedChat();
    expect(chat?.title).toMatch(/^Conversation \d+$/);
    expect(chat?.remoteSummaryPending).toBe(true);
    expect(requestTitleMock).not.toHaveBeenCalled();
    expect(updateMetadataMock).not.toHaveBeenCalled();
  });

  it("still leaves it alone once the chat list confirms it with earlier history", async () => {
    await run(false, ME);
    const chat = unloadedChat()!;
    await act(async () => {
      latest!.dispatch({ type: "SET_REMOTE_HISTORY", id: chat.localId, hasMessages: true });
      latest!.dispatch({ type: "SET_REMOTE_SUMMARY_PENDING", id: chat.localId, pending: false });
    });
    await settle();
    // The local list holds only the reply, so the opening message is unknown.
    expect(requestTitleMock).toHaveBeenCalledWith({ projectId: PROJECT_ID, message: "Yes, that one" });
    expect(updateMetadataMock).not.toHaveBeenCalled();
    expect(unloadedChat()?.title).toMatch(/^Conversation \d+$/);
  });
});
