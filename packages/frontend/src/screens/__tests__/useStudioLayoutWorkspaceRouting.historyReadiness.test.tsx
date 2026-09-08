// @vitest-environment jsdom
import { Component, StrictMode, act, createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../../workspace/WorkspaceTabsProvider";
import { conversationsReducer, createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import { useStudioLayoutWorkspaceRouting } from "../useStudioLayoutWorkspaceRouting";
import type { StudioPanel } from "../studio/types";
import type { LeftDrawerPanel } from "../useStudioLayoutChromeState";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REMOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW_REMOTE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const noop = () => {};
const workspace = { files: [] };
type Scope = { project: string; projectKey: string; conversations: ConversationState[]; selected: string; resolved: boolean };
type State = Scope & { panel: StudioPanel; setPanel: (panel: StudioPanel) => void; select: (id: string) => void; markRead: (id: string) => void };
const FixtureContext = createContext<State | null>(null);
function useFixtureState() { return useContext(FixtureContext)!; }
function useFixtureConversations() {
  const state = useFixtureState();
  return {
    conversations: state.conversations, activeConversationId: state.selected,
    selectConversation: state.select, markConversationRead: state.markRead,
    createConversation: () => { throw new Error("Routing must not create a conversation to force readiness"); },
    remoteConversationHistoryResolved: state.resolved, projectKey: state.projectKey,
  };
}
vi.mock("../../conversations/ConversationsProvider", () => ({ useConversations: () => useFixtureConversations() }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: useFixtureState().project }) }));
vi.mock("../../workspace/useWorkspace", () => ({ useWorkspaceUi: () => { const state = useFixtureState(); return { activePanel: state.panel, setActivePanel: state.setPanel }; } }));
vi.mock("../../code/useCode", () => ({ useCode: () => ({ workspace, setActiveFile: noop }) }));

class TestBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div data-testid="routing-error">Navigation failed</div> : this.props.children; }
}

describe("routing with the real tab owner's history readiness", () => {
  let root: Root;
  let container: HTMLDivElement;
  let updateScope: (update: (scope: Scope) => Scope) => void;
  let navigateTo: ReturnType<typeof useNavigate>;
  let strictMode: boolean;
  const placeholder = () => ({ ...createInitialConversation({ localId: "new-space-placeholder" }), createdAt: 1 });
  const oldChat = () => ({ ...createInitialConversation({ localId: "old-chat", controllerId: REMOTE }), createdAt: 1 });

  function Workspace() {
    const tabs = useWorkspaceTabs(), state = useFixtureState(), location = useLocation(), navigate = useNavigate();
    navigateTo = navigate;
    const [drawer, setDrawer] = useState<LeftDrawerPanel | null>(null);
    const tab = tabs.activeTab;
    useStudioLayoutWorkspaceRouting({
      activeConversationControllerId: state.conversations.find(c => c.localId === state.selected)?.controllerId ?? null,
      activeConversationId: state.selected, activePanel: state.panel, activeProjectId: state.project,
      activeWorkspaceGitReviewReturnTabId: null, activeWorkspaceReviewTabId: null,
      activeWorkspaceTabConversationId: tab?.kind === "jobThread" ? tab.conversationId : null,
      activeWorkspaceTabId: tab?.id ?? null, activeWorkspaceTabJobId: tab?.kind === "jobThread" ? tab.jobId : null,
      activeWorkspaceTabKind: tab?.kind ?? null, activeWorkspaceTabPanel: tab?.kind === "panel" ? tab.panel : null,
      conversationTabsReady: tabs.conversationTabsReady,
      consumeUrlNavigation: tabs.consumeUrlNavigation, conversations: state.conversations, conversationsProjectKey: state.projectKey,
      focusWorkspaceTab: tabs.focusTab, isLargeScreen: false, leftDrawer: drawer,
      locationPathname: location.pathname, locationSearch: location.search, locationKey: location.key, locationState: location.state, navigate,
      openConversationTab: tabs.openConversationTab, openJobThreadTab: tabs.openJobThreadTab, openPanelTab: tabs.openPanelTab,
      peekUrlNavigation: tabs.peekUrlNavigation, projectReadyForWorkspace: true, requestUrlNavigation: tabs.requestUrlNavigation,
      restoreGitReviewTab: tabs.restoreGitReviewTab, selectConversation: state.select, setConversationControllerId: noop,
      setIsProjectLauncherOpen: noop, setLeftDrawer: setDrawer, setMobileSidebarOpen: noop, workspaceTabs: tabs.tabs,
    });
    return <>
      <output data-testid="tab">{tab?.kind === "panel" ? tab.panel : tab?.kind ?? "pending"}</output>
      <output data-testid="tab-chat">{tab?.kind === "conversation" ? tab.conversationId : ""}</output>
      <output data-testid="drawer">{drawer}</output>
      <output data-testid="ready">{String(tabs.conversationTabsReady)}</output>
    </>;
  }
  function Fixture() {
    const [scope, setScope] = useState<Scope>(() => ({ project: A, projectKey: A, conversations: [oldChat()], selected: "old-chat", resolved: true }));
    const [panel, setPanel] = useState<StudioPanel>("projects");
    updateScope = setScope;
    const select = useCallback((selected: string) => setScope(old => old.selected === selected ? old : { ...old, selected }), []);
    // Opening a real conversation tab marks it read. Use the real reducer:
    // that creates a new array even when unreadCount was already zero, unlike
    // a no-op fixture which hides the pending-history reopen/strip loop.
    const markRead = useCallback((id: string) => setScope(old => ({ ...old, conversations: conversationsReducer({
      projectKey: old.projectKey, conversations: old.conversations, activeId: old.selected, sequence: 2, runMap: {},
    }, { type: "MARK_READ", id }).conversations })), []);
    return <FixtureContext.Provider value={{ ...scope, panel, setPanel, select, markRead }}><WorkspaceTabsProvider><Workspace /></WorkspaceTabsProvider></FixtureContext.Provider>;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    strictMode = false;
    localStorage.clear();
    window.history.replaceState({ idx: 2, key: "spaces-overview" }, "", `/studio?projectId=${A}&panel=projects`);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.restoreAllMocks();
    delete window.__INSTAFY_WORKSPACE_TABS_DEBUG__;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const read = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
  const visit = () => ({ idx: window.history.state.idx, key: window.history.state.usr?.instafyVisitKey ?? window.history.state.key, length: window.history.length });
  const render = () => act(async () => root.render(<BrowserRouter>{strictMode
    ? <StrictMode><TestBoundary><Fixture /></TestBoundary></StrictMode>
    : <TestBoundary><Fixture /></TestBoundary>}</BrowserRouter>));
  async function enterPendingSpace(suffix = "") {
    await render();
    expect(read("tab")).toBe("projects");
    await act(async () => {
      updateScope(() => ({ project: B, projectKey: B, conversations: [placeholder()], selected: "new-space-placeholder", resolved: false }));
      await navigateTo(`/studio?projectId=${B}${suffix}`);
    });
  }

  it.each([
    { suffix: "", fetched: false }, { suffix: "&panel=chat", fetched: false },
    { suffix: "", fetched: true }, { suffix: "&panel=chat", fetched: true },
    { suffix: "", fetched: true, strict: true }, { suffix: "&panel=chat", fetched: true, strict: true },
  ])("waits without a render loop for genuinely unresolved placeholder history ($suffix, fetched=$fetched, strict=$strict)", async ({ suffix, fetched, strict = false }) => {
    strictMode = strict;
    const errors = vi.spyOn(console, "error").mockImplementation(noop);
    await enterPendingSpace(suffix);
    expect(read("routing-error")).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    expect(read("ready")).toBe("false");
    expect(read("tab")).toBe("projects");
    expect(window.location.search).toBe(`?projectId=${B}${suffix}`);
    const before = visit();
    await act(async () => updateScope(scope => ({ ...scope, resolved: true,
      conversations: fetched ? [{ ...scope.conversations[0], controllerId: NEW_REMOTE }] : scope.conversations,
    })));
    expect(read("routing-error")).toBeUndefined();
    expect(read("tab")).toBe("conversation");
    expect(read("tab-chat")).toBe("new-space-placeholder");
    expect(read("ready")).toBe("true");
    expect(visit()).toEqual(before);
    expect(new URLSearchParams(window.location.search).get("projectId")).toBe(B);
    expect(new URLSearchParams(window.location.search).get("conversationId")).not.toBe("old-chat");
    if (fetched) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
      expect(new URLSearchParams(window.location.search).get("conversationControllerId")).toBe(NEW_REMOTE);
      expect(visit()).toEqual(before);
    }
  });

  it("uses the owner's existing usable-local-draft predicate, not a remote-fetch-only gate", async () => {
    await enterPendingSpace();
    expect(read("ready")).toBe("false");
    await act(async () => updateScope(scope => ({ ...scope, conversations: [{ ...scope.conversations[0], draft: "Inert local draft" }] })));
    expect(read("ready")).toBe("true");
    expect(read("tab")).toBe("conversation");
    expect(read("routing-error")).toBeUndefined();
  });

  it("never pairs the previous space's conversations with a new space before its owner catches up", async () => {
    await render();
    await act(async () => {
      updateScope(scope => ({ ...scope, project: B }));
      await navigateTo(`/studio?projectId=${B}`);
    });
    expect(read("ready")).toBe("false");
    expect(read("tab")).toBe("projects");
    expect(window.location.search).toBe(`?projectId=${B}`);
    await act(async () => updateScope(() => ({ project: B, projectKey: B, conversations: [placeholder()], selected: "new-space-placeholder", resolved: true })));
    expect(read("ready")).toBe("true");
    expect(read("tab-chat")).toBe("new-space-placeholder");
    expect(new URLSearchParams(window.location.search).get("conversationControllerId")).not.toBe(REMOTE);
  });

  it.each(["history", "workspaces", "files", "sourceControl"] as const)("keeps the URL-owned %s drawer open as pending chat history resolves", async (drawer) => {
    await enterPendingSpace("&panel=settings");
    expect(read("tab")).toBe("settings");
    await act(async () => navigateTo(`/studio?projectId=${B}&panel=projects`));
    expect(read("tab")).toBe("projects");
    await act(async () => navigateTo(`/studio?projectId=${B}&workspaceTab=${drawer}`));
    expect(read("routing-error")).toBeUndefined();
    expect(read("drawer")).toBe(drawer);
    const before = visit();
    await act(async () => updateScope(scope => ({ ...scope, resolved: true })));
    expect(read("tab")).toBe("conversation");
    expect(read("drawer")).toBe(drawer);
    expect(visit()).toEqual(before);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(new URLSearchParams(window.location.search).get("workspaceTab")).toBe(drawer);
    expect(read("drawer")).toBe(drawer);
    expect(visit()).toEqual(before);
  });

  it("supersedes an older release and cancels every queued release on unmount", async () => {
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      const id = ++nextFrame; frames.set(id, callback); return id;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const errors = vi.spyOn(console, "error").mockImplementation(noop);
    await enterPendingSpace();
    const oldFrames = [...frames.entries()];
    expect(oldFrames.length).toBeGreaterThan(0);
    await act(async () => updateScope(scope => ({ ...scope, resolved: true })));
    for (const [id] of oldFrames) expect(cancel).toHaveBeenCalledWith(id);
    const currentIds = [...frames.keys()];
    expect(currentIds.length).toBeGreaterThan(0);
    // Even a callback already dequeued by the browser cannot release a newer
    // application or enqueue its second frame after cancellation.
    await act(async () => oldFrames.forEach(([, callback]) => callback(0)));
    expect([...frames.keys()]).toEqual(currentIds);
    const currentFrames = [...frames.values()];
    const before = window.location.href;
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(frames.size).toBe(0);
    await act(async () => currentFrames.forEach(callback => callback(0)));
    expect(frames.size).toBe(0);
    expect(window.location.href).toBe(before);
    expect(errors).not.toHaveBeenCalled();
  });
});
