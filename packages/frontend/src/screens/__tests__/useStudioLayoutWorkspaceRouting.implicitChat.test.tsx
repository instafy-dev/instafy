// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioLayoutWorkspaceRouting } from "../useStudioLayoutWorkspaceRouting";
import type { StudioPanel } from "../studio/types";
import type { ConversationState } from "../../conversations/ConversationsProvider";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTROLLER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCAL = "local-chat";
const conversation = { localId: LOCAL, controllerId: CONTROLLER, title: "Conversation 1", lifecycleStatus: "active" } as ConversationState;
type Tab = { id: string; kind: string; panel: StudioPanel | null; jobId: string | null };
const chatTab: Tab = { id: "chat-tab", kind: "conversation", panel: null, jobId: null };
const projectsTab: Tab = { id: "projects-tab", kind: "panel", panel: "projects", jobId: null };
const reviewTab: Tab = { id: "review-tab", kind: "gitReview", panel: null, jobId: null };
const jobTab: Tab = { id: "job-tab", kind: "jobThread", panel: null, jobId: "job-a" };

describe("implicit chat route rendered-tab reconciliation", () => {
  let root: Root;
  let container: HTMLDivElement;
  let restoreTab: (tab: Tab | null, panel?: StudioPanel) => void;
  let initialTab: Tab | null;
  let initialPanel: StudioPanel;
  let pendingIntent: "push" | "replace" | null;
  let projectReady: boolean;
  let conversationsProjectKey: string;
  let selectedControllerId: string | null;
  const openedPanels = vi.fn();
  const openedConversations = vi.fn();
  const openedJobs = vi.fn();
  const selectedConversations = vi.fn();
  const focusedTabs = vi.fn();
  const restoredReviews = vi.fn(() => false);
  const navigations = vi.fn();
  const peek = () => pendingIntent;
  const consume = () => { const current = pendingIntent; pendingIntent = null; return current; };
  function Harness() {
    const location = useLocation();
    const navigate = useNavigate();
    const [tab, setTab] = useState(initialTab);
    const [panel, setPanel] = useState(initialPanel);
    const [leftDrawer, setLeftDrawer] = useState<"history" | "files" | "sourceControl" | null>(null);
    restoreTab = (next, nextPanel) => { setTab(next); if (nextPanel) setPanel(nextPanel); };
    const openPanelTab = useCallback((next: StudioPanel) => {
      openedPanels(next); setPanel(next);
      setTab(next === "chat" ? chatTab : { id: `${next}-tab`, kind: "panel", panel: next, jobId: null });
    }, []);
    useStudioLayoutWorkspaceRouting({
      activeConversationControllerId: selectedControllerId, activeConversationId: LOCAL,
      activePanel: panel, activeProjectId: PROJECT,
      activeWorkspaceGitReviewReturnTabId: null, activeWorkspaceReviewTabId: tab?.kind === "gitReview" ? tab.id : null,
      // Studio's adapter supplies this only for job threads, not normal chats.
      activeWorkspaceTabConversationId: tab?.kind === "jobThread" ? LOCAL : null,
      activeWorkspaceTabId: tab?.id ?? null, activeWorkspaceTabJobId: tab?.jobId ?? null,
      activeWorkspaceTabKind: tab?.kind ?? null, activeWorkspaceTabPanel: tab?.panel ?? null,
      conversationTabsReady: true,
      consumeUrlNavigation: consume, conversations: [{ ...conversation, controllerId: selectedControllerId }], conversationsProjectKey,
      focusWorkspaceTab: focusedTabs, isLargeScreen: false, leftDrawer,
      locationPathname: location.pathname, locationSearch: location.search,
      locationKey: location.key, locationState: location.state,
      navigate: (to, options) => { navigations(to, options); void navigate(to, options); },
      openConversationTab: openedConversations, openJobThreadTab: openedJobs,
      openPanelTab, peekUrlNavigation: peek, projectReadyForWorkspace: projectReady,
      requestUrlNavigation: mode => { pendingIntent = mode ?? "push"; }, restoreGitReviewTab: restoredReviews,
      selectConversation: selectedConversations, setConversationControllerId: vi.fn(),
      setIsProjectLauncherOpen: vi.fn(), setLeftDrawer, setMobileSidebarOpen: vi.fn(),
      workspaceTabs: [chatTab, projectsTab, reviewTab, jobTab],
    });
    return <div data-testid="rendered-tab">{tab ? tab.kind === "panel" ? tab.panel : tab.kind : "pending"}</div>;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); initialTab = chatTab; initialPanel = "chat";
    pendingIntent = null; projectReady = true; conversationsProjectKey = PROJECT;
    selectedControllerId = CONTROLLER;
    window.history.replaceState({ idx: 4, key: "new-space-visit" }, "", `/studio?projectId=${PROJECT}&conversationId=${LOCAL}&conversationControllerId=${CONTROLLER}`);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = () => act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  const rendered = () => container.querySelector('[data-testid="rendered-tab"]')?.textContent;

  it.each([
    { panel: "chat", withController: true }, { panel: "projects", withController: true },
    { panel: "chat", withController: false }, { panel: "projects", withController: false },
  ] as const)("repairs late retained overview after the same URL was hydrated (activePanel=$panel, controller=$withController)", async ({ panel, withController }) => {
    if (!withController) {
      selectedControllerId = null;
      window.history.replaceState(window.history.state, "", `/studio?projectId=${PROJECT}&conversationId=${LOCAL}`);
    }
    await render();
    expect(rendered()).toBe("conversation");
    const before = { url: window.location.href, key: window.history.state.key, idx: window.history.state.idx, length: window.history.length };
    // A new project's passive tab restoration can retain a non-conversation
    // tab after the child routing layout effect already accepted this URL.
    await act(async () => restoreTab(projectsTab, panel));
    expect(rendered()).toBe("conversation");
    expect(openedPanels).toHaveBeenCalledExactlyOnceWith("chat");
    expect(selectedConversations).not.toHaveBeenCalled();
    expect(navigations).not.toHaveBeenCalled();
    expect({ url: window.location.href, key: window.history.state.key, idx: window.history.state.idx, length: window.history.length }).toEqual(before);
  });

  it("reconciles the first render even when selected conversation and activePanel already say chat", async () => {
    initialTab = projectsTab;
    await render();
    expect(rendered()).toBe("conversation");
    expect(openedPanels).toHaveBeenCalledExactlyOnceWith("chat");
    expect(navigations).not.toHaveBeenCalled();
  });

  it("does not force a placeholder tab while new-space conversation tabs are intentionally pending", async () => {
    initialTab = null;
    await render();
    expect(rendered()).toBe("pending");
    expect(openedPanels).not.toHaveBeenCalled();
    expect(openedConversations).not.toHaveBeenCalled();
    expect(navigations).not.toHaveBeenCalled();
  });

  it.each([reviewTab, jobTab])("preserves the dedicated $kind route without replacing it with default chat", async tab => {
    initialTab = tab;
    const params = new URLSearchParams(window.location.search);
    if (tab.kind === "gitReview") params.set("reviewTab", tab.id);
    else params.set("jobId", tab.jobId!);
    window.history.replaceState(window.history.state, "", `/studio?${params}`);
    await render();
    expect(rendered()).toBe(tab.kind);
    expect(openedPanels).not.toHaveBeenCalled();
    expect(openedConversations).not.toHaveBeenCalled();
    expect(openedJobs).not.toHaveBeenCalled();
    expect(navigations).not.toHaveBeenCalled();
  });

  it("does not override a legitimate pending legacy tab push", async () => {
    await render();
    pendingIntent = "push";
    await act(async () => restoreTab(projectsTab, "projects"));
    expect(rendered()).toBe("projects");
    expect(openedPanels).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("panel")).toBe("projects");
    expect(window.history.state.idx).toBe(5);
  });

  it.each(["access", "conversations"])("waits for matching destination %s readiness", async scope => {
    initialTab = projectsTab;
    if (scope === "access") projectReady = false;
    else conversationsProjectKey = "old-project";
    await render();
    expect(rendered()).toBe("projects"); expect(openedPanels).not.toHaveBeenCalled();
    projectReady = true; conversationsProjectKey = PROJECT;
    await render();
    expect(rendered()).toBe("conversation"); expect(openedPanels).toHaveBeenCalledExactlyOnceWith("chat");
  });
});
