// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { StudioDraftsProvider, useStudioDraftStore } from "../StudioDrafts";
import type { CodeFile } from "../../types";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import type { StudioPanel } from "../../screens/studio/types";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../WorkspaceTabsProvider";
import { getTabIdForConversation, getTabIdForJobThread, getTabIdForPanel } from "../workspaceTabFactories";
import { loadPersistedWorkspaceTabs, persistWorkspaceTabsState } from "../workspaceTabPersistence";
import { studioPerformance, type StudioPerformanceSample } from "../../telemetry/studioPerformance";

const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const fixture = vi.hoisted(() => ({
  projectId: "",
  projectKey: "",
  conversations: [] as ConversationState[],
  activeConversationId: null as string | null,
  activePanel: "chat" as StudioPanel,
  historyResolved: true,
  workspace: { files: [] as CodeFile[] },
  selectConversation: vi.fn((id: string) => { fixture.activeConversationId = id; }),
  setActivePanel: vi.fn((panel: StudioPanel) => { fixture.activePanel = panel; }),
  markConversationRead: vi.fn(),
  setActiveFile: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: fixture.conversations,
    activeConversationId: fixture.activeConversationId,
    projectKey: fixture.projectKey,
    remoteConversationHistoryResolved: fixture.historyResolved,
    selectConversation: fixture.selectConversation,
    markConversationRead: fixture.markConversationRead,
    createConversation: fixture.createConversation,
  }),
}));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: fixture.projectId }) }));
vi.mock("../useWorkspace", () => ({ useWorkspaceUi: () => ({
  activePanel: fixture.activePanel, setActivePanel: fixture.setActivePanel,
}) }));
vi.mock("../../code/useCode", () => ({ useCode: () => ({
  workspace: fixture.workspace, setActiveFile: fixture.setActiveFile,
}) }));

function conversation(id: string, overrides: Partial<ConversationState> = {}): ConversationState {
  return { ...createInitialConversation({ localId: id }), title: `Chat ${id}`, createdAt: 1, controllerId: `remote-${id}`, ...overrides };
}

describe("conversation preview tabs", () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: ReturnType<typeof useWorkspaceTabs>;
  let draftStore: ReturnType<typeof useStudioDraftStore>;

  function Probe() {
    api = useWorkspaceTabs();
    draftStore = useStudioDraftStore();
    return null;
  }
  async function render(props: Omit<ComponentProps<typeof WorkspaceTabsProvider>, "children"> = {}) {
    await act(async () => root.render(<StudioDraftsProvider><WorkspaceTabsProvider {...props}><Probe /></WorkspaceTabsProvider></StudioDraftsProvider>));
  }
  const ids = () => api.tabs.filter((tab) => tab.kind === "conversation").map((tab) => tab.conversationId);
  const previews = () => api.tabs.flatMap((tab) => tab.kind === "conversation" && tab.preview ? [tab.conversationId] : []);
  const openPreview = async (id: string) => act(async () => api.openConversationTab(id, { preview: true }));
  const save = (ids: string[], previewConversationId?: string) => persistWorkspaceTabsState({ projects: {
    [projectA]: { conversations: ids, activeConversationId: ids[0], previewConversationId },
  } });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.sessionStorage.clear();
    fixture.projectId = projectA;
    fixture.projectKey = projectA;
    fixture.conversations = ["a", "b", "c", "d", "e"].map((id) => conversation(id));
    fixture.activeConversationId = "a";
    fixture.activePanel = "chat";
    fixture.historyResolved = true;
    fixture.workspace.files = [];
    vi.clearAllMocks();
    studioPerformance.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    studioPerformance.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reuses a utility preview independently of chat browsing and route replay", async () => {
    save(["a"]);
    await render();
    await openPreview("b");
    for (const panel of ["ai", "machines", "credits"] as const) {
      await act(async () => api.openPanelTab(panel));
    }
    expect(api.tabs.filter(tab => tab.kind === "panel")).toMatchObject([{ panel: "credits", preview: true }]);
    expect(ids()).toEqual(["a", "b"]);
    fixture.activePanel = "machines";
    await render();
    expect(api.tabs.filter(tab => tab.kind === "panel")).toMatchObject([{ panel: "machines", preview: true }]);
    expect(api.activeTab).toMatchObject({ kind: "panel", panel: "machines" });
  });

  it("keeps utility tabs explicitly without duplicating them or displacing another preview", async () => {
    await render();
    await act(async () => api.openPanelTab("settings"));
    await act(async () => api.keepTabOpen(getTabIdForPanel("settings")));
    await act(async () => api.openPanelTab("credits"));
    await act(async () => api.openPanelTab("settings"));
    expect(api.tabs.filter(tab => tab.kind === "panel")).toMatchObject([
      { panel: "settings", preview: false }, { panel: "credits", preview: true },
    ]);
    await act(async () => api.moveTab(getTabIdForPanel("credits"), 0));
    await act(async () => api.openPanelTab("machines"));
    expect(api.tabs.filter(tab => tab.kind === "panel")).toHaveLength(3);
  });

  it("reuses file previews, then keeps an edited file after saving", async () => {
    await render();
    const file = (id: string) => ({ id, path: id, label: id });
    await act(async () => api.openFileTab(file("a.ts")));
    await act(async () => api.openFileTab(file("b.ts")));
    expect(api.tabs.filter(tab => tab.kind === "file")).toMatchObject([{ fileId: "b.ts", preview: true }]);
    fixture.workspace.files = [{ ...file("b.ts"), generated: "old", modified: "edit" } as CodeFile];
    await render();
    expect(api.tabs.find(tab => tab.kind === "file")).toMatchObject({ preview: false, dirty: true });
    fixture.workspace.files = [{ ...file("b.ts"), generated: "edit", modified: "edit" } as CodeFile];
    await render();
    await act(async () => api.openFileTab(file("c.ts")));
    await act(async () => api.openPanelTab("credits"));
    expect(api.tabs.filter(tab => tab.kind === "file")).toMatchObject([
      { fileId: "b.ts", preview: false, dirty: false }, { fileId: "c.ts", preview: true },
    ]);
    await act(async () => api.openFileTab(file("c.ts"), { preview: false }));
    expect(api.tabs.filter(tab => tab.kind === "file")).toHaveLength(2);
    expect(api.activeTab).toMatchObject({ fileId: "c.ts", preview: false });
  });

  it("protects a draft entered in the same batch as navigation and keeps its tab after saving", async () => {
    await render();
    await act(async () => api.openPanelTab("settings"));
    await act(async () => {
      draftStore!.set({ key: "profile:name", panel: "settings", base: "Alex", value: "Alex edited" });
      api.openPanelTab("credits");
    });
    expect(api.tabs.filter(tab => tab.kind === "panel")).toMatchObject([
      { panel: "settings", preview: false, dirty: true }, { panel: "credits", preview: true },
    ]);
    await act(async () => draftStore!.remove("profile:name"));
    expect(api.tabs.find(tab => tab.kind === "panel" && tab.panel === "settings")).toMatchObject({ preview: false, dirty: false });
  });

  it("restores a kept utility's section on focus, respects route replay, and isolates spaces", async () => {
    const restore = vi.fn();
    const props = { onRestorePanelDestination: restore, locationSearch: "?panel=settings&settingsTab=profile&settingsCategory=preferences&messageId=stale" };
    fixture.activePanel = "settings";
    await render(props);
    await act(async () => api.keepTabOpen(getTabIdForPanel("settings")));
    await act(async () => api.openPanelTab("credits"));
    await render({ ...props, locationSearch: "?panel=credits" });
    await act(async () => api.focusTab(getTabIdForPanel("settings")));
    expect(restore).toHaveBeenLastCalledWith({ kind: "panel", panel: "settings", settingsTab: "profile",
      settingsCategory: "preferences", settingsItem: null, settingsOrgId: null, teamId: null }, { replace: false });
    await act(async () => api.openPanelTab("credits"));
    await act(async () => api.closeTab(getTabIdForPanel("credits")));
    expect(restore.mock.lastCall).toEqual([expect.objectContaining({ settingsCategory: "preferences" }), { replace: true }]);
    restore.mockClear();
    // Route hydration calls openPanelTab with the URL's destination. It must
    // not restore cached sections, or an old render can bounce the route back.
    await act(async () => api.openPanelTab("settings"));
    expect(restore).not.toHaveBeenCalled();
    // Back/Forward hydrates its exact route rather than the last tab destination.
    await render({ ...props, locationSearch: "?panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=audio" });
    await act(async () => api.openPanelTab("credits"));
    await act(async () => api.focusTab(getTabIdForPanel("settings")));
    expect(restore.mock.lastCall?.[0]).toMatchObject({ settingsTab: "project", settingsCategory: "ai", settingsItem: "audio" });
    await act(async () => api.openPanelTab("credits"));
    fixture.projectId = projectB; fixture.projectKey = projectB;
    await render({ ...props, locationSearch: "?panel=credits" });
    restore.mockClear();
    await act(async () => api.focusTab(getTabIdForPanel("settings")));
    expect(restore).not.toHaveBeenCalled();
  });

  it("preserves legacy kept tabs and reuses just the new preview slot", async () => {
    save(["a", "b", "c"]);
    await render();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(previews()).toEqual([]);
    await openPreview("b");
    expect(ids()).toEqual(["a", "b", "c"]);
    await openPreview("d");
    await openPreview("e");
    expect(ids()).toEqual(["a", "b", "c", "e"]);
    expect(previews()).toEqual(["e"]);
    expect(api.activeTabId).toBe(getTabIdForConversation("e"));
    expect(fixture.conversations.map((entry) => entry.localId)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it.each(["home", "code", "settings"] as const)("supersedes a pending chat switch when opening %s", async (panel) => {
    save(["a", "b"]);
    await render();
    studioPerformance.clear();
    const samples: StudioPerformanceSample[] = [];
    const stop = studioPerformance.subscribe((sample) => samples.push(sample));
    try {
      await openPreview("b");
      expect(samples).toEqual([]);
      await act(async () => api.openPanelTab(panel));
      expect(samples).toMatchObject([{ operation: "conversation_switch", outcome: "superseded" }]);
      studioPerformance.observe({
        projectId: projectA, organizationId: null, conversationId: "b", messageCount: 1, loading: false, error: false,
      })?.();
      expect(samples).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("begins a measurement when opening a run thread of the already selected conversation", async () => {
    save(["a"]);
    await render();
    studioPerformance.clear();
    const samples: StudioPerformanceSample[] = [];
    const stop = studioPerformance.subscribe((sample) => samples.push(sample));
    try {
      await act(async () => api.openJobThreadTab({ conversationId: "a", jobId: "run-a" }));
      studioPerformance.observe({
        projectId: projectA, organizationId: null, conversationId: "a", messageCount: 3, loading: false, error: false,
      })?.();
      expect(samples).toMatchObject([{ operation: "conversation_switch", outcome: "ready", messageCountBucket: "1-50" }]);
    } finally {
      stop();
    }
  });

  it("restores preview ownership and does not resurrect replaced tabs during refresh or Back", async () => {
    save(["a", "b"], "b");
    fixture.activeConversationId = "b";
    await render();
    expect(previews()).toEqual(["b"]);
    await openPreview("c");
    fixture.conversations = fixture.conversations.map((entry) => ({ ...entry, title: `${entry.title}!` }));
    await render();
    expect(ids()).toEqual(["a", "c"]);
    fixture.activeConversationId = "b";
    await render();
    expect(ids()).toEqual(["a", "b"]);
    expect(previews()).toEqual(["b"]);
    fixture.activeConversationId = "c";
    await render();
    expect(ids()).toEqual(["a", "c"]);
    expect(previews()).toEqual(["c"]);
    expect(loadPersistedWorkspaceTabs()?.projects[projectA]).toEqual({
      conversations: ["a", "c"], activeConversationId: "c", previewConversationId: "c",
    });
  });

  it("keeps previews explicitly, while focus and opening the chat panel remain browsing", async () => {
    save(["a"]);
    await render();
    await openPreview("b");
    await act(async () => api.focusTab(getTabIdForConversation("a")));
    await act(async () => api.focusTab(getTabIdForConversation("b")));
    await act(async () => api.openPanelTab("chat"));
    expect(previews()).toEqual(["b"]);
    await act(async () => api.keepTabOpen(getTabIdForConversation("b")));
    await openPreview("c");
    await act(async () => api.openConversationTab("c"));
    await openPreview("d");
    expect(ids()).toEqual(["a", "b", "c", "d"]);
    expect(previews()).toEqual(["d"]);
  });

  it.each([
    { draft: "unsent draft" },
    { pendingRunIds: ["run-1"] },
    { awaitingLeaseRunIds: ["run-1"] },
  ])("promotes a preview when conversation work appears: %j", async (work) => {
    save(["a"]);
    await render();
    await openPreview("b");
    fixture.conversations = fixture.conversations.map((entry) => entry.localId === "b" ? { ...entry, ...work } : entry);
    await render();
    expect(previews()).toEqual([]);
    await openPreview("c");
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(previews()).toEqual(["c"]);
  });

  it("keeps a chat before opening its run, and preserves both when browsing", async () => {
    save(["a"]);
    await render();
    await openPreview("b");
    await act(async () => api.openJobThreadTab({ conversationId: "b", jobId: "run-1" }));
    await openPreview("c");
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(api.tabs.some((tab) => tab.kind === "jobThread" && tab.jobId === "run-1")).toBe(true);
    expect(previews()).toEqual(["c"]);
  });

  it("keeps a dirty tab and opens an already busy conversation as a kept tab", async () => {
    save(["a"]);
    fixture.conversations = fixture.conversations.map((entry) => entry.localId === "c"
      ? { ...entry, pendingRunIds: ["run-1"] } : entry);
    await render();
    await openPreview("b");
    await act(async () => api.setTabDirty(getTabIdForConversation("b"), true));
    await openPreview("c");
    expect(previews()).toEqual([]);
    await openPreview("d");
    await openPreview("e");
    expect(ids()).toEqual(["a", "b", "c", "e"]);
    expect(previews()).toEqual(["e"]);
  });

  it("keeps dragged tabs and closes a preview without reopening it", async () => {
    save(["a"]);
    await render();
    await openPreview("b");
    await act(async () => api.moveTab(getTabIdForConversation("b"), 0));
    expect(api.activeTabId).toBe(getTabIdForConversation("b"));
    expect(previews()).toEqual([]);
    await openPreview("c");
    expect(ids()).toEqual(["b", "a", "c"]);
    await act(async () => api.closeTab(getTabIdForConversation("c")));
    fixture.conversations = [...fixture.conversations];
    await render();
    expect(ids()).toEqual(["b", "a"]);
    expect(previews()).toEqual([]);
  });

  it("selects an inactive Machines tab and reorders it without changing the selection", async () => {
    save(["a"]);
    await render();
    await act(async () => api.openPanelTab("machines", { activate: false }));
    const chatId = getTabIdForConversation("a");
    const machinesId = getTabIdForPanel("machines");
    expect(api.tabs.map((tab) => tab.id)).toEqual([chatId, machinesId]);
    expect(api.activeTabId).toBe(chatId);

    await act(async () => api.focusTab(machinesId));
    expect(api.activeTabId).toBe(machinesId);
    expect(fixture.activePanel).toBe("machines");
    await act(async () => api.moveTab(machinesId, 0));
    expect(api.tabs.map((tab) => tab.id)).toEqual([machinesId, chatId]);
    expect(api.activeTab).toMatchObject({ id: machinesId, kind: "panel", panel: "machines" });
    expect(fixture.activePanel).toBe("machines");

    await act(async () => api.moveTab(machinesId, 1));
    expect(api.tabs.map((tab) => tab.id)).toEqual([chatId, machinesId]);
    expect(api.activeTabId).toBe(machinesId);
  });

  it.each([
    { position: "before chats", index: 0, order: [getTabIdForPanel("machines"), getTabIdForConversation("a"), getTabIdForConversation("b")] },
    { position: "between chats", index: 1, order: [getTabIdForConversation("a"), getTabIdForPanel("machines"), getTabIdForConversation("b")] },
  ])("keeps Machines $position when conversation titles and unread counts refresh", async ({ index, order }) => {
    save(["a", "b"]);
    await render();
    await act(async () => api.openPanelTab("machines"));
    await act(async () => api.moveTab(getTabIdForPanel("machines"), index));
    expect(api.tabs.map((tab) => tab.id)).toEqual(order);

    fixture.conversations = fixture.conversations.map((entry) => entry.localId === "a"
      ? { ...entry, title: "Renamed chat" }
      : entry.localId === "b" ? { ...entry, unreadCount: 3 } : entry);
    await render();

    expect(api.tabs.map((tab) => tab.id)).toEqual(order);
    expect(api.tabs.find((tab) => tab.id === getTabIdForConversation("a"))?.title).toBe("Renamed chat");
    expect(api.tabs.find((tab) => tab.id === getTabIdForConversation("b"))?.badge).toBe("3");
    expect(api.activeTab).toMatchObject({ id: getTabIdForPanel("machines"), kind: "panel", panel: "machines" });
    expect(fixture.activePanel).toBe("machines");
    expect(loadPersistedWorkspaceTabs()?.projects[projectA]?.conversations).toEqual(["a", "b"]);
  });

  it("removes a deleted chat without moving a surviving chat across Machines", async () => {
    save(["a", "b"]);
    await render();
    await act(async () => api.openPanelTab("machines"));
    const machinesId = getTabIdForPanel("machines");
    await act(async () => api.moveTab(machinesId, 1));
    expect(api.tabs.map((tab) => tab.id)).toEqual([getTabIdForConversation("a"), machinesId, getTabIdForConversation("b")]);

    fixture.conversations = fixture.conversations.filter((entry) => entry.localId !== "a");
    await render();

    expect(api.tabs.map((tab) => tab.id)).toEqual([machinesId, getTabIdForConversation("b")]);
    expect(api.activeTabId).toBe(machinesId);
    expect(fixture.activePanel).toBe("machines");
  });

  it("reorders a run tab while keeping its selected conversation and parent chat", async () => {
    save(["a"]);
    await render();
    await openPreview("b");
    await act(async () => api.openJobThreadTab({ conversationId: "b", jobId: "run-b" }));
    const chatA = getTabIdForConversation("a");
    const chatB = getTabIdForConversation("b");
    const runId = getTabIdForJobThread("run-b");
    expect(api.tabs.map((tab) => tab.id)).toEqual([chatA, chatB, runId]);

    await act(async () => api.moveTab(runId, 0));
    expect(api.tabs.map((tab) => tab.id)).toEqual([runId, chatA, chatB]);
    expect(api.activeTab).toMatchObject({ id: runId, kind: "jobThread", conversationId: "b", jobId: "run-b" });
    expect(fixture.activeConversationId).toBe("b");
    expect(fixture.activePanel).toBe("chat");
    expect(previews()).toEqual([]);

    await openPreview("c");
    expect(api.tabs.filter((tab) => tab.id !== getTabIdForConversation("c")).map((tab) => tab.id)).toEqual([runId, chatA, chatB]);
    expect(previews()).toEqual(["c"]);
    expect(api.activeTabId).toBe(getTabIdForConversation("c"));
    await openPreview("d");
    expect(api.tabs.filter((tab) => tab.id !== getTabIdForConversation("d")).map((tab) => tab.id)).toEqual([runId, chatA, chatB]);
    expect(previews()).toEqual(["d"]);
    expect(api.activeTabId).toBe(getTabIdForConversation("d"));
  });

  it("retains saved tabs during partial history hydration even if a panel opens first", async () => {
    save(["a", "b", "c"]);
    fixture.historyResolved = false;
    fixture.conversations = [conversation("a")];
    await render();
    await act(async () => api.openPanelTab("home"));
    expect(loadPersistedWorkspaceTabs()?.projects[projectA]?.conversations).toEqual(["a", "b", "c"]);
    fixture.conversations = ["a", "b", "c"].map((id) => conversation(id));
    fixture.historyResolved = true;
    await render();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(previews()).toEqual([]);
    expect(api.tabs.some((tab) => tab.kind === "panel" && tab.panel === "home")).toBe(true);
  });

  it("restores each space's own preview and kept tabs", async () => {
    persistWorkspaceTabsState({ projects: {
      [projectA]: { conversations: ["a", "b"], activeConversationId: "b", previewConversationId: "b" },
      [projectB]: { conversations: ["x", "y"], activeConversationId: "y", previewConversationId: "y" },
    } });
    fixture.activeConversationId = "b";
    await render();
    fixture.projectId = projectB;
    await render(); // Conversations still belong to the old space for one commit.
    fixture.projectKey = projectB;
    fixture.conversations = [conversation("x"), conversation("y")];
    fixture.activeConversationId = "y";
    await render();
    expect(ids()).toEqual(["x", "y"]);
    expect(previews()).toEqual(["y"]);
    fixture.projectId = projectA;
    fixture.projectKey = projectA;
    fixture.conversations = [conversation("a"), conversation("b")];
    fixture.activeConversationId = "b";
    await render();
    expect(ids()).toEqual(["a", "b"]);
    expect(previews()).toEqual(["b"]);
  });

  it("clears the previous space's tabs while saved destination history is delayed", async () => {
    const destination = { conversations: ["x", "y"], activeConversationId: "y", previewConversationId: "y" };
    persistWorkspaceTabsState({ projects: {
      [projectA]: { conversations: ["a", "b"], activeConversationId: "b" },
      [projectB]: destination,
    } });
    fixture.activeConversationId = "b";
    await render();
    await act(async () => api.openJobThreadTab({ conversationId: "b", jobId: "run-b" }));
    await act(async () => api.openPanelTab("home"));

    fixture.projectId = projectB;
    await render(); // The conversations reducer still holds A for one commit.
    expect(ids()).toEqual([]);
    expect(api.tabs.some((tab) => tab.kind === "jobThread")).toBe(false);
    expect(api.activeTab?.kind === "panel" && api.activeTab.panel).toBe("home");
    // The layout relies on this signal to paint a quiet frame instead of the
    // "Open a panel" copy while the destination tabs are being rebuilt.
    expect(api.conversationTabsReady).toBe(false);

    fixture.projectKey = projectB;
    fixture.conversations = [conversation("x")];
    fixture.activeConversationId = "x";
    fixture.historyResolved = false;
    await render();
    // Real conversations have landed, so the strip may materialize; only the
    // saved-tab restore still waits for the rest of history.
    expect(api.conversationTabsReady).toBe(true);
    await act(async () => api.closeTab(getTabIdForConversation("b")));
    expect(ids()).toEqual([]);
    expect(loadPersistedWorkspaceTabs()?.projects[projectB]).toEqual(destination);
    await render(); // A failed/retrying fetch keeps the same unresolved snapshot.
    expect(ids()).toEqual([]);

    fixture.conversations = [conversation("x"), conversation("y")];
    fixture.historyResolved = true;
    await render();
    expect(api.conversationTabsReady).toBe(true);
    expect(ids()).toEqual(["x", "y"]);
    expect(previews()).toEqual(["y"]);
    expect(api.activeTab?.kind === "panel" && api.activeTab.panel).toBe("home");
  });

  it("holds a fresh space's placeholder off the strip until its history resolves", async () => {
    fixture.activeConversationId = "a";
    await render();
    expect(ids()).toEqual(["a"]);

    // Create: the new space starts with one local placeholder and no other
    // tab, so the layout sees no active tab. It must read this as hydrating,
    // not as an empty workspace.
    fixture.projectId = projectB;
    fixture.projectKey = projectB;
    fixture.conversations = [{ ...createInitialConversation({ localId: "fresh" }), createdAt: Date.now() - 1_000 }];
    fixture.activeConversationId = "fresh";
    fixture.historyResolved = false;
    await render();
    expect(ids()).toEqual([]);
    expect(api.activeTab).toBeNull();
    expect(api.conversationTabsReady).toBe(false);

    fixture.historyResolved = true;
    await render();
    expect(api.conversationTabsReady).toBe(true);
    expect(ids()).toEqual(["fresh"]);
    expect(api.activeTab?.kind === "conversation" && api.activeTab.conversationId).toBe("fresh");
  });

  it("does not overwrite saved destination tabs when closing a partial hydration tab", async () => {
    fixture.projectId = projectB;
    fixture.projectKey = projectB;
    fixture.conversations = [conversation("x")];
    fixture.activeConversationId = "x";
    fixture.historyResolved = false;
    const destination = { conversations: ["x", "y"], activeConversationId: "y", previewConversationId: "y" };
    persistWorkspaceTabsState({ projects: { [projectB]: destination } });
    await render();
    expect(ids()).toEqual(["x"]);
    await act(async () => api.closeTab(getTabIdForConversation("x")));
    expect(loadPersistedWorkspaceTabs()?.projects[projectB]).toEqual(destination);
    fixture.conversations = [conversation("x"), conversation("y")];
    fixture.historyResolved = true;
    await render();
    expect(ids()).toEqual(["x", "y"]);
    expect(previews()).toEqual(["y"]);
  });
});
