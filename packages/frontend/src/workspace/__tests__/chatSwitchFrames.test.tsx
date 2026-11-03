// @vitest-environment jsdom

import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import type { StudioPanel } from "../../screens/studio/types";
import type { CodeFile } from "../../types";
import { openChat } from "../openChat";
import { StudioDraftsProvider } from "../StudioDrafts";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../WorkspaceTabsProvider";
import { persistWorkspaceTabsState } from "../workspaceTabPersistence";

// A switch never draws the chat it leaves. A local test, Nov 3: right after a
// press on the Seville chat's tab, the GitHub chat stayed on screen for up to
// a quarter second: its Browser view on github.com/login with "Let Octo
// continue", and another time the submit prompt of the form chat. The tab bar
// sent the press through the address, which React Router renders later as a
// transition, and the chat, then its tab, followed in effects after that.

const project = "11111111-1111-4111-8111-111111111111";
const fixture = vi.hoisted(() => ({
  conversations: [] as ConversationState[],
  activeConversationId: null as string | null,
  activePanel: "chat" as StudioPanel,
  workspace: { files: [] as CodeFile[] },
  selectConversation: vi.fn((id: string) => { fixture.activeConversationId = id; }),
  setActivePanel: vi.fn((panel: StudioPanel) => { fixture.activePanel = panel; }),
}));

vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: fixture.conversations,
    activeConversationId: fixture.activeConversationId,
    projectKey: project,
    remoteConversationHistoryResolved: true,
    selectConversation: fixture.selectConversation,
    markConversationRead: vi.fn(),
    createConversation: vi.fn(),
  }),
}));
vi.mock("../../screens/studio/useStudioNavigationPosture", () => ({ useStudioNavigationPosture: () => ({ isLargeScreen: true }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: project }) }));
vi.mock("../useWorkspace", () => ({ useWorkspaceUi: () => ({
  activePanel: fixture.activePanel, setActivePanel: fixture.setActivePanel,
}) }));
vi.mock("../../code/useCode", () => ({ useCode: () => ({ workspace: fixture.workspace, setActiveFile: vi.fn() }) }));

function conversation(id: string): ConversationState {
  return { ...createInitialConversation({ localId: id }), title: `Chat ${id}`, createdAt: 1, controllerId: `remote-${id}` };
}

describe("switching chats", () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: ReturnType<typeof useWorkspaceTabs>;
  /** What each commit drew, in order. */
  let frames: string[];
  /** The chats a chat area was mounted for, in order: each mount reconnects what it holds. */
  let mounts: string[];

  /**
   * The chat area as StudioLayout draws it: keyed by the active tab, holding
   * what it drew for its chat as ChatPanel holds its Browser view and prompts.
   * The GitHub chat waits on a sign-in.
   */
  function ChatArea({ chat }: { chat: string | null }) {
    const [held] = useState(chat);
    useLayoutEffect(() => {
      mounts.push(`${held}`);
    }, [held]);
    return <p>{held === "github" ? "github.com/login · Let Octo continue" : `Chat ${held}`}</p>;
  }
  function Probe() {
    api = useWorkspaceTabs();
    const chat = api.activeTab?.kind === "conversation" ? api.activeTab.conversationId : null;
    return <div key={api.activeTab?.id ?? "empty"}><ChatArea chat={chat} /></div>;
  }
  function Frames() {
    // Reads the tabs, so it draws (and records) every commit they change in.
    useWorkspaceTabs();
    useLayoutEffect(() => {
      frames.push(container.textContent ?? "");
    });
    return null;
  }
  async function render() {
    await act(async () => root.render(
      <StudioDraftsProvider><WorkspaceTabsProvider><Probe /><Frames /></WorkspaceTabsProvider></StudioDraftsProvider>,
    ));
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    window.localStorage.clear();
    window.sessionStorage.clear();
    // The Porto chat has no open tab.
    fixture.conversations = ["seville", "github", "porto"].map(conversation);
    fixture.activeConversationId = "github";
    fixture.activePanel = "chat";
    vi.clearAllMocks();
    // Both chats are open in the tab bar, the GitHub one in front.
    persistWorkspaceTabsState({ projects: { [project]: { conversations: ["seville", "github"], activeConversationId: "github" } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    frames = [];
    mounts = [];
    await render();
    expect(api.activeTab).toMatchObject({ kind: "conversation", conversationId: "github" });
    expect(container.textContent).toBe("github.com/login · Let Octo continue");
    frames = [];
    mounts = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("draws the chat a link or Back selects from the render it is selected in, never the chat it leaves", async () => {
    // The address names the Seville chat: the route selects it, and its tab
    // follows.
    fixture.activeConversationId = "seville";
    await render();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame !== "Chat seville")).toEqual([]);
    expect(api.activeTab).toMatchObject({ kind: "conversation", conversationId: "seville" });
    expect(mounts).toEqual(["seville"]);
  });

  // Back to a chat whose preview tab another chat took, a search result or the
  // phone's Chats sheet selects a chat with no open tab: its tab opens one
  // commit later, and until then the chat area was the previous chat's.
  it("draws a chat without an open tab from the render it is selected in, and keeps it when its tab opens", async () => {
    fixture.activeConversationId = "porto";
    await render();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame !== "Chat porto")).toEqual([]);
    expect(api.activeTab).toMatchObject({ kind: "conversation", conversationId: "porto" });
    expect(api.tabs.some((tab) => tab.kind === "conversation" && tab.conversationId === "porto")).toBe(true);
    // Its area mounted once: the tab that opened is the one it was drawn under.
    expect(mounts).toEqual(["porto"]);
  });

  it("opens a chat of this space in the press on its tab: the next frame is that chat", async () => {
    const navigate = vi.fn();
    await act(async () => openChat({ kind: "conversation", projectId: project, conversationId: "seville" }, {
      activeProjectId: project,
      conversationsProjectKey: project,
      conversations: fixture.conversations,
      navigate,
      open: (id, options) => {
        api.requestUrlPush();
        api.openConversationTab(id, options);
      },
    }, { restoreWorkspace: true }));
    expect(navigate).not.toHaveBeenCalled();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame !== "Chat seville")).toEqual([]);
    expect(mounts).toEqual(["seville"]);
    expect(api.consumeUrlPush()).toBe(true);
  });

  it("sends another space's chat through the address", async () => {
    const navigate = vi.fn();
    const open = vi.fn();
    const destination = { kind: "conversation" as const, projectId: "22222222-2222-4222-8222-222222222222", conversationId: "seville" };
    openChat(destination, {
      activeProjectId: project, conversationsProjectKey: project, conversations: fixture.conversations, navigate, open,
    }, { restoreWorkspace: true });
    expect(open).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(destination);
  });
});
