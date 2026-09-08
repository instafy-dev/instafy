// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../../conversations/conversationState";
import type { StudioPanel } from "../../screens/studio/types";
import { WorkspaceTabsProvider, useWorkspaceTabs } from "../WorkspaceTabsProvider";
import { getTabIdForConversation } from "../workspaceTabFactories";
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
  workspace: { files: [] },
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

  function Probe() {
    api = useWorkspaceTabs();
    return null;
  }
  async function render() {
    await act(async () => root.render(<WorkspaceTabsProvider><Probe /></WorkspaceTabsProvider>));
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
    await openPreview("c");
    expect(ids()).toEqual(["b", "a", "c"]);
    await act(async () => api.closeTab(getTabIdForConversation("c")));
    fixture.conversations = [...fixture.conversations];
    await render();
    expect(ids()).toEqual(["b", "a"]);
    expect(previews()).toEqual([]);
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

    fixture.projectKey = projectB;
    fixture.conversations = [conversation("x")];
    fixture.activeConversationId = "x";
    fixture.historyResolved = false;
    await render();
    await act(async () => api.closeTab(getTabIdForConversation("b")));
    expect(ids()).toEqual([]);
    expect(loadPersistedWorkspaceTabs()?.projects[projectB]).toEqual(destination);
    await render(); // A failed/retrying fetch keeps the same unresolved snapshot.
    expect(ids()).toEqual([]);

    fixture.conversations = [conversation("x"), conversation("y")];
    fixture.historyResolved = true;
    await render();
    expect(ids()).toEqual(["x", "y"]);
    expect(previews()).toEqual(["y"]);
    expect(api.activeTab?.kind === "panel" && api.activeTab.panel).toBe("home");
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
